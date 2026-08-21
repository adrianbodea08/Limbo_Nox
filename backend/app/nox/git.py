"""What git is doing to an issue: branches, pull requests, and their checks.

Why this exists at all, in one number: in the Jira we are replacing, **57% of
DRC's status changes are made by automation, not people** — 2,419 of them in 90
days — and the shape is unmistakably git-driven (In Progress → In Review on a PR
opening, → Done on a merge, → STAGING → LIVE on deploys). A tracker without git
does not lose a feature, it loses half the workflow and hands it back to people
as manual clicking. That is how a tool gets abandoned in its second week.

So this module does two things:

  * **Records** what git has: a branch, a PR, its state and whether its checks
    passed, linked to the issues whose keys it mentions.
  * **Says so**, by writing events on those issues — which is what lets the
    automation engine react. `pr_opened`, `pr_merged`, `build_failed` and
    `branch_created` are triggers like any other; nothing in the engine needed
    changing to accept them.

Two ways in, deliberately. A **webhook** is the real mechanism and gives you the
state a second after it changes. A **sync** pulls the same data on demand, which
is what makes this usable before anyone has configured a webhook, and what
repairs the record after an outage drops one.
"""
from __future__ import annotations

import hashlib
import hmac
import re
from typing import Any

from sqlalchemy import Connection, select, text

from . import github_app
from . import repo as repo_mod
from .repo import Actor
from .schema import components, git_refs, issue_git, issues

# PROJ-123. Bounded rather than open-ended: an unanchored [A-Z]+-\d+ matches
# "COVID-19" and every ticket reference to another system, and a key that is
# checked against the real project list cannot do that.
KEY_PATTERN = re.compile(r"\b([A-Z][A-Z0-9]{1,9})-(\d+)\b")

# Where a key was found, in the order we trust it. A key in the title is
# deliberate; a key in a branch name is usually deliberate; a key in the body
# might be someone quoting another ticket, which is why the link records which.
SOURCES = ("title", "branch", "body")


class GitError(Exception):
    """Something a caller can act on — a bad signature, an unknown repo."""


# ------------------------------------------------------------------- keys --

def keys_in(text_value: str) -> set[str]:
    """Every issue key shaped string in a piece of text."""
    return {f"{m.group(1)}-{m.group(2)}" for m in KEY_PATTERN.finditer(text_value or "")}


def resolve_keys(conn: Connection, found: dict[str, set[str]]) -> dict[int, str]:
    """Turn candidate keys into real issue ids, remembering where each was seen.

    Anything that is not a live issue key is dropped without ceremony: a commit
    message mentioning `ABC-1` from another system is not an error, it is a
    string that happens to look like a key.
    """
    everything: set[str] = set()
    for keys in found.values():
        everything |= keys
    if not everything:
        return {}

    rows = conn.execute(
        select(issues.c.id, issues.c.key)
        .where(issues.c.key.in_(sorted(everything)))
        .where(issues.c.archived_at.is_(None))
    ).all()

    out: dict[int, str] = {}
    for issue_id, key in rows:
        for source in SOURCES:
            if key in found.get(source, set()):
                out[issue_id] = source
                break
    return out


def live_keys(conn: Connection, candidates: set[str]) -> set[str]:
    """The subset that are real, open issues.

    Asked before spending a network call on a branch: `release/2.4-RC1` matches
    the shape of a key and belongs to nobody, and comparing four hundred of
    those against the default branch is four hundred calls for nothing.
    """
    if not candidates:
        return set()
    rows = conn.execute(
        select(issues.c.key)
        .where(issues.c.key.in_(sorted(candidates)))
        .where(issues.c.archived_at.is_(None))
    ).all()
    return {r[0] for r in rows}


# ------------------------------------------------------------- recording --

