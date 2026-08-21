"""HTTP routes for the tracker.

Thin on purpose: parse, authorise, call repo/query, return. No SQL lives here —
writes go through repo.py so the event log cannot be bypassed, and reads go
through query.py so a filter is compiled rather than concatenated.

Every route answers 503 with a readable message when no database is configured,
which is the normal state on live. That is the whole reason this module can ship
before devops has provisioned anything.
"""
from __future__ import annotations

import json
import os
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, text

from .. import db
from . import (
    admin, asks as asks_mod, automation, git, github_app, insights,
    labels as labels_mod, links, mock, notify, query, releases as rel, repo,
    seed, views as views_mod, work,
)
from .admin import SettingsError
from .links import LinkError
from .work import WorkError
from .repo import Actor, TrackerError
from .schema import (
    automation_rules, automation_runs, components, field_defs, issue_types,
    issues, project_issue_types, project_workflows, projects, release_actions,
    statuses, team_members, teams, transitions, users, views, workflow_statuses,
)

router = APIRouter(prefix="/api/nox", tags=["nox"])


def _engine():
    eng = db.engine()
    if eng is None:
        # 503, not 500: nothing is broken, there is simply no database yet.
        raise HTTPException(503, "The tracker is not connected to a database yet.")
    return eng


def _actor(request: Request) -> Actor:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Not authenticated")
    return Actor(id=user["id"], kind="human")


