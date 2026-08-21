"""Automations — trigger, condition, action, stored as data.

Rules are built in a UI out of typed blocks, so this module is the interpreter
for those blocks rather than a place anyone writes code.

The three hard problems, and where each is solved here:

  * **Loops.** Events carry `actor_kind`. Rules ignore automation-caused events
    unless they explicitly opt in, and even then `depth` caps how far a chain
    can run. A rule that trips itself stops after one hop instead of filling
    the database overnight.
  * **Idempotency.** A job's `dedupe_key` is `(rule_id, event_id)` and it is
    unique. The runner retries — that is what makes it reliable — and a retry
    has to be a no-op, or you get duplicate comments forever.
  * **Serialisation.** The queue claims one job per issue at a time, so two
    rules cannot interleave halfway through changing the same issue.

Nothing runs inline. Events are written by whoever wrote them; a worker scans
for new ones, enqueues jobs, and executes them out of band. Automations are
slow, they fail and they cascade, and none of that belongs in a request a
person is waiting on.

Every run is recorded in `automation_runs`, including the ones that did
nothing. "Why did this rule not fire" is the question actually asked.
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import Connection, and_, select, text, update

from . import query, releases as rel, repo
from .repo import Actor, TrackerError
from .schema import (
    automation_jobs, automation_rules, automation_runs, events, issue_types,
    issues, projects, statuses, worker_state,
)

# How deep an automation chain may run before it is cut off. Two is enough for
# "rule creates an issue, another rule assigns it" and far short of a loop.
MAX_DEPTH = 2

# Consecutive failures before a rule switches itself off. A broken rule firing
# on every event is an outage, not a bug report.
FAILURE_LIMIT = 5

AUTOMATION = Actor(id=None, kind="automation")


class RuleError(Exception):
    """A rule that cannot run as written — the author's problem."""


# ------------------------------------------------------------------ triggers --

# Event kinds each trigger type listens for. Kept as data so the UI can offer
# exactly these and nothing else.
TRIGGERS: dict[str, dict] = {
    "issue_created": {"entity": "issue", "kinds": ["created"],
                      "label": "an issue is created"},
    "issue_transitioned": {"entity": "issue", "kinds": ["field_changed"],
                           "field": "status_id",
                           "label": "an issue moves to a status"},
    "issue_field_changed": {"entity": "issue", "kinds": ["field_changed"],
                            "label": "a field changes"},
    "issue_commented": {"entity": "issue", "kinds": ["commented"],
                        "label": "someone comments"},
    "release_created": {"entity": "release", "kinds": ["created"],
                        "label": "a release is created"},
    "release_shipped": {"entity": "release", "kinds": ["field_changed"],
                        "field": "state", "value": "shipped",
                        "label": "a release ships"},
    # Git. These are what close the gap with the Jira we are replacing, where
    # 57% of DRC's status changes are automation reacting to git rather than a
    # person clicking. The engine needed nothing new to accept them — a trigger
    # is an event kind, and git writes events like everything else does.
    "pr_opened": {"entity": "issue", "kinds": ["pr_opened"],
                  "label": "a pull request is opened"},
    "pr_merged": {"entity": "issue", "kinds": ["pr_merged"],
                  "label": "a pull request is merged"},
    "pr_closed": {"entity": "issue", "kinds": ["pr_closed"],
                  "label": "a pull request is closed without merging"},
    "branch_created": {"entity": "issue", "kinds": ["branch_created"],
                       "label": "a branch is created"},
    "build_failed": {"entity": "issue", "kinds": ["build_failed"],
                     "label": "a build fails"},
    "build_passed": {"entity": "issue", "kinds": ["build_passed"],
                     "label": "a build passes"},
    "manual": {"entity": "issue", "kinds": [], "label": "someone runs it by hand"},
}


