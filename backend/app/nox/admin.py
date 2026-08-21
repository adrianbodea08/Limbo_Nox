"""Project settings — the workflow, who can see it, and the fields.

Everything here is admin-only and everything here is the kind of change that
looks harmless and is not. Reordering a column moves it for everyone. Removing
a status from a workflow can strand issues sitting in it. Restricting a project
hides work someone was relying on seeing. So each function refuses rather than
guesses, and says what it refused on.

Visibility is the part worth reading twice. `visible_project_ids` is not a
convenience for the UI — it is the enforcement, applied to every read. A
"who can see it" setting that only hides the project in a sidebar is decorative,
and worse than none, because people believe it.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import Connection, delete, func, select, text

from .schema import (
    board_column_statuses, board_columns, field_defs, field_usage, issue_types,
    issues, project_access, project_issue_types, project_workflows, projects,
    statuses, transitions, workflow_statuses, workflows,
)


class SettingsError(Exception):
    """A change that cannot be made, with a reason a person can act on."""


# ------------------------------------------------------------- who sees what --

def visible_project_ids(conn: Connection, user: dict) -> set[int] | None:
    """Projects this person may see. `None` means "all of them".

    None rather than the full set so callers can skip the filter entirely for
    an admin, which is the common case and the one worth not paying for.
    """
    if not user or user.get("role") == "admin":
        return None

    tags = set(user.get("tags") or [])
    uid = str(user.get("id"))

    rows = conn.execute(
        select(projects.c.id, projects.c.visibility,
               project_access.c.kind, project_access.c.value)
        .select_from(projects.outerjoin(
            project_access, project_access.c.project_id == projects.c.id))
        .where(projects.c.archived_at.is_(None))
    ).all()

    allowed: set[int] = set()
    for pid, visibility, kind, value in rows:
        if visibility == "everyone":
            allowed.add(pid)
        elif kind == "tag" and value in tags:
            allowed.add(pid)
        elif kind == "user" and value == uid:
            allowed.add(pid)
    return allowed


def access_list(conn: Connection, project_id: int) -> list[dict]:
    return [dict(r) for r in conn.execute(
        select(project_access).where(project_access.c.project_id == project_id)
        .order_by(project_access.c.kind, project_access.c.value)).mappings()]


def set_access(conn: Connection, project_id: int, visibility: str,
               entries: list[dict], granted_by: int | None) -> None:
    if visibility not in ("everyone", "restricted"):
        raise SettingsError(f"unknown visibility: {visibility}")
    # Restricting a project with nobody on the list would lock everyone out
    # including the person doing it, which is never what was meant.
    if visibility == "restricted" and not entries:
        raise SettingsError(
            "A restricted project needs at least one tag or person who can see it.")

    conn.execute(projects.update().where(projects.c.id == project_id)
                 .values(visibility=visibility))
    conn.execute(delete(project_access).where(project_access.c.project_id == project_id))
    for entry in entries:
        kind, value = entry.get("kind"), str(entry.get("value", "")).strip()
        if kind not in ("user", "tag") or not value:
            raise SettingsError("each entry needs a kind of user or tag, and a value")
        conn.execute(project_access.insert().values(
            project_id=project_id, kind=kind, value=value, granted_by=granted_by))


# ------------------------------------------------------------------ workflow --

def workflow_id(conn: Connection, project_id: int) -> int:
    wf = conn.execute(
        select(project_workflows.c.workflow_id)
        .where(project_workflows.c.project_id == project_id)
        .where(project_workflows.c.issue_type_id.is_(None))
    ).scalar()
    if wf is None:
        raise SettingsError("this project has no workflow yet")
    return int(wf)


def workflow(conn: Connection, project_id: int) -> dict:
    """The board's columns in order, and every move between them."""
    wf = workflow_id(conn, project_id)
    columns = [dict(r) for r in conn.execute(
        select(statuses.c.id, statuses.c.key, statuses.c.name, statuses.c.category,
               statuses.c.colour, workflow_statuses.c.position,
               # How many issues sit here — the number that decides whether a
               # column can be removed, so it travels with the column.
               select(func.count()).select_from(issues)
               .where(issues.c.status_id == statuses.c.id)
               .where(issues.c.project_id == project_id)
               .where(issues.c.archived_at.is_(None))
               .scalar_subquery().label("issue_count"))
        .select_from(workflow_statuses.join(
            statuses, workflow_statuses.c.status_id == statuses.c.id))
        .where(workflow_statuses.c.workflow_id == wf)
        .order_by(workflow_statuses.c.position)).mappings()]

    edges = [dict(r) for r in conn.execute(
        select(transitions.c.id, transitions.c.from_status_id,
               transitions.c.to_status_id, transitions.c.name,
               transitions.c.conditions)
        .where(transitions.c.workflow_id == wf)).mappings()]

    layout = conn.execute(
        select(workflows.c.layout).where(workflows.c.id == wf)).scalar() or {}
    return {"workflow_id": wf, "columns": columns, "transitions": edges,
            "layout": layout, "board": board(conn, project_id)}