def record(conn: Connection, actor: Actor, *, kind: str, repo_name: str, ref: str,
           title: str = "", url: str = "", state: str = "", checks: str = "none",
           author: str = "", branch: str = "", opened_at: Any = None,
           merged_at: Any = None, found: dict[str, set[str]] | None = None,
           announce: bool = True) -> dict:
    """Store a ref and link it to the issues it names.

    Idempotent by (repo, kind, ref), because both ways in can deliver the same
    pull request: a webhook fires on every edit, and a sync re-reads everything
    it can see. Re-recording updates the row and re-links, so replaying a day of
    webhooks changes nothing.

    `announce=False` records without writing events. It is for the things a
    poller *finds* rather than *witnesses*: reading a six-month-old branch for
    the first time is not that branch being created, and an automation that
    moves an issue when a branch appears must not fire for two hundred branches
    the first time somebody connects an organisation. A webhook, which really
    did witness the event, still announces.
    """
    existing = conn.execute(
        select(git_refs)
        .where(git_refs.c.repo == repo_name)
        .where(git_refs.c.kind == kind)
        .where(git_refs.c.ref == str(ref))
    ).mappings().first()

    values = {
        "kind": kind, "repo": repo_name, "ref": str(ref), "title": title or "",
        "url": url or "", "state": state or "", "checks": checks or "none",
        "author": author or "", "branch": branch or "",
        "opened_at": opened_at, "merged_at": merged_at,
        "updated_at": text("now()"),
    }

    if existing is None:
        ref_id = conn.execute(
            git_refs.insert().values(**values).returning(git_refs.c.id)).scalar_one()
        before = None
    else:
        ref_id = existing["id"]
        # Do not let a partial update blank out what we already knew. A check
        # event carries no title; a PR edit carries no check result.
        keep = {k: v for k, v in values.items()
                if v not in ("", None, "none") or k in ("state", "updated_at")}
        conn.execute(git_refs.update().where(git_refs.c.id == ref_id).values(**keep))
        before = dict(existing)

    linked = resolve_keys(conn, found or {})
    for issue_id, source in linked.items():
        conn.execute(text("""
            INSERT INTO issue_git (issue_id, git_ref_id, found_in)
            VALUES (:i, :g, :s)
            ON CONFLICT (issue_id, git_ref_id) DO NOTHING
        """), {"i": issue_id, "g": ref_id, "s": source})

    # Announce to everything attached to this ref, not only what this payload
    # named. A check result carries no issue keys at all — it arrives against a
    # pull request — so announcing to the keys in the payload would mean a build
    # never failed as far as any issue was concerned.
    attached = [r[0] for r in conn.execute(
        select(issue_git.c.issue_id).where(issue_git.c.git_ref_id == ref_id)).all()]
    if announce:
        _announce(conn, actor, ref_id, kind, values, before, attached)
    return {"id": ref_id, "issues": attached}


def _announce(conn: Connection, actor: Actor, ref_id: int, kind: str,
              now_values: dict, before: dict | None, issue_ids: list[int]) -> None:
    """Write the events that automations listen for.

    Only on a real change. A webhook that fires because somebody edited a PR
    description must not read as "this PR was just merged" — that is how an
    automation ends up running every time anyone touches anything.
    """
    if not issue_ids:
        return

    happenings: list[tuple[str, dict]] = []
    state = now_values.get("state") or ""
    checks = now_values.get("checks") or "none"
    was_state = (before or {}).get("state") or ""
    was_checks = (before or {}).get("checks") or "none"

    if kind == "branch" and before is None:
        happenings.append(("branch_created", {"branch": now_values.get("ref")}))
    # A build ref is a record, not a herald. What an automation listens to is
    # the *pull request's* check state, which the same sync sets — one event per
    # real change, from the place that knows which issues it concerns.
    if kind in ("commit", "build"):
        return
    if kind == "pr":
        if before is None and state in ("open", "draft"):
            happenings.append(("pr_opened", {"state": state}))
        if state == "merged" and was_state != "merged":
            happenings.append(("pr_merged", {}))
        if state == "closed" and was_state not in ("closed", "merged"):
            happenings.append(("pr_closed", {}))
        if checks == "failing" and was_checks != "failing":
            happenings.append(("build_failed", {}))
        if checks == "passing" and was_checks != "passing":
            happenings.append(("build_passed", {}))

    if not happenings:
        return

    batch = repo_mod.new_batch(conn)
    for issue_id in issue_ids:
        for kind_name, payload in happenings:
            repo_mod.write_event(
                conn, actor, entity_type="issue", entity_id=issue_id,
                batch_id=batch, kind=kind_name,
                payload={**payload, "ref_id": ref_id, "repo": now_values["repo"],
                         "ref": now_values["ref"], "title": now_values["title"],
                         "url": now_values["url"]})


