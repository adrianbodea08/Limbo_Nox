"""Releases — what ships, when, and what is in it.

A release here is one object that spans projects, because a delivery does. In
Jira a fixVersion belongs to a project, which is why one delivery ends up
tagged twelve times and nothing knows the whole of it.

Three things this module takes seriously:

  * **Artifacts ship independently.** Mobile ships when Apple says so. Each
    artifact carries its own `shipped_at`, and the release is shipped when its
    artifacts are — not on a date somebody typed.
  * **The runbook is data.** "What is left before we ship" should be a query,
    not a conversation. Actions are ordered, owned and timestamped.
  * **Releases emit events**, like issues. "Release created" is a real
    automation trigger, and the history of a release is worth as much as the
    history of an issue.

Writes go through here so the event log cannot be bypassed, the same rule that
repo.py holds for issues.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import Connection, delete, exists, func, insert, select, text, update

from .repo import Actor, TrackerError, new_batch, write_event
from .schema import (
    components, issue_types, issues, projects, release_actions,
    release_artifacts, release_issues, releases, statuses, users,
)

# Changes worth recording against a release.
TRACKED = ("name", "kind", "state", "cycle_start", "planned_at", "shipped_at",
           "description", "notes_published", "archived_at")


def _row(conn: Connection, release_id: int) -> dict:
    row = conn.execute(select(releases).where(releases.c.id == release_id)).mappings().first()
    if row is None:
        raise TrackerError(f"release {release_id} does not exist")
    return dict(row)


# ---------------------------------------------------------------- the release --

def create(conn: Connection, actor: Actor, **fields: Any) -> dict:
    values = {k: v for k, v in fields.items() if v is not None}
    if not (values.get("name") or "").strip():
        raise TrackerError("a release needs a name")
    values["name"] = values["name"].strip()
    values["created_by"] = actor.id

    release_id = conn.execute(
        releases.insert().values(**values).returning(releases.c.id)
    ).scalar_one()
    write_event(
        conn, actor,
        entity_type="release", entity_id=release_id, batch_id=new_batch(conn),
        kind="created", payload={k: str(v) for k, v in values.items() if k in TRACKED},
    )
    return _row(conn, release_id)


def update_release(conn: Connection, actor: Actor, release_id: int,
                   changes: dict[str, Any]) -> dict:
    before = _row(conn, release_id)
    diffs = [(f, before[f], v) for f, v in changes.items()
             if f in TRACKED and before[f] != v]
    unknown = [f for f in changes if f not in TRACKED and f != "notes"]
    if unknown:
        raise TrackerError(f"{unknown[0]} is not a release field")

    # Notes are edited constantly before publishing; recording every keystroke
    # batch as history would bury the changes that matter.
    values = dict(changes)
    if not diffs and "notes" not in changes:
        return before
    values["updated_at"] = text("now()")
    conn.execute(releases.update().where(releases.c.id == release_id).values(**values))

    if diffs:
        batch = new_batch(conn)
        for field, old, new in diffs:
            write_event(conn, actor, entity_type="release", entity_id=release_id,
                        batch_id=batch, kind="field_changed", field=field,
                        from_value=old, to_value=new)
    return _row(conn, release_id)


# ------------------------------------------------------------------- contents --

def add_issues(conn: Connection, actor: Actor, release_id: int, issue_ids: list[int]) -> int:
    """Put issues on a release.

    An issue may be on **one release of each kind**. A fix that ships in the
    34.0.1 hotfix and again in the next standard release is a real thing and
    both facts are worth recording; the same fix on two standard releases is
    somebody having lost track, and it makes "which release contains this"
    unanswerable — which is the question the whole model exists to answer.

    Already-present issues are skipped silently, so adding a filter's worth of
    issues twice stays harmless.
    """
    release = _row(conn, release_id)
    existing = {r[0] for r in conn.execute(
        select(release_issues.c.issue_id).where(release_issues.c.release_id == release_id)
    ).all()}
    fresh = [i for i in issue_ids if i not in existing]
    if not fresh:
        return 0

    clashes = conn.execute(
        select(issues.c.key, releases.c.name)
        .select_from(release_issues
                     .join(releases, release_issues.c.release_id == releases.c.id)
                     .join(issues, release_issues.c.issue_id == issues.c.id))
        .where(release_issues.c.issue_id.in_(fresh))
        .where(releases.c.kind == release["kind"])
        .where(releases.c.archived_at.is_(None))
    ).all()
    if clashes:
        first = ", ".join(f"{key} is already on {name}" for key, name in clashes[:3])
        more = f" (and {len(clashes) - 3} more)" if len(clashes) > 3 else ""
        raise TrackerError(
            f"An issue can only be on one {release['kind']} release. {first}{more}.")

    conn.execute(insert(release_issues), [
        {"release_id": release_id, "issue_id": i, "added_by": actor.id} for i in fresh
    ])
    batch = new_batch(conn)
    for issue_id in fresh:
        # Written against both entities: the release's history should show what
        # went in, and the issue's history should show which release took it.
        write_event(conn, actor, entity_type="release", entity_id=release_id,
                    batch_id=batch, kind="issue_added", field="issue_id",
                    to_value=issue_id)
        write_event(conn, actor, entity_type="issue", entity_id=issue_id,
                    batch_id=batch, kind="release_added", field="release_id",
                    to_value=release_id)
    return len(fresh)


def remove_issue(conn: Connection, actor: Actor, release_id: int, issue_id: int) -> None:
    removed = conn.execute(
        delete(release_issues)
        .where(release_issues.c.release_id == release_id)
        .where(release_issues.c.issue_id == issue_id)
    ).rowcount
    if not removed:
        return
    batch = new_batch(conn)
    write_event(conn, actor, entity_type="release", entity_id=release_id,
                batch_id=batch, kind="issue_removed", field="issue_id", from_value=issue_id)
    write_event(conn, actor, entity_type="issue", entity_id=issue_id,
                batch_id=batch, kind="release_removed", field="release_id",
                from_value=release_id)


# ------------------------------------------------------------------ artifacts --

def add_artifact(conn: Connection, actor: Actor, release_id: int, component_id: int,
                 version: str = "", planned_at: Any = None) -> dict:
    _row(conn, release_id)
    clash = conn.execute(
        select(release_artifacts.c.id)
        .where(release_artifacts.c.release_id == release_id)
        .where(release_artifacts.c.component_id == component_id)
    ).scalar()
    if clash is not None:
        raise TrackerError("that component is already on this release")

    artifact_id = conn.execute(release_artifacts.insert().values(
        release_id=release_id, component_id=component_id,
        version=version.strip(), planned_at=planned_at,
    ).returning(release_artifacts.c.id)).scalar_one()
    write_event(conn, actor, entity_type="release", entity_id=release_id,
                batch_id=new_batch(conn), kind="artifact_added",
                payload={"artifact_id": artifact_id, "component_id": component_id,
                         "version": version})
    return dict(conn.execute(
        select(release_artifacts).where(release_artifacts.c.id == artifact_id)
    ).mappings().one())


def ship_artifact(conn: Connection, actor: Actor, artifact_id: int,
                  shipped: bool = True) -> dict:
    """Mark one artifact shipped, and the release with it once they all are.

    The release's own state is derived rather than typed: a release is shipped
    when the things in it have shipped. That is what stops "shipped on the 4th"
    from meaning three different dates depending on who you ask.
    """
    row = conn.execute(
        select(release_artifacts).where(release_artifacts.c.id == artifact_id)
    ).mappings().first()
    if row is None:
        raise TrackerError(f"artifact {artifact_id} does not exist")

    conn.execute(release_artifacts.update().where(release_artifacts.c.id == artifact_id).values(
        state="shipped" if shipped else "pending",
        shipped_at=text("now()") if shipped else None,
    ))
    write_event(conn, actor, entity_type="release", entity_id=row["release_id"],
                batch_id=new_batch(conn),
                kind="artifact_shipped" if shipped else "artifact_unshipped",
                payload={"artifact_id": artifact_id})

    outstanding = conn.execute(
        select(func.count())
        .select_from(release_artifacts)
        .where(release_artifacts.c.release_id == row["release_id"])
        .where(release_artifacts.c.state == "pending")
    ).scalar_one()
    current = _row(conn, row["release_id"])
    if outstanding == 0 and current["state"] != "shipped":
        update_release(conn, actor, row["release_id"], {"state": "shipped"})
        conn.execute(releases.update()
                     .where(releases.c.id == row["release_id"])
                     .values(shipped_at=text("now()")))
    elif outstanding and current["state"] == "shipped":
        # Un-shipping has to clear the date as well as the state. A release
        # that reads "in progress" while still carrying a ship date is worse
        # than either answer on its own.
        update_release(conn, actor, row["release_id"], {"state": "in_progress"})
        conn.execute(releases.update()
                     .where(releases.c.id == row["release_id"])
                     .values(shipped_at=None))

    return dict(conn.execute(
        select(release_artifacts).where(release_artifacts.c.id == artifact_id)
    ).mappings().one())


# -------------------------------------------------------------------- runbook --

def add_action(conn: Connection, actor: Actor, release_id: int, title: str,
               description: str = "", owner_id: int | None = None) -> dict:
    _row(conn, release_id)
    title = (title or "").strip()
    if not title:
        raise TrackerError("an action needs a title")
    position = conn.execute(
        select(func.coalesce(func.max(release_actions.c.position), -1) + 1)
        .where(release_actions.c.release_id == release_id)
    ).scalar_one()
    action_id = conn.execute(release_actions.insert().values(
        release_id=release_id, title=title, description=description,
        owner_id=owner_id, position=position,
    ).returning(release_actions.c.id)).scalar_one()
    write_event(conn, actor, entity_type="release", entity_id=release_id,
                batch_id=new_batch(conn), kind="action_added",
                payload={"action_id": action_id, "title": title})
    return dict(conn.execute(
        select(release_actions).where(release_actions.c.id == action_id)
    ).mappings().one())


def complete_action(conn: Connection, actor: Actor, action_id: int, done: bool = True) -> dict:
    row = conn.execute(
        select(release_actions).where(release_actions.c.id == action_id)
    ).mappings().first()
    if row is None:
        raise TrackerError(f"action {action_id} does not exist")
    conn.execute(release_actions.update().where(release_actions.c.id == action_id).values(
        done_at=text("now()") if done else None,
        done_by=actor.id if done else None,
    ))
    write_event(conn, actor, entity_type="release", entity_id=row["release_id"],
                batch_id=new_batch(conn),
                kind="action_done" if done else "action_reopened",
                payload={"action_id": action_id, "title": row["title"]})
    return dict(conn.execute(
        select(release_actions).where(release_actions.c.id == action_id)
    ).mappings().one())


def remove_action(conn: Connection, actor: Actor, action_id: int) -> None:
    row = conn.execute(
        select(release_actions.c.release_id, release_actions.c.title)
        .where(release_actions.c.id == action_id)
    ).first()
    if row is None:
        return
    conn.execute(delete(release_actions).where(release_actions.c.id == action_id))
    write_event(conn, actor, entity_type="release", entity_id=row.release_id,
                batch_id=new_batch(conn), kind="action_removed",
                payload={"action_id": action_id, "title": row.title})


# ---------------------------------------------------------------------- reads --

def _counts(conn: Connection, release_id: int) -> dict:
    """Progress by status category — the numbers a release page opens with."""
    rows = conn.execute(
        select(statuses.c.category, func.count())
        .select_from(release_issues
                     .join(issues, release_issues.c.issue_id == issues.c.id)
                     .join(statuses, issues.c.status_id == statuses.c.id))
        .where(release_issues.c.release_id == release_id)
        .group_by(statuses.c.category)
    ).all()
    by_category = {c: n for c, n in rows}
    return {
        "todo": by_category.get("todo", 0),
        "in_progress": by_category.get("in_progress", 0),
        "done": by_category.get("done", 0),
        "total": sum(by_category.values()),
    }


def listing(conn: Connection, *, state: str | None = None, limit: int = 100) -> list[dict]:
    q = (
        select(releases,
               func.count(release_issues.c.issue_id).label("issue_count"))
        .select_from(releases.outerjoin(
            release_issues, release_issues.c.release_id == releases.c.id))
        .where(releases.c.archived_at.is_(None))
        .group_by(releases.c.id)
        # Planned first, and un-dated releases last rather than first — a
        # release with no date is a draft, not the most urgent thing.
        .order_by(releases.c.planned_at.desc().nullslast(), releases.c.id.desc())
        .limit(limit)
    )
    if state:
        q = q.where(releases.c.state == state)
    out = []
    for row in conn.execute(q).mappings():
        item = dict(row)
        item["counts"] = _counts(conn, item["id"])
        out.append(item)
    return out


def timeline(conn: Connection, *, months_back: int = 4, months_on: int = 2) -> dict:
    """Every release with a window, and what each one ships.

    One query per table rather than one per release: a timeline draws a hundred
    bars, and a request per bar is how a view like this becomes the slowest page
    in the product.

    Releases with no dates at all are left out. They are drafts — a bar with no
    position is not a thing a timeline can draw, and inventing one puts a lie on
    the screen. The page says how many it is holding back.
    """
    window_start = text(f"now() - interval '{int(months_back)} months'")
    window_end = text(f"now() + interval '{int(months_on)} months'")

    rows = conn.execute(
        select(releases,
               func.count(release_issues.c.issue_id).label("issue_count"))
        .select_from(releases.outerjoin(
            release_issues, release_issues.c.release_id == releases.c.id))
        .where(releases.c.archived_at.is_(None))
        .group_by(releases.c.id)
        .order_by(releases.c.id)
    ).mappings().all()

    # Artifacts for every release at once, keyed by release.
    art_by_release: dict[int, list[dict]] = {}
    for a in conn.execute(
        select(release_artifacts, components.c.key.label("component_key"),
               components.c.name.label("component_name"))
        .select_from(release_artifacts.join(
            components, release_artifacts.c.component_id == components.c.id))
        .order_by(release_artifacts.c.id)
    ).mappings():
        art_by_release.setdefault(a["release_id"], []).append(dict(a))

    # Progress for every release at once, rather than _counts per row.
    progress: dict[int, dict] = {}
    for release_id, category, n in conn.execute(
        select(release_issues.c.release_id, statuses.c.category, func.count())
        .select_from(release_issues
                     .join(issues, release_issues.c.issue_id == issues.c.id)
                     .join(statuses, issues.c.status_id == statuses.c.id))
        .group_by(release_issues.c.release_id, statuses.c.category)
    ).all():
        bucket = progress.setdefault(release_id, {"todo": 0, "in_progress": 0, "done": 0})
        bucket[category] = bucket.get(category, 0) + n

    today = conn.execute(select(func.current_date())).scalar_one()
    out, undated = [], 0
    for row in rows:
        item = dict(row)
        starts = item["cycle_start"]
        ends = item["shipped_at"] or item["planned_at"]
        if not ends and not starts:
            undated += 1
            continue
        counts = progress.get(item["id"], {"todo": 0, "in_progress": 0, "done": 0})
        counts["total"] = sum(counts.values())
        item["counts"] = counts
        item["artifacts"] = art_by_release.get(item["id"], [])
        # Late is worked out here and never stored: a stored flag is wrong the
        # moment somebody moves the date.
        item["late"] = bool(
            item["state"] != "shipped" and item["planned_at"]
            and item["planned_at"].date() < today)
        out.append(item)

    out.sort(key=lambda r: (r["cycle_start"] or r["planned_at"] or r["shipped_at"]))
    return {"releases": out, "undated": undated, "today": today.isoformat()}


def detail(conn: Connection, release_id: int) -> dict | None:
    row = conn.execute(select(releases).where(releases.c.id == release_id)).mappings().first()
    if row is None:
        return None
    release = dict(row)

    release["artifacts"] = [dict(r) for r in conn.execute(
        select(release_artifacts,
               components.c.name.label("component_name"),
               components.c.key.label("component_key"),
               components.c.repo.label("component_repo"))
        .select_from(release_artifacts.join(
            components, release_artifacts.c.component_id == components.c.id))
        .where(release_artifacts.c.release_id == release_id)
        .order_by(components.c.position, components.c.id)
    ).mappings()]

    release["issues"] = [dict(r) for r in conn.execute(
        select(issues.c.id, issues.c.key, issues.c.summary, issues.c.priority,
               statuses.c.name.label("status_name"),
               statuses.c.colour.label("status_colour"),
               statuses.c.category.label("status_category"),
               issue_types.c.name.label("type_name"),
               issue_types.c.key.label("type_key"),
               issue_types.c.icon.label("type_icon"),
               issue_types.c.colour.label("type_colour"),
               projects.c.key.label("project_key"),
               users.c.display_name.label("assignee_name"))
        .select_from(release_issues
                     .join(issues, release_issues.c.issue_id == issues.c.id)
                     .join(statuses, issues.c.status_id == statuses.c.id)
                     .join(issue_types, issues.c.issue_type_id == issue_types.c.id)
                     .join(projects, issues.c.project_id == projects.c.id)
                     .outerjoin(users, issues.c.assignee_id == users.c.id))
        .where(release_issues.c.release_id == release_id)
        .order_by(issue_types.c.hierarchy_level.desc(), issues.c.key)
    ).mappings()]

    release["actions"] = [dict(r) for r in conn.execute(
        select(release_actions, users.c.display_name.label("owner_name"))
        .select_from(release_actions.outerjoin(
            users, release_actions.c.owner_id == users.c.id))
        .where(release_actions.c.release_id == release_id)
        .order_by(release_actions.c.position, release_actions.c.id)
    ).mappings()]

    release["counts"] = _counts(conn, release_id)
    # Per project, because "who still owes something for this release" is the
    # question a cross-project release makes askable and Jira does not.
    release["byProject"] = [
        {"project": p, "total": total, "done": done}
        for p, total, done in conn.execute(
            select(projects.c.key, func.count(),
                   func.count().filter(statuses.c.category == "done"))
            .select_from(release_issues
                         .join(issues, release_issues.c.issue_id == issues.c.id)
                         .join(statuses, issues.c.status_id == statuses.c.id)
                         .join(projects, issues.c.project_id == projects.c.id))
            .where(release_issues.c.release_id == release_id)
            .group_by(projects.c.key)
            .order_by(projects.c.key)
        ).all()
    ]
    return release


def unreleased(conn: Connection, *, search: str = "", limit: int = 80,
               kind: str | None = None) -> list[dict]:
    """Issues that could go on a release of this kind.

    Not "issues on no release": an issue may be on one release of each kind, so
    the pool for a hotfix still contains work that is already on the next
    standard release. With no kind given it falls back to issues on no release
    at all, which is the safe reading when the caller has not said.
    """
    q = (
        select(issues.c.id, issues.c.key, issues.c.summary, issues.c.priority,
               statuses.c.name.label("status_name"),
               statuses.c.colour.label("status_colour"),
               statuses.c.category.label("status_category"),
               issue_types.c.name.label("type_name"),
               issue_types.c.icon.label("type_icon"),
               issue_types.c.colour.label("type_colour"),
               projects.c.key.label("project_key"),
               users.c.display_name.label("assignee_name"),
               users.c.avatar.label("assignee_avatar"))
        .select_from(issues
                     .join(statuses, issues.c.status_id == statuses.c.id)
                     .join(issue_types, issues.c.issue_type_id == issue_types.c.id)
                     .join(projects, issues.c.project_id == projects.c.id)
                     .outerjoin(users, issues.c.assignee_id == users.c.id))
        .where(issues.c.archived_at.is_(None))
        .where(~exists(
            select(release_issues.c.issue_id)
            .select_from(release_issues.join(
                releases, release_issues.c.release_id == releases.c.id))
            .where(release_issues.c.issue_id == issues.c.id)
            .where(releases.c.archived_at.is_(None))
            .where(releases.c.kind == kind if kind else text("true"))))
        # Finished work first would be noise: a release is built out of what is
        # still to come.
        .order_by(statuses.c.category, issue_types.c.hierarchy_level.desc(), issues.c.key)
        .limit(min(limit, 300))
    )
    term = (search or "").strip()
    if term:
        like = f"%{term}%"
        q = q.where(issues.c.key.ilike(like) | issues.c.summary.ilike(like))
    return [dict(r) for r in conn.execute(q).mappings()]


def draft_notes(conn: Connection, release_id: int) -> str:
    """Generate release notes from the issues, grouped by type.

    Generated rather than written, then edited before publishing — the first
    draft should never be the blocker. Stored on the release once accepted, so
    publishing does not depend on regenerating identically later.
    """
    release = conn.execute(
        select(releases.c.name).where(releases.c.id == release_id)
    ).scalar()
    rows = conn.execute(
        select(issue_types.c.name.label("type_name"),
               issue_types.c.hierarchy_level,
               issues.c.key, issues.c.summary)
        .select_from(release_issues
                     .join(issues, release_issues.c.issue_id == issues.c.id)
                     .join(issue_types, issues.c.issue_type_id == issue_types.c.id))
        .where(release_issues.c.release_id == release_id)
        .order_by(issue_types.c.hierarchy_level.desc(), issue_types.c.name, issues.c.key)
    ).mappings().all()

    if not rows:
        return f"# {release}\n\nNothing on this release yet."

    lines = [f"# {release}"]
    current = None
    for row in rows:
        if row["type_name"] != current:
            current = row["type_name"]
            heading = current if current.endswith("s") else f"{current}s"
            lines += ["", f"## {heading}", ""]
        lines.append(f"- **{row['key']}** — {row['summary']}")
    return "\n".join(lines).strip() + "\n"
