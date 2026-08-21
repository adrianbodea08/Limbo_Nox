"""First-run contents: statuses, issue types, the four workflows, the projects.

Run once against an empty database, and idempotent — every insert checks first,
so running it twice changes nothing and adding a status here later fills it in
without disturbing what exists.

Nothing here is invented. The statuses and every transition come from
`jira_workflows.py`, which was captured from the live Jira: Classic Dev from
DRC, AI First Development from AID, QA Board from QA, DevOps Board from OPS.
Read that module's header before changing anything — it records which names
were merged, which categories were wrong in Jira, and why.

Each project gets **its own workflow**, because they genuinely are different:
DRC ships through Staging to Live, AID runs a seventeen-step gated pipeline,
QA has no workflow at all (every status reaches every other, which is Jira's
default when nobody configured one). One shared default would have been a lie.
"""
from __future__ import annotations

from sqlalchemy import Connection, select

from .jira_workflows import STATUSES, UNSAMPLED, WORKFLOWS
from .schema import (
    field_defs, field_usage, issue_types, project_issue_types, project_workflows,
    projects, statuses, transitions, views, workflow_statuses, workflows,
)

# key, name, icon, colour, hierarchy_level.
#
# The union of what the four Jira projects actually use. DRC's Defect, Hotfix,
# Live Bug and Add-on Task are real types there and are kept — they are how bug
# work is told apart from planned work, which several reports depend on.
# The mark is a named icon — `lucide:Bug` — not a character. See
# frontend/src/components/nox/TypeGlyph.tsx for why, and for the set a type may
# choose from. The column is still TEXT and a bare character still renders, so
# an installation that predates this keeps its marks until somebody changes one.
ISSUE_TYPES = [
    ("epic",        "Epic",         "lucide:Layers",          "#a371f7", 2),
    ("story",       "Story",        "lucide:Bookmark",        "#3fb950", 1),
    ("task",        "Task",         "lucide:SquareCheck",     "#5b8cff", 1),
    ("bug",         "Bug",          "lucide:Bug",             "#f85149", 1),
    ("defect",      "Defect",       "lucide:TriangleAlert",   "#d29922", 1),
    ("live_bug",    "Live Bug",     "lucide:Siren",           "#f85149", 1),
    ("hotfix",      "Hotfix",       "lucide:Flame",           "#f0883e", 1),
    ("addon_task",  "Add-on Task",  "lucide:Puzzle",          "#2dd4bf", 1),
    ("subtask",     "Sub-task",     "lucide:CornerDownRight", "#8b949e", 0),
]

# What each of those characters used to be, so an existing database comes
# across on the next start. Keyed by the glyph rather than by the type key,
# because somebody may have made their own type using one of them.
GLYPH_TO_ICON = {
    "◆": "lucide:Layers",
    "▣": "lucide:Bookmark",
    "▢": "lucide:SquareCheck",
    "▲": "lucide:Bug",
    "▼": "lucide:TriangleAlert",
    "●": "lucide:Siren",
    "⬟": "lucide:Flame",
    "◈": "lucide:Puzzle",
    "▫": "lucide:CornerDownRight",
}

# Which types each board offers, mirroring the Jira project it came from.
PROJECT_TYPES = {
    "CD":  ["epic", "story", "task", "bug", "defect", "live_bug", "hotfix", "addon_task", "subtask"],
    "AIF": ["epic", "story", "task", "subtask"],
    "QAB": ["epic", "story", "task", "bug", "subtask"],
    "DVO": ["epic", "story", "task", "bug", "subtask"],
}

# The fields the boards already use, defined properly rather than left as loose
# JSON keys. Global, never per-project — that is the decision that stops one
# idea becoming four fields with four ids the way it did in Jira.
#
# key, name, kind, description
FIELDS = [
    ("utility_points", "Utility points", "number",
     "The delivery KPI. Set on development work; drives the dev leaderboard."),
    ("feature_utility_points", "Feature utility points", "number",
     "The testing equivalent, set where someone is the tester on an issue."),
    ("risk", "Risk", "select", "How much could this break."),
    ("root_cause", "Root cause", "text", "Filled in after a bug is fixed."),
    ("environment", "Environment", "select", "Where it was seen."),
]