def _admin(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if not user or user.get("role") != "admin":
        raise HTTPException(403, "Only an admin can change project settings.")
    return user


def _scope(conn, request: Request, filter: dict | None) -> dict | None:
    """Narrow a filter to the projects this person may see.

    Applied on every read rather than only in the sidebar. A "who can see it"
    setting that merely hides a project from a list is decorative, and worse
    than none, because people believe it.
    """
    allowed = admin.visible_project_ids(conn, getattr(request.state, "user", None))
    if allowed is None:
        return filter
    clause = {"field": "project_id", "op": "in", "value": sorted(allowed) or [0]}
    return {"all": [filter, clause]} if filter else {"all": [clause]}


def _sync_user(conn, user: dict) -> None:
    """Keep the Postgres projection of this person up to date.

    Accounts live in SQLite, so there is no foreign key to lean on. Mirroring
    the handful of columns we filter, sort and group by keeps those in SQL
    instead of an in-memory join after every query. Refreshed on the way past.
    """
    values = {
        "display_name": user.get("nickname") or user.get("username") or "",
        "avatar": user.get("avatar") or "",
        "active": True,
    }
    updated = conn.execute(
        users.update().where(users.c.id == user["id"]).values(**values)
    ).rowcount
    if not updated:
        conn.execute(users.insert().values(id=user["id"], **values))


# ------------------------------------------------------------------- schema --

@router.get("/status")
async def status() -> dict:
    return db.status()


@router.post("/setup")
async def setup(request: Request) -> dict:
    """Create the starting statuses, types, workflow and projects.

    Idempotent, so it is safe to press twice and safe to call again after new
    defaults are added.
    """
    user = getattr(request.state, "user", None)
    if not user or user.get("role") != "admin":
        raise HTTPException(403, "Only an admin can set the tracker up.")
    with _engine().begin() as conn:
        result = seed.run(conn)
        _sync_user(conn, user)
    return {"ok": True, **result}


@router.get("/meta")
async def meta(request: Request) -> dict:
    """Everything the UI needs to render forms and boards without a round trip
    per dropdown: projects, types, statuses, fields and views."""
    actor = _actor(request)
    with _engine().connect() as conn:
        allowed = admin.visible_project_ids(conn, request.state.user)
        project_q = (select(projects).where(projects.c.archived_at.is_(None))
                     .order_by(projects.c.position, projects.c.id))
        if allowed is not None:
            project_q = project_q.where(projects.c.id.in_(sorted(allowed) or [0]))
        return {
            # Who is asking. Needed wherever the UI has to tell "yours" from
            # "somebody else's" — an ask directed at you is answerable, one
            # directed at a colleague is only readable.
            "me": actor.id,
            "projects": [dict(r) for r in conn.execute(project_q).mappings()],
            "issueTypes": [dict(r) for r in conn.execute(
                select(issue_types).where(issue_types.c.archived_at.is_(None))
                .order_by(issue_types.c.hierarchy_level.desc(), issue_types.c.id)).mappings()],
            "statuses": [dict(r) for r in conn.execute(
                select(statuses).where(statuses.c.archived_at.is_(None))
                .order_by(statuses.c.id)).mappings()],
            "fields": [dict(r) for r in conn.execute(
                select(field_defs).where(field_defs.c.archived_at.is_(None))
                .order_by(field_defs.c.id)).mappings()],
            "views": [dict(r) for r in conn.execute(
                select(views).order_by(views.c.position, views.c.id)).mappings()],
        }


# ------------------------------------------------------------------- issues --

class IssueCreate(BaseModel):
    project_id: int
    issue_type_id: int
    summary: str = Field(min_length=1, max_length=500)
    description: str = ""
    status_id: int | None = None
    assignee_id: int | None = None
    tester_id: int | None = None
    priority: str = "medium"
    parent_id: int | None = None
    custom: dict[str, Any] = Field(default_factory=dict)


class IssueUpdate(BaseModel):
    summary: str | None = None
    issue_type_id: int | None = None
    description: str | None = None
    assignee_id: int | None = None
    tester_id: int | None = None
    priority: str | None = None
    parent_id: int | None = None
    rank: str | None = None
    custom: dict[str, Any] | None = None


class BoardOrder(BaseModel):
    project_id: int
    status_ids: list[int]
    priority: str
    issue_ids: list[int]


class Transition(BaseModel):
    status_id: int


class CommentIn(BaseModel):
    body: str = Field(min_length=1, max_length=20000)


class Search(BaseModel):
    filter: dict | None = None
    sort: list[dict] | None = None
    limit: int = 100
    offset: int = 0


@router.post("/issues/search")
async def search(body: Search, request: Request) -> dict:
    _actor(request)
    try:
        with _engine().connect() as conn:
            return query.list_issues(conn, filter=_scope(conn, request, body.filter),
                                     sort=body.sort,
                                     limit=body.limit, offset=body.offset)
    except query.QueryError as exc:
        raise HTTPException(400, str(exc))


@router.get("/search")
async def search_everything(request: Request, q: str = "", limit: int = 25) -> list[dict]:
    """The header's search box: every project, and the three places words live."""
    _actor(request)
    with _engine().connect() as conn:
        allowed = admin.visible_project_ids(conn, request.state.user)
        return query.search_everything(conn, q, limit=limit, project_ids=allowed)


@router.post("/board")
async def board(body: dict, request: Request) -> dict:
    _actor(request)
    try:
        with _engine().connect() as conn:
            return query.board(conn, {**body, "filter": _scope(conn, request, body.get("filter"))})
    except query.QueryError as exc:
        raise HTTPException(400, str(exc))


@router.get("/issues/{ident}")
async def get_issue(ident: str, request: Request) -> dict:
    _actor(request)
    with _engine().connect() as conn:
        issue = query.get_issue(conn, ident)
        if issue is None:
            raise HTTPException(404, f"No issue {ident}")
        allowed = admin.visible_project_ids(conn, request.state.user)
        # 404 rather than 403: a restricted project should not confirm that the
        # issue exists to someone who may not see it.
        if allowed is not None and issue["project_id"] not in allowed:
            raise HTTPException(404, f"No issue {ident}")
        issue["activity"] = query.activity(conn, "issue", issue["id"])
        return issue


@router.post("/issues")
async def create_issue(body: IssueCreate, request: Request) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        status_id = body.status_id or _first_status(conn, body.project_id, body.issue_type_id)
        try:
            created = repo.create_issue(
                conn, actor,
                project_id=body.project_id, issue_type_id=body.issue_type_id,
                status_id=status_id, summary=body.summary,
                description=body.description, assignee_id=body.assignee_id,
                tester_id=body.tester_id,
                reporter_id=actor.id, priority=body.priority,
                parent_id=body.parent_id, custom=body.custom,
            )
        except TrackerError as exc:
            raise HTTPException(400, str(exc))
        # Enriched, so the caller can render the card without a second request.
        return query.get_issue(conn, created["id"])


@router.patch("/issues/{issue_id}")
async def update_issue(issue_id: int, body: IssueUpdate, request: Request) -> dict:
    actor = _actor(request)
    changes = body.model_dump(exclude_unset=True, exclude={"custom"})
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        try:
            repo.update_issue(conn, actor, issue_id, changes, custom=body.custom)
        except TrackerError as exc:
            raise HTTPException(400, str(exc))
        return query.get_issue(conn, issue_id)


@router.delete("/issues/{issue_id}")
async def archive_issue(issue_id: int, request: Request) -> dict:
    """Archive, never delete.

    Events point at issues, and a deleted issue would leave a history nobody
    can read — which is the reporting story gone. Archived issues drop out of
    every list and stay in the database.
    """
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        try:
            repo.update_issue(conn, actor, issue_id, {"archived_at": "now"})
        except TrackerError as exc:
            raise HTTPException(400, str(exc))
    return {"ok": True}


@router.get("/projects/{project_id}/statuses")
async def project_statuses(project_id: int, request: Request) -> list[dict]:
    """The statuses in this project's workflow, in its own order.

    Its own route because the card needs it to draw the status list, and asking
    for a whole board to find out is a heavy query for a dropdown.
    """
    _actor(request)
    with _engine().connect() as conn:
        return [dict(r) for r in conn.execute(
            select(statuses.c.id, statuses.c.key, statuses.c.name,
                   statuses.c.category, statuses.c.colour)
            .select_from(workflow_statuses.join(
                statuses, workflow_statuses.c.status_id == statuses.c.id))
            .where(workflow_statuses.c.workflow_id.in_(
                select(project_workflows.c.workflow_id)
                .where(project_workflows.c.project_id == project_id)))
            .order_by(workflow_statuses.c.position)).mappings()]


@router.get("/users")
async def list_users(request: Request) -> list[dict]:
    """Everyone the tracker knows about, for the assignee and tester pickers.

    Carries their craft, which lives on their team membership rather than on
    them — so a picker can say "QA" beside a name without a second request.
    DISTINCT ON keeps one row per person: the model says one team each, and a
    picker that lists somebody twice is a picker nobody trusts.
    """
    _actor(request)
    with _engine().connect() as conn:
        rows = [dict(r) for r in conn.execute(
            select(users, team_members.c.craft, team_members.c.team_id)
            .select_from(users.outerjoin(
                team_members, team_members.c.user_id == users.c.id))
            .where(users.c.active.is_(True))
            .distinct(users.c.id)
            .order_by(users.c.id)).mappings()]
        rows.sort(key=lambda r: r["display_name"].lower())
        return rows


# ---------------------------------------------------------------------- git --

@router.post("/git/webhook")
async def git_webhook(request: Request) -> dict:
    """GitHub calls this. Nobody else should be able to.

    Public by necessity — GitHub cannot hold a session — so the only thing
    standing between this endpoint and the open internet is the HMAC over the
    raw body. With no secret configured it refuses everything rather than
    trusting whoever called: an open write endpoint is worse than a broken
    integration, because nothing tells you it is open.
    """
    secret = os.getenv("TRACKER_GIT_WEBHOOK_SECRET", "").strip()
    body = await request.body()
    signature = request.headers.get("X-Hub-Signature-256", "")
    try:
        if not git.verify(secret, body, signature):
            raise HTTPException(401, "bad signature")
    except git.GitError as exc:
        raise HTTPException(503, str(exc))

    event = request.headers.get("X-GitHub-Event", "")
    try:
        payload = json.loads(body or b"{}")
    except ValueError:
        raise HTTPException(400, "body is not JSON")

    with _engine().begin() as conn:
        # repo.SYSTEM, not a person: an issue moved by a merge should say so in
        # its history rather than name whoever happened to have a session open.
        return git.from_webhook(conn, repo.SYSTEM, event, payload)


@router.get("/git/status")
async def git_status(request: Request) -> dict:
    """Everything the Git settings panel needs in one answer.

    Not configured is a state, not an error — the same rule the database
    follows. The panel shows the registration steps instead of a red box.
    """
    _actor(request)
    ready = github_app.configured()
    out: dict[str, Any] = {
        "configured": ready,
        "webhookSecretSet": bool(os.getenv("TRACKER_GIT_WEBHOOK_SECRET", "").strip()),
        "installations": [],
        "installUrl": None,
    }
    if not ready:
        out["message"] = (
            "No GitHub App is registered yet. Once one is, connecting an "
            "organisation is a single click and nobody has to paste a token.")
        return out
    try:
        out["installUrl"] = github_app.install_url()
    except github_app.AppError as exc:
        out["message"] = str(exc)

    with _engine().connect() as conn:
        out["installations"] = [
            {**row, "connected_at": row["connected_at"],
             "last_sync_at": row["last_sync_at"]}
            for row in github_app.live(conn)
        ]
    return out


@router.get("/git/connect")
async def git_connect(request: Request) -> dict:
    """Where the Connect button points."""
    _admin(request)
    try:
        return {"url": github_app.install_url()}
    except github_app.AppError as exc:
        raise HTTPException(503, str(exc))


@router.post("/git/connected")
async def git_connected(request: Request, installation_id: int) -> dict:
    """GitHub sends the browser back here after the install.

    The id arrives in a query string, which makes it a claim rather than a
    fact — so it is checked against GitHub before anything is stored. Without
    that, anyone could post someone else's installation id and have us read
    their repositories.
    """
    user = _admin(request)
    try:
        described = await github_app.describe(installation_id)
    except github_app.AppError as exc:
        raise HTTPException(400, str(exc))

    with _engine().begin() as conn:
        github_app.remember(conn, user["id"], described)
    return described


@router.delete("/git/installations/{installation_id}")
async def git_disconnect(installation_id: int, request: Request) -> dict:
    """Forget an installation on our side.

    Marked, not deleted, and it does NOT uninstall the app on GitHub — that is
    the org's decision to make in their own settings, not ours to make for them.
    """
    _admin(request)
    with _engine().begin() as conn:
        github_app.remove(conn, installation_id)
    return {"ok": True, "note": "The app is still installed on GitHub until an "
                                "owner removes it there."}


@router.post("/git/sync")
async def git_sync(request: Request, repo_name: str | None = None,
                   pages: int = 2) -> dict:
    """Pull recent PRs for the configured repositories.

    The webhook is the real mechanism; this is what makes the integration
    usable before anybody has configured one, and what repairs the record after
    a delivery is missed.
    """
    _actor(request)
    try:
        return await git.sync(_engine(), only=repo_name, pages=pages)
    except git.NothingToSync as exc:
        raise HTTPException(400, str(exc))
    except git.NoCredentials as exc:
        raise HTTPException(503, str(exc))


# -------------------------------------------------------------------- labels --

@router.get("/people/{user_id}/projects")
async def person_projects(user_id: int, request: Request) -> list[dict]:
    """What this person can see, and why. Admin-only: it is the answer to a
    question about somebody else."""
    _admin(request)
    with _engine().connect() as conn:
        return admin.seen_by(conn, user_id, _tags_of(user_id))


@router.put("/people/{user_id}/projects/{project_id}")
async def name_person_on_project(user_id: int, project_id: int,
                                 request: Request, body: dict) -> list[dict]:
    """Name somebody on a project, or take them off it."""
    who = _admin(request)
    with _engine().begin() as conn:
        admin.name_on_project(conn, project_id, user_id,
                              bool(body.get("granted")), who["id"])
        return admin.seen_by(conn, user_id, _tags_of(user_id))


def _tags_of(user_id: int) -> set[str]:
    """An account's tags, so a project opened to a tag shows as reachable
    rather than as something this person is mysteriously missing."""
    try:
        from ..main import auth
        row = auth.by_id(user_id)
        return {t for t in (row["tags"] or "").split(",") if t} if row else set()
    except Exception:
        return set()


# ------------------------------------------------------------------ views --

@router.get("/views")
async def list_views(request: Request, project_id: int | None = None) -> list[dict]:
    """Yours first, then the team's."""
    actor = _actor(request)
    with _engine().connect() as conn:
        return views_mod.for_user(conn, actor, request.state.user, project_id)


@router.post("/views")
async def create_view(request: Request, body: dict) -> dict:
    """Keep the board the way it is set up right now."""
    actor = _actor(request)
    with _engine().begin() as conn:
        try:
            return views_mod.create(conn, actor, body)
        except views_mod.ViewError as e:
            raise HTTPException(400, str(e)) from e


@router.patch("/views/{view_id}")
async def patch_view(view_id: int, request: Request, body: dict) -> dict:
    """Rename it, re-point it at what the board shows now, or share it."""
    actor = _actor(request)
    with _engine().begin() as conn:
        try:
            return views_mod.update(conn, actor, request.state.user, view_id, body)
        except views_mod.ViewError as e:
            raise HTTPException(404, str(e)) from e


@router.delete("/views/{view_id}")
async def delete_view(view_id: int, request: Request) -> dict:
    """Really delete. A view is an arrangement, not a record of anything — there
    is no history to keep and nothing points at it."""
    actor = _actor(request)
    with _engine().begin() as conn:
        try:
            views_mod.remove(conn, actor, request.state.user, view_id)
        except views_mod.ViewError as e:
            raise HTTPException(404, str(e)) from e
    return {"ok": True}


@router.get("/labels")
async def list_labels(request: Request) -> list[dict]:
    """Every label, commonest first — the only ranking that means anything for
    a list people type into."""
    _actor(request)
    with _engine().connect() as conn:
        return labels_mod.all_labels(conn)


@router.post("/issues/{issue_id}/labels")
async def add_label(issue_id: int, request: Request, body: dict) -> list[dict]:
    """Put a label on an issue, making it if nobody has used the word yet.

    There is no "create a label" screen on purpose: an admin curating the list
    before anybody may tag anything is how a tag system ends up with eleven
    labels nobody uses and the actual words living in the summary.
    """
    actor = _actor(request)
    with _engine().begin() as conn:
        try:
            return labels_mod.add(conn, actor, issue_id, body.get("name", ""))
        except labels_mod.LabelError as exc:
            raise HTTPException(400, str(exc))


@router.delete("/issues/{issue_id}/labels/{label_id}")
async def drop_label(issue_id: int, label_id: int, request: Request) -> list[dict]:
    actor = _actor(request)
    with _engine().begin() as conn:
        return labels_mod.remove(conn, actor, issue_id, label_id)


@router.patch("/labels/{label_id}")
async def patch_label(label_id: int, body: dict, request: Request) -> dict:
    """Rename, recolour or archive. Global, like the statuses it sits beside —
    the key never moves, because that is what "the same label" means."""
    _admin(request)
    with _engine().begin() as conn:
        try:
            return labels_mod.update(conn, label_id, body)
        except labels_mod.LabelError as exc:
            raise HTTPException(400, str(exc))


# ------------------------------------------------------------- notifications --

@router.get("/notifications")
async def list_notifications(request: Request, limit: int = 30) -> dict:
    """The bell: what is unread, and what recently was."""
    actor = _actor(request)
    with _engine().connect() as conn:
        return {
            "unread": notify.unread_count(conn, actor.id),
            "items": notify.recent(conn, actor.id, min(max(limit, 1), 100)),
        }


@router.post("/notifications/read")
async def read_notifications(request: Request, body: dict | None = None) -> dict:
    """Mark some read, or everything if no ids are given."""
    actor = _actor(request)
    ids = (body or {}).get("ids") or None
    with _engine().begin() as conn:
        notify.mark_read(conn, actor.id, ids)
        return {
            "unread": notify.unread_count(conn, actor.id),
            "items": notify.recent(conn, actor.id),
        }


@router.get("/notifications/prefs")
async def get_notification_prefs(request: Request) -> dict:
    """Four switches. The list is short enough that the default is on and the
    setting exists to turn one off rather than to opt in."""
    actor = _actor(request)
    with _engine().connect() as conn:
        return notify.prefs(conn, actor.id)


@router.put("/notifications/prefs/{kind}")
async def set_notification_pref(kind: str, request: Request, on: bool = True) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        try:
            return notify.set_pref(conn, actor.id, kind, on)
        except ValueError as exc:
            raise HTTPException(400, str(exc))


# ---------------------------------------------------------------------- asks --

class AskNew(BaseModel):
    issue_id: int
    asked_of: int
    kind: str
    question: str = Field(min_length=1, max_length=2000)
    blocking: bool = False


class AskAnswer(BaseModel):
    answer: str = Field(default="", max_length=4000)


@router.get("/asks/kinds")
async def ask_kinds(request: Request) -> dict:
    """The four shapes, and what coming back looks like for each."""
    _actor(request)
    return asks_mod.KINDS


@router.post("/asks")
async def create_ask(body: AskNew, request: Request) -> dict:
    """Ask somebody something about an issue."""
    actor = _actor(request)
    with _engine().begin() as conn:
        try:
            return asks_mod.ask(
                conn, actor, issue_id=body.issue_id, asked_of=body.asked_of,
                kind=body.kind, question=body.question, blocking=body.blocking)
        except asks_mod.AskError as exc:
            raise HTTPException(400, str(exc))


@router.post("/asks/{ask_id}/answer")
async def answer_ask(ask_id: int, body: AskAnswer, request: Request) -> dict:
    """Come back to somebody."""
    actor = _actor(request)
    with _engine().begin() as conn:
        try:
            return asks_mod.answer(conn, actor, ask_id, body.answer)
        except asks_mod.AskError as exc:
            raise HTTPException(400, str(exc))


@router.post("/asks/{ask_id}/decline")
async def decline_ask(ask_id: int, body: AskAnswer, request: Request) -> dict:
    """Say no, or say it is not yours. Kept apart from answering because a
    queue that cannot tell them apart is a queue people clear badly."""
    actor = _actor(request)
    with _engine().begin() as conn:
        try:
            return asks_mod.decline(conn, actor, ask_id, body.answer)
        except asks_mod.AskError as exc:
            raise HTTPException(400, str(exc))


@router.post("/asks/{ask_id}/withdraw")
async def withdraw_ask(ask_id: int, request: Request) -> dict:
    """Take it back. Only the person who asked may."""
    actor = _actor(request)
    with _engine().begin() as conn:
        try:
            return asks_mod.withdraw(conn, actor, ask_id)
        except asks_mod.AskError as exc:
            raise HTTPException(400, str(exc))


# ------------------------------------------------------------------ insights --

@router.get("/insights/overview")
async def insights_overview(request: Request, project: str | None = None,
                            days: int = 30) -> dict:
    """Four numbers with a comparison, and created versus finished."""
    _actor(request)
    with _engine().connect() as conn:
        return insights.overview(
            conn, project_id=insights.project_id_for(conn, project),
            days=_period(days))


@router.get("/insights/flow")
async def insights_flow(request: Request, project: str | None = None,
                        days: int = 30) -> dict:
    """Where work waits, how long it takes, and who is moving it."""
    _actor(request)
    with _engine().connect() as conn:
        return insights.flow(
            conn, project_id=insights.project_id_for(conn, project),
            days=_period(days))


def _period(days: int) -> int:
    """A window somebody asked for, clamped to one somebody can read.

    The upper bound is not a performance guard — it is that a year of daily
    buckets is a texture, not a chart, and the page already switches to weeks
    past six weeks.
    """
    return max(7, min(int(days), 365))


@router.get("/git/refs")
async def git_refs_for(request: Request, issue_id: int) -> list[dict]:
    """Everything git knows about one issue."""
    _actor(request)
    with _engine().connect() as conn:
        return git.for_issues(conn, [issue_id]).get(issue_id, [])


@router.post("/board/order")
async def reorder_board(body: BoardOrder, request: Request) -> dict:
    """Reorder one priority band of one board column.

    The whole band in one request, like every other reorder here: rewriting a
    band is cheap at this size, and it cannot leave the order half-applied the
    way a sequence of little moves can.
    """
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        try:
            work.reorder_board_band(
                conn, actor, project_id=body.project_id, status_ids=body.status_ids,
                priority=body.priority, issue_ids=body.issue_ids)
        except WorkError as exc:
            raise HTTPException(400, str(exc))
        return {"ok": True}


@router.post("/issues/{issue_id}/transition")
async def transition(issue_id: int, body: Transition, request: Request) -> dict:
    """Move an issue, if the workflow allows that move.

    Transitions are strict here by design. The refusal names the reason rather
    than hiding the option, because a rule you cannot see is indistinguishable
    from a broken page.
    """
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        issue = query.get_issue(conn, issue_id)
        if issue is None:
            raise HTTPException(404, f"No issue {issue_id}")
        allowed = _allowed_transitions(conn, issue["project_id"],
                                       issue["issue_type_id"], issue["status_id"])
        if body.status_id not in {t["to_status_id"] for t in allowed}:
            names = ", ".join(t["name"] for t in allowed) or "nothing"
            raise HTTPException(
                409, f"{issue['key']} cannot move there from {issue['status_name']}. "
                     f"Available: {names}.")
        try:
            repo.update_issue(conn, actor, issue_id, {"status_id": body.status_id})
        except TrackerError as exc:
            raise HTTPException(400, str(exc))
        return query.get_issue(conn, issue_id)


@router.get("/issues/{issue_id}/transitions")
async def list_transitions(issue_id: int, request: Request) -> list[dict]:
    _actor(request)
    with _engine().connect() as conn:
        issue = query.get_issue(conn, issue_id)
        if issue is None:
            raise HTTPException(404, f"No issue {issue_id}")
        return _allowed_transitions(conn, issue["project_id"],
                                    issue["issue_type_id"], issue["status_id"])


@router.post("/issues/{issue_id}/comments")
async def comment(issue_id: int, body: CommentIn, request: Request) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        try:
            return repo.add_comment(conn, actor, issue_id, body.body)
        except TrackerError as exc:
            raise HTTPException(400, str(exc))


# ----------------------------------------------------------------- releases --

class ReleaseIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    kind: str = "standard"
    description: str = ""
    cycle_start: str | None = None
    planned_at: str | None = None


class ReleasePatch(BaseModel):
    name: str | None = None
    kind: str | None = None
    state: str | None = None
    description: str | None = None
    notes: str | None = None
    notes_published: bool | None = None
    cycle_start: str | None = None
    planned_at: str | None = None


class ArtifactIn(BaseModel):
    component_id: int
    version: str = ""
    planned_at: str | None = None


class ActionIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    description: str = ""
    owner_id: int | None = None


class ComponentIn(BaseModel):
    key: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=200)
    repo: str = ""