def board(conn: Connection, project_id: int) -> dict:
    """The board's columns, and the statuses each one holds.

    Statuses in the workflow but in no column are *hidden*: their issues are
    simply not on the board. That is a real arrangement — a Won't Do nobody
    wants to look at — rather than an error, so it is a bucket of its own
    rather than something to correct.
    """
    rows = conn.execute(
        select(board_columns.c.id, board_columns.c.name, board_columns.c.position,
               board_column_statuses.c.status_id, board_column_statuses.c.position.label("sp"),
               statuses.c.name.label("status_name"), statuses.c.colour,
               statuses.c.category)
        .select_from(board_columns
                     .outerjoin(board_column_statuses,
                                board_column_statuses.c.column_id == board_columns.c.id)
                     .outerjoin(statuses,
                                board_column_statuses.c.status_id == statuses.c.id))
        .where(board_columns.c.project_id == project_id)
        .order_by(board_columns.c.position, board_column_statuses.c.position)
    ).mappings().all()

    counts = dict(conn.execute(
        select(issues.c.status_id, func.count())
        .where(issues.c.project_id == project_id)
        .where(issues.c.archived_at.is_(None))
        .group_by(issues.c.status_id)).all())

    columns: dict[int, dict] = {}
    placed: set[int] = set()
    for row in rows:
        col = columns.setdefault(row["id"], {
            "id": row["id"], "name": row["name"], "position": row["position"],
            "statuses": [], "issue_count": 0,
        })
        if row["status_id"] is None:
            continue
        placed.add(row["status_id"])
        col["statuses"].append({
            "id": row["status_id"], "name": row["status_name"],
            "colour": row["colour"], "category": row["category"],
            "issue_count": counts.get(row["status_id"], 0),
        })
        col["issue_count"] += counts.get(row["status_id"], 0)

    wf = workflow_id(conn, project_id)
    in_workflow = [dict(r) for r in conn.execute(
        select(statuses.c.id, statuses.c.name, statuses.c.colour, statuses.c.category)
        .select_from(workflow_statuses.join(
            statuses, workflow_statuses.c.status_id == statuses.c.id))
        .where(workflow_statuses.c.workflow_id == wf)
        .order_by(workflow_statuses.c.position)).mappings()]

    hidden = [{**s, "issue_count": counts.get(s["id"], 0)}
              for s in in_workflow if s["id"] not in placed]

    return {"columns": sorted(columns.values(), key=lambda c: c["position"]),
            "hidden": hidden}


def set_board(conn: Connection, project_id: int, columns: list[dict]) -> None:
    """Write the whole arrangement at once.

    One write rather than a dozen little ones, because a drag lands columns and
    statuses in a new arrangement together and a half-applied layout is a board
    nobody can read. Anything not listed becomes hidden.
    """
    if not columns:
        raise SettingsError("a board needs at least one column")

    wf = workflow_id(conn, project_id)
    allowed = {r[0] for r in conn.execute(
        select(workflow_statuses.c.status_id)
        .where(workflow_statuses.c.workflow_id == wf)).all()}

    # A layout whose columns hold nothing between them would hide every issue
    # on the board, with nothing on screen to say why. Refused loudly here
    # rather than discovered by somebody wondering where their work went.
    if not any(column.get("status_ids") for column in columns):
        raise SettingsError(
            "at least one column has to hold a status — a board where none do "
            "would show no issues at all")

    seen: set[int] = set()
    for column in columns:
        if not (column.get("name") or "").strip():
            raise SettingsError("every column needs a name")
        for status_id in column.get("status_ids") or []:
            sid = int(status_id)
            if sid not in allowed:
                raise SettingsError(
                    "a column can only hold statuses that are in this project's workflow")
            if sid in seen:
                raise SettingsError(
                    "a status can only be in one column — it would decide "
                    "which one an issue shows up in by accident")
            seen.add(sid)

    conn.execute(delete(board_columns).where(board_columns.c.project_id == project_id))
    for position, column in enumerate(columns):
        column_id = conn.execute(board_columns.insert().values(
            project_id=project_id, name=column["name"].strip(), position=position,
        ).returning(board_columns.c.id)).scalar_one()
        for order, status_id in enumerate(column.get("status_ids") or []):
            conn.execute(board_column_statuses.insert().values(
                column_id=column_id, status_id=int(status_id), position=order))