FIELD_OPTIONS = {
    "risk": ["low", "medium", "high"],
    "environment": ["production", "staging", "local"],
}

# key, name, description. The keys are permanent and end up in git branches, so
# they are short. Change them here BEFORE the first issue exists.
PROJECTS = [
    ("CD",  "Classic Dev",           "Delivery the established way. Workflow from DRC."),
    ("AIF", "AI First Development",  "Work built AI-first. Workflow from AID."),
    ("QAB", "QA Board",              "Testing and quality. Workflow from QA."),
    ("DVO", "DevOps Board",          "Infrastructure and operations. Workflow from OPS."),
]


def _get_or_create(conn: Connection, table, match: dict, values: dict) -> int:
    where = [table.c[k] == v for k, v in match.items()]
    existing = conn.execute(select(table.c.id).where(*where)).scalar()
    if existing is not None:
        return int(existing)
    return int(conn.execute(
        table.insert().values(**{**match, **values}).returning(table.c.id)
    ).scalar_one())


def run(conn: Connection) -> dict:
    """Create anything missing. Returns what exists afterwards."""
    status_ids = {
        key: _get_or_create(conn, statuses, {"key": key},
                            {"name": name, "category": cat, "colour": colour})
        for key, name, cat, colour in STATUSES
    }
    type_ids = {
        key: _get_or_create(conn, issue_types, {"key": key},
                            {"name": name, "icon": icon, "colour": colour,
                             "hierarchy_level": level})
        for key, name, icon, colour, level in ISSUE_TYPES
    }
    # Types created before the marks were named still hold a character. Swap
    # the ones we recognise; leave anything else alone, because a character
    # somebody chose deliberately is still a valid mark.
    for glyph, icon in GLYPH_TO_ICON.items():
        conn.execute(issue_types.update()
                     .where(issue_types.c.icon == glyph)
                     .values(icon=icon))

    field_ids = {
        key: _get_or_create(conn, field_defs, {"key": key},
                            {"name": name, "kind": kind, "description": description,
                             "options": FIELD_OPTIONS.get(key, [])})
        for key, name, kind, description in FIELDS
    }

    project_ids = {}
    for pos, (key, name, description) in enumerate(PROJECTS):
        pid = _get_or_create(conn, projects, {"key": key},
                             {"name": name, "description": description, "position": pos})
        project_ids[key] = pid
        spec = WORKFLOWS[key]

        # One workflow per project, named after the board so the Jira lineage
        # stays visible in the database rather than only in a comment.
        wf = _get_or_create(
            conn, workflows, {"name": f"{name} workflow"},
            {"description": f"Captured from Jira project {spec['from_jira']}.",
             # What "shipped" means differs per board: DRC ends at Live, QA at
             # Done. Hard-coding either is how "DRC ships to LIVE but QA ends at
             # Done" became a special case in three different reports.
             "shipped_status_id": status_ids.get(
                 "live" if "live" in spec["statuses"] else "done")},
        )

        for order, status_key in enumerate(spec["statuses"]):
            exists = conn.execute(
                select(workflow_statuses.c.status_id)
                .where(workflow_statuses.c.workflow_id == wf)
                .where(workflow_statuses.c.status_id == status_ids[status_key])
            ).scalar()
            if exists is None:
                conn.execute(workflow_statuses.insert().values(
                    workflow_id=wf, status_id=status_ids[status_key], position=order))

        # The real graph, edge for edge. Names read the way a person would say
        # the move out loud: "→ In Review", "← back to To Do".
        order_index = {k: i for i, k in enumerate(spec["statuses"])}
        names = {k: n for k, n, *_ in STATUSES}
        for pos_i, (frm, tos) in enumerate(spec["transitions"].items()):
            if frm not in status_ids:
                continue
            for to in tos:
                if to not in status_ids:
                    continue
                back = order_index.get(to, 0) < order_index.get(frm, 0)
                label = f"{'←' if back else '→'} {names[to]}"
                exists = conn.execute(
                    select(transitions.c.id)
                    .where(transitions.c.workflow_id == wf)
                    .where(transitions.c.from_status_id == status_ids[frm])
                    .where(transitions.c.to_status_id == status_ids[to])
                ).scalar()
                if exists is None:
                    conn.execute(transitions.insert().values(
                        workflow_id=wf, from_status_id=status_ids[frm],
                        to_status_id=status_ids[to], name=label,
                        position=order_index.get(to, pos_i)))

        # No status may be a dead end. Three AID statuses had no live issue to
        # sample, so they arrived with no outgoing moves — and in a strict
        # workflow that is an issue that can never leave. Give each a forward
        # step and an abandon, and say in the name that it was inferred.
        for gap in UNSAMPLED.get(key, []):
            if gap not in status_ids or gap not in order_index:
                continue
            nxt = order_index[gap] + 1
            targets = [spec["statuses"][nxt]] if nxt < len(spec["statuses"]) else []
            if "wont_do" in status_ids and "wont_do" in spec["statuses"]:
                targets.append("wont_do")
            for to in targets:
                exists = conn.execute(
                    select(transitions.c.id)
                    .where(transitions.c.workflow_id == wf)
                    .where(transitions.c.from_status_id == status_ids[gap])
                    .where(transitions.c.to_status_id == status_ids[to])
                ).scalar()
                if exists is None:
                    conn.execute(transitions.insert().values(
                        workflow_id=wf, from_status_id=status_ids[gap],
                        to_status_id=status_ids[to],
                        name=f"→ {names[to]}",
                        position=order_index.get(to, 99),
                        conditions={"inferred": True,
                                    "reason": "no issue was in this status when "
                                              "the workflow was captured"}))

        # Which field each type asks for. The QA board tracks the testing KPI,
        # everywhere else tracks the delivery one — the split that took three
        # reports to work out in Jira, stated once here.
        kpi = "feature_utility_points" if key == "QAB" else "utility_points"
        for t_key in PROJECT_TYPES[key]:
            if t_key in ("epic", "subtask"):
                continue
            wanted = [kpi] + (["risk", "environment", "root_cause"]
                              if t_key in ("bug", "defect", "live_bug") else [])
            for f_pos, f_key in enumerate(wanted):
                exists = conn.execute(
                    select(field_usage.c.id)
                    .where(field_usage.c.project_id == pid)
                    .where(field_usage.c.issue_type_id == type_ids[t_key])
                    .where(field_usage.c.field_id == field_ids[f_key])
                ).scalar()
                if exists is None:
                    conn.execute(field_usage.insert().values(
                        field_id=field_ids[f_key], project_id=pid,
                        issue_type_id=type_ids[t_key],
                        required=f_key == kpi and t_key != "task",
                        position=f_pos))

        for t_pos, t_key in enumerate(PROJECT_TYPES[key]):
            exists = conn.execute(
                select(project_issue_types.c.project_id)
                .where(project_issue_types.c.project_id == pid)
                .where(project_issue_types.c.issue_type_id == type_ids[t_key])
            ).scalar()
            if exists is None:
                conn.execute(project_issue_types.insert().values(
                    project_id=pid, issue_type_id=type_ids[t_key], position=t_pos))

        exists = conn.execute(
            select(project_workflows.c.id)
            .where(project_workflows.c.project_id == pid)
            .where(project_workflows.c.issue_type_id.is_(None))
        ).scalar()
        if exists is None:
            conn.execute(project_workflows.insert().values(
                project_id=pid, issue_type_id=None, workflow_id=wf))

        # A board and a list per project. They are just saved views, so these
        # are a starting point to change rather than a layout to live with.
        for v_pos, (v_name, renderer, group_by) in enumerate(
                [("Board", "columns", "status"), ("All issues", "table", "none")]):
            exists = conn.execute(
                select(views.c.id).where(views.c.project_id == pid).where(views.c.name == v_name)
            ).scalar()
            if exists is None:
                conn.execute(views.insert().values(
                    project_id=pid, name=v_name, shared=True, renderer=renderer,
                    group_by=group_by, position=v_pos,
                    filter={"all": [{"field": "project_id", "op": "eq", "value": pid}]},
                    columns=["key", "summary", "status", "assignee", "priority", "updated_at"],
                    sort=[{"field": "rank"}]))

    return {"statuses": len(status_ids), "types": len(type_ids),
            "fields": len(field_ids), "projects": len(project_ids),
            "workflows": len(WORKFLOWS)}