class ReleaseIssues(BaseModel):
    issue_ids: list[int] = Field(default_factory=list)
    filter: dict | None = None


@router.get("/releases")
async def list_releases(request: Request, state: str | None = None) -> list[dict]:
    _actor(request)
    with _engine().connect() as conn:
        return rel.listing(conn, state=state)


@router.post("/releases")
async def create_release(body: ReleaseIn, request: Request) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        try:
            return rel.create(conn, actor, **body.model_dump(exclude_none=True))
        except TrackerError as exc:
            raise HTTPException(400, str(exc))


@router.get("/releases/timeline")
async def release_timeline(request: Request, months_back: int = 4,
                           months_on: int = 2) -> dict:
    """Every dated release, with what it ships — the timeline's one request."""
    _actor(request)
    with _engine().connect() as conn:
        return rel.timeline(conn, months_back=months_back, months_on=months_on)


@router.get("/releases/{release_id}")
async def get_release(release_id: int, request: Request) -> dict:
    _actor(request)
    with _engine().connect() as conn:
        found = rel.detail(conn, release_id)
        if found is None:
            raise HTTPException(404, f"No release {release_id}")
        found["activity"] = query.activity(conn, "release", release_id)
        return found


@router.patch("/releases/{release_id}")
async def patch_release(release_id: int, body: ReleasePatch, request: Request) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        try:
            rel.update_release(conn, actor, release_id, body.model_dump(exclude_unset=True))
        except TrackerError as exc:
            raise HTTPException(400, str(exc))
        return rel.detail(conn, release_id)


