"""Reads, and the compiler that turns a saved view into SQL.

A board here is a saved view — a filter, a grouping and a renderer — so the
filter has to become real SQL at runtime. That is exactly why this project uses
SQLAlchemy Core: the alternative is assembling WHERE clauses out of f-strings,
which is an injection hole on day one and unmaintainable by month three.

Two rules hold everything together:

  * field names are matched against a whitelist, never interpolated
  * every value is a bound parameter, including inside JSONB paths

Writes live in repo.py. This file only reads.
"""
from __future__ import annotations

from typing import Any

from sqlalchemy import (
    Connection, Numeric, and_, case, cast, func, or_, select, text,
)

from .repo import CUSTOM_PREFIX
# work.py deliberately imports nothing from here, so this direction is safe.
# The order of the priorities is one fact and belongs in one place.
from .work import PRIORITY_ORDER
from .schema import (
    board_column_statuses, board_columns, comments, field_defs, field_usage,
    git_refs, issue_git, issue_labels, issue_links, issues, issue_types,
    projects, project_workflows, release_issues, releases, statuses, users,
    workflow_statuses,
)

# Only these can be filtered or sorted on. Anything else is refused rather than
# guessed at, so a malformed view is an error message and not a query.
# `users` appears twice in the base query — once as the assignee, once as the
# tester — so the second one needs a name of its own. Same for `issues`, which
# joins to itself to reach the parent.
_tester = users.alias("tester")
_parent = issues.alias("parent")

FILTERABLE = {
    "project_id": issues.c.project_id,
    "issue_type_id": issues.c.issue_type_id,
    "status_id": issues.c.status_id,
    "assignee_id": issues.c.assignee_id,
    "tester_id": issues.c.tester_id,
    "reporter_id": issues.c.reporter_id,
    "priority": issues.c.priority,
    "parent_id": issues.c.parent_id,
    "key": issues.c.key,
    "summary": issues.c.summary,
    "created_at": issues.c.created_at,
    "updated_at": issues.c.updated_at,
    "resolved_at": issues.c.resolved_at,
    # Category rather than a specific status: "everything open", across
    # projects that name their statuses differently. This is the column that
    # made cross-project reporting possible.
    "status_category": statuses.c.category,
    "team_id": issues.c.team_id,
    "plan_priority": issues.c.plan_priority,
}

# Priority sorted by what it *means*, not by its spelling: alphabetically
# "high" comes before "highest" and "low" before "medium", which is nonsense on
# a board. Sortable but not filterable — you filter on the word, you sort on
# the order.
PRIORITY_SORT = case(
    {name: position for position, name in enumerate(PRIORITY_ORDER)},
    value=issues.c.priority,
    else_=len(PRIORITY_ORDER),
)

# `id` is here and not in FILTERABLE on purpose: it is a stable tiebreaker for
# ordering, not something anyone should be writing filters against.
SORTABLE = {**FILTERABLE, "rank": issues.c.rank, "id": issues.c.id,
            "priority_rank": PRIORITY_SORT}


class QueryError(Exception):
    """A view that cannot be compiled — the author's problem, not a crash."""


def _column(field: str):
    if field.startswith(CUSTOM_PREFIX):
        key = field[len(CUSTOM_PREFIX):]
        if not key.replace("_", "").isalnum():
            raise QueryError(f"bad custom field name: {key}")
        # Bound as a parameter, not formatted into the path.
        return issues.c.custom[key].astext
    col = FILTERABLE.get(field)
    if col is None:
        raise QueryError(f"cannot filter on {field}")
    return col


def _is_text(col) -> bool:
    """Whether comparing this column to a string is meaningful."""
    try:
        return col.type.python_type is str
    except NotImplementedError:  # a type that declines to say; assume it is not
        return False


