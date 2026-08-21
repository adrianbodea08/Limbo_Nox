"""Telling somebody something may need their attention.

See docs/ASKS.md section 5. Four triggers, and the list is the whole list:

    asked         somebody asked you something
    ask_answered  somebody came back to you
    assigned      an issue became yours
    mentioned     somebody used your name in a comment

A mention counts wherever prose is written — a comment, an ask, an ask's
answer, a description. The trigger is still one trigger; what changed is that
`@Ana` reaches Ana from every box that lets you type it, which is the only way
the completion in `Mentions.tsx` can be an honest promise.

Everything on it is either somebody waiting on you or somebody answering you.
Anything that fails that test needs an argument before it is added — the failure
mode here is not "too few", it is a person who has learned to ignore the badge,
and once they have, the badge is worth nothing for anything.

**Every notification goes through `consider`.** It is called from
`repo.write_event`, so the decision about whether anybody should be told lives
in exactly one place and cannot drift between the four callers that cause them.
An event that matches no trigger falls through and nobody is disturbed, which is
what happens to the overwhelming majority of them.
"""

from __future__ import annotations

import re
from typing import Any

from sqlalchemy import Connection, and_, func, select

from .schema import comments, issues, notification_prefs, notifications, users

# The whole list.
KINDS: dict[str, str] = {
    "asked": "Asked you something",
    "ask_answered": "Came back to you",
    "assigned": "Gave you an issue",
    "mentioned": "Used your name",
}

# `@Ana Mihalache` or `@Ana`. Matched longest-first against display names, so
# the full name wins over the first word of it. Deliberately not a stored handle:
# these are people's actual names in a small workspace, and inventing a second
# identifier for them is a login screen nobody asked for.
MENTION = re.compile(r"@([\w][\w'.-]*(?:\s+[\w][\w'.-]*)?)", re.UNICODE)


def _muted(conn: Connection, user_id: int) -> set[str]:
    row = conn.execute(
        select(notification_prefs.c.muted)
        .where(notification_prefs.c.user_id == user_id)).scalar_one_or_none()
    return {k for k in (row or "").split(",") if k}


def _tell(conn: Connection, *, user_id: int | None, kind: str, issue_id: int,
          actor_id: int | None, text_value: str) -> None:
    """Write one, unless there is a reason not to."""
    if not user_id:
        return
    # Nobody needs telling about their own doing. This is the single most
    # important line in the file: without it every trigger fires on the person
    # who caused it and the badge becomes an echo.
    if actor_id and user_id == actor_id:
        return
    if kind in _muted(conn, user_id):
        return
    conn.execute(notifications.insert().values(
        user_id=user_id, kind=kind, issue_id=issue_id,
        actor_id=actor_id, text=text_value))


def _who(conn: Connection, user_id: int | None) -> str:
    """A name, or an honest word for a machine.

    Automations and integrations have no `actor_id`. Saying "somebody" is
    better than inventing a person, and better than a blank.
    """
    if not user_id:
        return "Something"
    name = conn.execute(
        select(users.c.display_name).where(users.c.id == user_id)).scalar_one_or_none()
    return name or "Somebody"


def _key(conn: Connection, issue_id: int) -> str:
    return conn.execute(
        select(issues.c.key).where(issues.c.id == issue_id)).scalar_one_or_none() or ""


def find_mentions(conn: Connection, body: str) -> list[int]:
    """Which people a piece of text names.

    Longest match first: "@Ana Mihalache" should reach Ana Mihalache rather
    than every Ana. A name that matches nobody is left alone — somebody writing
    an email address is not mentioning anyone.
    """
    if "@" not in (body or ""):
        return []
    everyone = conn.execute(
        select(users.c.id, users.c.display_name).where(users.c.active.is_(True))).all()
    by_name = {(n or "").lower(): i for i, n in everyone}
    first_word = {}
    for i, n in everyone:
        head = (n or "").split(" ")[0].lower()
        # An ambiguous first name reaches nobody rather than the wrong person.
        first_word[head] = None if head in first_word else i

    found: list[int] = []
    for candidate in MENTION.findall(body):
        text_value = candidate.strip().lower()
        hit = by_name.get(text_value)
        if hit is None:
            hit = by_name.get(text_value.split(" ")[0]) or first_word.get(text_value.split(" ")[0])
        if hit and hit not in found:
            found.append(hit)
    return found


def _mention(conn: Connection, actor_id: int | None, issue_id: int, body: str,
             skip: set | None = None) -> None:
    """Tell everybody named in a piece of text.

    `skip` is for people who are already being told about the same act by a
    louder notification — being asked something *and* told you were mentioned
    in it is two rows for one event.
    """
    for user_id in find_mentions(conn, body or ""):
        if skip and user_id in skip:
            continue
        _tell(conn, user_id=user_id, kind="mentioned", issue_id=issue_id,
              actor_id=actor_id,
              text_value=f"{_who(conn, actor_id)} mentioned you on "
                         f"{_key(conn, issue_id)}")