@router.post("/releases/{release_id}/issues")
async def add_release_issues(release_id: int, body: ReleaseIssues, request: Request) -> dict:
    """Add issues by id, or everything matching a filter.

    Putting a saved view's worth of work onto a release is the common case, and
    doing it one id at a time from the client is how releases end up incomplete.
    """
    actor = _actor(request)
    ids = list(body.issue_ids)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        if body.filter:
            try:
                found = query.list_issues(conn, filter=body.filter, limit=500)
            except query.QueryError as exc:
                raise HTTPException(400, str(exc))
            ids += [i["id"] for i in found["issues"]]
        try:
            added = rel.add_issues(conn, actor, release_id, ids)
        except TrackerError as exc:
            raise HTTPException(400, str(exc))
        return {"added": added, "release": rel.detail(conn, release_id)}


@router.delete("/releases/{release_id}/issues/{issue_id}")
async def drop_release_issue(release_id: int, issue_id: int, request: Request) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        rel.remove_issue(conn, actor, release_id, issue_id)
        return rel.detail(conn, release_id)


@router.post("/releases/{release_id}/artifacts")
async def add_artifact(release_id: int, body: ArtifactIn, request: Request) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        try:
            rel.add_artifact(conn, actor, release_id, body.component_id,
                             body.version, body.planned_at)
        except TrackerError as exc:
            raise HTTPException(400, str(exc))
        return rel.detail(conn, release_id)


@router.post("/artifacts/{artifact_id}/ship")
async def ship_artifact(artifact_id: int, request: Request, shipped: bool = True) -> dict:
    """Ship one artifact. The release follows once they all have — a release is
    shipped when the things in it are, not on a date somebody typed."""
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        try:
            artifact = rel.ship_artifact(conn, actor, artifact_id, shipped)
        except TrackerError as exc:
            raise HTTPException(400, str(exc))
        return rel.detail(conn, artifact["release_id"])


@router.post("/releases/{release_id}/actions")
async def add_action(release_id: int, body: ActionIn, request: Request) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        try:
            rel.add_action(conn, actor, release_id, body.title, body.description, body.owner_id)
        except TrackerError as exc:
            raise HTTPException(400, str(exc))
        return rel.detail(conn, release_id)


