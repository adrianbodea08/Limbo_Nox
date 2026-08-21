"""Who works on what, and in which order.

Three people each own exactly one lever, which is the whole reason this can be
kept up to date rather than rotting into decoration:

    PO          which team a piece of work belongs to, and the order that team
                should pick things up in          -> plan_priority, team_id
    Team lead   who does it, and what each developer's next thing is
                                                  -> assignee_id, priority
    Developer   the order inside one of their own priority bands
                                                  -> rank

So the sort is coarse-then-fine: `(priority band, rank within the band)`. A
developer can sequence their three `high` items however suits them and cannot
move one above a `highest`. Enough freedom to plan a day, not enough to argue
with the lead.

`urgent` sits above the five ordinary priorities and does not mean "very
important" — it means stop. Marking something urgent *is* the interrupt; there
is no second escalation concept, so nobody has to reconcile two signals.

Pauses are the other half of that. When an urgent arrives a developer is asked
which of their running tasks actually stop, and each stop is recorded with what
took over. The sum of those is what interruptions cost, which is a number the
old setup could not produce — and it stays honest precisely because a person
presses the button rather than the system inferring it.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import Connection, and_, delete, func, or_, select, text
from sqlalchemy import true as sa_true

from . import repo
from .repo import Actor, TrackerError
from .schema import (
    issue_pauses, issue_types, issues, projects, statuses, team_members, teams,
    users,
)

# Highest first. `urgent` is above the five and carries the stop-everything
# meaning; the rest are the ordinary grading.
PRIORITY_ORDER = ["urgent", "highest", "high", "medium", "low", "lowest"]
PRIORITY_RANK = {p: i for i, p in enumerate(PRIORITY_ORDER)}

# Only these may be set to urgent by, and only these may pull free-for-all work.
LEAD_ROLES = ("lead", "po")


class WorkError(Exception):
    """A refusal a person can act on."""


# --------------------------------------------------------------------- teams --

def all_teams(conn: Connection) -> list[dict]:
    rows = conn.execute(
        select(teams, users.c.display_name.label("lead_name"),
               users.c.avatar.label("lead_avatar"))
        .select_from(teams.outerjoin(users, teams.c.lead_id == users.c.id))
        .where(teams.c.archived_at.is_(None))
        .order_by(teams.c.position, teams.c.id)
    ).mappings().all()

    out = []
    for row in rows:
        team = dict(row)
        team["members"] = [dict(m) for m in conn.execute(
            select(team_members.c.user_id, team_members.c.craft,
                   users.c.display_name, users.c.avatar)
            .select_from(team_members.join(users, team_members.c.user_id == users.c.id))
            .where(team_members.c.team_id == team["id"])
            .order_by(team_members.c.craft, users.c.display_name)).mappings()]
        out.append(team)
    return out


def team_of(conn: Connection, user_id: int) -> dict | None:
    """The team this person is on. Each person is on exactly one."""
    row = conn.execute(
        select(teams).select_from(
            team_members.join(teams, team_members.c.team_id == teams.c.id))
        .where(team_members.c.user_id == user_id)
        .where(teams.c.archived_at.is_(None))
    ).mappings().first()
    return dict(row) if row else None


def leads(conn: Connection, user_id: int) -> dict | None:
    """The team this person leads, if any."""
    row = conn.execute(
        select(teams).where(teams.c.lead_id == user_id)
        .where(teams.c.archived_at.is_(None))).mappings().first()
    return dict(row) if row else None


# ------------------------------------------------------------------ ordering --

def _rank(n: int) -> str:
    """Ranks are zero-padded so they sort as text, which is what the column is.

    A whole band is rewritten on every reorder rather than fitting a value
    between neighbours. A band is one developer's items at one priority — a
    handful, not a backlog — so the simple thing is also the cheap thing.
    """
    return f"{n:08d}"


def _reorder_within_band(conn: Connection, band: list[int], issue_ids: list[int],
                         what: str) -> None:
    """Rearrange some members of a band without disturbing the rest.

    Every screen that ranks work ranks it the same way: a band is one priority,
    the order inside it is by hand, and nothing can leave its band by being
    dragged. This is that rule, written once.

    The given order is a *subset* on purpose. A screen shows what it shows —
    one board column, one status band on My work — and it cannot be expected to
    know about the issues it is not displaying, of which finished work older
    than a fortnight is the obvious case. So the listed issues are rearranged
    among the positions they already occupy and everything else stays exactly
    where it was. That is also what makes the rule unbreakable: positions are
    only ever swapped between members of the same band, so no amount of
    dragging can put a medium above a high.
    """
    listed = set(issue_ids)
    if len(listed) != len(issue_ids):
        raise WorkError("that order lists the same issue more than once")
    missing = listed - set(band)
    if missing:
        raise WorkError(
            f"{len(missing)} of those issues are not {what} — a card can only "
            "be moved among the others at its own priority")

    # Walk the band in its current order; wherever a listed issue sits, take
    # the next one from the new order instead.
    fresh = iter(issue_ids)
    merged = [next(fresh) if issue_id in listed else issue_id for issue_id in band]
    for position, issue_id in enumerate(merged):
        conn.execute(issues.update().where(issues.c.id == issue_id)
                     .values(rank=_rank(position)))


def reorder_band(conn: Connection, actor: Actor, *, assignee_id: int,
                 priority: str, issue_ids: list[int]) -> None:
    """Set the order inside one developer's priority band."""
    if priority not in PRIORITY_ORDER:
        raise WorkError(f"unknown priority: {priority}")
    band = [r[0] for r in conn.execute(
        select(issues.c.id)
        .where(issues.c.assignee_id == assignee_id)
        .where(issues.c.priority == priority)
        .where(issues.c.archived_at.is_(None))
        .order_by(issues.c.rank, issues.c.id)).all()]
    _reorder_within_band(conn, band, issue_ids,
                         f"{priority} issues assigned to this person")