# ----------------------------------------------------------------- reads --

def for_issues(conn: Connection, issue_ids: list[int]) -> dict[int, list[dict]]:
    """Every branch and PR on each issue, newest first."""
    if not issue_ids:
        return {}
    rows = conn.execute(
        select(git_refs, issue_git.c.issue_id, issue_git.c.found_in)
        .select_from(issue_git.join(git_refs, issue_git.c.git_ref_id == git_refs.c.id))
        .where(issue_git.c.issue_id.in_(issue_ids))
        .order_by(git_refs.c.kind, git_refs.c.updated_at.desc())
    ).mappings().all()
    out: dict[int, list[dict]] = {}
    for row in rows:
        out.setdefault(row["issue_id"], []).append(dict(row))
    return out


def repos(conn: Connection) -> list[str]:
    """The repositories the tracker knows about — the components' own.

    A component already carries its repo, so there is no second list to keep in
    step with the first.
    """
    rows = conn.execute(
        select(components.c.repo)
        .where(components.c.repo != "")
        .where(components.c.archived_at.is_(None))
    ).all()
    return sorted({r[0] for r in rows})


# --------------------------------------------------------------- webhook --

def verify(secret: str, body: bytes, signature: str) -> bool:
    """GitHub's HMAC over the raw body.

    Compared with `compare_digest`, not `==`: a byte-by-byte comparison leaks
    how much of a forged signature was right, and this endpoint is public by
    definition.
    """
    if not secret:
        raise GitError("no webhook secret is configured — refusing to trust the sender")
    if not signature.startswith("sha256="):
        return False
    want = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, signature)


def from_webhook(conn: Connection, actor: Actor, event: str, payload: dict) -> dict:
    """Turn one GitHub delivery into a recorded ref, or ignore it.

    Unknown events are ignored rather than refused. GitHub sends whatever the
    hook is subscribed to, and answering 400 to a `star` event would have
    somebody debugging a delivery that was never a problem.
    """
    repo_name = ((payload.get("repository") or {}).get("full_name")) or ""
    if not repo_name:
        return {"ignored": "no repository in the payload"}

    if event == "pull_request":
        return record_pull(conn, actor, repo_name, payload.get("pull_request") or {})

    if event == "create" and payload.get("ref_type") == "branch":
        branch = payload.get("ref") or ""
        # No title: the sync computes "3 ahead, 1 behind" for this row, and a
        # webhook that knows less must not overwrite it with the branch name.
        return record(conn, actor, kind="branch", repo_name=repo_name, ref=branch,
                      branch=branch,
                      url=f"https://github.com/{repo_name}/tree/{branch}",
                      found={"branch": keys_in(branch)})

    # Commits, as they land. The branch is on the delivery, which is how a
    # commit whose message never mentions a key still reaches its issue.
    if event == "push":
        branch = (payload.get("ref") or "").removeprefix("refs/heads/")
        stored = [record_commit(conn, actor, repo_name, c, branch)
                  for c in payload.get("commits") or []]
        return {"commits": len(stored), "branch": branch}

    # A run reaches an issue two ways: through the pull requests it ran for, and
    # through the branch it ran on. The first is what an automation listens to.
    if event == "workflow_run":
        run = payload.get("workflow_run") or {}
        record_run(conn, actor, repo_name, run)
        outcome = RUN_CHECKS.get(
            RUN_STATE.get(run.get("conclusion") or "", "")
            if run.get("status") == "completed" else "running", "pending")
        touched = [record(conn, actor, kind="pr", repo_name=repo_name,
                          ref=str(pr.get("number")), checks=outcome)
                   for pr in run.get("pull_requests") or []]
        return {"checks": outcome, "pull_requests": len(touched)}

    # Checks that are not Actions — a third-party CI reporting in. No run to
    # record, so this reaches an issue only through the pull request.
    if event == "check_suite":
        body = payload.get("check_suite") or {}
        outcome = {"success": "passing", "failure": "failing", "timed_out": "failing",
                   "cancelled": "none"}.get(body.get("conclusion") or "", "pending")
        touched = [record(conn, actor, kind="pr", repo_name=repo_name,
                          ref=str(pr.get("number")), checks=outcome)
                   for pr in body.get("pull_requests") or []]
        return {"checks": outcome, "pull_requests": len(touched)}

    return {"ignored": event}