@router.post("/actions/{action_id}/done")
async def complete_action(action_id: int, request: Request, done: bool = True) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        try:
            action = rel.complete_action(conn, actor, action_id, done)
        except TrackerError as exc:
            raise HTTPException(400, str(exc))
        return rel.detail(conn, action["release_id"])


@router.delete("/actions/{action_id}")
async def drop_action(action_id: int, request: Request) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        release_id = conn.execute(
            select(release_actions.c.release_id).where(release_actions.c.id == action_id)
        ).scalar()
        rel.remove_action(conn, actor, action_id)
        return rel.detail(conn, release_id) if release_id else {"ok": True}


@router.get("/releases/{release_id}/notes/draft")
async def draft_notes(release_id: int, request: Request) -> dict:
    """A first draft generated from the issues.

    Deliberately not written straight onto the release: somebody edits these
    before publishing, and silently overwriting that edit is the whole problem.
    """
    _actor(request)
    with _engine().connect() as conn:
        return {"notes": rel.draft_notes(conn, release_id)}


@router.get("/unreleased-issues")
async def unreleased_issues(request: Request, q: str = "", limit: int = 80,
                            kind: str | None = None) -> list[dict]:
    """Issues not on any release — what a release gets built from.

    Its own path rather than /releases/... so it cannot be mistaken for a
    release id, and scoped to what the caller may see like every other read.
    """
    _actor(request)
    with _engine().connect() as conn:
        rows = rel.unreleased(conn, search=q, limit=limit, kind=kind)
        allowed = admin.visible_project_ids(conn, request.state.user)
        if allowed is None:
            return rows
        keys = {p["key"] for p in conn.execute(
            select(projects.c.key).where(projects.c.id.in_(sorted(allowed) or [0]))).mappings()}
        return [r for r in rows if r["project_key"] in keys]


@router.get("/components")
async def list_components(request: Request) -> list[dict]:
    _actor(request)
    with _engine().connect() as conn:
        return [dict(r) for r in conn.execute(
            select(components).where(components.c.archived_at.is_(None))
            .order_by(components.c.position, components.c.id)).mappings()]


@router.post("/components")
async def create_component(body: ComponentIn, request: Request) -> dict:
    _actor(request)
    with _engine().begin() as conn:
        clash = conn.execute(
            select(components.c.id).where(components.c.key == body.key.lower())
        ).scalar()
        if clash is not None:
            raise HTTPException(400, f"A component keyed {body.key} already exists.")
        new_id = conn.execute(components.insert().values(
            key=body.key.lower(), name=body.name, repo=body.repo,
        ).returning(components.c.id)).scalar_one()
        return dict(conn.execute(
            select(components).where(components.c.id == new_id)).mappings().one())


@router.post("/mock")
async def generate_mock(request: Request, wipe: bool = True) -> dict:
    """Fill the tracker with demo data so it can be looked at.

    Admin only, and it empties the tracker's own tables first — which is why it
    is a deliberate button rather than something that runs on setup. It cannot
    reach anything outside the tracker database.
    """
    user = getattr(request.state, "user", None)
    if not user or user.get("role") != "admin":
        raise HTTPException(403, "Only an admin can generate demo data.")
    with _engine().begin() as conn:
        return mock.generate(conn, wipe=wipe)


# --------------------------------------------------------------- automations --

class RuleIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = ""
    enabled: bool = True
    project_id: int | None = None
    trigger: dict = Field(default_factory=dict)
    conditions: dict = Field(default_factory=dict)
    actions: list[dict] = Field(default_factory=list)


class RulePatch(BaseModel):
    name: str | None = None
    description: str | None = None
    enabled: bool | None = None
    project_id: int | None = None
    trigger: dict | None = None
    conditions: dict | None = None
    actions: list[dict] | None = None


@router.get("/automation/blocks")
async def automation_blocks(request: Request) -> dict:
    """The vocabulary the rule builder is allowed to offer.

    Served from the backend rather than hard-coded in the UI so the two cannot
    drift: if a block is not here, the runner does not know it either.
    """
    _actor(request)
    return {
        "triggers": [
            {"type": key, "label": spec["label"], "entity": spec["entity"]}
            for key, spec in automation.TRIGGERS.items()
        ],
        "actions": [
            {"type": "transition", "label": "Move to a status",
             "fields": [{"key": "status_id", "kind": "status", "required": True}]},
            {"type": "assign", "label": "Assign to someone",
             "fields": [{"key": "assignee_id", "kind": "user"}]},
            {"type": "set_field", "label": "Set a field",
             "fields": [{"key": "field", "kind": "field", "required": True},
                        {"key": "value", "kind": "text"}]},
            {"type": "comment", "label": "Add a comment",
             "fields": [{"key": "body", "kind": "template", "required": True}]},
            {"type": "create_issue", "label": "Create an issue",
             "fields": [{"key": "project_id", "kind": "project", "required": True},
                        {"key": "issue_type_id", "kind": "issue_type", "required": True},
                        {"key": "summary", "kind": "template", "required": True},
                        {"key": "description", "kind": "template"},
                        {"key": "priority", "kind": "priority"},
                        {"key": "link_to_release", "kind": "bool"}]},
            {"type": "add_to_release", "label": "Add to a release",
             "fields": [{"key": "release_id", "kind": "release"}]},
            {"type": "for_each", "label": "For each issue…",
             "fields": [{"key": "over", "kind": "choice",
                         "options": ["release_issues", "filter"], "required": True},
                        {"key": "actions", "kind": "actions"}]},
        ],
        # Click-to-insert, never free text — a typo in a variable name should
        # not be something the author can make.
        "variables": [
            "{{issue.key}}", "{{issue.summary}}", "{{issue.status}}",
            "{{issue.type}}", "{{issue.project}}", "{{issue.priority}}",
            "{{release.name}}", "{{release.kind}}", "{{release.state}}",
            "{{release.issues}}",
        ],
        "maxDepth": automation.MAX_DEPTH,
        "failureLimit": automation.FAILURE_LIMIT,
    }


@router.get("/automation/rules")
async def list_rules(request: Request) -> list[dict]:
    _actor(request)
    with _engine().connect() as conn:
        return [dict(r) for r in conn.execute(
            select(automation_rules).order_by(automation_rules.c.id)).mappings()]


@router.post("/automation/rules")
async def create_rule(body: RuleIn, request: Request) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        new_id = conn.execute(automation_rules.insert().values(
            **body.model_dump(), created_by=actor.id,
        ).returning(automation_rules.c.id)).scalar_one()
        return dict(conn.execute(
            select(automation_rules).where(automation_rules.c.id == new_id)).mappings().one())


@router.patch("/automation/rules/{rule_id}")
async def patch_rule(rule_id: int, body: RulePatch, request: Request) -> dict:
    _actor(request)
    changes = body.model_dump(exclude_unset=True)
    with _engine().begin() as conn:
        if changes:
            # Re-enabling by hand clears the circuit breaker, otherwise a rule
            # disabled after five failures would switch itself off again on the
            # first event without anyone understanding why.
            if changes.get("enabled"):
                changes |= {"failure_count": 0, "disabled_reason": ""}
            conn.execute(automation_rules.update()
                         .where(automation_rules.c.id == rule_id)
                         .values(**changes, updated_at=text("now()")))
        found = conn.execute(
            select(automation_rules).where(automation_rules.c.id == rule_id)).mappings().first()
        if found is None:
            raise HTTPException(404, f"No rule {rule_id}")
        return dict(found)


@router.delete("/automation/rules/{rule_id}")
async def delete_rule(rule_id: int, request: Request) -> dict:
    _actor(request)
    with _engine().begin() as conn:
        conn.execute(automation_rules.delete().where(automation_rules.c.id == rule_id))
    return {"ok": True}


