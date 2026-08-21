"""Saved views — a board arrangement worth keeping.

The `views` table has been in the schema since the first migration, seeded with
a board and a list per project, and returned in `/meta`. Nothing has ever read
or written it: the board builds its filters on the bar and throws them away when
you leave, so the same three dropdowns get set again every morning.

A view is **the whole arrangement**, not only the filter — Columns or Table or
List, the grouping, the sort, and what to show. "My view" means how I like to
look at this, and remembering half of that would leave the board rearranged
under somebody who picked one.

**Yours unless you say otherwise.** A view is private to the person who made it;
a toggle turns one into a team view that everybody gets. That ordering matters:
if sharing were the default, the list would fill with half-finished filters
somebody made once, and a list nobody trusts is a list nobody opens.
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import Connection, delete, or_, select

from . import admin as admin_mod
from .repo import Actor
from .schema import users, views

# What a caller is allowed to set. Anything else in the body is ignored rather
# than rejected: a client sending `id` back with the rest of the row should not
# be an error, and it must certainly not be able to change one.
SETTABLE = {
    "name", "shared", "filter", "group_by", "renderer",
    "columns", "sort", "wip_limits", "position", "project_id",
}

RENDERERS = {"columns", "table", "timeline", "swimlanes"}


class ViewError(Exception):
    """Something a caller can act on, and a sentence they can read."""


def _clean(changes: dict) -> dict:
    values = {k: v for k, v in changes.items() if k in SETTABLE}
    if "name" in values:
        name = str(values["name"] or "").strip()
        if not name:
            raise ViewError("A view needs a name.")
        if len(name) > 60:
            raise ViewError("A view's name is at most 60 characters.")
        values["name"] = name
    if "renderer" in values and values["renderer"] not in RENDERERS:
        raise ViewError(f"{values['renderer']!r} is not a way to show a board.")
    return values


def for_user(conn: Connection, actor: Actor, user: dict,
             project_id: int | None = None) -> list[dict]:
    """Yours first, then the team's.

    Yours first because they are the ones you made on purpose; a shared view is
    somebody else's idea of the board and belongs under your own.
    """
    q = (
        select(views, users.c.display_name.label("owner_name"))
        .select_from(views.outerjoin(users, users.c.id == views.c.owner_id))
        .where(or_(views.c.owner_id == actor.id, views.c.shared.is_(True)))
    )
    # A view pinned to a project is only offered on that project's board. One
    # with no project is cross-project and always offered.
    if project_id is not None:
        q = q.where(or_(views.c.project_id == project_id, views.c.project_id.is_(None)))

    rows = [dict(r) for r in conn.execute(q).mappings()]

    # A shared view on a project somebody cannot see would be a way to learn
    # that the project exists, and its name usually says what it is about.
    allowed = admin_mod.visible_project_ids(conn, user)
    if allowed is not None:
        rows = [r for r in rows if r["project_id"] is None or r["project_id"] in allowed]

    rows.sort(key=lambda r: (r["owner_id"] != actor.id, r["position"], r["id"]))
    for r in rows:
        r["mine"] = r["owner_id"] == actor.id
    return rows


def create(conn: Connection, actor: Actor, body: dict) -> dict:
    values = _clean(body)
    if not values.get("name"):
        raise ViewError("A view needs a name.")
    # Never from the body. Whoever is asking is the owner, and a client that
    # could name somebody else could put a view in their list.
    values["owner_id"] = actor.id
    return dict(conn.execute(views.insert().values(**values).returning(views)).mappings().one())


def _mine_or_admin(row: Any, actor: Actor, user: dict) -> None:
    if row is None:
        raise ViewError("That view no longer exists.")
    if row["owner_id"] == actor.id:
        return
    # An admin can tidy a shared view — the same people who can change a
    # project's settings. Somebody else's *private* view is nobody's business,
    # admin or not, so it is refused with the same words as one that is gone.
    if user.get("role") == "admin" and row["shared"]:
        return
    raise ViewError("That view no longer exists.")


def update(conn: Connection, actor: Actor, user: dict, view_id: int, changes: dict) -> dict:
    row = conn.execute(select(views).where(views.c.id == view_id)).mappings().first()
    _mine_or_admin(row, actor, user)
    values = _clean(changes)
    if not values:
        return dict(row)
    return dict(conn.execute(
        views.update().where(views.c.id == view_id).values(**values).returning(views)
    ).mappings().one())


def remove(conn: Connection, actor: Actor, user: dict, view_id: int) -> None:
    row = conn.execute(select(views).where(views.c.id == view_id)).mappings().first()
    _mine_or_admin(row, actor, user)
    conn.execute(delete(views).where(views.c.id == view_id))