def _clause(node: dict):
    """One condition, or a nested all/any group."""
    if "all" in node:
        return and_(*[_clause(n) for n in node["all"]]) if node["all"] else text("true")
    if "any" in node:
        return or_(*[_clause(n) for n in node["any"]]) if node["any"] else text("false")

    field, op, value = node.get("field"), node.get("op", "eq"), node.get("value")
    if not field:
        raise QueryError("a condition needs a field")

    # Labels are many-per-issue, so they are the one filterable thing that is
    # not a column. An EXISTS rather than a join, because a join would multiply
    # the row for an issue wearing three of them and every count on the page
    # would quietly triple.
    if field == "label_id":
        wearing = (
            select(issue_labels.c.issue_id)
            .where(issue_labels.c.issue_id == issues.c.id))
        match op:
            case "in" | "eq":
                wanted = value if isinstance(value, list) else [value]
                return wearing.where(issue_labels.c.label_id.in_(wanted or [])).exists()
            case "not_in" | "ne":
                unwanted = value if isinstance(value, list) else [value]
                return ~wearing.where(
                    issue_labels.c.label_id.in_(unwanted or [])).exists()
            case "is_empty":
                return ~wearing.exists()
            case "is_not_empty":
                return wearing.exists()
        raise QueryError(f"a label cannot be compared with {op}")

    col = _column(field)
    numeric = field.startswith(CUSTOM_PREFIX) and op in (">", ">=", "<", "<=")
    if numeric:
        col = cast(col, Numeric)

    match op:
        case "eq":     return col == value
        case "ne":     return col != value
        case "in":     return col.in_(value or [])
        case "not_in": return col.notin_(value or [])
        case ">":      return col > value
        case ">=":     return col >= value
        case "<":      return col < value
        case "<=":     return col <= value
        case "contains":
            # ilike with the wildcards bound, so a % in the search text is
            # searched for rather than treated as a wildcard.
            return col.ilike(func.concat("%", value, "%"))
        # "Empty" means NULL everywhere, and additionally the empty string on
        # a text column. Testing an integer column against '' is not a false
        # condition in Postgres, it is `operator does not exist: integer =
        # character varying` — so "unassigned" would 500 rather than answer.
        case "is_empty":
            return or_(col.is_(None), col == "") if _is_text(col) else col.is_(None)
        case "is_not_empty":
            return and_(col.isnot(None), col != "") if _is_text(col) else col.isnot(None)
    raise QueryError(f"unknown operator: {op}")


def _base():
    """Issues joined to the lookups every list needs, so rendering a board is
    one query rather than one plus a lookup per row."""
    return (
        select(
            issues,
            statuses.c.key.label("status_key"),
            statuses.c.name.label("status_name"),
            statuses.c.category.label("status_category"),
            statuses.c.colour.label("status_colour"),
            issue_types.c.key.label("type_key"),
            issue_types.c.name.label("type_name"),
            issue_types.c.icon.label("type_icon"),
            issue_types.c.colour.label("type_colour"),
            projects.c.key.label("project_key"),
            users.c.display_name.label("assignee_name"),
            users.c.avatar.label("assignee_avatar"),
            _tester.c.display_name.label("tester_name"),
            _tester.c.avatar.label("tester_avatar"),
            # Enough of the parent to name it on a card. The full parent object
            # is only worth assembling when a single issue is opened.
            _parent.c.key.label("parent_key"),
            _parent.c.summary.label("parent_summary"),
        )
        .select_from(
            issues.join(statuses, issues.c.status_id == statuses.c.id)
            .join(issue_types, issues.c.issue_type_id == issue_types.c.id)
            .join(projects, issues.c.project_id == projects.c.id)
            # Outer: an unassigned issue is normal, not missing data.
            .outerjoin(users, issues.c.assignee_id == users.c.id)
            # The same table twice, so it needs an alias — otherwise the join
            # is ambiguous and both names come back as the assignee's.
            .outerjoin(_tester, issues.c.tester_id == _tester.c.id)
            .outerjoin(_parent, issues.c.parent_id == _parent.c.id)
        )
    )


def list_issues(
    conn: Connection,
    *,
    filter: dict | None = None,
    sort: list[dict] | None = None,
    limit: int = 100,
    offset: int = 0,
    include_archived: bool = False,
) -> dict:
    q = _base()
    if not include_archived:
        q = q.where(issues.c.archived_at.is_(None))
    if filter:
        q = q.where(_clause(filter))

    total = conn.execute(
        select(func.count()).select_from(q.subquery())
    ).scalar_one()

    for s in sort or [{"field": "rank"}, {"field": "id"}]:
        col = SORTABLE.get(s.get("field", ""))
        if col is None:
            raise QueryError(f"cannot sort on {s.get('field')}")
        q = q.order_by(col.desc() if s.get("dir") == "desc" else col.asc())

    rows = conn.execute(q.limit(min(limit, 500)).offset(offset)).mappings().all()
    return {"total": total, "issues": _badges(conn, [dict(r) for r in rows])}