@router.get("/automation/rules/{rule_id}/runs")
async def rule_runs(rule_id: int, request: Request, limit: int = 50) -> list[dict]:
    """The audit log for one rule.

    This ships in v1 rather than later on purpose: Jira Automation is only
    tolerable because you can see why a rule did something, and without it
    every surprise is a mystery and the feature gets switched off out of fear.
    """
    _actor(request)
    with _engine().connect() as conn:
        return [dict(r) for r in conn.execute(
            select(automation_runs).where(automation_runs.c.rule_id == rule_id)
            .order_by(automation_runs.c.at.desc()).limit(min(limit, 200))).mappings()]


@router.post("/automation/rules/{rule_id}/dry-run")
async def dry_run(rule_id: int, body: dict, request: Request) -> dict:
    """Run a rule against a real entity without changing anything.

    Authoring a rule blind and finding out on live is how people learn to
    distrust automation. The transaction is rolled back either way.
    """
    _actor(request)
    entity_type = body.get("entity_type", "issue")
    entity_id = body.get("entity_id")
    if not entity_id:
        raise HTTPException(400, "Give an entity_id to try the rule against.")

    engine = _engine()
    with engine.connect() as conn:
        with conn.begin() as tx:
            job = {"id": 0, "rule_id": rule_id, "event_id": None, "depth": 0,
                   "entity_type": entity_type, "entity_id": int(entity_id)}
            result = automation.execute(conn, job, dry_run=True)
            tx.rollback()
    return result


@router.post("/automation/rules/{rule_id}/run")
async def run_rule(rule_id: int, body: dict, request: Request) -> dict:
    """Queue a rule by hand against one entity."""
    _actor(request)
    entity_id = body.get("entity_id")
    if not entity_id:
        raise HTTPException(400, "Give an entity_id to run the rule against.")
    with _engine().begin() as conn:
        rule = conn.execute(
            select(automation_rules).where(automation_rules.c.id == rule_id)).mappings().first()
        if rule is None:
            raise HTTPException(404, f"No rule {rule_id}")
        job_id = automation.enqueue(
            conn, dict(rule), None,
            entity_type=body.get("entity_type", "issue"), entity_id=int(entity_id),
            manual_tag=f"{entity_id}:{body.get('tag', '')}",
        )
    return {"queued": job_id is not None, "job_id": job_id}


@router.post("/automation/tick")
async def automation_tick(request: Request) -> dict:
    """Run the queue now instead of waiting for the worker — used by tests and
    by the "run it now" button, so nobody has to watch a spinner for three
    seconds to find out whether a rule works."""
    user = getattr(request.state, "user", None)
    if not user or user.get("role") != "admin":
        raise HTTPException(403, "Only an admin can drive the queue by hand.")
    with _engine().begin() as conn:
        return automation.tick(conn)


@router.post("/mock/give-me-work")
async def give_me_work(request: Request, team: str = "ROCKET") -> dict:
    """Put a slice of the demo work on the account asking.

    So My work can be looked at as yourself rather than as somebody invented.
    Tops up to about six items, makes one urgent and parks one against it, so
    all four bands have something in them. Safe to press twice.
    """
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        try:
            result = mock.give_to(conn, actor.id, team_key=team)
        except ValueError as exc:
            raise HTTPException(400, str(exc))
        return {**result, "work": work.my_work(conn, actor.id)}


# ---------------------------------------------------------- links & family --

class LinkIn(BaseModel):
    kind: str
    target_key: str


class ParentIn(BaseModel):
    parent_key: str | None = None


@router.get("/link-types")
async def link_types(request: Request) -> list[dict]:
    """The relationships an issue can have, and how each reads both ways."""
    _actor(request)
    return [{"kind": k, **v} for k, v in links.LINK_TYPES.items()]


@router.post("/issues/{issue_id}/links")
async def add_link(issue_id: int, body: LinkIn, request: Request) -> dict:
    """Link this issue to another, by key — which is what people have to hand."""
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        target = conn.execute(
            select(issues.c.id).where(issues.c.key == body.target_key.strip().upper())).scalar()
        if target is None:
            raise HTTPException(404, f"No issue {body.target_key}")
        try:
            links.add(conn, actor, issue_id, int(target), body.kind)
        except (LinkError, TrackerError) as exc:
            raise HTTPException(400, str(exc))
        return query.get_issue(conn, issue_id)


@router.delete("/issues/{issue_id}/links/{link_id}")
async def drop_link(issue_id: int, link_id: int, request: Request) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        links.remove(conn, actor, link_id)
        return query.get_issue(conn, issue_id)


@router.put("/issues/{issue_id}/parent")
async def set_parent(issue_id: int, body: ParentIn, request: Request) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        parent_id = None
        if body.parent_key:
            parent_id = conn.execute(
                select(issues.c.id)
                .where(issues.c.key == body.parent_key.strip().upper())).scalar()
            if parent_id is None:
                raise HTTPException(404, f"No issue {body.parent_key}")
        try:
            links.set_parent(conn, actor, issue_id, int(parent_id) if parent_id else None)
        except (LinkError, TrackerError) as exc:
            raise HTTPException(400, str(exc))
        return query.get_issue(conn, issue_id)


@router.get("/issues/{issue_id}/parent-candidates")
async def parent_candidates(issue_id: int, request: Request, q: str = "") -> list[dict]:
    """What could legally be this issue's parent: same board, higher up."""
    _actor(request)
    with _engine().connect() as conn:
        return links.parent_candidates(conn, issue_id, search=q)


# ------------------------------------------------------------------- work --

class AssignIn(BaseModel):
    assignee_id: int | None = None
    priority: str | None = None
    team_id: int | None = None
    set_team: bool = False


class UrgentIn(BaseModel):
    reason: str = ""
    urgent: bool = True


class PauseIn(BaseModel):
    for_issue_id: int | None = None
    reason: str = ""


class BandOrder(BaseModel):
    assignee_id: int
    priority: str
    issue_ids: list[int]


def _lead_or_admin(request: Request, conn, team_id: int | None = None) -> dict:
    """Leads run their own team; admins run everything.

    Deliberately not "anyone on the team": the order having one owner is what
    makes it worth following, and a queue several people reorder is a queue
    nobody trusts.
    """
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Not authenticated")
    if user.get("role") == "admin":
        return user
    led = work.leads(conn, user["id"])
    if led is None or (team_id is not None and led["id"] != team_id):
        raise HTTPException(403, "Only this team's lead can change its queue.")
    return user


@router.get("/teams")
async def list_teams(request: Request) -> list[dict]:
    _actor(request)
    with _engine().connect() as conn:
        return work.all_teams(conn)


@router.get("/my-work")
async def my_work(request: Request, user_id: int | None = None) -> dict:
    """One developer's screen. Defaults to whoever is asking."""
    actor = _actor(request)
    with _engine().connect() as conn:
        return work.my_work(conn, user_id or actor.id)


@router.get("/team-queue")
async def team_queue(request: Request, team_id: int | None = None) -> dict:
    """A lead's screen, or all of them at once when no team is named.

    Readable by anyone with the tracker — leads see each other's queues, which
    is the point of having two teams in one place. What they may *change* is a
    narrower question, and it is answered per row rather than per screen: the
    All tab shows both teams, and a Rocket lead editing a Sparta row there
    would quietly undo the read-only rule.
    """
    _actor(request)
    with _engine().connect() as conn:
        try:
            queue = work.team_queue(conn, team_id)
        except WorkError as exc:
            raise HTTPException(404, str(exc))
        user = getattr(request.state, "user", {})
        admin_user = user.get("role") == "admin"
        led = work.leads(conn, user.get("id"))

        # Which teams' rows this person may touch. An admin may touch any, so
        # the list is every team rather than a special case downstream.
        if admin_user:
            editable = [t[0] for t in conn.execute(
                select(teams.c.id).where(teams.c.archived_at.is_(None))).all()]
        else:
            editable = [led["id"]] if led else []
        queue["editableTeams"] = editable
        # Free-for-all work is a lead's to pull, whichever team they lead.
        queue["canTakePool"] = admin_user or led is not None
        queue["canEdit"] = bool(editable) if team_id is None else (team_id in editable)
        return queue