# ------------------------------------------------------------------ sync --

class NothingToSync(GitError):
    """There is nowhere to read from — a setup problem, not a failure."""


class NoCredentials(GitError):
    """Neither an installation nor a token. The panel says how to fix it."""


async def sync(engine, *, only: str | None = None, pages: int = 2) -> dict:
    """Read pull requests and record them. Shared by the route and the worker.

    Reads as the connected GitHub App, which covers every repository the
    installation can see — including ones created after somebody stopped
    maintaining a list.
    """
    with engine.connect() as conn:
        installs = github_app.live(conn)
    if not installs:
        raise NoCredentials(
            "No GitHub organisation is connected yet. Connect one on the Git "
            "page — it is one click and nothing to paste.")
    return await _sync_via_app(engine, installs, only, pages)



def record_pull(conn: Connection, actor: Actor, repo_name: str, pr: dict) -> dict:
    """One GitHub pull request payload, recorded. Shared by sync and webhook so
    the two cannot disagree about what a PR means."""
    branch = ((pr.get("head") or {}).get("ref")) or ""
    return record(
        conn, actor, kind="pr", repo_name=repo_name, ref=str(pr.get("number")),
        title=pr.get("title") or "", url=pr.get("html_url") or "",
        state=_pr_state(pr), author=((pr.get("user") or {}).get("login")) or "",
        branch=branch, opened_at=pr.get("created_at"), merged_at=pr.get("merged_at"),
        found={
            "title": keys_in(pr.get("title") or ""),
            "branch": keys_in(branch),
            "body": keys_in(pr.get("body") or ""),
        })


def record_branch(conn: Connection, actor: Actor, repo_name: str, name: str,
                  compared: dict | None = None, *, announce: bool = False) -> dict:
    """A branch, and how far it has run past the default branch.

    The comparison is the useful part. "Exists" is not news — every branch
    exists. "Four commits ahead, none behind" says the work is live and will
    merge cleanly, and "eleven behind" says it will not.
    """
    compared = compared or {}
    commits = compared.get("commits") or []
    tip = commits[-1] if commits else {}
    ahead, behind = compared.get("ahead") or 0, compared.get("behind") or 0

    if compared:
        parts = [f"{ahead} ahead"] + ([f"{behind} behind"] if behind else [])
        title = ", ".join(parts)
    else:
        title = ""

    return record(
        conn, actor, kind="branch", repo_name=repo_name, ref=name,
        title=title, url=f"https://github.com/{repo_name}/tree/{name}",
        # GitHub's own word for it: identical, ahead, behind, diverged.
        state=compared.get("status") or "",
        author=_commit_author(tip), branch=name,
        opened_at=_commit_date(tip),
        found={"branch": keys_in(name)}, announce=announce)


