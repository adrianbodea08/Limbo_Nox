"""Labels — the axis nothing else covers.

Type says what kind of work it is, status where it has got to, component which
part of the system, parent what it belongs to. None of them can say "flaky",
"needs-design" or "good-first-issue" — those are words a team invents for
itself, which is exactly why this is a free-form list rather than another
configured taxonomy.

Global, like statuses and fields and for the same reason: a label meaning
something different per project makes every cross-project filter a guess.

**Made by using them.** There is no "create a label" screen. You type a word on
an issue and it exists; if somebody typed it before, you get theirs. The
alternative — an admin curating the list before anybody may tag anything — is
how a tag system ends up with eleven labels nobody uses and the actual words
living in the summary.
"""

from __future__ import annotations

import re

from sqlalchemy import Connection, delete, func, select

from . import repo as repo_mod
from .repo import Actor
from .schema import issue_labels, issues, labels

# What a label is allowed to be. Deliberately narrow: letters, digits and
# hyphens. A label with a space in it is two labels somebody will type
# differently next time.
SHAPE = re.compile(r"[^a-z0-9]+")
MAX = 40


class LabelError(Exception):
    """Something a caller can act on, and a sentence they can read."""


def normalise(name: str) -> str:
    """`Needs Design`, `needs design` and `needs-design` are one label.

    Folding on the way in rather than comparing loosely on the way out, so the
    uniqueness constraint does the work and there is exactly one row however it
    was typed.
    """
    key = SHAPE.sub("-", (name or "").strip().lower()).strip("-")
    if not key:
        raise LabelError("A label needs a word. Letters, digits and hyphens.")
    if len(key) > MAX:
        raise LabelError(f"A label is at most {MAX} characters — {key[:MAX]}… is longer.")
    return key


# A spread that reads as distinct at chip size, in the order they get handed
# out. Not the status palette: a label is not a state and should not borrow the
# colours that mean one.
PALETTE = [
    "#5b8cff", "#3fb950", "#d29922", "#f85149", "#a371f7",
    "#2dd4bf", "#f0883e", "#db61a2", "#8b949e",
]


def ensure(conn: Connection, name: str) -> dict:
    """The label for this word, making it if nobody has used it yet."""
    key = normalise(name)
    row = conn.execute(select(labels).where(labels.c.key == key)).mappings().first()
    if row is not None:
        if row["archived_at"] is not None:
            # Somebody is using it again, which is the only vote that counts.
            conn.execute(labels.update().where(labels.c.id == row["id"])
                         .values(archived_at=None))
            row = conn.execute(
                select(labels).where(labels.c.id == row["id"])).mappings().one()
        return dict(row)

    # Colour by position, so the first nine are all different without anybody
    # choosing. Changeable afterwards; the point is that nobody is asked to pick
    # one before they may tag anything.
    taken = conn.execute(select(func.count()).select_from(labels)).scalar_one()
    return dict(conn.execute(
        labels.insert()
        .values(key=key, name=(name or "").strip() or key,
                colour=PALETTE[taken % len(PALETTE)])
        .returning(labels)
    ).mappings().one())


def all_labels(conn: Connection, *, include_archived: bool = False) -> list[dict]:
    """Every label, with how many issues wear it — which is the only ranking
    that means anything for a list people type into."""
    used = dict(conn.execute(
        select(issue_labels.c.label_id, func.count())
        .select_from(issue_labels.join(issues, issues.c.id == issue_labels.c.issue_id))
        .where(issues.c.archived_at.is_(None))
        .group_by(issue_labels.c.label_id)).all())

    q = select(labels)
    if not include_archived:
        q = q.where(labels.c.archived_at.is_(None))
    rows = conn.execute(q).mappings().all()
    out = [{**dict(r), "count": used.get(r["id"], 0)} for r in rows]
    out.sort(key=lambda r: (-r["count"], r["key"]))
    return out


def for_issues(conn: Connection, issue_ids: list[int]) -> dict[int, list[dict]]:
    if not issue_ids:
        return {}
    rows = conn.execute(
        select(issue_labels.c.issue_id, labels)
        .select_from(issue_labels.join(labels, labels.c.id == issue_labels.c.label_id))
        .where(issue_labels.c.issue_id.in_(issue_ids))
        .order_by(labels.c.key)
    ).mappings().all()
    out: dict[int, list[dict]] = {}
    for r in rows:
        out.setdefault(r["issue_id"], []).append(
            {"id": r["id"], "key": r["key"], "name": r["name"], "colour": r["colour"]})
    return out


def add(conn: Connection, actor: Actor, issue_id: int, name: str) -> list[dict]:
    """Put a label on an issue, making it if it is new."""
    label = ensure(conn, name)
    already = conn.execute(
        select(issue_labels.c.label_id)
        .where(issue_labels.c.issue_id == issue_id)
        .where(issue_labels.c.label_id == label["id"])).first()
    if already:
        return for_issues(conn, [issue_id]).get(issue_id, [])

    conn.execute(issue_labels.insert().values(
        issue_id=issue_id, label_id=label["id"]))
    _announce(conn, actor, issue_id, "labelled", label)
    return for_issues(conn, [issue_id]).get(issue_id, [])


def remove(conn: Connection, actor: Actor, issue_id: int, label_id: int) -> list[dict]:
    label = conn.execute(
        select(labels).where(labels.c.id == label_id)).mappings().first()
    conn.execute(delete(issue_labels)
                 .where(issue_labels.c.issue_id == issue_id)
                 .where(issue_labels.c.label_id == label_id))
    if label is not None:
        _announce(conn, actor, issue_id, "unlabelled", dict(label))
    return for_issues(conn, [issue_id]).get(issue_id, [])


def update(conn: Connection, label_id: int, changes: dict) -> dict:
    """Rename or recolour. Global, like the statuses and types it sits beside.

    The `key` never changes — it is what "the same label" means, and letting it
    move would silently split every issue already wearing it.
    """
    values: dict = {}
    if "name" in changes:
        name = str(changes["name"]).strip()
        if not name:
            raise LabelError("A label needs a name.")
        values["name"] = name
    if "colour" in changes:
        colour = str(changes["colour"] or "").strip()
        if not colour.startswith("#"):
            raise LabelError(f"{colour!r} is not a colour.")
        values["colour"] = colour
    if "description" in changes:
        values["description"] = str(changes["description"] or "")
    if "archived" in changes:
        values["archived_at"] = func.now() if changes["archived"] else None
    if not values:
        return dict(conn.execute(
            select(labels).where(labels.c.id == label_id)).mappings().one())
    return dict(conn.execute(
        labels.update().where(labels.c.id == label_id).values(**values)
        .returning(labels)).mappings().one())


def _announce(conn: Connection, actor: Actor, issue_id: int, kind: str,
              label: dict) -> None:
    """In the activity feed, like every other change.

    Not a notification: somebody tagging an issue is not somebody waiting on
    you, and the trigger list stays four long.
    """
    repo_mod.write_event(
        conn, actor,
        entity_type="issue", entity_id=issue_id, batch_id=repo_mod.new_batch(conn),
        kind=kind,
        payload={"label_id": label["id"], "label": label["name"],
                 "colour": label["colour"]},
    )