@router.get("/plan")
async def plan(request: Request, project_id: int | None = None) -> dict:
    """The PO's screen — everything open, in the order teams should pick it up."""
    _actor(request)
    with _engine().connect() as conn:
        return work.plan(conn, project_id=project_id)


@router.post("/issues/{issue_id}/assign")
async def assign(issue_id: int, body: AssignIn, request: Request) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        row = conn.execute(
            select(issues.c.team_id).where(issues.c.id == issue_id)).mappings().first()
        if row is None:
            raise HTTPException(404, f"No issue {issue_id}")
        # Taking something out of the free-for-all pool is a lead's act, so the
        # check is against the team it is going to, not the one it came from.
        _lead_or_admin(request, conn, body.team_id if body.set_team else row["team_id"])
        try:
            work.assign(conn, actor, issue_id, assignee_id=body.assignee_id,
                        priority=body.priority, team_id=body.team_id,
                        set_team=body.set_team)
        except (WorkError, TrackerError) as exc:
            raise HTTPException(400, str(exc))
        return query.get_issue(conn, issue_id)


@router.post("/issues/{issue_id}/urgent")
async def set_urgent(issue_id: int, body: UrgentIn, request: Request) -> dict:
    """Mark it urgent — which means stop, not "very important"."""
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        row = conn.execute(
            select(issues.c.team_id).where(issues.c.id == issue_id)).mappings().first()
        if row is None:
            raise HTTPException(404, f"No issue {issue_id}")
        _lead_or_admin(request, conn, row["team_id"])
        try:
            work.set_urgent(conn, actor, issue_id, reason=body.reason, urgent=body.urgent)
        except (WorkError, TrackerError) as exc:
            raise HTTPException(400, str(exc))
        return query.get_issue(conn, issue_id)


@router.put("/my-work/order")
async def reorder_band(body: BandOrder, request: Request) -> dict:
    """A developer sequencing one of their own priority bands.

    Their own only: reordering someone else's day is the lead's job, and this
    is the one lever a developer owns.
    """
    actor = _actor(request)
    user = request.state.user
    if user.get("role") != "admin" and body.assignee_id != actor.id:
        raise HTTPException(403, "You can only order your own queue.")
    with _engine().begin() as conn:
        try:
            work.reorder_band(conn, actor, assignee_id=body.assignee_id,
                              priority=body.priority, issue_ids=body.issue_ids)
        except WorkError as exc:
            raise HTTPException(400, str(exc))
        return work.my_work(conn, body.assignee_id)


@router.post("/issues/{issue_id}/pause")
async def pause_issue(issue_id: int, body: PauseIn, request: Request) -> dict:
    """Park something, recording what took over.

    A person presses this. Parking automatically would make the number it
    produces meaningless — it would measure a flag flip rather than someone
    actually stopping.
    """
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        try:
            work.pause(conn, actor, issue_id, for_issue_id=body.for_issue_id,
                       reason=body.reason)
        except (WorkError, TrackerError) as exc:
            raise HTTPException(400, str(exc))
        # The queue that changed belongs to whoever holds the issue, not to
        # whoever pressed the button — a lead parking something on someone
        # else's behalf should get that person's screen back, not their own.
        return work.my_work(conn, _holder(conn, issue_id, actor.id))


@router.post("/issues/{issue_id}/resume")
async def resume_issue(issue_id: int, request: Request) -> dict:
    actor = _actor(request)
    with _engine().begin() as conn:
        _sync_user(conn, request.state.user)
        work.resume(conn, actor, issue_id)
        return work.my_work(conn, _holder(conn, issue_id, actor.id))


def _holder(conn, issue_id: int, fallback: int | None) -> int:
    """Whose queue an issue sits in."""
    who = conn.execute(
        select(issues.c.assignee_id).where(issues.c.id == issue_id)).scalar()
    return int(who) if who else int(fallback or 0)


@router.get("/interruptions")
async def interruptions(request: Request, team_id: int | None = None,
                        days: int = 30) -> list[dict]:
    """What stopping and starting cost, per person, over a window."""
    _actor(request)
    with _engine().connect() as conn:
        return work.interruption_cost(conn, team_id=team_id, days=days)


# ------------------------------------------------------ project settings --

class AccessIn(BaseModel):
    visibility: str = "everyone"
    entries: list[dict] = Field(default_factory=list)


class OrderIn(BaseModel):
    ids: list[int]


class TransitionIn(BaseModel):
    from_status_id: int
    to_status_id: int
    allowed: bool


class TypeFieldsIn(BaseModel):
    fields: list[dict] = Field(default_factory=list)


class FieldIn(BaseModel):
    key: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    kind: str = "text"
    description: str = ""
    options: list = Field(default_factory=list)
    reason: str = ""


class ProjectPatch(BaseModel):
    name: str | None = None
    description: str | None = None


@router.get("/projects/{project_id}/settings")
async def project_settings(project_id: int, request: Request) -> dict:
    _admin(request)
    with _engine().connect() as conn:
        try:
            return admin.settings(conn, project_id)
        except SettingsError as exc:
            raise HTTPException(404, str(exc))


@router.patch("/projects/{project_id}")
async def patch_project(project_id: int, body: ProjectPatch, request: Request) -> dict:
    _admin(request)
    changes = body.model_dump(exclude_unset=True)
    with _engine().begin() as conn:
        if changes:
            conn.execute(projects.update().where(projects.c.id == project_id)
                         .values(**changes))
        return admin.settings(conn, project_id)


@router.put("/projects/{project_id}/access")
async def put_access(project_id: int, body: AccessIn, request: Request) -> dict:
    user = _admin(request)
    with _engine().begin() as conn:
        try:
            admin.set_access(conn, project_id, body.visibility, body.entries, user.get("id"))
        except SettingsError as exc:
            raise HTTPException(400, str(exc))
        return admin.settings(conn, project_id)


class BoardLayout(BaseModel):
    columns: list[dict] = Field(default_factory=list)


@router.put("/projects/{project_id}/board")
async def put_board(project_id: int, body: BoardLayout, request: Request) -> dict:
    """The whole column arrangement in one write.

    A drag moves columns and statuses together, and a half-applied layout is a
    board nobody can read — so it is one request and one transaction, not a
    dozen little ones racing each other.
    """
    _admin(request)
    with _engine().begin() as conn:
        try:
            admin.set_board(conn, project_id, body.columns)
        except SettingsError as exc:
            raise HTTPException(400, str(exc))
        return admin.settings(conn, project_id)


@router.put("/projects/{project_id}/columns/order")
async def put_column_order(project_id: int, body: OrderIn, request: Request) -> dict:
    """Reorder the board's columns. The list is the whole board, not a fragment."""
    _admin(request)
    with _engine().begin() as conn:
        try:
            admin.reorder_columns(conn, project_id, body.ids)
        except SettingsError as exc:
            raise HTTPException(400, str(exc))
        return admin.settings(conn, project_id)


@router.post("/projects/{project_id}/columns/{status_id}")
async def add_column(project_id: int, status_id: int, request: Request) -> dict:
    _admin(request)
    with _engine().begin() as conn:
        try:
            admin.add_column(conn, project_id, status_id)
        except SettingsError as exc:
            raise HTTPException(400, str(exc))
        return admin.settings(conn, project_id)