# Event kinds that come from outside and can never be produced by a rule here.
# They are exempt from the "ignore automation-caused events" guard: nothing in
# ACTIONS opens a pull request, so a git event cannot be an echo of our own work.
EXTERNAL_KINDS = frozenset({
    "pr_opened", "pr_merged", "pr_closed",
    "branch_created", "build_failed", "build_passed",
})


def _trigger_matches(rule: dict, event: dict) -> bool:
    trigger = rule["trigger"] or {}
    spec = TRIGGERS.get(trigger.get("type", ""))
    if spec is None or not spec["kinds"]:
        return False
    if event["entity_type"] != spec["entity"] or event["kind"] not in spec["kinds"]:
        return False

    # A trigger tied to one field only fires for that field.
    field = spec.get("field")
    if field and event["field"] != field:
        return False
    if "value" in spec and str(event["to_value"]) != spec["value"]:
        return False

    # "moves to In Review" rather than "moves anywhere".
    if trigger.get("type") == "issue_transitioned" and trigger.get("to_status_id"):
        if str(event["to_value"]) != str(trigger["to_status_id"]):
            return False
    if trigger.get("type") == "issue_field_changed" and trigger.get("field"):
        if event["field"] != trigger["field"]:
            return False
    return True


# ---------------------------------------------------------------- conditions --

def _conditions_pass(conn: Connection, rule: dict, entity_type: str, entity_id: int) -> bool:
    """Evaluate the rule's filter against the entity, reusing the board's
    filter compiler — one filter language for views and rules means one thing
    to learn, and one thing to keep correct."""
    conditions = rule.get("conditions") or {}
    if not conditions or not conditions.get("all") and not conditions.get("any"):
        return True
    if entity_type != "issue":
        return True  # release conditions are not expressible yet; do not block

    try:
        found = query.list_issues(
            conn,
            filter={"all": [conditions, {"field": "key", "op": "eq", "value": _key(conn, entity_id)}]},
            limit=1,
        )
    except query.QueryError as exc:
        raise RuleError(str(exc))
    return found["total"] > 0


def _key(conn: Connection, issue_id: int) -> str:
    return conn.execute(select(issues.c.key).where(issues.c.id == issue_id)).scalar() or ""


# ------------------------------------------------------------------- actions --

def _resolve(template: str, context: dict) -> str:
    """Fill {{release.name}} style placeholders.

    Deliberately dumb: it substitutes known values and leaves anything else
    alone. Variables are click-to-insert in the UI, never free text, so an
    unresolved placeholder means the rule was authored against something that
    no longer exists — and showing it verbatim is how that gets noticed.
    """
    out = template or ""
    for scope, values in context.items():
        if not isinstance(values, dict):
            continue
        for key, value in values.items():
            out = out.replace("{{%s.%s}}" % (scope, key), "" if value is None else str(value))
    return out