def set_layout(conn: Connection, project_id: int, layout: dict) -> None:
    """Remember where the diagram's boxes were dragged to.

    Stored on the workflow rather than per person: a diagram everyone lays out
    differently is a diagram nobody can point at during a conversation.
    """
    wf = workflow_id(conn, project_id)
    clean = {}
    for key, pos in (layout or {}).items():
        try:
            clean[str(int(key))] = {"x": round(float(pos["x"]), 1),
                                    "y": round(float(pos["y"]), 1)}
        except (KeyError, TypeError, ValueError):
            continue
    conn.execute(workflows.update().where(workflows.c.id == wf).values(layout=clean))


def rename_transition(conn: Connection, transition_id: int, name: str) -> None:
    """What the arrow says on the diagram.

    Worth having: "Begin Work" and "Deploy to Staging" tell a reader what the
    move means in a way "→ In Progress" never will.
    """
    name = (name or "").strip()
    if not name:
        raise SettingsError("a transition needs a name")
    conn.execute(transitions.update().where(transitions.c.id == transition_id)
                 .values(name=name[:80]))


def update_status(conn: Connection, status_id: int, changes: dict[str, Any]) -> None:
    """Rename or recolour a status.

    Statuses are **global**, so this changes it on every board that uses it —
    which is the point of them being global, and also why the UI says so before
    anyone presses it. Category is here too because getting it wrong is what
    made Jira's "is this finished" unanswerable; it is worth being able to fix.
    """
    allowed = {"name", "colour", "category"}
    unknown = set(changes) - allowed
    if unknown:
        raise SettingsError(f"{sorted(unknown)[0]} cannot be changed on a status")
    if changes.get("category") not in (None, "todo", "in_progress", "done"):
        raise SettingsError("a category is todo, in_progress or done")
    if "name" in changes and not (changes["name"] or "").strip():
        raise SettingsError("a status needs a name")
    if changes:
        conn.execute(statuses.update().where(statuses.c.id == status_id).values(**changes))


def create_status(conn: Connection, *, name: str, category: str, colour: str) -> dict:
    """Add a status to the global list."""
    name = (name or "").strip()
    if not name:
        raise SettingsError("a status needs a name")
    if category not in ("todo", "in_progress", "done"):
        raise SettingsError("a category is todo, in_progress or done")
    key = name.lower().replace(" ", "_").replace("'", "")
    key = "".join(c for c in key if c.isalnum() or c == "_")
    clash = conn.execute(select(statuses.c.id).where(statuses.c.key == key)).scalar()
    if clash is not None:
        raise SettingsError(f"a status keyed {key} already exists — statuses are global")
    new_id = conn.execute(statuses.insert().values(
        key=key, name=name, category=category, colour=colour or "#8b949e",
    ).returning(statuses.c.id)).scalar_one()
    return dict(conn.execute(
        select(statuses).where(statuses.c.id == new_id)).mappings().one())


def reorder_columns(conn: Connection, project_id: int, status_ids: list[int]) -> None:
    """Set the column order. The list must be the whole board, not a fragment —
    a partial order silently leaves the rest wherever they happened to be."""
    wf = workflow_id(conn, project_id)
    current = {r[0] for r in conn.execute(
        select(workflow_statuses.c.status_id)
        .where(workflow_statuses.c.workflow_id == wf)).all()}
    if set(status_ids) != current:
        raise SettingsError(
            "the new order has to list every column exactly once "
            f"({len(current)} expected, {len(set(status_ids))} given)")
    for position, status_id in enumerate(status_ids):
        conn.execute(workflow_statuses.update()
                     .where(workflow_statuses.c.workflow_id == wf)
                     .where(workflow_statuses.c.status_id == status_id)
                     .values(position=position))


