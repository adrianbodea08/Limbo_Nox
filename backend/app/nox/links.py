"""How issues relate to each other: hierarchy, and links.

Two different things, kept apart on purpose.

**Hierarchy** is `parent_id`, and it is a tree: an epic contains stories and
tasks, a task contains sub-tasks. One parent, decided by the issue types'
hierarchy levels rather than by convention, so "epic under a sub-task" is
refused by the model instead of being a thing people learn not to do.

**Links** are everything else — blocks, duplicates, relates to, causes. A graph,
not a tree, and an issue can have as many as it likes.

The one that earns its keep is `blocks`. "What can I actually start" is the
question a queue cannot answer without it, and an issue sitting at the top of
somebody's list waiting on work that has not happened is how a ranked list stops
being believed.
"""
from __future__ import annotations

from sqlalchemy import Connection, delete, or_, select, text

from . import repo
from .repo import Actor, TrackerError
from .schema import issue_links, issue_types, issues, projects, statuses

# kind -> how it reads in each direction. Symmetric kinds read the same both
# ways, which is why "relates to" needs no inverse phrasing.
LINK_TYPES: dict[str, dict] = {
    "blocks":     {"outward": "blocks",     "inward": "is blocked by"},
    "relates":    {"outward": "relates to", "inward": "relates to", "symmetric": True},
    "duplicates": {"outward": "duplicates", "inward": "is duplicated by"},
    "causes":     {"outward": "causes",     "inward": "is caused by"},
    "clones":     {"outward": "clones",     "inward": "is cloned by"},
}


class LinkError(Exception):
    """A relationship that cannot exist, with the reason."""


def _summary(conn: Connection, issue_id: int) -> dict | None:
    row = conn.execute(
        select(issues.c.id, issues.c.key, issues.c.summary, issues.c.priority,
               issues.c.parent_id, issues.c.project_id, issues.c.issue_type_id,
               statuses.c.name.label("status_name"),
               statuses.c.colour.label("status_colour"),
               statuses.c.category.label("status_category"),
               issue_types.c.name.label("type_name"),
               issue_types.c.icon.label("type_icon"),
               issue_types.c.colour.label("type_colour"),
               issue_types.c.hierarchy_level,
               projects.c.key.label("project_key"))
        .select_from(issues
                     .join(statuses, issues.c.status_id == statuses.c.id)
                     .join(issue_types, issues.c.issue_type_id == issue_types.c.id)
                     .join(projects, issues.c.project_id == projects.c.id))
        .where(issues.c.id == issue_id)
    ).mappings().first()
    return dict(row) if row else None


# ------------------------------------------------------------------- links --

def add(conn: Connection, actor: Actor, source_id: int, target_id: int, kind: str) -> dict:
    """Link two issues.

    Refuses the arrangements that would make the graph lie: an issue linked to
    itself, the same link twice, and — for `blocks` — a cycle, because "A is
    blocked by B which is blocked by A" is not a state anybody can act on.
    """
    if kind not in LINK_TYPES:
        raise LinkError(f"unknown link type: {kind}")
    if source_id == target_id:
        raise LinkError("an issue cannot be linked to itself")

    source, target = _summary(conn, source_id), _summary(conn, target_id)
    if source is None or target is None:
        raise TrackerError("one of those issues does not exist")

    symmetric = LINK_TYPES[kind].get("symmetric")
    existing = conn.execute(
        select(issue_links.c.id)
        .where(issue_links.c.kind == kind)
        .where(or_(
            (issue_links.c.source_id == source_id) & (issue_links.c.target_id == target_id),
            # A symmetric link already recorded the other way round is the same
            # link, and adding it again would draw it twice on both issues.
            (issue_links.c.source_id == target_id) & (issue_links.c.target_id == source_id)
            if symmetric else text("false"),
        ))
    ).scalar()
    if existing is not None:
        raise LinkError(f"{source['key']} already {LINK_TYPES[kind]['outward']} {target['key']}")

    if kind == "blocks" and _reaches(conn, target_id, source_id):
        raise LinkError(
            f"{target['key']} already blocks {source['key']}, directly or through "
            "another issue — that would be a circle nobody can start.")

    link_id = conn.execute(issue_links.insert().values(
        source_id=source_id, target_id=target_id, kind=kind, created_by=actor.id,
    ).returning(issue_links.c.id)).scalar_one()

    # Recorded on both issues: whichever one you are reading, the history should
    # say how this relationship appeared.
    batch = repo.new_batch(conn)
    for entity, other, phrase in (
        (source_id, target, LINK_TYPES[kind]["outward"]),
        (target_id, source, LINK_TYPES[kind]["inward"]),
    ):
        repo.write_event(conn, actor, entity_type="issue", entity_id=entity,
                         batch_id=batch, kind="linked",
                         payload={"link_id": link_id, "kind": kind,
                                  "phrase": phrase, "other": other["key"]})
    return {"id": link_id, "kind": kind}


def remove(conn: Connection, actor: Actor, link_id: int) -> None:
    row = conn.execute(
        select(issue_links).where(issue_links.c.id == link_id)).mappings().first()
    if row is None:
        return
    conn.execute(delete(issue_links).where(issue_links.c.id == link_id))
    batch = repo.new_batch(conn)
    for entity in (row["source_id"], row["target_id"]):
        repo.write_event(conn, actor, entity_type="issue", entity_id=entity,
                         batch_id=batch, kind="unlinked",
                         payload={"kind": row["kind"]})