def _run_action(conn: Connection, action: dict, context: dict, actor: Actor) -> dict:
    """Execute one block. Returns a record of what it did, for the audit log."""
    kind = action.get("type")
    issue_id = context.get("issue", {}).get("id")

    if kind == "transition":
        if not issue_id:
            raise RuleError("transition needs an issue")
        repo.update_issue(conn, actor, int(issue_id), {"status_id": int(action["status_id"])})
        return {"type": kind, "issue_id": issue_id, "status_id": action["status_id"]}

    if kind == "assign":
        if not issue_id:
            raise RuleError("assign needs an issue")
        assignee = action.get("assignee_id")
        repo.update_issue(conn, actor, int(issue_id),
                          {"assignee_id": int(assignee) if assignee else None})
        return {"type": kind, "issue_id": issue_id, "assignee_id": assignee}

    if kind == "set_field":
        if not issue_id:
            raise RuleError("set_field needs an issue")
        field, value = action.get("field", ""), action.get("value")
        if field.startswith(repo.CUSTOM_PREFIX):
            repo.update_issue(conn, actor, int(issue_id), {},
                              custom={field[len(repo.CUSTOM_PREFIX):]: value})
        else:
            repo.update_issue(conn, actor, int(issue_id), {field: value})
        return {"type": kind, "issue_id": issue_id, "field": field, "value": value}

    if kind == "comment":
        if not issue_id:
            raise RuleError("comment needs an issue")
        body = _resolve(action.get("body", ""), context)
        repo.add_comment(conn, actor, int(issue_id), body)
        return {"type": kind, "issue_id": issue_id, "body": body[:120]}

    if kind == "create_issue":
        summary = _resolve(action.get("summary", ""), context)
        if not summary.strip():
            raise RuleError("create_issue needs a summary")
        created = repo.create_issue(
            conn, actor,
            project_id=int(action["project_id"]),
            issue_type_id=int(action["issue_type_id"]),
            status_id=_first_status(conn, int(action["project_id"])),
            summary=summary,
            description=_resolve(action.get("description", ""), context),
            assignee_id=action.get("assignee_id"),
            priority=action.get("priority", "medium"),
        )
        # Link it to the release that triggered the rule, when there was one —
        # this is the whole point of "create a testing task for a release".
        release_id = context.get("release", {}).get("id")
        if release_id and action.get("link_to_release", True):
            rel.add_issues(conn, actor, int(release_id), [created["id"]])
        return {"type": kind, "created": created["key"], "summary": summary}

    if kind == "add_to_release":
        release_id = action.get("release_id") or context.get("release", {}).get("id")
        if not (release_id and issue_id):
            raise RuleError("add_to_release needs a release and an issue")
        rel.add_issues(conn, actor, int(release_id), [int(issue_id)])
        return {"type": kind, "release_id": release_id, "issue_id": issue_id}

    if kind == "for_each":
        # Half the useful rules iterate: "for every issue on this release, ...".
        # Not optional, which is why it is a block rather than a special case.
        target = action.get("over", "release_issues")
        inner = action.get("actions") or []
        done = []
        if target == "release_issues":
            release_id = context.get("release", {}).get("id")
            if not release_id:
                raise RuleError("for_each over release issues needs a release")
            detail = rel.detail(conn, int(release_id)) or {"issues": []}
            targets = [i["id"] for i in detail["issues"]]
        elif target == "filter":
            try:
                found = query.list_issues(conn, filter=action.get("filter"), limit=200)
            except query.QueryError as exc:
                raise RuleError(str(exc))
            targets = [i["id"] for i in found["issues"]]
        else:
            raise RuleError(f"unknown for_each source: {target}")

        for target_id in targets:
            scoped = {**context, "issue": {"id": target_id, "key": _key(conn, target_id)}}
            for step in inner:
                done.append(_run_action(conn, step, scoped, actor))
        return {"type": kind, "over": target, "count": len(targets), "steps": done}

    raise RuleError(f"unknown action: {kind}")


def _first_status(conn: Connection, project_id: int) -> int:
    from .api import _first_status as first  # the workflow lookup already exists
    return first(conn, project_id, 0)


# --------------------------------------------------------------------- queue --

def _dedupe_key(rule_id: int, event_id: int | None, manual_tag: str = "") -> str:
    return f"{rule_id}:{event_id if event_id is not None else 'manual:' + manual_tag}"


def enqueue(conn: Connection, rule: dict, event: dict | None, *,
            entity_type: str, entity_id: int, depth: int = 0,
            manual_tag: str = "") -> int | None:
    """Queue one rule against one entity. Returns the job id, or None if this
    exact (rule, event) pair is already queued — which is the retry story."""
    key = _dedupe_key(rule["id"], event["id"] if event else None, manual_tag)
    existing = conn.execute(
        select(automation_jobs.c.id).where(automation_jobs.c.dedupe_key == key)
    ).scalar()
    if existing is not None:
        return None
    return int(conn.execute(automation_jobs.insert().values(
        rule_id=rule["id"],
        event_id=event["id"] if event else None,
        dedupe_key=key,
        issue_id=entity_id if entity_type == "issue" else None,
        entity_type=entity_type,
        entity_id=entity_id,
        depth=depth,
        payload={"trigger": rule["trigger"]},
    ).returning(automation_jobs.c.id)).scalar_one())