# How a card picks one answer out of several pull requests. Failing outranks
# everything: it is the one that changes what somebody does next.
CHECK_RANK = {"none": 0, "passing": 1, "pending": 2, "failing": 3}
STATE_RANK = {"closed": 0, "merged": 1, "draft": 2, "open": 3}


def _badges(conn: Connection, items: list[dict]) -> list[dict]:
    """The handful of counts a card shows without being opened.

    Four small aggregates over the page of issues just fetched, rather than
    four columns of correlated subqueries on the main select — the main select
    is the one that has to stay fast, and these are answering a different
    question. One round trip each, over at most 500 ids.

    `blocked_by` counts only blockers that are not finished. A blocker that has
    shipped is history, and counting it would leave cards looking stuck forever.
    """
    ids = [i["id"] for i in items]
    if not ids:
        return items

    blocker_source = issues.alias("blocker")
    blocked = dict(conn.execute(
        select(issue_links.c.target_id, func.count())
        .select_from(issue_links
                     .join(blocker_source, issue_links.c.source_id == blocker_source.c.id)
                     .join(statuses, blocker_source.c.status_id == statuses.c.id))
        .where(issue_links.c.kind == "blocks")
        .where(issue_links.c.target_id.in_(ids))
        .where(statuses.c.category != "done")
        .where(blocker_source.c.archived_at.is_(None))
        .group_by(issue_links.c.target_id)).all())

    # Both directions: "three things point at this" is the useful number, and
    # which way the arrow runs is a question for the issue itself.
    linked: dict[int, int] = {}
    for column in (issue_links.c.source_id, issue_links.c.target_id):
        for issue_id, count in conn.execute(
            select(column, func.count()).where(column.in_(ids)).group_by(column)
        ).all():
            linked[issue_id] = linked.get(issue_id, 0) + count

    children = dict(conn.execute(
        select(issues.c.parent_id, func.count())
        .where(issues.c.parent_id.in_(ids))
        .where(issues.c.archived_at.is_(None))
        .group_by(issues.c.parent_id)).all())

    talk = dict(conn.execute(
        select(comments.c.issue_id, func.count())
        .where(comments.c.issue_id.in_(ids))
        .where(comments.c.deleted_at.is_(None))
        .group_by(comments.c.issue_id)).all())

    # The worst news wins: a failing build outranks an open PR, because that is
    # the one that changes what somebody does next. Same reasoning as blocked.
    git_state: dict[int, dict] = {}
    # Builds come along for the ride so a red pipeline on a branch with no pull
    # request still reaches the card. Only pull requests are counted, though —
    # "2 PRs" must not become "5" because the CI ran three times.
    for issue_id, kind, state, checks in conn.execute(
        select(issue_git.c.issue_id, git_refs.c.kind, git_refs.c.state,
               git_refs.c.checks)
        .select_from(issue_git.join(git_refs, issue_git.c.git_ref_id == git_refs.c.id))
        .where(issue_git.c.issue_id.in_(ids))
        .where(git_refs.c.kind.in_(("pr", "build")))
    ).all():
        seen = git_state.setdefault(issue_id, {"prs": 0, "state": "", "checks": "none"})
        if kind == "build":
            if CHECK_RANK.get(checks, 0) > CHECK_RANK.get(seen["checks"], 0):
                seen["checks"] = checks
            continue
        seen["prs"] += 1
        # Worst news wins on both axes, so one badge can stand for several PRs
        # without hiding the one that needs attention.
        if CHECK_RANK.get(checks, 0) > CHECK_RANK.get(seen["checks"], 0):
            seen["checks"] = checks
        if STATE_RANK.get(state, -1) > STATE_RANK.get(seen["state"], -1):
            seen["state"] = state

    # An open, blocking ask is a third way to be stuck — not another issue and
    # not your own attention, but somebody who has not answered. It counts
    # towards the same badge, because a card that is stuck should look stuck
    # whichever of the three is doing it.
    from . import asks as asks_mod
    waiting = asks_mod.blocking_counts(conn, ids)
    open_asks = asks_mod.open_counts(conn, ids)

    from . import labels as labels_mod
    wearing = labels_mod.for_issues(conn, ids)

    for item in items:
        key = item["id"]
        item["blocked_by"] = blocked.get(key, 0) + waiting.get(key, 0)
        item["open_asks"] = open_asks.get(key, 0)
        item["labels"] = wearing.get(key, [])
        item["link_count"] = linked.get(key, 0)
        item["child_count"] = children.get(key, 0)
        item["comment_count"] = talk.get(key, 0)
        # Named apart from the issue's own `git`: a row carries a summary and
        # an opened issue carries the whole list, and one field holding two
        # different shapes is how a client ends up guessing which it got.
        item["git_summary"] = git_state.get(key)
    return items