def _reaches(conn: Connection, start: int, goal: int, depth: int = 12) -> bool:
    """Whether `start` blocks `goal`, directly or down a chain.

    Bounded rather than exhaustive: a dozen hops is far past any real blocking
    chain, and an unbounded walk over a graph somebody can edit is a request
    that hangs.
    """
    seen, frontier = {start}, [start]
    for _ in range(depth):
        if not frontier:
            return False
        rows = conn.execute(
            select(issue_links.c.target_id)
            .where(issue_links.c.kind == "blocks")
            .where(issue_links.c.source_id.in_(frontier))).all()
        nxt = [r[0] for r in rows if r[0] not in seen]
        if goal in nxt:
            return True
        seen.update(nxt)
        frontier = nxt
    return False


def links_for(conn: Connection, issue_id: int) -> list[dict]:
    """Every link on this issue, phrased from its point of view."""
    out = []
    for row in conn.execute(
        select(issue_links).where(or_(issue_links.c.source_id == issue_id,
                                      issue_links.c.target_id == issue_id))
        .order_by(issue_links.c.kind, issue_links.c.id)
    ).mappings():
        outward = row["source_id"] == issue_id
        other = _summary(conn, row["target_id"] if outward else row["source_id"])
        if other is None:
            continue
        spec = LINK_TYPES.get(row["kind"], {"outward": row["kind"], "inward": row["kind"]})
        out.append({
            "id": row["id"], "kind": row["kind"],
            "phrase": spec["outward"] if outward else spec["inward"],
            "direction": "outward" if outward else "inward",
            "issue": other,
        })
    return out


def blockers(conn: Connection, issue_ids: list[int]) -> dict[int, list[dict]]:
    """Unfinished work standing in front of each issue.

    Only the ones that are not done — a blocker that has shipped is history, and
    showing it would make everything look stuck forever.
    """
    if not issue_ids:
        return {}
    rows = conn.execute(
        select(issue_links.c.target_id, issues.c.id, issues.c.key, issues.c.summary,
               statuses.c.name.label("status_name"))
        .select_from(issue_links
                     .join(issues, issue_links.c.source_id == issues.c.id)
                     .join(statuses, issues.c.status_id == statuses.c.id))
        .where(issue_links.c.kind == "blocks")
        .where(issue_links.c.target_id.in_(issue_ids))
        .where(statuses.c.category != "done")
        .where(issues.c.archived_at.is_(None))
    ).mappings().all()

    out: dict[int, list[dict]] = {}
    for row in rows:
        out.setdefault(row["target_id"], []).append({
            "id": row["id"], "key": row["key"], "summary": row["summary"],
            "status_name": row["status_name"],
        })
    return out


# --------------------------------------------------------------- hierarchy --

def set_parent(conn: Connection, actor: Actor, issue_id: int, parent_id: int | None) -> None:
    """Put an issue under a parent, or take it out.

    The rule is the issue types' own hierarchy levels rather than a list of
    allowed pairs: a parent has to sit above its child. That way adding a type
    later needs no change here — it just needs a level.
    """
    if parent_id is None:
        repo.update_issue(conn, actor, issue_id, {"parent_id": None})
        return
    if parent_id == issue_id:
        raise LinkError("an issue cannot be its own parent")

    child, parent = _summary(conn, issue_id), _summary(conn, parent_id)
    if child is None or parent is None:
        raise TrackerError("one of those issues does not exist")

    if parent["hierarchy_level"] <= child["hierarchy_level"]:
        article = lambda w: "an" if w[:1].lower() in "aeiou" else "a"
        raise LinkError(
            f"{article(parent['type_name'])} {parent['type_name']} cannot be the parent of "
            f"{article(child['type_name'])} {child['type_name']} — a parent has to sit "
            "above its child")
    if parent["project_id"] != child["project_id"]:
        raise LinkError(
            f"{parent['key']} is on another board. Work that spans boards is held "
            "together by a release, not by a parent.")

    # Walk up from the proposed parent: if we meet the child, this closes a loop.
    seen, current = set(), parent
    while current and current["parent_id"] and current["id"] not in seen:
        seen.add(current["id"])
        if current["parent_id"] == issue_id:
            raise LinkError(f"{child['key']} is already above {parent['key']}")
        current = _summary(conn, current["parent_id"])

    repo.update_issue(conn, actor, issue_id, {"parent_id": parent_id})


def children(conn: Connection, issue_id: int) -> list[dict]:
    rows = conn.execute(
        select(issues.c.id).where(issues.c.parent_id == issue_id)
        .where(issues.c.archived_at.is_(None))
        .order_by(issues.c.key)).all()
    return [c for c in (_summary(conn, r[0]) for r in rows) if c]


def parent_candidates(conn: Connection, issue_id: int, search: str = "",
                      limit: int = 40) -> list[dict]:
    """Issues that could legally be this one's parent: same board, higher level."""
    me = _summary(conn, issue_id)
    if me is None:
        return []
    q = (
        select(issues.c.id)
        .select_from(issues.join(issue_types, issues.c.issue_type_id == issue_types.c.id))
        .where(issues.c.project_id == me["project_id"])
        .where(issues.c.id != issue_id)
        .where(issues.c.archived_at.is_(None))
        .where(issue_types.c.hierarchy_level > me["hierarchy_level"])
        .order_by(issue_types.c.hierarchy_level.desc(), issues.c.key)
        .limit(limit)
    )
    term = (search or "").strip()
    if term:
        like = f"%{term}%"
        q = q.where(issues.c.key.ilike(like) | issues.c.summary.ilike(like))
    return [c for c in (_summary(conn, r[0]) for r in conn.execute(q).all()) if c]