def reorder_board_band(conn: Connection, actor: Actor, *, project_id: int,
                       status_ids: list[int], priority: str,
                       issue_ids: list[int]) -> None:
    """Set the order inside one priority band of one board column.

    A board is always in priority order, so the only thing a drag can change is
    where a card sits *among its equals*. The band is (this project, these
    statuses, this one priority); drop a medium among the highs and it is not a
    member, so the whole move is refused rather than half-applied.

    The column is passed as a set of statuses because a board column can hold
    more than one, and what a person reorders is the column they can see.
    """
    if priority not in PRIORITY_ORDER:
        raise WorkError(f"unknown priority: {priority}")
    if not status_ids:
        raise WorkError("a column has to hold at least one status")

    band = [r[0] for r in conn.execute(
        select(issues.c.id)
        .where(issues.c.project_id == project_id)
        .where(issues.c.status_id.in_(status_ids))
        .where(issues.c.priority == priority)
        .where(issues.c.archived_at.is_(None))
        .order_by(issues.c.rank, issues.c.id)).all()]
    _reorder_within_band(conn, band, issue_ids,
                         f"{priority} issues in this column")


def _append_rank(conn: Connection, assignee_id: int | None, priority: str) -> str:
    """Where a newly-arrived issue lands: the end of its band."""
    if assignee_id is None:
        return _rank(0)
    count = conn.execute(
        select(func.count()).select_from(issues)
        .where(issues.c.assignee_id == assignee_id)
        .where(issues.c.priority == priority)
        .where(issues.c.archived_at.is_(None))).scalar_one()
    return _rank(count)


# ------------------------------------------------------------------- urgency --

def set_urgent(conn: Connection, actor: Actor, issue_id: int, *, reason: str,
               urgent: bool = True) -> dict:
    """Mark something urgent, or take it back.

    Urgency carries a name, a time and a reason because urgency without those
    is how everything is urgent by the end of the quarter. Going back to
    ordinary restores `highest` rather than guessing what it used to be — the
    event log has the real answer if anyone needs it.
    """
    if urgent and not (reason or "").strip():
        raise WorkError("say why it is urgent — a reason is what stops everything becoming urgent")

    before = conn.execute(select(issues).where(issues.c.id == issue_id)).mappings().first()
    if before is None:
        raise TrackerError(f"issue {issue_id} does not exist")

    if urgent:
        repo.update_issue(conn, actor, issue_id, {"priority": "urgent"})
        conn.execute(issues.update().where(issues.c.id == issue_id).values(
            urgent_at=text("now()"), urgent_by=actor.id, urgent_reason=reason.strip(),
            rank=_rank(0)))
    else:
        repo.update_issue(conn, actor, issue_id, {"priority": "highest"})
        conn.execute(issues.update().where(issues.c.id == issue_id).values(
            urgent_at=None, urgent_by=None, urgent_reason=""))
    return dict(conn.execute(select(issues).where(issues.c.id == issue_id)).mappings().one())


# -------------------------------------------------------------------- pauses --