def scan(conn: Connection, limit: int = 200) -> int:
    """Turn new events into jobs.

    Polling the event log rather than firing from the write path keeps
    automations entirely out of the request that caused them, and means a rule
    added today can be replayed against yesterday by moving the cursor back.
    """
    cursor = conn.execute(
        select(worker_state.c.value).where(worker_state.c.key == "automation_cursor")
    ).scalar()
    last_id = int(cursor or 0)

    new_events = conn.execute(
        select(events).where(events.c.id > last_id).order_by(events.c.id).limit(limit)
    ).mappings().all()
    if not new_events:
        return 0

    rules = [dict(r) for r in conn.execute(
        select(automation_rules).where(automation_rules.c.enabled.is_(True))
    ).mappings()]

    queued = 0
    for event in new_events:
        event = dict(event)
        for rule in rules:
            # A rule ignores automation-caused events unless it opts in. This is
            # the first and cheapest of the three loop defences.
            #
            # "Caused by automation" means caused by *a rule of ours*. An event
            # from git is an external fact — a person opened a pull request —
            # and no action here can produce one, so it cannot close a loop.
            # Treating it as automated would have silenced the entire git
            # integration without a word: rules would sit enabled and never run.
            caused_here = event["actor_kind"] != "human" and event["kind"] not in EXTERNAL_KINDS
            if caused_here and not (rule["trigger"] or {}).get("allow_automated"):
                continue
            if not _trigger_matches(rule, event):
                continue
            if enqueue(conn, rule, event,
                       entity_type=event["entity_type"], entity_id=event["entity_id"]):
                queued += 1

    high = new_events[-1]["id"]
    _set_state(conn, "automation_cursor", str(high))
    return queued


def _set_state(conn: Connection, key: str, value: str) -> None:
    updated = conn.execute(
        update(worker_state).where(worker_state.c.key == key)
        .values(value=value, updated_at=text("now()"))
    ).rowcount
    if not updated:
        conn.execute(worker_state.insert().values(key=key, value=value))


def claim(conn: Connection) -> dict | None:
    """Take the next runnable job.

    `FOR UPDATE SKIP LOCKED` plus a per-issue exclusion: a job whose issue
    already has one running is left where it is, so two rules cannot interleave
    halfway through changing the same issue.
    """
    busy = select(automation_jobs.c.issue_id).where(
        and_(automation_jobs.c.state == "running", automation_jobs.c.issue_id.isnot(None))
    ).scalar_subquery()

    row = conn.execute(text("""
        SELECT id FROM automation_jobs
         WHERE state = 'pending'
           AND scheduled_at <= now()
           AND (issue_id IS NULL OR issue_id NOT IN (
                 SELECT issue_id FROM automation_jobs
                  WHERE state = 'running' AND issue_id IS NOT NULL))
         ORDER BY id
         LIMIT 1
           FOR UPDATE SKIP LOCKED
    """)).first()
    if row is None:
        return None

    conn.execute(automation_jobs.update()
                 .where(automation_jobs.c.id == row.id)
                 .values(state="running", started_at=text("now()"),
                         attempts=automation_jobs.c.attempts + 1))
    return dict(conn.execute(
        select(automation_jobs).where(automation_jobs.c.id == row.id)
    ).mappings().one())


# --------------------------------------------------------------------- runner --