def record_commit(conn: Connection, actor: Actor, repo_name: str, commit: dict,
                  branch: str = "", *, announce: bool = False) -> dict:
    """One commit.

    Linked through its branch as well as its message, because a commit on
    `fix/CD-19-…` belongs to CD-19 whether or not whoever wrote it remembered
    to say so in the message. That is most of them.
    """
    body = commit.get("commit") or {}
    message = body.get("message") or ""
    first, _, rest = message.partition("\n")
    return record(
        conn, actor, kind="commit", repo_name=repo_name,
        ref=commit.get("sha") or "", title=first.strip(),
        url=commit.get("html_url") or "",
        author=_commit_author(commit), branch=branch,
        opened_at=_commit_date(commit),
        found={"title": keys_in(first), "body": keys_in(rest),
               "branch": keys_in(branch)}, announce=announce)


# GitHub says "success"; a person reading a column says "passed". The words on
# the left are the API's, the ones on the right are the product's.
RUN_STATE = {
    "success": "success", "failure": "failure", "timed_out": "failure",
    "startup_failure": "failure", "cancelled": "cancelled",
    "action_required": "failure", "neutral": "skipped", "skipped": "skipped",
    "stale": "skipped",
}
RUN_CHECKS = {"success": "passing", "failure": "failing", "cancelled": "none",
              "skipped": "none", "running": "pending"}


def record_run(conn: Connection, actor: Actor, repo_name: str, run: dict,
               *, announce: bool = False) -> dict:
    """One GitHub Actions run.

    Identified by the run id and not the run number: two workflows in the same
    repository both have a run #7, and keying on the number would have them
    overwrite each other for the rest of time.
    """
    done = run.get("status") == "completed"
    state = RUN_STATE.get(run.get("conclusion") or "", "") if done else "running"
    branch = run.get("head_branch") or ""
    number = run.get("run_number")
    name = run.get("name") or run.get("display_title") or "workflow"

    return record(
        conn, actor, kind="build", repo_name=repo_name, ref=str(run.get("id") or ""),
        # The number lives in the title because the ref column is spoken for by
        # the id, and "CI #128" is what somebody is looking for.
        title=f"{name} #{number}" if number else name,
        url=run.get("html_url") or "", state=state,
        checks=RUN_CHECKS.get(state, "none"),
        author=((run.get("actor") or {}).get("login")) or "",
        branch=branch, opened_at=run.get("created_at"),
        merged_at=run.get("updated_at") if done else None,
        found={"branch": keys_in(branch),
               "title": keys_in(run.get("display_title") or "")},
        announce=announce)


# A check run says less than a workflow run, and says it in different words.
CHECK_STATE = {
    "success": "success", "failure": "failure", "timed_out": "failure",
    "action_required": "failure", "startup_failure": "failure",
    "cancelled": "cancelled", "neutral": "skipped", "skipped": "skipped",
    "stale": "skipped",
}


def record_check(conn: Connection, actor: Actor, repo_name: str, check: dict,
                 branch: str = "", *, announce: bool = False) -> dict:
    """One check run — a build, read the way an app without the `actions`
    permission has to read it."""
    done = check.get("status") == "completed"
    state = CHECK_STATE.get(check.get("conclusion") or "", "") if done else "running"
    producer = ((check.get("app") or {}).get("name")) or ""
    return record(
        conn, actor, kind="build", repo_name=repo_name,
        ref=str(check.get("id") or ""), title=check.get("name") or "check",
        url=check.get("html_url") or check.get("details_url") or "",
        state=state, checks=RUN_CHECKS.get(state, "none"),
        author=producer, branch=branch,
        opened_at=check.get("started_at"),
        merged_at=check.get("completed_at") if done else None,
        found={"branch": keys_in(branch)}, announce=announce)