def add_column(conn: Connection, project_id: int, status_id: int) -> None:
    wf = workflow_id(conn, project_id)
    exists = conn.execute(
        select(workflow_statuses.c.status_id)
        .where(workflow_statuses.c.workflow_id == wf)
        .where(workflow_statuses.c.status_id == status_id)).scalar()
    if exists is not None:
        return
    end = conn.execute(
        select(func.coalesce(func.max(workflow_statuses.c.position), -1) + 1)
        .where(workflow_statuses.c.workflow_id == wf)).scalar_one()
    conn.execute(workflow_statuses.insert().values(
        workflow_id=wf, status_id=status_id, position=end))


def remove_column(conn: Connection, project_id: int, status_id: int) -> None:
    """Take a column off the board, if nothing is sitting in it.

    Refused rather than cascaded: issues in a status that is no longer in the
    workflow are invisible on the board and cannot be moved, which is a worse
    outcome than the change not happening.
    """
    wf = workflow_id(conn, project_id)
    stuck = conn.execute(
        select(func.count()).select_from(issues)
        .where(issues.c.project_id == project_id)
        .where(issues.c.status_id == status_id)
        .where(issues.c.archived_at.is_(None))).scalar_one()
    if stuck:
        name = conn.execute(select(statuses.c.name)
                            .where(statuses.c.id == status_id)).scalar()
        raise SettingsError(
            f"{stuck} issue(s) are still in {name}. Move them first — a column "
            "removed from under them would leave them unreachable.")

    conn.execute(delete(workflow_statuses)
                 .where(workflow_statuses.c.workflow_id == wf)
                 .where(workflow_statuses.c.status_id == status_id))
    # Its transitions go too, or the workflow keeps offering moves to a column
    # that is no longer on the board.
    conn.execute(delete(transitions)
                 .where(transitions.c.workflow_id == wf)
                 .where((transitions.c.from_status_id == status_id)
                        | (transitions.c.to_status_id == status_id)))


def set_transition(conn: Connection, project_id: int, from_status_id: int,
                   to_status_id: int, allowed: bool) -> None:
    """Turn one move on or off. The flow editor is a grid of these."""
    if from_status_id == to_status_id:
        return
    wf = workflow_id(conn, project_id)
    existing = conn.execute(
        select(transitions.c.id)
        .where(transitions.c.workflow_id == wf)
        .where(transitions.c.from_status_id == from_status_id)
        .where(transitions.c.to_status_id == to_status_id)).scalar()

    if not allowed:
        if existing is not None:
            conn.execute(delete(transitions).where(transitions.c.id == existing))
        return
    if existing is not None:
        return

    order = {r[0]: r[1] for r in conn.execute(
        select(workflow_statuses.c.status_id, workflow_statuses.c.position)
        .where(workflow_statuses.c.workflow_id == wf)).all()}
    to_name = conn.execute(select(statuses.c.name)
                           .where(statuses.c.id == to_status_id)).scalar()
    back = order.get(to_status_id, 0) < order.get(from_status_id, 0)
    conn.execute(transitions.insert().values(
        workflow_id=wf, from_status_id=from_status_id, to_status_id=to_status_id,
        name=f"{'←' if back else '→'} {to_name}",
        position=order.get(to_status_id, 0)))


# ------------------------------------------------------- types and their fields --

def types_and_fields(conn: Connection, project_id: int) -> list[dict]:
    """The issue types this project offers, each with the fields it asks for."""
    rows = conn.execute(
        select(issue_types.c.id, issue_types.c.key, issue_types.c.name,
               issue_types.c.icon, issue_types.c.colour,
               project_issue_types.c.position)
        .select_from(project_issue_types.join(
            issue_types, project_issue_types.c.issue_type_id == issue_types.c.id))
        .where(project_issue_types.c.project_id == project_id)
        .order_by(project_issue_types.c.position)).mappings()

    out = []
    for row in rows:
        item = dict(row)
        item["fields"] = [dict(f) for f in conn.execute(
            select(field_defs.c.id, field_defs.c.key, field_defs.c.name,
                   field_defs.c.kind, field_usage.c.required, field_usage.c.position)
            .select_from(field_usage.join(
                field_defs, field_usage.c.field_id == field_defs.c.id))
            .where(field_usage.c.project_id == project_id)
            .where(field_usage.c.issue_type_id == row["id"])
            .order_by(field_usage.c.position)).mappings()]
        out.append(item)
    return out