def consider(conn: Connection, *, actor_id: int | None, actor_kind: str,
             entity_type: str, entity_id: int, kind: str,
             field: str | None, from_value: Any = None, to_value: Any = None,
             payload: dict | None = None) -> None:
    """One event. Tell somebody, or do nothing.

    Called from `repo.write_event`. Most events land here and leave without
    doing anything, which is the intended shape.
    """
    if entity_type != "issue":
        return
    payload = payload or {}

    # 1 and 2: an ask, either direction.
    if kind == "asked":
        _tell(conn, user_id=payload.get("asked_of"), kind="asked",
              issue_id=entity_id, actor_id=actor_id,
              text_value=f"{_who(conn, actor_id)} asked you to "
                         f"{payload.get('ask_kind', 'look at')} {_key(conn, entity_id)}")
        # "@Ana, is this the same one you fixed?" — the person the question is
        # *of* has to answer it; a person named inside it is being pulled in,
        # and that is worth exactly as much as being named in a comment.
        _mention(conn, actor_id, entity_id, payload.get("question", ""),
                 skip={payload.get("asked_of")})
        return

    if kind in ("ask_answered", "ask_declined"):
        settled = "answered" if kind == "ask_answered" else "passed on"
        _tell(conn, user_id=payload.get("asked_by"), kind="ask_answered",
              issue_id=entity_id, actor_id=actor_id,
              text_value=f"{_who(conn, actor_id)} {settled} your question "
                         f"on {_key(conn, entity_id)}")
        # "Not mine — @Radu owns that now" is the most useful thing an answer
        # can say, and it is worthless if Radu is never told.
        _mention(conn, actor_id, entity_id, payload.get("answer", ""),
                 skip={payload.get("asked_by")})
        return

    # 3: an issue became yours. Automations assign too, and being handed work by
    # a rule is exactly as worth knowing as being handed it by a person.
    # A description is edited over and over, so only names that were not there
    # before count. Without that, everybody named in it is notified again every
    # time somebody fixes a typo three paragraphs away.
    if kind == "field_changed" and field == "description":
        was = set(find_mentions(conn, str(from_value or "")))
        for user_id in find_mentions(conn, str(to_value or "")):
            if user_id in was:
                continue
            _tell(conn, user_id=user_id, kind="mentioned", issue_id=entity_id,
                  actor_id=actor_id,
                  text_value=f"{_who(conn, actor_id)} mentioned you on "
                             f"{_key(conn, entity_id)}")
        return

    if kind == "field_changed" and field == "assignee_id" and to_value:
        try:
            became = int(to_value)
        except (TypeError, ValueError):
            return
        _tell(conn, user_id=became, kind="assigned", issue_id=entity_id,
              actor_id=actor_id,
              text_value=f"{_who(conn, actor_id)} gave you {_key(conn, entity_id)}")
        return

    # 4: your name in a comment.
    if kind == "commented" and payload.get("comment_id"):
        body = conn.execute(
            select(comments.c.body)
            .where(comments.c.id == payload["comment_id"])).scalar_one_or_none() or ""
        _mention(conn, actor_id, entity_id, body)
        return


# ------------------------------------------------------------------- reads --

def unread_count(conn: Connection, user_id: int) -> int:
    return conn.execute(
        select(func.count()).select_from(notifications)
        .where(notifications.c.user_id == user_id)
        .where(notifications.c.read_at.is_(None))).scalar_one()


def recent(conn: Connection, user_id: int, limit: int = 30) -> list[dict]:
    """Newest first, unread and read together.

    Both, because a list that empties as you read it gives you nowhere to go
    back to — and "what was that thing I dismissed" is a real question.
    """
    rows = conn.execute(
        select(notifications, issues.c.key, issues.c.summary,
               users.c.display_name, users.c.avatar)
        .select_from(
            notifications
            .join(issues, issues.c.id == notifications.c.issue_id)
            .outerjoin(users, users.c.id == notifications.c.actor_id))
        .where(notifications.c.user_id == user_id)
        .order_by(notifications.c.at.desc())
        .limit(limit)
    ).mappings().all()
    return [
        {
            "id": r["id"], "kind": r["kind"], "text": r["text"],
            "at": r["at"], "read": r["read_at"] is not None,
            "issue_id": r["issue_id"], "issue_key": r["key"],
            "issue_summary": r["summary"],
            "actor_name": r["display_name"], "actor_avatar": r["avatar"],
        }
        for r in rows
    ]


def mark_read(conn: Connection, user_id: int, ids: list[int] | None = None) -> None:
    """One, several, or everything unread."""
    where = and_(notifications.c.user_id == user_id,
                 notifications.c.read_at.is_(None))
    if ids:
        where = and_(where, notifications.c.id.in_(ids))
    conn.execute(notifications.update().where(where).values(read_at=func.now()))


def prefs(conn: Connection, user_id: int) -> dict:
    muted = _muted(conn, user_id)
    return {k: {"label": label, "on": k not in muted} for k, label in KINDS.items()}


def set_pref(conn: Connection, user_id: int, kind: str, on: bool) -> dict:
    if kind not in KINDS:
        raise ValueError(f"there is no {kind!r} notification")
    muted = _muted(conn, user_id)
    muted.discard(kind) if on else muted.add(kind)
    value = ",".join(sorted(muted))
    conn.execute(text_upsert(), {"u": user_id, "m": value})
    return prefs(conn, user_id)


def text_upsert():
    from sqlalchemy import text as _t
    return _t("""
        INSERT INTO notification_prefs (user_id, muted) VALUES (:u, :m)
        ON CONFLICT (user_id) DO UPDATE SET muted = EXCLUDED.muted
    """)