def open_pause(conn: Connection, issue_id: int) -> dict | None:
    row = conn.execute(
        select(issue_pauses)
        .where(issue_pauses.c.issue_id == issue_id)
        .where(issue_pauses.c.resumed_at.is_(None))
        .order_by(issue_pauses.c.paused_at.desc())).mappings().first()
    return dict(row) if row else None


def pause(conn: Connection, actor: Actor, issue_id: int, *,
          for_issue_id: int | None = None, reason: str = "") -> dict:
    """Stop work on something, recording what took over."""
    if open_pause(conn, issue_id):
        raise WorkError("that issue is already parked")
    if for_issue_id == issue_id:
        raise WorkError("an issue cannot be parked for itself")

    pause_id = conn.execute(issue_pauses.insert().values(
        issue_id=issue_id, paused_by=actor.id,
        paused_for_issue_id=for_issue_id, reason=reason.strip(),
    ).returning(issue_pauses.c.id)).scalar_one()

    repo.write_event(conn, actor, entity_type="issue", entity_id=issue_id,
                     batch_id=repo.new_batch(conn), kind="paused",
                     payload={"pause_id": pause_id, "for_issue_id": for_issue_id,
                              "reason": reason})
    return dict(conn.execute(
        select(issue_pauses).where(issue_pauses.c.id == pause_id)).mappings().one())


def resume(conn: Connection, actor: Actor, issue_id: int) -> dict | None:
    current = open_pause(conn, issue_id)
    if current is None:
        return None
    conn.execute(issue_pauses.update()
                 .where(issue_pauses.c.id == current["id"])
                 .values(resumed_at=text("now()")))
    row = dict(conn.execute(
        select(issue_pauses).where(issue_pauses.c.id == current["id"])).mappings().one())
    repo.write_event(conn, actor, entity_type="issue", entity_id=issue_id,
                     batch_id=repo.new_batch(conn), kind="resumed",
                     payload={"pause_id": current["id"]})
    return row


def paused_seconds(conn: Connection, issue_id: int) -> float:
    """How long this has spent parked, closed pauses and the open one."""
    return float(conn.execute(text("""
        SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(resumed_at, now()) - paused_at))), 0)
          FROM issue_pauses WHERE issue_id = :id
    """), {"id": issue_id}).scalar_one())


def interruption_cost(conn: Connection, *, team_id: int | None = None,
                      days: int = 30) -> list[dict]:
    """What stopping and starting cost, per person.

    The number the old setup could not produce. Reads only from pauses somebody
    actually pressed, so it is a floor rather than an estimate.
    """
    rows = conn.execute(text("""
        SELECT p.paused_by AS user_id,
               u.display_name,
               count(*) AS stops,
               COALESCE(SUM(EXTRACT(EPOCH FROM
                   (COALESCE(p.resumed_at, now()) - p.paused_at))), 0) AS seconds
          FROM issue_pauses p
          JOIN issues i ON i.id = p.issue_id
          LEFT JOIN users u ON u.id = p.paused_by
         WHERE p.paused_at > now() - make_interval(days => :days)
           AND (CAST(:team AS integer) IS NULL OR i.team_id = CAST(:team AS integer))
      GROUP BY p.paused_by, u.display_name
      ORDER BY seconds DESC
    """), {"days": days, "team": team_id}).mappings().all()
    return [{**dict(r), "hours": round(float(r["seconds"]) / 3600, 1)} for r in rows]


# -------------------------------------------------------------------- queues --

def _queue_select(allowed: set[int] | None = None):
    """Issues with everything a queue card needs, and nothing it does not.

    `allowed` is the set of projects the person *asking* may see — `None` for an
    admin, who may see all of them. It is a parameter rather than something the
    callers remember to apply because both screens here take a `user_id` and
    show somebody else's work: without it, asking for a colleague's queue was a
    way to read a project you had been explicitly kept out of. Every query in
    this file goes through here, so this is the one place it has to be right.
    """
    return (
        select(
            issues.c.id, issues.c.key, issues.c.summary, issues.c.priority,
            issues.c.plan_priority, issues.c.rank, issues.c.team_id,
            issues.c.assignee_id, issues.c.status_id, issues.c.updated_at,
            issues.c.resolved_at,
            issues.c.urgent_at, issues.c.urgent_reason, issues.c.urgent_by,
            statuses.c.key.label("status_key"),
            statuses.c.name.label("status_name"),
            statuses.c.colour.label("status_colour"),
            statuses.c.category.label("status_category"),
            issue_types.c.name.label("type_name"),
            issue_types.c.key.label("type_key"),
            issue_types.c.icon.label("type_icon"),
            issue_types.c.colour.label("type_colour"),
            projects.c.key.label("project_key"),
            users.c.display_name.label("assignee_name"),
            users.c.avatar.label("assignee_avatar"),
            teams.c.name.label("team_name"),
            teams.c.colour.label("team_colour"),
        )
        .select_from(
            issues.join(statuses, issues.c.status_id == statuses.c.id)
            .join(issue_types, issues.c.issue_type_id == issue_types.c.id)
            .join(projects, issues.c.project_id == projects.c.id)
            .outerjoin(users, issues.c.assignee_id == users.c.id)
            .outerjoin(teams, issues.c.team_id == teams.c.id)
        )
        .where(issues.c.project_id.in_(allowed) if allowed is not None
               else sa_true())
        .where(issues.c.archived_at.is_(None))
    )