def update_type(conn: Connection, issue_type_id: int, changes: dict) -> None:
    """A type's name, mark or colour.

    Global, like statuses and fields: an issue type is how reports tell planned
    work from bug work, and a type that means something different per project
    would make every cross-project number a guess. The UI says so before this
    is called.

    The mark is a name — `lucide:Bug` — and this does not check it resolves.
    A name the client cannot draw falls back to rendering as text, which is the
    same forgiving behaviour that lets a pre-existing character keep working.
    """
    values: dict[str, Any] = {}
    if "name" in changes:
        name = str(changes["name"]).strip()
        if not name:
            raise SettingsError("A type needs a name.")
        values["name"] = name
    if "icon" in changes:
        values["icon"] = str(changes["icon"] or "")
    if "colour" in changes:
        colour = str(changes["colour"] or "").strip()
        if not colour.startswith("#"):
            raise SettingsError(f"{colour!r} is not a colour.")
        values["colour"] = colour
    if not values:
        return
    conn.execute(issue_types.update()
                 .where(issue_types.c.id == issue_type_id)
                 .values(**values))


def set_types(conn: Connection, project_id: int, type_ids: list[int]) -> None:
    """Which types this board offers, in order.

    Removing a type it still has issues of is refused: the issues would keep
    their type and the board would have no way to describe them.
    """
    current = {r[0] for r in conn.execute(
        select(project_issue_types.c.issue_type_id)
        .where(project_issue_types.c.project_id == project_id)).all()}
    for removed in current - set(type_ids):
        count = conn.execute(
            select(func.count()).select_from(issues)
            .where(issues.c.project_id == project_id)
            .where(issues.c.issue_type_id == removed)
            .where(issues.c.archived_at.is_(None))).scalar_one()
        if count:
            name = conn.execute(select(issue_types.c.name)
                                .where(issue_types.c.id == removed)).scalar()
            raise SettingsError(
                f"{count} issue(s) on this board are still {name}s. "
                "Change or archive them before removing the type.")

    conn.execute(delete(project_issue_types)
                 .where(project_issue_types.c.project_id == project_id))
    for position, type_id in enumerate(type_ids):
        conn.execute(project_issue_types.insert().values(
            project_id=project_id, issue_type_id=type_id, position=position))


def set_type_fields(conn: Connection, project_id: int, issue_type_id: int,
                    fields: list[dict]) -> None:
    """Which fields this type asks for, in order, and which are required."""
    conn.execute(delete(field_usage)
                 .where(field_usage.c.project_id == project_id)
                 .where(field_usage.c.issue_type_id == issue_type_id))
    for position, field in enumerate(fields):
        conn.execute(field_usage.insert().values(
            field_id=int(field["field_id"]),
            project_id=project_id,
            issue_type_id=issue_type_id,
            required=bool(field.get("required")),
            position=position))


def create_field(conn: Connection, *, key: str, name: str, kind: str,
                 description: str = "", options: list | None = None,
                 reason: str = "", created_by: int | None = None) -> dict:
    """Define a new field.

    Fields are **global**, never per-project — that decision is why the same
    idea cannot end up as four fields with four ids the way it did in Jira. The
    key is lower-case and permanent; the name is what people read and can be
    changed freely.
    """
    key = (key or "").strip().lower().replace(" ", "_")
    if not key or not key.replace("_", "").isalnum():
        raise SettingsError("a field key is letters, numbers and underscores")
    if kind not in ("text", "number", "select", "multiselect", "date", "user", "checkbox"):
        raise SettingsError(f"unknown field kind: {kind}")

    clash = conn.execute(select(field_defs.c.id).where(field_defs.c.key == key)).scalar()
    if clash is not None:
        raise SettingsError(f"a field keyed {key} already exists — fields are global")

    new_id = conn.execute(field_defs.insert().values(
        key=key, name=name.strip() or key, kind=kind, description=description,
        options=options or [], reason=reason, created_by=created_by,
    ).returning(field_defs.c.id)).scalar_one()
    return dict(conn.execute(
        select(field_defs).where(field_defs.c.id == new_id)).mappings().one())


# ----------------------------------------------------------- the field library --

