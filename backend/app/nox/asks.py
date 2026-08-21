"""Asks — somebody needs a named person to look at something and come back.

See docs/ASKS.md for why this is not code review and why it is not a comment.
The short version of the second one: there are fifty comments in this database
and not one of them is a thing you can be *waiting on*. A comment has no state,
no owner and no age, so a question asked in one is a question nobody is
accountable for.

Every transition writes an event, the same as every other mutation, which is
what lets the activity feed show it, notifications fire on it, and — later — the
insights page measure who the bottleneck is.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import Connection, and_, func, select

from . import repo as repo_mod
from .repo import Actor
from .schema import asks, issues, users

# The four shapes, and what coming back looks like for each. Not a taxonomy to
# extend lightly: a fifth kind needs a fifth shape of answer.
KINDS: dict[str, dict] = {
    "confirm": {
        "label": "Confirm",
        "asking": "Is this really what it looks like?",
        "wants": "a verdict",
    },
    "explain": {
        "label": "Explain",
        "asking": "I do not understand this — can you explain?",
        "wants": "an answer",
    },
    "discuss": {
        "label": "Discuss",
        "asking": "Can we talk about this?",
        "wants": "a conversation",
    },
    "present": {
        "label": "Present",
        "asking": "This is done — can we show you?",
        "wants": "a slot, then a sign-off",
    },
}

OPEN = "open"
ANSWERED = "answered"
DECLINED = "declined"
WITHDRAWN = "withdrawn"


class AskError(Exception):
    """Something a caller can act on, and a sentence they can read."""


# ------------------------------------------------------------------ asking --

def ask(conn: Connection, actor: Actor, *, issue_id: int, asked_of: int,
        kind: str, question: str, blocking: bool = False) -> dict:
    """Ask somebody something about an issue."""
    if kind not in KINDS:
        raise AskError(f"{kind!r} is not something you can ask. "
                       f"Try one of: {', '.join(KINDS)}.")
    question = (question or "").strip()
    if not question:
        raise AskError("An ask needs a question. Without one it is a nudge, and "
                       "a nudge does not deserve somebody's attention.")
    if actor.id and asked_of == actor.id:
        raise AskError("You cannot ask yourself. Write it down as a comment, or "
                       "ask the person who actually knows.")

    row = conn.execute(
        asks.insert().values(
            issue_id=issue_id, asked_by=actor.id, asked_of=asked_of,
            kind=kind, question=question, blocking=bool(blocking),
        ).returning(asks)
    ).mappings().one()

    _announce(conn, actor, row, "asked")
    return _decorate(conn, row)


def answer(conn: Connection, actor: Actor, ask_id: int, text_value: str) -> dict:
    """Come back to somebody.

    Whoever answers is recorded, not whoever was asked: a colleague picking it
    up is a real thing and pretending otherwise loses the truth.
    """
    row = _open_one(conn, ask_id)
    said = (text_value or "").strip()
    if not said:
        raise AskError("An answer needs saying. Decline it instead if there is "
                       "nothing to say.")
    updated = conn.execute(
        asks.update().where(asks.c.id == ask_id)
        .values(state=ANSWERED, answer=said, answered_by=actor.id,
                answered_at=func.now())
        .returning(asks)
    ).mappings().one()
    _announce(conn, actor, updated, "ask_answered")
    return _decorate(conn, updated)


def decline(conn: Connection, actor: Actor, ask_id: int, why: str = "") -> dict:
    """Say no, or say it is not yours.

    Kept separate from answering because "I am not the right person" and "here
    is your answer" are different outcomes, and a queue that cannot tell them
    apart is a queue people clear by answering badly.
    """
    row = _open_one(conn, ask_id)
    updated = conn.execute(
        asks.update().where(asks.c.id == ask_id)
        .values(state=DECLINED, answer=(why or "").strip(), answered_by=actor.id,
                answered_at=func.now())
        .returning(asks)
    ).mappings().one()
    _announce(conn, actor, updated, "ask_declined")
    return _decorate(conn, updated)


def withdraw(conn: Connection, actor: Actor, ask_id: int) -> dict:
    """Take it back. Only the person who asked may.

    Not a delete: somebody spent attention on it appearing in their queue, and
    an ask that vanishes teaches them to distrust the queue.
    """
    row = _open_one(conn, ask_id)
    if actor.id and row["asked_by"] != actor.id:
        raise AskError("Only the person who asked can withdraw it. Decline it "
                       "if it is not yours to answer.")
    updated = conn.execute(
        asks.update().where(asks.c.id == ask_id)
        .values(state=WITHDRAWN, answered_at=func.now())
        .returning(asks)
    ).mappings().one()
    _announce(conn, actor, updated, "ask_withdrawn")
    return _decorate(conn, updated)


def _open_one(conn: Connection, ask_id: int) -> dict:
    row = conn.execute(select(asks).where(asks.c.id == ask_id)).mappings().first()
    if row is None:
        raise AskError("That ask is gone.")
    if row["state"] != OPEN:
        raise AskError(f"That ask was already {row['state']}.")
    return dict(row)


# ------------------------------------------------------------------- reads --

def _decorate(conn: Connection, row: Any) -> dict:
    """One ask, with the names a screen needs."""
    who = {
        r[0]: {"name": r[1], "avatar": r[2]}
        for r in conn.execute(
            select(users.c.id, users.c.display_name, users.c.avatar)
            .where(users.c.id.in_([row["asked_by"], row["asked_of"],
                                   row["answered_by"] or row["asked_of"]]))
        ).all()
    }
    return {
        "id": row["id"],
        "issue_id": row["issue_id"],
        "kind": row["kind"],
        "kind_label": KINDS.get(row["kind"], {}).get("label", row["kind"]),
        "question": row["question"],
        "state": row["state"],
        "answer": row["answer"],
        "blocking": row["blocking"],
        "asked_at": row["asked_at"],
        "answered_at": row["answered_at"],
        "asked_by": row["asked_by"],
        "asked_by_name": who.get(row["asked_by"], {}).get("name"),
        "asked_by_avatar": who.get(row["asked_by"], {}).get("avatar"),
        "asked_of": row["asked_of"],
        "asked_of_name": who.get(row["asked_of"], {}).get("name"),
        "asked_of_avatar": who.get(row["asked_of"], {}).get("avatar"),
        "answered_by_name": who.get(row["answered_by"], {}).get("name")
        if row["answered_by"] else None,
    }


def for_issue(conn: Connection, issue_id: int) -> list[dict]:
    """Every ask on one issue — open ones first, then what was settled."""
    rows = conn.execute(
        select(asks).where(asks.c.issue_id == issue_id)
        .order_by((asks.c.state != OPEN), asks.c.asked_at.desc())
    ).mappings().all()
    return [_decorate(conn, r) for r in rows]


def waiting_on(conn: Connection, user_id: int) -> list[dict]:
    """What is open on this person, oldest first.

    Oldest first on purpose. Newest-first would bury the thing that has been
    waiting three weeks under the thing that arrived this morning, which is the
    behaviour that made these into comments nobody answered.
    """
    rows = conn.execute(
        select(asks, issues.c.key, issues.c.summary)
        .select_from(asks.join(issues, issues.c.id == asks.c.issue_id))
        .where(asks.c.asked_of == user_id)
        .where(asks.c.state == OPEN)
        .where(issues.c.archived_at.is_(None))
        .order_by(asks.c.asked_at)
    ).mappings().all()
    out = []
    for r in rows:
        item = _decorate(conn, r)
        item["issue_key"] = r["key"]
        item["issue_summary"] = r["summary"]
        out.append(item)
    return out


def asked_by(conn: Connection, user_id: int) -> list[dict]:
    """What this person is waiting on somebody else for."""
    rows = conn.execute(
        select(asks, issues.c.key, issues.c.summary)
        .select_from(asks.join(issues, issues.c.id == asks.c.issue_id))
        .where(asks.c.asked_by == user_id)
        .where(asks.c.state == OPEN)
        .where(issues.c.archived_at.is_(None))
        .order_by(asks.c.asked_at)
    ).mappings().all()
    out = []
    for r in rows:
        item = _decorate(conn, r)
        item["issue_key"] = r["key"]
        item["issue_summary"] = r["summary"]
        out.append(item)
    return out


def blocking_counts(conn: Connection, issue_ids: list[int]) -> dict[int, int]:
    """Open, blocking asks per issue.

    Added to the blocked count a board card already shows. Three different
    things can be in the way — another issue, your own attention, somebody
    else's — and a card that is stuck should look stuck whichever it is.
    """
    if not issue_ids:
        return {}
    rows = conn.execute(
        select(asks.c.issue_id, func.count())
        .where(asks.c.issue_id.in_(issue_ids))
        .where(asks.c.state == OPEN)
        .where(asks.c.blocking.is_(True))
        .group_by(asks.c.issue_id)
    ).all()
    return {r[0]: r[1] for r in rows}


def open_counts(conn: Connection, issue_ids: list[int]) -> dict[int, int]:
    """Open asks per issue, blocking or not."""
    if not issue_ids:
        return {}
    rows = conn.execute(
        select(asks.c.issue_id, func.count())
        .where(asks.c.issue_id.in_(issue_ids))
        .where(asks.c.state == OPEN)
        .group_by(asks.c.issue_id)
    ).all()
    return {r[0]: r[1] for r in rows}


# ------------------------------------------------------------------ events --

def _announce(conn: Connection, actor: Actor, row: Any, kind: str) -> None:
    """Write the event.

    Same shape as every other mutation, so the activity feed renders it, an
    automation could trigger on it, and the notifications that come next have
    something real to fire on.
    """
    batch = repo_mod.new_batch(conn)
    repo_mod.write_event(
        conn, actor,
        entity_type="issue", entity_id=row["issue_id"], batch_id=batch,
        kind=kind,
        payload={
            "ask_id": row["id"], "ask_kind": row["kind"],
            "asked_of": row["asked_of"], "asked_by": row["asked_by"],
            "question": row["question"], "blocking": row["blocking"],
            "answer": row["answer"] or "",
        },
    )