def _board_order(issue: dict) -> tuple:
    """Priority first, then the hand-set rank, then id to break ties."""
    return (
        PRIORITY_ORDER.index(issue["priority"])
        if issue["priority"] in PRIORITY_ORDER else len(PRIORITY_ORDER),
        issue["rank"] or "",
        issue["id"],
    )


def board(conn: Connection, view: dict) -> dict:
    """A view rendered as groups. Grouping happens here rather than in the
    client so a column can report a total that is bigger than what it sent."""
    group_by = view.get("group_by") or "status"
    data = list_issues(
        conn,
        filter=view.get("filter") or None,
        # A board is always in priority order — that is the promise it makes,
        # and the hand-set rank only decides the order *within* one priority.
        # Somebody dragging a card can move it among its equals and nowhere
        # else, so no drag can ever put a medium above a high.
        sort=view.get("sort") or [
            {"field": "priority_rank"}, {"field": "rank"}, {"field": "id"},
        ],
        limit=view.get("limit", 500),
    )

    key_of = {
        "status": lambda i: i["status_id"],
        "assignee": lambda i: i["assignee_id"],
        "type": lambda i: i["issue_type_id"],
        "priority": lambda i: i["priority"],
        "project": lambda i: i["project_id"],
        "none": lambda i: None,
    }.get(group_by)
    if key_of is None:
        raise QueryError(f"cannot group by {group_by}")

    groups: dict[Any, list] = {}
    for issue in data["issues"]:
        groups.setdefault(key_of(issue), []).append(issue)

    if group_by == "status":
        # Every status in the workflow gets a column, including the empty ones
        # — a board that hides "In Review" because nothing is there is a board
        # that quietly changes shape during the day.
        #
        # "In the workflow" is doing real work here. The statuses are global, so
        # the full list is every status every board uses; showing all of them on
        # one project would put AID's seventeen gates on the QA board. Scope to
        # the project's own workflow, in its own order, and only fall back to
        # the global list when the view genuinely spans projects.
        project_id = view.get("project_id")

        # A column holds one *or more* statuses. Grouping by status and calling
        # each group a column was the old shape; the board is now told how to
        # group by the project's own column layout.
        layout = conn.execute(
            select(board_columns.c.id, board_columns.c.name,
                   board_column_statuses.c.status_id,
                   statuses.c.category, statuses.c.colour, statuses.c.name.label("status_name"))
            .select_from(board_columns
                         .outerjoin(board_column_statuses,
                                    board_column_statuses.c.column_id == board_columns.c.id)
                         .outerjoin(statuses,
                                    board_column_statuses.c.status_id == statuses.c.id))
            .where(board_columns.c.project_id == project_id)
            .order_by(board_columns.c.position, board_column_statuses.c.position)
        ).mappings().all() if project_id else []

        # Columns that between them hold no status at all are not a board, they
        # are a blank screen — every issue would be "in no column" and silently
        # vanish. `set_board` refuses to write that, but boards already in this
        # state exist, so treat it as no layout and fall back to the workflow
        # rather than showing a project an empty board with no explanation.
        if not any(row["status_id"] is not None for row in layout):
            layout = []

        if layout:
            by_column: dict[int, dict] = {}
            for row in layout:
                col = by_column.setdefault(row["id"], {
                    "key": row["id"], "name": row["name"], "issues": [],
                    "statuses": [], "colour": None, "category": None,
                })
                if row["status_id"] is None:
                    continue
                col["statuses"].append({
                    "id": row["status_id"], "name": row["status_name"],
                    "colour": row["colour"], "category": row["category"],
                })
                # A column's colour and category come from its first status.
                # With one status that is exactly the old behaviour; with two it
                # is the one the column is named after.
                if col["colour"] is None:
                    col["colour"], col["category"] = row["colour"], row["category"]
                col["issues"].extend(groups.get(row["status_id"], []))
            # A column holding two statuses has just been handed one status'
            # issues after the other's, so the column as a whole is no longer
            # in priority order even though each half was. Sort what is
            # actually displayed, by the same rule the query used.
            for col in by_column.values():
                col["issues"].sort(key=_board_order)
            columns = list(by_column.values())
        else:
            # No layout configured — every status its own column, which is what
            # the board did before columns existed.
            order = conn.execute(
                select(statuses.c.id, statuses.c.name, statuses.c.category, statuses.c.colour)
                .order_by(statuses.c.id)
            ).mappings().all()
            columns = [
                {"key": s["id"], "name": s["name"], "category": s["category"],
                 "colour": s["colour"], "issues": groups.get(s["id"], []),
                 "statuses": [{"id": s["id"], "name": s["name"],
                               "colour": s["colour"], "category": s["category"]}]}
                for s in order
            ]
    else:
        columns = [{"key": k, "name": str(k), "issues": v} for k, v in groups.items()]

    return {"groupBy": group_by, "total": data["total"], "columns": columns}