@router.delete("/projects/{project_id}/columns/{status_id}")
async def drop_column(project_id: int, status_id: int, request: Request) -> dict:
    _admin(request)
    with _engine().begin() as conn:
        try:
            admin.remove_column(conn, project_id, status_id)
        except SettingsError as exc:
            raise HTTPException(400, str(exc))
        return admin.settings(conn, project_id)


@router.put("/projects/{project_id}/transitions")
async def put_transition(project_id: int, body: TransitionIn, request: Request) -> dict:
    """One cell of the flow grid: may an issue go from here to there."""
    _admin(request)
    with _engine().begin() as conn:
        try:
            admin.set_transition(conn, project_id, body.from_status_id,
                                 body.to_status_id, body.allowed)
        except SettingsError as exc:
            raise HTTPException(400, str(exc))
        return admin.settings(conn, project_id)


@router.put("/projects/{project_id}/layout")
async def put_layout(project_id: int, body: dict, request: Request) -> dict:
    """Where the diagram's boxes sit. Presentation only — no rule changes."""
    _admin(request)
    with _engine().begin() as conn:
        try:
            admin.set_layout(conn, project_id, body.get("layout") or {})
        except SettingsError as exc:
            raise HTTPException(400, str(exc))
        return admin.settings(conn, project_id)


@router.patch("/projects/{project_id}/transitions/{transition_id}")
async def rename_transition(project_id: int, transition_id: int,
                            body: dict, request: Request) -> dict:
    """Name the arrow. "Begin Work" says what the move means; "→ In Progress"
    only says where it lands."""
    _admin(request)
    with _engine().begin() as conn:
        try:
            admin.rename_transition(conn, transition_id, body.get("name", ""))
        except SettingsError as exc:
            raise HTTPException(400, str(exc))
        return admin.settings(conn, project_id)


@router.patch("/projects/{project_id}/statuses/{status_id}")
async def patch_status(project_id: int, status_id: int, body: dict,
                       request: Request) -> dict:
    """Rename or recolour a status.

    Statuses are global, so this lands on every board using it. The UI says so
    before anyone presses it; that is the trade for cross-project reporting
    working at all.
    """
    _admin(request)
    with _engine().begin() as conn:
        try:
            admin.update_status(conn, status_id, body)
        except SettingsError as exc:
            raise HTTPException(400, str(exc))
        return admin.settings(conn, project_id)


@router.post("/projects/{project_id}/statuses")
async def create_status(project_id: int, body: dict, request: Request) -> dict:
    """Define a status and put it on this board in one go."""
    _admin(request)
    with _engine().begin() as conn:
        try:
            created = admin.create_status(
                conn, name=body.get("name", ""),
                category=body.get("category", "todo"),
                colour=body.get("colour", ""))
            admin.add_column(conn, project_id, created["id"])
        except SettingsError as exc:
            raise HTTPException(400, str(exc))
        return admin.settings(conn, project_id)


@router.put("/projects/{project_id}/types")
async def put_types(project_id: int, body: OrderIn, request: Request) -> dict:
    _admin(request)
    with _engine().begin() as conn:
        try:
            admin.set_types(conn, project_id, body.ids)
        except SettingsError as exc:
            raise HTTPException(400, str(exc))
        return admin.settings(conn, project_id)


@router.patch("/projects/{project_id}/types/{issue_type_id}")
async def patch_type(project_id: int, issue_type_id: int, body: dict,
                     request: Request) -> dict:
    """Rename, re-mark or recolour an issue type.

    Types are global for the same reason statuses are: a Bug has to mean a Bug
    on every board or no cross-project number means anything. This lands
    everywhere, and the UI says so first.
    """
    _admin(request)
    with _engine().begin() as conn:
        try:
            admin.update_type(conn, issue_type_id, body)
        except SettingsError as exc:
            raise HTTPException(400, str(exc))
        return admin.settings(conn, project_id)


@router.put("/projects/{project_id}/types/{issue_type_id}/fields")
async def put_type_fields(project_id: int, issue_type_id: int,
                          body: TypeFieldsIn, request: Request) -> dict:
    _admin(request)
    with _engine().begin() as conn:
        try:
            admin.set_type_fields(conn, project_id, issue_type_id, body.fields)
        except SettingsError as exc:
            raise HTTPException(400, str(exc))
        return admin.settings(conn, project_id)


@router.get("/fields")
async def list_fields(request: Request) -> list[dict]:
    """Every field, with where it is asked for and how many issues have one."""
    _admin(request)
    with _engine().connect() as conn:
        return admin.all_fields(conn)


@router.patch("/fields/{field_id}")
async def patch_field(field_id: int, body: dict, request: Request) -> dict:
    _admin(request)
    with _engine().begin() as conn:
        try:
            return admin.update_field(conn, field_id, body)
        except SettingsError as exc:
            raise HTTPException(400, str(exc))


@router.post("/fields/{field_id}/archive")
async def archive_field(field_id: int, request: Request, archived: bool = True) -> dict:
    _admin(request)
    with _engine().begin() as conn:
        try:
            admin.archive_field(conn, field_id, archived)
        except SettingsError as exc:
            raise HTTPException(400, str(exc))
        return {"ok": True}


@router.post("/fields")
async def create_field(body: FieldIn, request: Request) -> dict:
    """Define a field. Global, never per-project — that is the decision that
    stops one idea becoming four fields with four ids."""
    user = _admin(request)
    with _engine().begin() as conn:
        try:
            return admin.create_field(
                conn, key=body.key, name=body.name, kind=body.kind,
                description=body.description, options=body.options,
                reason=body.reason, created_by=user.get("id"))
        except SettingsError as exc:
            raise HTTPException(400, str(exc))


# ------------------------------------------------------------------ helpers --

def _workflow_for(conn, project_id: int, issue_type_id: int) -> int | None:
    """The type's own workflow if it has one, else the project's default."""
    row = conn.execute(
        select(project_workflows.c.workflow_id)
        .where(project_workflows.c.project_id == project_id)
        .where(project_workflows.c.issue_type_id == issue_type_id)
    ).scalar()
    if row is not None:
        return int(row)
    row = conn.execute(
        select(project_workflows.c.workflow_id)
        .where(project_workflows.c.project_id == project_id)
        .where(project_workflows.c.issue_type_id.is_(None))
    ).scalar()
    return int(row) if row is not None else None


def _first_status(conn, project_id: int, issue_type_id: int) -> int:
    """Where a new issue starts: the first status of whichever workflow governs
    this project and type."""
    wf = _workflow_for(conn, project_id, issue_type_id)
    row = conn.execute(
        select(workflow_statuses.c.status_id)
        .where(workflow_statuses.c.workflow_id == wf)
        .order_by(workflow_statuses.c.position).limit(1)
    ).scalar()
    if row is None:
        raise HTTPException(400, "This project has no workflow — run setup first.")
    return int(row)


def _allowed_transitions(conn, project_id: int, issue_type_id: int,
                         from_status_id: int) -> list[dict]:
    wf = _workflow_for(conn, project_id, issue_type_id)
    if wf is None:
        return []
    rows = conn.execute(
        select(transitions.c.id, transitions.c.name, transitions.c.to_status_id,
               statuses.c.name.label("to_name"), statuses.c.colour.label("to_colour"),
               statuses.c.category.label("to_category"))
        .select_from(transitions.join(statuses, transitions.c.to_status_id == statuses.c.id))
        .where(transitions.c.workflow_id == wf)
        # NULL from_status means "from anywhere" — Won't Do, reopen.
        .where((transitions.c.from_status_id == from_status_id)
               | (transitions.c.from_status_id.is_(None)))
        .where(transitions.c.to_status_id != from_status_id)
        .order_by(transitions.c.position, transitions.c.id)
    ).mappings().all()
    return [dict(r) for r in rows]