def _commit_author(commit: dict) -> str:
    """The GitHub login if the commit is attributed to an account, the name in
    the commit itself otherwise. Plenty of commits are the latter."""
    account = commit.get("author") or {}
    if account.get("login"):
        return account["login"]
    return ((commit.get("commit") or {}).get("author") or {}).get("name") or ""


def _commit_date(commit: dict) -> Any:
    return ((commit.get("commit") or {}).get("author") or {}).get("date")


def _pr_state(pr: dict) -> str:
    if pr.get("merged_at"):
        return "merged"
    if pr.get("state") == "closed":
        return "closed"
    return "draft" if pr.get("draft") else "open"


# Per repository, per sync. Reading a pull request's commits or comparing a
# branch costs one call each, so both are bounded — and when a bound bites, the
# result says so rather than quietly returning a subset that looks complete.
COMMIT_BUDGET = 40
BRANCH_BUDGET = 40


def _count(n: int, one: str, many: str = "") -> str:
    """"1 branch", "2 branches". A summary that says "1 branches" is a summary
    somebody stops reading."""
    return f"{n} {one if n == 1 else (many or one + 's')}"


async def _sync_via_app(engine, installs: list[dict], only: str | None,
                        pages: int) -> dict:
    """The good path: read as the app, over every repository it can see.

    No list to maintain — "all repositories" on the installation means a repo
    created next month is covered without anybody remembering.

    Four passes per repository, in the order that makes each one cheaper than
    it looks: pull requests, then the commits of the pull requests that
    actually named an issue, then the branches whose names name a live issue,
    then the Actions runs. Everything after the first pass is filtered by what
    the first pass proved is relevant, which is what keeps a repository with
    four hundred branches from costing four hundred calls.
    """
    tally = {"pull_requests": 0, "branches": 0, "commits": 0, "builds": 0, "links": 0}
    failed: dict[str, str] = {}
    capped: dict[str, str] = {}
    notes: dict[str, str] = {}
    repos_done: list[str] = []

    for install in installs:
        iid = install["installation_id"]
        try:
            found_repos = await github_app.repositories(iid)
        except github_app.AppError as exc:
            failed[install["account_login"]] = str(exc)
            continue
        if only:
            found_repos = [r for r in found_repos if r["name"] == only]

        for entry in found_repos:
            name, base = entry["name"], entry["default_branch"]
            try:
                await _sync_repo(engine, iid, name, base, pages, tally, capped, notes)
            except github_app.AppError as exc:
                # Whatever the earlier passes committed is kept. Saying the repo
                # failed while silently keeping half its data is how somebody
                # ends up not trusting either number.
                failed[name] = str(exc)
            repos_done.append(name)

        with engine.begin() as conn:
            github_app.note_sync(conn, iid, ", ".join([
                _count(len(repos_done), "repo"),
                _count(tally["pull_requests"], "pull request"),
                _count(tally["branches"], "branch", "branches"),
                _count(tally["commits"], "commit"),
                _count(tally["builds"], "build"),
                f"{tally['links']} linked",
            ]))

    return {"via": "app", "repos": repos_done, **tally,
            "failed": failed, "capped": capped, "notes": notes}