def get_issue(conn: Connection, ident: str | int) -> dict | None:
    q = _base()
    q = q.where(issues.c.key == ident) if isinstance(ident, str) else q.where(issues.c.id == ident)
    row = conn.execute(q).mappings().first()
    if row is None:
        return None
    issue = dict(row)
    issue["comments"] = [
        dict(r) for r in conn.execute(
            select(comments, users.c.display_name.label("author_name"),
                   users.c.avatar.label("author_avatar"))
            .select_from(comments.outerjoin(users, comments.c.author_id == users.c.id))
            .where(comments.c.issue_id == issue["id"])
            .where(comments.c.deleted_at.is_(None))
            .order_by(comments.c.created_at)
        ).mappings().all()
    ]
    # The fields this project asks for on this type, with the values it holds.
    #
    # Configured centrally and answered here, so the card renders what an admin
    # decided rather than whatever keys happen to be in the JSON. Anything in
    # `custom` that is no longer configured still travels — hiding a value
    # because somebody retired its field is how data quietly disappears.
    configured = [dict(r) for r in conn.execute(
        select(field_defs.c.id, field_defs.c.key, field_defs.c.name,
               field_defs.c.kind, field_defs.c.options, field_defs.c.description,
               field_usage.c.required, field_usage.c.position)
        .select_from(field_usage.join(field_defs, field_usage.c.field_id == field_defs.c.id))
        .where(field_usage.c.project_id == issue["project_id"])
        .where(field_usage.c.issue_type_id == issue["issue_type_id"])
        .where(field_defs.c.archived_at.is_(None))
        .order_by(field_usage.c.position)).mappings()]

    values = issue.get("custom") or {}
    known = {f["key"] for f in configured}
    for field in configured:
        field["value"] = values.get(field["key"])
    for key in values:
        if key not in known:
            configured.append({
                "id": None, "key": key, "name": key.replace("_", " ").capitalize(),
                "kind": "text", "options": [], "description": "",
                "required": False, "position": 999,
                "value": values[key], "unconfigured": True,
            })
    issue["fields"] = configured

    from . import links as link_module

    issue["links"] = link_module.links_for(conn, issue["id"])
    issue["children"] = link_module.children(conn, issue["id"])
    issue["parent"] = (link_module._summary(conn, issue["parent_id"])
                       if issue["parent_id"] else None)
    # Only the unfinished blockers: one that has shipped is history, and showing
    # it would make everything look stuck forever.
    issue["blockers"] = link_module.blockers(conn, [issue["id"]]).get(issue["id"], [])
    # Branches and pull requests. Imported here rather than at module scope for
    # the same reason links is: git reads issues, and issues read git.
    from . import git as git_module
    issue["git"] = git_module.for_issues(conn, [issue["id"]]).get(issue["id"], [])

    # Who is waiting on whom, and for what. Near the issue's own facts rather
    # than in the discussion — an open ask is the reason the thing is not
    # moving, which is not a remark.
    from . import asks as asks_module
    issue["asks"] = asks_module.for_issue(conn, issue["id"])

    from . import labels as labels_module
    issue["labels"] = labels_module.for_issues(
        conn, [issue["id"]]).get(issue["id"], [])

    # Which releases carry this issue. Asked constantly ("is my fix in B-34?")
    # and cheap here, where the issue is already loaded.
    issue["releases"] = [
        dict(r) for r in conn.execute(
            select(releases.c.id, releases.c.name, releases.c.state,
                   releases.c.kind, releases.c.shipped_at)
            .select_from(release_issues.join(
                releases, release_issues.c.release_id == releases.c.id))
            .where(release_issues.c.issue_id == issue["id"])
            .order_by(releases.c.planned_at.desc().nullslast())
        ).mappings().all()
    ]
    return issue