def _decorate(conn: Connection, rows: list[dict]) -> list[dict]:
    """Attach the pause state, and the sentence that says why a card is here.

    Every card carries its own reason. A ranked list nobody understands is a
    ranked list nobody trusts — the same argument as the automation audit log.
    """
    out = []
    by_id = {r["id"]: dict(r) for r in rows}
    if not by_id:
        return []

    open_pauses = conn.execute(
        select(issue_pauses.c.issue_id, issue_pauses.c.paused_at,
               issue_pauses.c.paused_for_issue_id, issue_pauses.c.reason,
               issues.c.key.label("for_key"))
        .select_from(issue_pauses.outerjoin(
            issues, issue_pauses.c.paused_for_issue_id == issues.c.id))
        .where(issue_pauses.c.issue_id.in_(list(by_id)))
        .where(issue_pauses.c.resumed_at.is_(None))
    ).mappings().all()
    paused = {p["issue_id"]: dict(p) for p in open_pauses}

    # What is standing in front of these. The question a queue cannot answer
    # without links is "what can I actually start", and an issue at the top of
    # somebody's list waiting on work that has not happened is how a ranked list
    # stops being believed.
    from . import links as link_module
    blocked = link_module.blockers(conn, list(by_id))

    urgent_names = {}
    urgent_ids = [r["urgent_by"] for r in by_id.values() if r.get("urgent_by")]
    if urgent_ids:
        urgent_names = {u[0]: u[1] for u in conn.execute(
            select(users.c.id, users.c.display_name)
            .where(users.c.id.in_(urgent_ids))).all()}

    for row in rows:
        item = dict(row)
        item["paused"] = paused.get(item["id"])
        item["blockers"] = blocked.get(item["id"], [])
        item["urgent_by_name"] = urgent_names.get(item.get("urgent_by"))
        if item["priority"] == "urgent":
            who = item["urgent_by_name"] or "someone"
            item["why"] = f"Urgent — {who}: {item['urgent_reason'] or 'no reason given'}"
        elif item["blockers"]:
            first = item["blockers"][0]
            more = f" and {len(item['blockers']) - 1} more" if len(item["blockers"]) > 1 else ""
            item["why"] = f"Blocked by {first['key']}{more}"
        elif item["paused"]:
            for_key = item["paused"].get("for_key")
            item["why"] = f"Paused for {for_key}" if for_key else "Paused"
        elif item["type_key"] in ("live_bug", "hotfix"):
            item["why"] = f"{item['type_name']} — broken in production"
        elif item["status_category"] == "done":
            # "Won't Do" is in the done category and is not an achievement.
            # Reading "Finished in Won't Do" back to somebody is worse than
            # saying nothing.
            item["why"] = ("Dropped" if item["type_key"] and item["status_key"] == "wont_do"
                           else f"Done — {item['status_name']}")
        elif item["status_category"] == "in_progress":
            # "In In Progress" — statuses are named by people, and several of
            # them already start with the preposition.
            name = item["status_name"]
            item["why"] = name if name.lower().startswith(("in ", "on ", "pre-", "under "))                 else f"In {name}"
        else:
            item["why"] = f"{item['priority'].capitalize()} priority"
        out.append(item)
    return out


def _sorted(rows: list[dict]) -> list[dict]:
    return sorted(rows, key=lambda r: (PRIORITY_RANK.get(r["priority"], 9),
                                       r["rank"] or "", r["id"]))