async def _sync_repo(engine, iid: int, name: str, base: str, pages: int,
                     tally: dict, capped: dict, notes: dict) -> None:
    """One repository, read four ways."""
    system = repo_mod.SYSTEM
    # sha -> the branch it is the tip of. Collected as we go and spent on the
    # builds pass, which can only afford to ask about commits that matter.
    heads: dict[str, str] = {}

    # 1. Pull requests. Everything else narrows down from what these link.
    pulls = await github_app.pulls(iid, name, pages=pages)
    linked_pulls: list[dict] = []
    with engine.begin() as conn:
        for pull in pulls:
            tally["pull_requests"] += 1
            outcome = record_pull(conn, system, name, pull)
            tally["links"] += len(outcome["issues"])
            if outcome["issues"]:
                linked_pulls.append(pull)
                head = pull.get("head") or {}
                if head.get("sha"):
                    heads[head["sha"]] = head.get("ref") or ""

    # 2. The commits inside those pull requests. Asked of the pull request, so
    #    it still answers for work that merged and had its branch deleted.
    if len(linked_pulls) > COMMIT_BUDGET:
        capped[f"{name} commits"] = (
            f"read the commits of {COMMIT_BUDGET} of {len(linked_pulls)} linked "
            f"pull requests this pass")
    for pull in linked_pulls[:COMMIT_BUDGET]:
        commits = await github_app.pull_commits(iid, name, pull["number"])
        head = ((pull.get("head") or {}).get("ref")) or ""
        with engine.begin() as conn:
            for commit in commits:
                tally["commits"] += 1
                record_commit(conn, system, name, commit, head)

    # 3. Branches. Only the ones naming an issue that exists — checked against
    #    the tracker before spending a call, not after.
    everything = await github_app.branches(iid, name, pages=1)
    tips = {b["name"]: ((b.get("commit") or {}).get("sha")) or "" for b in everything}
    named = {b["name"]: keys_in(b["name"]) for b in everything
             if b.get("name") and b["name"] != base and keys_in(b["name"])}
    if named:
        with engine.begin() as conn:
            real = live_keys(conn, set().union(*named.values()))
        wanted = [b for b, keys in named.items() if keys & real]
        if len(wanted) > BRANCH_BUDGET:
            capped[f"{name} branches"] = (
                f"compared {BRANCH_BUDGET} of {len(wanted)} branches this pass")
        for branch_name in wanted[:BRANCH_BUDGET]:
            if tips.get(branch_name):
                heads[tips[branch_name]] = branch_name
            compared = await github_app.ahead_of(iid, name, base, branch_name)
            with engine.begin() as conn:
                tally["branches"] += 1
                record_branch(conn, system, name, branch_name, compared)
                for commit in compared.get("commits") or []:
                    tally["commits"] += 1
                    record_commit(conn, system, name, commit, branch_name)

    # 4. Builds. Two ways to ask, and the better one needs a permission this
    #    app does not insist on, so it falls back rather than going blank.
    try:
        runs = await github_app.runs(iid, name, pages=1)
    except github_app.NotPermitted:
        notes[f"{name} builds"] = (
            "read through the Checks API — grant this app the Actions "
            "permission on GitHub for workflow names and numbers")
        await _builds_via_checks(engine, iid, name, heads, tally)
        return

    with engine.begin() as conn:
        for run in runs:
            tally["builds"] += 1
            record_run(conn, system, name, run)
            # The run is a record; the *pull request's* check state is what an
            # automation listens to, so that goes through the announcing path.
            checks = RUN_CHECKS.get(
                RUN_STATE.get(run.get("conclusion") or "", "")
                if run.get("status") == "completed" else "running", "none")
            if checks == "none":
                continue
            for pull in run.get("pull_requests") or []:
                record(conn, system, kind="pr", repo_name=name,
                       ref=str(pull.get("number")), checks=checks)


async def _builds_via_checks(engine, iid: int, name: str,
                             heads: dict[str, str], tally: dict) -> None:
    """Builds for the commits we already care about, one call each.

    Bounded by `heads` — the tip of every pull request and branch this issue
    tracker has a reason to know about — rather than by the repository, because
    asking per commit is only affordable when the commits are chosen.
    """
    for sha, branch in list(heads.items())[:COMMIT_BUDGET]:
        for check in await github_app.check_runs(iid, name, sha):
            with engine.begin() as conn:
                tally["builds"] += 1
                record_check(conn, repo_mod.SYSTEM, name, check, branch)