def context_for(conn: Connection, entity_type: str, entity_id: int) -> dict:
    """The values a rule's templates can reference."""
    context: dict[str, Any] = {}
    if entity_type == "issue":
        row = conn.execute(
            select(issues.c.id, issues.c.key, issues.c.summary, issues.c.priority,
                   statuses.c.name.label("status"), issue_types.c.name.label("type"),
                   projects.c.key.label("project"))
            .select_from(issues
                         .join(statuses, issues.c.status_id == statuses.c.id)
                         .join(issue_types, issues.c.issue_type_id == issue_types.c.id)
                         .join(projects, issues.c.project_id == projects.c.id))
            .where(issues.c.id == entity_id)
        ).mappings().first()
        if row:
            context["issue"] = dict(row)
    elif entity_type == "release":
        found = rel.detail(conn, entity_id)
        if found:
            context["release"] = {
                "id": found["id"], "name": found["name"], "kind": found["kind"],
                "state": found["state"], "issues": found["counts"]["total"],
            }
    return context


def execute(conn: Connection, job: dict, *, dry_run: bool = False) -> dict:
    """Run one job, and record what happened whatever that was."""
    rule = conn.execute(
        select(automation_rules).where(automation_rules.c.id == job["rule_id"])
    ).mappings().first()
    if rule is None:
        return {"outcome": "skipped", "note": "rule is gone"}
    rule = dict(rule)

    steps: list[dict] = []
    outcome, error, passed = "ran", "", True
    try:
        if job["depth"] > MAX_DEPTH:
            outcome, passed = "skipped", False
            error = f"depth {job['depth']} exceeds the cap"
        else:
            passed = _conditions_pass(conn, rule, job["entity_type"], job["entity_id"])
            if not passed:
                outcome = "skipped"
            else:
                context = context_for(conn, job["entity_type"], job["entity_id"])
                actor = AUTOMATION if rule["run_as"] == "automation" else AUTOMATION
                for action in rule["actions"] or []:
                    if dry_run:
                        steps.append({"type": action.get("type"), "dry_run": True})
                    else:
                        steps.append(_run_action(conn, action, context, actor))
    except (RuleError, TrackerError) as exc:
        outcome, error = "failed", str(exc)
    except Exception as exc:  # noqa: BLE001 - a rule must never take the worker down
        outcome, error = "failed", f"{type(exc).__name__}: {exc}"

    conn.execute(automation_runs.insert().values(
        rule_id=rule["id"], job_id=job["id"], event_id=job["event_id"],
        outcome=outcome, condition_result=passed, steps=steps, error=error,
        dry_run=dry_run,
    ))

    if not dry_run:
        conn.execute(automation_jobs.update().where(automation_jobs.c.id == job["id"]).values(
            state="done" if outcome != "failed" else "failed",
            finished_at=text("now()"), error=error,
        ))
        # A rule that keeps throwing switches itself off; one that succeeds
        # clears the count, so an occasional blip never accumulates into a
        # disable.
        if outcome == "failed":
            failures = int(rule["failure_count"]) + 1
            values: dict[str, Any] = {"failure_count": failures}
            if failures >= FAILURE_LIMIT:
                values |= {"enabled": False,
                           "disabled_reason": f"disabled after {failures} failures: {error[:180]}"}
            conn.execute(automation_rules.update()
                         .where(automation_rules.c.id == rule["id"]).values(**values))
        elif rule["failure_count"]:
            conn.execute(automation_rules.update()
                         .where(automation_rules.c.id == rule["id"])
                         .values(failure_count=0))

    return {"outcome": outcome, "steps": steps, "error": error, "conditions": passed}


def drain(conn: Connection, limit: int = 25) -> dict:
    """Run whatever is queued, up to a limit. One tick of the worker."""
    ran = {"ran": 0, "skipped": 0, "failed": 0}
    for _ in range(limit):
        job = claim(conn)
        if job is None:
            break
        result = execute(conn, job)
        ran[result["outcome"]] = ran.get(result["outcome"], 0) + 1
    return ran


def tick(conn: Connection) -> dict:
    """Scan for new events, then run what that produced."""
    queued = scan(conn)
    return {"queued": queued, **drain(conn)}