def all_fields(conn: Connection) -> list[dict]:
    """Every field that exists, and the two numbers that say whether it earns
    its keep: where it is asked for, and how many issues actually have a value.

    This is the audit the design doc asks for, made continuous. A tracker's
    field list rots the same way Jira's did — a field is added for one release,
    nobody removes it, and three years later half the create form is fields
    nobody fills in. Fill count is what makes that visible instead of a
    suspicion.
    """
    rows = conn.execute(
        select(field_defs).order_by(field_defs.c.archived_at.isnot(None),
                                    field_defs.c.name)).mappings().all()

    usage = {}
    for r in conn.execute(
        select(field_usage.c.field_id, field_usage.c.required,
               projects.c.key.label("project_key"), projects.c.id.label("project_id"),
               issue_types.c.name.label("type_name"), issue_types.c.id.label("type_id"))
        .select_from(field_usage
                     .join(projects, field_usage.c.project_id == projects.c.id)
                     .join(issue_types, field_usage.c.issue_type_id == issue_types.c.id))
        .order_by(projects.c.position, issue_types.c.hierarchy_level.desc(), issue_types.c.name)
    ).mappings():
        usage.setdefault(r["field_id"], []).append(dict(r))

    out = []
    for row in rows:
        field = dict(row)
        field["usage"] = usage.get(field["id"], [])
        # `?` is the JSONB has-key operator: how many live issues carry this
        # field at all, which is the honest measure of whether it is used.
        field["filled"] = conn.execute(
            text("SELECT count(*) FROM issues "
                 " WHERE archived_at IS NULL AND custom ? :key"),
            {"key": field["key"]}).scalar_one()
        out.append(field)
    return out


def update_field(conn: Connection, field_id: int, changes: dict[str, Any]) -> dict:
    """Rename or re-describe a field. The key never changes.

    The key is what issues store and what filters are written against; letting
    it change would silently orphan every value already saved under the old one.
    The name is what people read, and can be changed as often as anyone likes.
    """
    allowed = {"name", "description", "reason", "options", "kind"}
    unknown = set(changes) - allowed
    if unknown:
        raise SettingsError(f"{sorted(unknown)[0]} cannot be changed on a field")
    row = conn.execute(select(field_defs).where(field_defs.c.id == field_id)).mappings().first()
    if row is None:
        raise SettingsError(f"no field {field_id}")
    if changes:
        conn.execute(field_defs.update().where(field_defs.c.id == field_id).values(**changes))
    return dict(conn.execute(
        select(field_defs).where(field_defs.c.id == field_id)).mappings().one())


def archive_field(conn: Connection, field_id: int, archived: bool = True) -> None:
    """Retire a field, or bring it back.

    Archived rather than deleted, and the values already on issues stay where
    they are: a field can be un-retired, and deleting the definition would turn
    every stored value into an orphan nobody can explain.
    """
    if archived:
        used = conn.execute(
            select(func.count()).select_from(field_usage)
            .where(field_usage.c.field_id == field_id)).scalar_one()
        if used:
            raise SettingsError(
                f"this field is still asked for on {used} issue type(s). "
                "Take it off those first.")
    conn.execute(field_defs.update().where(field_defs.c.id == field_id)
                 .values(archived_at=text("now()") if archived else None))


# --------------------------------------------------------------- the whole lot --

def settings(conn: Connection, project_id: int) -> dict:
    project = conn.execute(
        select(projects).where(projects.c.id == project_id)).mappings().first()
    if project is None:
        raise SettingsError(f"no project {project_id}")
    return {
        "project": dict(project),
        "access": access_list(conn, project_id),
        "workflow": workflow(conn, project_id),
        "types": types_and_fields(conn, project_id),
        # Everything available to add, so the UI never has to guess.
        "allStatuses": [dict(r) for r in conn.execute(
            select(statuses).where(statuses.c.archived_at.is_(None))
            .order_by(statuses.c.category, statuses.c.name)).mappings()],
        "allTypes": [dict(r) for r in conn.execute(
            select(issue_types).where(issue_types.c.archived_at.is_(None))
            .order_by(issue_types.c.hierarchy_level.desc(), issue_types.c.name)).mappings()],
        "allFields": [dict(r) for r in conn.execute(
            select(field_defs).where(field_defs.c.archived_at.is_(None))
            .order_by(field_defs.c.name)).mappings()],
    }