def search_everything(conn: Connection, term: str, *, limit: int = 25,
                      project_ids: set[int] | None = None) -> list[dict]:
    """One box, every project, and the three places words actually live.

    Summary, description and comments. Leaving comments out is what makes a
    search box feel broken — half of what anybody remembers about an issue was
    said underneath it rather than in its title.

    A trigram or full-text index is the eventual answer; at this size ILIKE over
    a few thousand rows is milliseconds, and pretending otherwise would be
    building for a scale we do not have.
    """
    term = (term or "").strip()
    if len(term) < 2:
        return []
    like = f"%{term}%"

    matched_comment = (
        select(comments.c.issue_id)
        .where(comments.c.issue_id == issues.c.id)
        .where(comments.c.deleted_at.is_(None))
        .where(comments.c.body.ilike(like))
    )

    q = (
        _base()
        .where(issues.c.archived_at.is_(None))
        .where(or_(
            issues.c.key.ilike(like),
            issues.c.summary.ilike(like),
            issues.c.description.ilike(like),
            matched_comment.exists(),
        ))
        # Whatever is moving comes first: an old issue matching on a word in its
        # description is rarely what somebody is looking for.
        .order_by(issues.c.updated_at.desc())
        .limit(min(limit, 50))
    )
    if project_ids is not None:
        q = q.where(issues.c.project_id.in_(sorted(project_ids) or [0]))

    out = []
    for row in conn.execute(q).mappings():
        item = dict(row)
        lowered = term.lower()
        # Say where it matched, so a result whose title looks unrelated does not
        # read as a bug in the search.
        if lowered in (item["key"] or "").lower() or lowered in (item["summary"] or "").lower():
            item["matched"] = None
        elif lowered in (item["description"] or "").lower():
            item["matched"] = {"where": "description",
                               "text": _snippet(item["description"], term)}
        else:
            body = conn.execute(
                select(comments.c.body)
                .where(comments.c.issue_id == item["id"])
                .where(comments.c.deleted_at.is_(None))
                .where(comments.c.body.ilike(like))
                .limit(1)).scalar()
            item["matched"] = {"where": "comment", "text": _snippet(body or "", term)}
        out.append(item)
    return out


def _snippet(text_value: str, term: str, width: int = 90) -> str:
    """The matching words with a little either side, rather than the first line
    of something that matched at the bottom."""
    lowered, needle = text_value.lower(), term.lower()
    at = lowered.find(needle)
    if at < 0:
        return text_value[:width]
    start = max(0, at - width // 3)
    end = min(len(text_value), at + len(term) + width)
    return ("…" if start else "") + text_value[start:end].strip() + ("…" if end < len(text_value) else "")


def activity(conn: Connection, entity_type: str, entity_id: int, limit: int = 100) -> list[dict]:
    """The history, folded back into one item per save.

    Events are stored one per field so they can be queried individually; a
    reader wants "Alex changed status and assignee", which is what batch_id is
    for. Split for querying, joined for reading.
    """
    rows = conn.execute(text("""
        SELECT e.id, e.batch_id, e.actor_id, e.actor_kind, e.at, e.kind,
               e.field, e.from_value, e.to_value, e.payload,
               u.display_name AS actor_name, u.avatar AS actor_avatar
          FROM events e
          LEFT JOIN users u ON u.id = e.actor_id
         WHERE e.entity_type = :t AND e.entity_id = :i
      ORDER BY e.at DESC, e.id DESC
         LIMIT :lim
    """), {"t": entity_type, "i": entity_id, "lim": limit}).mappings().all()

    batches: dict[int, dict] = {}
    for r in rows:
        b = batches.setdefault(r["batch_id"], {
            "batchId": r["batch_id"], "at": r["at"], "actorId": r["actor_id"],
            "actorKind": r["actor_kind"], "actorName": r["actor_name"],
            "actorAvatar": r["actor_avatar"], "kind": r["kind"], "changes": [],
        })
        if r["field"]:
            b["changes"].append({"field": r["field"], "from": r["from_value"], "to": r["to_value"]})
        elif r["payload"]:
            b["payload"] = r["payload"]
    return list(batches.values())