def my_work(conn: Connection, user_id: int,
            allowed: set[int] | None = None) -> dict:
    """One developer's screen.

    Four bands and no filters to set. Developers do not pull work here — only a
    lead can take something out of the free-for-all pool — so there is no
    "available" band to distract from the one question this screen answers.
    """
    rows = [dict(r) for r in conn.execute(
        _queue_select(allowed)
        .where(issues.c.assignee_id == user_id)
        .where(statuses.c.category != "done")).mappings()]
    rows = _sorted(_decorate(conn, rows))

    # What this person finished lately. Not for reporting — for the person, who
    # otherwise ends a week looking at a screen that only ever shows what is
    # left. Recent and capped, because a growing list of everything ever done
    # stops meaning anything by the second month.
    done = _decorate(conn, [dict(r) for r in conn.execute(
        _queue_select(allowed)
        .where(issues.c.assignee_id == user_id)
        .where(statuses.c.category == "done")
        .where(issues.c.resolved_at > text("now() - interval '14 days'"))
        .order_by(issues.c.resolved_at.desc())
        .limit(12)).mappings()])

    urgent = [r for r in rows if r["priority"] == "urgent"]
    rest = [r for r in rows if r["priority"] != "urgent"]
    # Parked things are shown apart from the queue: they are not what to do
    # next, they are what was put down and needs picking back up.
    parked = [r for r in rest if r["paused"]]
    live = [r for r in rest if not r["paused"]]

    person = conn.execute(
        select(users.c.display_name, users.c.avatar)
        .where(users.c.id == user_id)).mappings().first()

    # What other people need from you. My work answered "what am I doing" and
    # "what is next" and nothing about this, which is most of what a day
    # actually contains.
    from . import asks as asks_mod
    return {
        "who": person["display_name"] if person else None,
        "avatar": person["avatar"] if person else None,
        "asks": asks_mod.waiting_on(conn, user_id),
        "asked": asks_mod.asked_by(conn, user_id),
        "done": done,
        "urgent": urgent,
        "inProgress": [r for r in live if r["status_category"] == "in_progress"],
        "next": [r for r in live if r["status_category"] != "in_progress"],
        "paused": parked,
        "team": team_of(conn, user_id),
        "leads": leads(conn, user_id),
    }


