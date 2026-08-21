"""The tracker's write path — the only way anything changes.

There is one rule in this module, and the whole reporting story rests on it:

    nothing changes without writing an event, in the same transaction.

That is not a convention to remember. Every mutation here goes through
`_apply`, which diffs old against new, writes the row and the events together,
and rolls both back together if anything fails. Routes never write SQL against
these tables directly — if you find yourself wanting to, add a function here.

Why it matters: nearly every report worth having reads history rather than
current state, and Jira's one field without history (Test status) is the reason
a past day's testing queue simply cannot be reconstructed. An event log that is
90% reliable has that hole everywhere, so it has to be structural.

Reads live in query.py. This file is writes.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from sqlalchemy import Connection, select, text, update

from .schema import comments, events, issues, projects

# Fields on an issue that a change is worth recording against. Anything not
# listed is either derived (updated_at) or not a field a person sets.
TRACKED = (
    "summary", "description", "status_id", "assignee_id", "tester_id", "reporter_id",
    "priority", "issue_type_id", "parent_id", "rank", "estimate", "archived_at",
    # Who the work belongs to and how it is ordered. Tracked like everything
    # else, so "when did this become Sparta's" and "who made it high" are
    # answerable rather than remembered.
    "team_id", "plan_priority",
)

# Custom-field changes are recorded as "custom.<key>" so they query exactly the
# same way as a built-in field. The alternative — one event holding a JSON diff
# — makes "when did utility_points last change" unanswerable without scanning.
CUSTOM_PREFIX = "custom."


@dataclass(frozen=True)
class Actor:
    """Who is making a change. Never defaulted: an automation writing as though
    it were a person is how an audit trail stops being worth reading."""

    id: int | None
    kind: str = "human"  # human | automation | integration

    def __post_init__(self) -> None:
        if self.kind not in ("human", "automation", "integration"):
            raise ValueError(f"unknown actor kind: {self.kind}")


SYSTEM = Actor(id=None, kind="integration")


class TrackerError(Exception):
    """A refusal the caller can show a person — not a bug."""


# --------------------------------------------------------------------- events

def new_batch(conn: Connection) -> int:
    """One id shared by every event a single save produces."""
    return int(conn.execute(text("SELECT nextval('event_batch_seq')")).scalar_one())


def _as_text(value: Any) -> str | None:
    """Event values are text so one column holds every field type.

    Comparison and grouping happen on this, so the representation has to be
    stable: `None` stays NULL (distinct from the string "None"), and structured
    values are canonical JSON rather than repr().
    """
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if isinstance(value, (dict, list)):
        return json.dumps(value, sort_keys=True, ensure_ascii=False)
    return str(value)


def write_event(
    conn: Connection,
    actor: Actor,
    *,
    entity_type: str,
    entity_id: int,
    batch_id: int,
    kind: str,
    field: str | None = None,
    from_value: Any = None,
    to_value: Any = None,
    payload: dict | None = None,
    at: Any = None,
) -> None:
    """Record one change.

    `at` exists for backfills — an import, or generated demo data — where the
    event's real time is not now. Everything in the normal write path leaves it
    alone and takes the database default, which is the only way the ordering
    stays trustworthy.
    """
    extra = {"at": at} if at is not None else {}
    conn.execute(events.insert().values(
        entity_type=entity_type,
        entity_id=entity_id,
        batch_id=batch_id,
        actor_id=actor.id,
        actor_kind=actor.kind,
        kind=kind,
        field=field,
        from_value=_as_text(from_value),
        to_value=_as_text(to_value),
        payload=payload or {},
        **extra,
    ))

    # One funnel. Every notification this product sends is decided here, so the
    # four triggers cannot drift apart between the four callers that cause
    # them — and the overwhelming majority of events fall straight through
    # without disturbing anybody, which is the intended shape.
    #
    # Backfills are silent: an import or generated demo data is history, and
    # history should not ring a bell.
    if at is None:
        from . import notify

        notify.consider(
            conn, actor_id=actor.id, actor_kind=actor.kind,
            entity_type=entity_type, entity_id=entity_id, kind=kind,
            field=field, to_value=to_value, payload=payload,
        )


# --------------------------------------------------------------------- issues

def _issue_row(conn: Connection, issue_id: int) -> dict:
    row = conn.execute(select(issues).where(issues.c.id == issue_id)).mappings().first()
    if row is None:
        raise TrackerError(f"issue {issue_id} does not exist")
    return dict(row)


def _next_key(conn: Connection, project_id: int) -> str:
    """Allocate PREFIX-N.

    The counter is bumped and read in one statement, inside the caller's
    transaction, so two people creating at the same moment cannot be handed the
    same number — the row lock does the work.
    """
    row = conn.execute(
        update(projects)
        .where(projects.c.id == project_id)
        .values(issue_seq=projects.c.issue_seq + 1)
        .returning(projects.c.key, projects.c.issue_seq)
    ).first()
    if row is None:
        raise TrackerError(f"project {project_id} does not exist")
    return f"{row.key}-{row.issue_seq}"


def create_issue(conn: Connection, actor: Actor, **fields: Any) -> dict:
    """Create an issue and record its creation.

    One "created" event carrying the whole starting state, rather than an event
    per field — a creation is one act, and replaying it as twelve changes from
    nothing reads as noise in the activity feed.
    """
    project_id = fields["project_id"]
    custom = fields.pop("custom", None) or {}
    values = {k: v for k, v in fields.items() if v is not None}
    values["custom"] = custom
    values["key"] = _next_key(conn, project_id)

    issue_id = conn.execute(
        issues.insert().values(**values).returning(issues.c.id)
    ).scalar_one()

    batch = new_batch(conn)
    write_event(
        conn, actor,
        entity_type="issue", entity_id=issue_id, batch_id=batch,
        kind="created",
        payload={"key": values["key"], **{k: _as_text(v) for k, v in values.items()
                                          if k in TRACKED or k == "custom"}},
    )
    return _issue_row(conn, issue_id)


def update_issue(
    conn: Connection,
    actor: Actor,
    issue_id: int,
    changes: dict[str, Any],
    *,
    custom: dict[str, Any] | None = None,
) -> dict:
    """Apply changes and write one event per field that actually changed.

    "Actually" is the important word. Saving a form resubmits every field, and
    recording an event for each would bury the real change and make
    time-in-status meaningless. Only differences are recorded.
    """
    before = _issue_row(conn, issue_id)

    diffs: list[tuple[str, Any, Any]] = []
    for field, new in changes.items():
        if field not in TRACKED:
            raise TrackerError(f"{field} is not a tracked issue field")
        if before[field] != new:
            diffs.append((field, before[field], new))

    new_custom = dict(before["custom"] or {})
    for key, new in (custom or {}).items():
        old = new_custom.get(key)
        if old != new:
            diffs.append((CUSTOM_PREFIX + key, old, new))
            if new is None:
                new_custom.pop(key, None)
            else:
                new_custom[key] = new

    if not diffs:
        return before  # nothing moved; do not write an empty batch

    values: dict[str, Any] = dict(changes)
    # A caller asking to archive says so with a sentinel rather than inventing
    # a timestamp of its own, so the database clock stays the only clock.
    if values.get("archived_at") == "now":
        values["archived_at"] = text("now()")
    if custom:
        values["custom"] = new_custom
    values["updated_at"] = text("now()")
    # A status entering a done category resolves the issue; leaving one reopens
    # it. Derived here rather than trusted from the caller, so it cannot drift.
    if "status_id" in changes:
        values["resolved_at"] = _resolved_at(conn, changes["status_id"])

    conn.execute(issues.update().where(issues.c.id == issue_id).values(**values))

    batch = new_batch(conn)
    for field, old, new in diffs:
        write_event(
            conn, actor,
            entity_type="issue", entity_id=issue_id, batch_id=batch,
            kind="field_changed", field=field, from_value=old, to_value=new,
        )
    return _issue_row(conn, issue_id)


def _resolved_at(conn: Connection, status_id: int) -> Any:
    category = conn.execute(
        text("SELECT category FROM statuses WHERE id = :id"), {"id": status_id}
    ).scalar()
    return text("now()") if category == "done" else None


# ------------------------------------------------------------------- comments

def add_comment(conn: Connection, actor: Actor, issue_id: int, body: str) -> dict:
    """Comments are their own rows — editable, deletable, separately permitted —
    but they still emit an event, so the activity feed stays one query over
    `events` rather than a union that has to be kept in step."""
    body = (body or "").strip()
    if not body:
        raise TrackerError("a comment needs some text")
    _issue_row(conn, issue_id)  # 404 rather than a foreign-key error

    comment_id = conn.execute(comments.insert().values(
        issue_id=issue_id, author_id=actor.id, body=body
    ).returning(comments.c.id)).scalar_one()

    write_event(
        conn, actor,
        entity_type="issue", entity_id=issue_id, batch_id=new_batch(conn),
        kind="commented", payload={"comment_id": comment_id},
    )
    return dict(conn.execute(
        select(comments).where(comments.c.id == comment_id)
    ).mappings().one())


# --------------------------------------------------------------------- replay

def state_at(conn: Connection, issue_id: int, when: Any) -> dict:
    """What the issue looked like at a past moment.

    The query Jira cannot answer. Take the row as it is now and unwind every
    event since `when`, newest first — so a standup, a burndown or an audit can
    be reconstructed for any day rather than only for today.
    """
    state = _issue_row(conn, issue_id)
    rows = conn.execute(
        select(events.c.field, events.c.from_value)
        .where(events.c.entity_type == "issue")
        .where(events.c.entity_id == issue_id)
        .where(events.c.kind == "field_changed")
        .where(events.c.at > when)
        .order_by(events.c.at.desc(), events.c.id.desc())
    ).all()
    for field, from_value in rows:
        if field and field.startswith(CUSTOM_PREFIX):
            state["custom"] = dict(state.get("custom") or {})
            state["custom"][field[len(CUSTOM_PREFIX):]] = from_value
        elif field in state:
            state[field] = from_value
    return state
