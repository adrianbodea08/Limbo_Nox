"""Who granted what.

The tracker's event log is meticulous about issues — every status change, every
reassignment, every comment, eight hundred rows of it. It was completely silent
about **permissions**. Approving an account, making somebody an admin, letting
a person into a restricted project: none of it was recorded anywhere.

That is the wrong way round. Who moved a ticket on Tuesday is interesting; who
gave themselves admin on Tuesday is the thing you need to be able to answer, and
the only question here that anybody would ever ask under pressure.

**The same table, not a new one.** `events` has carried `entity_type` since the
first migration — the comment on it says releases and projects emit events too —
so an account event is what it was built for. One append-only log means one set
of guarantees rather than two, and the `actor_id` foreign key added on
2026-08-22 means the database now refuses to delete an admin while their actions
are still on record.

`notify.consider` returns early for anything that is not an issue, so none of
this rings anybody's bell.
"""

from __future__ import annotations

import logging

from sqlalchemy import desc, select

from .. import db
from . import repo as repo_mod
from .repo import Actor
from .schema import events, users

log = logging.getLogger("nox.audit")

# `entity_type` for these. Not "admin": the subject is a person or a project,
# and what makes a row auditable is *what changed*, not who happened to do it.
ACCOUNT = "account"
PROJECT = "project"

# Everything worth being able to answer later. A closed list rather than free
# text, so the reader can group and filter without guessing at spellings.
KINDS = {
    "account_status": "changed a status",
    "account_role": "changed a role",
    "account_created": "created an account",
    "account_deleted": "deleted an account",
    "project_access": "changed who can see a project",
    "project_visibility": "changed a project's visibility",
}


def record(actor_id: int | None, kind: str, *, subject_type: str, subject_id: int,
           field: str | None = None, was=None, now=None, **details) -> None:
    """One admin action.

    Never raises. An audit write that could fail a request would teach somebody
    to route around it, and a missing row is a smaller problem than an admin who
    cannot approve an account because the log is unhappy — but it is logged
    loudly, because a silently empty audit trail is worse than no audit trail.
    """
    if kind not in KINDS:
        log.warning("audit: unknown kind %r — recording it anyway", kind)
    engine = db.engine()
    if engine is None:
        log.error("audit: no database, %s by %s went unrecorded", kind, actor_id)
        return
    try:
        with engine.begin() as conn:
            repo_mod.write_event(
                conn, Actor(id=actor_id, kind="human"),
                entity_type=subject_type, entity_id=subject_id,
                batch_id=repo_mod.new_batch(conn),
                kind=kind, field=field,
                from_value=None if was is None else str(was),
                to_value=None if now is None else str(now),
                payload=details or None,
            )
    except Exception:
        log.exception("audit: could not record %s on %s %s",
                      kind, subject_type, subject_id)


def recent(limit: int = 100) -> list[dict]:
    """The log, newest first, with names rather than ids.

    Ids are what the table holds and names are what the question is about —
    "who made Radu an admin" is not answerable from two integers.
    """
    engine = db.engine()
    if engine is None:
        return []
    actor = users.alias("actor")
    subject = users.alias("subject")
    with engine.connect() as conn:
        rows = conn.execute(
            select(
                events.c.id, events.c.at, events.c.kind, events.c.field,
                events.c.from_value, events.c.to_value, events.c.payload,
                events.c.entity_type, events.c.entity_id,
                actor.c.display_name.label("actor_name"),
                subject.c.display_name.label("subject_name"),
            )
            .select_from(
                events
                .outerjoin(actor, actor.c.id == events.c.actor_id)
                # Only meaningful when the subject is a person; a project id
                # will simply find nobody and the name falls back to the
                # payload, which carries it for exactly that reason.
                .outerjoin(subject, subject.c.id == events.c.entity_id))
            .where(events.c.entity_type.in_([ACCOUNT, PROJECT]))
            .order_by(desc(events.c.at), desc(events.c.id))
            .limit(limit)
        ).mappings().all()

    out = []
    for r in rows:
        payload = r["payload"] or {}
        out.append({
            "id": r["id"],
            "at": r["at"],
            "kind": r["kind"],
            "what": KINDS.get(r["kind"], r["kind"]),
            "actor": r["actor_name"] or "Somebody",
            "subject": (r["subject_name"] if r["entity_type"] == ACCOUNT
                        else payload.get("project")) or payload.get("subject") or "",
            "subject_type": r["entity_type"],
            "was": r["from_value"],
            "now": r["to_value"],
            "detail": payload,
        })
    return out