def team_queue(conn: Connection, team_id: int | None,
               allowed: set[int] | None = None) -> dict:
    """A team lead's screen.

    The load-bearing one. If keeping this in order takes more than half a
    minute a morning it will not be kept, and a stale order is worse than none
    — people go back to guessing and have stopped trusting the screen too.

    `team_id=None` is the "All" view: every team's work in one table. Same
    shape, same numbers, so the screen renders it without a second code path —
    what changes is only which issues are in scope.
    """
    team = None
    if team_id is not None:
        team = conn.execute(select(teams).where(teams.c.id == team_id)).mappings().first()
        if team is None:
            raise WorkError(f"no team {team_id}")

    scope = (issues.c.team_id == team_id if team_id is not None
             else issues.c.team_id.isnot(None))
    mine = [dict(r) for r in conn.execute(
        _queue_select(allowed).where(scope)
        .where(statuses.c.category != "done")).mappings()]
    mine = _decorate(conn, mine)

    # Free-for-all: planned by the PO for nobody in particular. Only a lead
    # sees this, and taking one stamps the team so the other lead sees it go.
    pool = _decorate(conn, [dict(r) for r in conn.execute(
        _queue_select(allowed).where(issues.c.team_id.is_(None))
        .where(statuses.c.category != "done")).mappings()])
    pool.sort(key=lambda r: (PRIORITY_RANK.get(r["plan_priority"], 9), r["id"]))

    member_q = (
        select(team_members.c.user_id, team_members.c.craft,
               team_members.c.team_id,
               users.c.display_name, users.c.avatar)
        .select_from(team_members.join(users, team_members.c.user_id == users.c.id))
        .order_by(users.c.display_name))
    if team_id is not None:
        member_q = member_q.where(team_members.c.team_id == team_id)
    members = [dict(m) for m in conn.execute(member_q).mappings()]

    by_person = []
    for member in members:
        theirs = _sorted([r for r in mine if r["assignee_id"] == member["user_id"]])
        by_person.append({
            **member,
            "issues": theirs,
            "urgent": len([r for r in theirs if r["priority"] == "urgent"]),
            "inProgress": len([r for r in theirs if r["status_category"] == "in_progress"]),
            "parked": len([r for r in theirs if r["paused"]]),
        })

    # Assigned to the team but not yet to a person — the lead's actual inbox,
    # in the order the PO asked for.
    unassigned = sorted([r for r in mine if r["assignee_id"] is None],
                        key=lambda r: (PRIORITY_RANK.get(r["plan_priority"], 9), r["id"]))

    # The team's work sitting with somebody who is not on the team — DevOps
    # picking up a Rocket ticket, a loan between teams. Grouped separately
    # rather than dropped: work that belongs to this team and appears on nobody's
    # screen is precisely the thing this arrangement exists to prevent.
    member_ids = {m["user_id"] for m in members}
    outside: dict[int, dict] = {}
    for row in mine:
        who = row["assignee_id"]
        if who is None or who in member_ids:
            continue
        bucket = outside.setdefault(who, {
            "user_id": who, "display_name": row["assignee_name"] or "Someone",
            "avatar": row["assignee_avatar"], "craft": "guest", "issues": [],
        })
        bucket["issues"].append(row)
    for bucket in outside.values():
        bucket["issues"] = _sorted(bucket["issues"])
        bucket["urgent"] = len([r for r in bucket["issues"] if r["priority"] == "urgent"])
        bucket["inProgress"] = len([r for r in bucket["issues"]
                                    if r["status_category"] == "in_progress"])
        bucket["parked"] = len([r for r in bucket["issues"] if r["paused"]])

    # The same work as one flat list, which is what the screen actually shows.
    # A backlog is read down a column, not across a set of per-person cards —
    # the cards answered "how is everyone doing" and the question a lead has
    # first thing is "what is not moving".
    flat = _sorted(mine)

    by_priority: dict[str, int] = {}
    for row in mine:
        by_priority[row["priority"]] = by_priority.get(row["priority"], 0) + 1

    # Somebody with nothing open is the signal that gets missed: it is invisible
    # on a board, because absence does not draw a card.
    idle = [{"user_id": m["user_id"], "display_name": m["display_name"],
             "avatar": m["avatar"], "craft": m["craft"]}
            for m in members
            if not any(r["assignee_id"] == m["user_id"] for r in mine)]

    return {
        "team": dict(team) if team is not None else None,
        "issues": flat,
        "people": by_person,
        "members": members,
        "outside": sorted(outside.values(), key=lambda b: b["display_name"]),
        "unassigned": unassigned,
        "pool": pool,
        "urgentCount": len([r for r in mine if r["priority"] == "urgent"]),
        "stats": {
            "total": len(mine),
            "unassigned": len(unassigned),
            "idle": idle,
            "byPriority": by_priority,
            "parked": len([r for r in mine if r["paused"]]),
            "pool": len(pool),
            "outside": sum(len(b["issues"]) for b in outside.values()),
        },
    }


def plan(conn: Connection, *, project_id: int | None = None,
         allowed: set[int] | None = None) -> dict:
    """The PO's screen: everything, and which team is to pick it up."""
    q = _queue_select(allowed).where(statuses.c.category != "done")
    if project_id:
        q = q.where(issues.c.project_id == project_id)
    rows = _decorate(conn, [dict(r) for r in conn.execute(q).mappings()])
    rows.sort(key=lambda r: (PRIORITY_RANK.get(r["plan_priority"], 9), r["id"]))
    return {"issues": rows, "teams": all_teams(conn)}


def assign(conn: Connection, actor: Actor, issue_id: int, *,
           assignee_id: int | None = None, priority: str | None = None,
           team_id: int | None = None, set_team: bool = False) -> dict:
    """The lead's one action: who does it, and where it sits in their queue."""
    changes: dict[str, Any] = {}
    if assignee_id is not None or "assignee_id" in changes:
        changes["assignee_id"] = assignee_id
    if priority is not None:
        if priority not in PRIORITY_ORDER:
            raise WorkError(f"unknown priority: {priority}")
        if priority == "urgent":
            raise WorkError("mark it urgent with a reason rather than setting the priority")
        changes["priority"] = priority
    if set_team:
        changes["team_id"] = team_id

    if changes:
        repo.update_issue(conn, actor, issue_id, changes)
    # A newly assigned issue goes to the end of its band rather than the top,
    # so handing someone work never silently reorders what they were doing.
    row = conn.execute(select(issues).where(issues.c.id == issue_id)).mappings().one()
    if "assignee_id" in changes or "priority" in changes:
        conn.execute(issues.update().where(issues.c.id == issue_id).values(
            rank=_append_rank(conn, row["assignee_id"], row["priority"])))
    return dict(conn.execute(
        select(issues).where(issues.c.id == issue_id)).mappings().one())
