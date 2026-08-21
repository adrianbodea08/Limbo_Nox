"""What git is doing to an issue: branches, pull requests, and their checks.

Why this exists at all, in one number: in the Jira we are replacing, **57% of
DRC's status changes are made by automation, not people** — 2,419 of them in 90
days — and the shape is unmistakably git-driven (In Progress → In Review on a PR
opening, → Done on a merge, → STAGING → LIVE on deploys). A tracker without git
does not lose a feature, it loses half the workflow and hands it back to people
as manual clicking. That is how a tool gets abandoned in its second week.

So this module does two things:

  * **Records** what git has: a branch, a PR, its state and whether its checks
    passed, linked to the issues whose keys it mentions.
  * **Says so**, by writing events on those issues — which is what lets the
    automation engine react. `pr_opened`, `pr_merged`, `build_failed` and
    `branch_created` are triggers like any other; nothing in the engine needed
    changing to accept them.

Two ways in, deliberately. A **webhook** is the real mechanism and gives you the
state a second after it changes. A **sync** pulls the same data on demand, which
is what makes this usable before anyone has configured a webhook, and what
repairs the record after an outage drops one.
"""
from __future__ import annotations

import hashlib
import hmac
import re
from typing import Any

from sqlalchemy import Connection, select, text

from . import github_app
from . import repo as repo_mod
from .repo import Actor
from .schema import components, git_refs, issue_git, issues

# PROJ-123. Bounded rather than open-ended: an unanchored [A-Z]+-\d+ matches
# "COVID-19" and every ticket reference to another system, and a key that is
# checked against the real project list cannot do that.
KEY_PATTERN = re.compile(r"\b([A-Z][A-Z0-9]{1,9})-(\d+)\b")

# Where a key was found, in the order we trust it. A key in the title is
# deliberate; a key in a branch name is usually deliberate; a key in the body
# might be someone quoting another ticket, which is why the link records which.
SOURCES = ("title", "branch", "body")


class GitError(Exception):
    """Something a caller can act on — a bad signature, an unknown repo."""


# ------------------------------------------------------------------- keys --

def keys_in(text_value: str) -> set[str]:
    """Every issue key shaped string in a piece of text."""
    return {f"{m.group(1)}-{m.group(2)}" for m in KEY_PATTERN.finditer(text_value or "")}


def resolve_keys(conn: Connection, found: dict[str, set[str]]) -> dict[int, str]:
    """Turn candidate keys into real issue ids, remembering where each was seen.

    Anything that is not a live issue key is dropped without ceremony: a commit
    message mentioning `ABC-1` from another system is not an error, it is a
    string that happens to look like a key.
    """
    everything: set[str] = set()
    for keys in found.values():
        everything |= keys
    if not everything:
        return {}

    rows = conn.execute(
        select(issues.c.id, issues.c.key)
        .where(issues.c.key.in_(sorted(everything)))
        .where(issues.c.archived_at.is_(None))
    ).all()

    out: dict[int, str] = {}
    for issue_id, key in rows:
        for source in SOURCES:
            if key in found.get(source, set()):
                out[issue_id] = source
                break
    return out


# ------------------------------------------------------------- recording --

def record(conn: Connection, actor: Actor, *, kind: str, repo_name: str, ref: str,
           title: str = "", url: str = "", state: str = "", checks: str = "none",
           author: str = "", branch: str = "", opened_at: Any = None,
           merged_at: Any = None, found: dict[str, set[str]] | None = None) -> dict:
    """Store a ref and link it to the issues it names.

    Idempotent by (repo, kind, ref), because both ways in can deliver the same
    pull request: a webhook fires on every edit, and a sync re-reads everything
    it can see. Re-recording updates the row and re-links, so replaying a day of
    webhooks changes nothing.
    """
    existing = conn.execute(
        select(git_refs)
        .where(git_refs.c.repo == repo_name)
        .where(git_refs.c.kind == kind)
        .where(git_refs.c.ref == str(ref))
    ).mappings().first()

    values = {
        "kind": kind, "repo": repo_name, "ref": str(ref), "title": title or "",
        "url": url or "", "state": state or "", "checks": checks or "none",
        "author": author or "", "branch": branch or "",
        "opened_at": opened_at, "merged_at": merged_at,
        "updated_at": text("now()"),
    }

    if existing is None:
        ref_id = conn.execute(
            git_refs.insert().values(**values).returning(git_refs.c.id)).scalar_one()
        before = None
    else:
        ref_id = existing["id"]
        # Do not let a partial update blank out what we already knew. A check
        # event carries no title; a PR edit carries no check result.
        keep = {k: v for k, v in values.items()
                if v not in ("", None, "none") or k in ("state", "updated_at")}
        conn.execute(git_refs.update().where(git_refs.c.id == ref_id).values(**keep))
        before = dict(existing)

    linked = resolve_keys(conn, found or {})
    for issue_id, source in linked.items():
        conn.execute(text("""
            INSERT INTO issue_git (issue_id, git_ref_id, found_in)
            VALUES (:i, :g, :s)
            ON CONFLICT (issue_id, git_ref_id) DO NOTHING
        """), {"i": issue_id, "g": ref_id, "s": source})

    # Announce to everything attached to this ref, not only what this payload
    # named. A check result carries no issue keys at all — it arrives against a
    # pull request — so announcing to the keys in the payload would mean a build
    # never failed as far as any issue was concerned.
    attached = [r[0] for r in conn.execute(
        select(issue_git.c.issue_id).where(issue_git.c.git_ref_id == ref_id)).all()]
    _announce(conn, actor, ref_id, kind, values, before, attached)
    return {"id": ref_id, "issues": attached}


def _announce(conn: Connection, actor: Actor, ref_id: int, kind: str,
              now_values: dict, before: dict | None, issue_ids: list[int]) -> None:
    """Write the events that automations listen for.

    Only on a real change. A webhook that fires because somebody edited a PR
    description must not read as "this PR was just merged" — that is how an
    automation ends up running every time anyone touches anything.
    """
    if not issue_ids:
        return

    happenings: list[tuple[str, dict]] = []
    state = now_values.get("state") or ""
    checks = now_values.get("checks") or "none"
    was_state = (before or {}).get("state") or ""
    was_checks = (before or {}).get("checks") or "none"

    if kind == "branch" and before is None:
        happenings.append(("branch_created", {"branch": now_values.get("ref")}))
    if kind == "pr":
        if before is None and state in ("open", "draft"):
            happenings.append(("pr_opened", {"state": state}))
        if state == "merged" and was_state != "merged":
            happenings.append(("pr_merged", {}))
        if state == "closed" and was_state not in ("closed", "merged"):
            happenings.append(("pr_closed", {}))
        if checks == "failing" and was_checks != "failing":
            happenings.append(("build_failed", {}))
        if checks == "passing" and was_checks != "passing":
            happenings.append(("build_passed", {}))

    if not happenings:
        return

    batch = repo_mod.new_batch(conn)
    for issue_id in issue_ids:
        for kind_name, payload in happenings:
            repo_mod.write_event(
                conn, actor, entity_type="issue", entity_id=issue_id,
                batch_id=batch, kind=kind_name,
                payload={**payload, "ref_id": ref_id, "repo": now_values["repo"],
                         "ref": now_values["ref"], "title": now_values["title"],
                         "url": now_values["url"]})


# ----------------------------------------------------------------- reads --

def for_issues(conn: Connection, issue_ids: list[int]) -> dict[int, list[dict]]:
    """Every branch and PR on each issue, newest first."""
    if not issue_ids:
        return {}
    rows = conn.execute(
        select(git_refs, issue_git.c.issue_id, issue_git.c.found_in)
        .select_from(issue_git.join(git_refs, issue_git.c.git_ref_id == git_refs.c.id))
        .where(issue_git.c.issue_id.in_(issue_ids))
        .order_by(git_refs.c.kind, git_refs.c.updated_at.desc())
    ).mappings().all()
    out: dict[int, list[dict]] = {}
    for row in rows:
        out.setdefault(row["issue_id"], []).append(dict(row))
    return out


def repos(conn: Connection) -> list[str]:
    """The repositories the tracker knows about — the components' own.

    A component already carries its repo, so there is no second list to keep in
    step with the first.
    """
    rows = conn.execute(
        select(components.c.repo)
        .where(components.c.repo != "")
        .where(components.c.archived_at.is_(None))
    ).all()
    return sorted({r[0] for r in rows})


# --------------------------------------------------------------- webhook --

def verify(secret: str, body: bytes, signature: str) -> bool:
    """GitHub's HMAC over the raw body.

    Compared with `compare_digest`, not `==`: a byte-by-byte comparison leaks
    how much of a forged signature was right, and this endpoint is public by
    definition.
    """
    if not secret:
        raise GitError("no webhook secret is configured — refusing to trust the sender")
    if not signature.startswith("sha256="):
        return False
    want = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(want, signature)


def from_webhook(conn: Connection, actor: Actor, event: str, payload: dict) -> dict:
    """Turn one GitHub delivery into a recorded ref, or ignore it.

    Unknown events are ignored rather than refused. GitHub sends whatever the
    hook is subscribed to, and answering 400 to a `star` event would have
    somebody debugging a delivery that was never a problem.
    """
    repo_name = ((payload.get("repository") or {}).get("full_name")) or ""
    if not repo_name:
        return {"ignored": "no repository in the payload"}

    if event == "pull_request":
        return record_pull(conn, actor, repo_name, payload.get("pull_request") or {})

    if event == "create" and payload.get("ref_type") == "branch":
        branch = payload.get("ref") or ""
        return record(conn, actor, kind="branch", repo_name=repo_name, ref=branch,
                      title=branch, branch=branch,
                      url=f"https://github.com/{repo_name}/tree/{branch}",
                      found={"branch": keys_in(branch)})

    # A check result arrives against a commit, and reaches an issue through the
    # pull requests that commit belongs to.
    if event in ("check_suite", "workflow_run"):
        body = payload.get("check_suite") or payload.get("workflow_run") or {}
        outcome = {"success": "passing", "failure": "failing", "timed_out": "failing",
                   "cancelled": "none"}.get(body.get("conclusion") or "", "pending")
        touched = []
        for pr in body.get("pull_requests") or []:
            touched.append(record(conn, actor, kind="pr", repo_name=repo_name,
                                  ref=str(pr.get("number")), checks=outcome))
        return {"checks": outcome, "pull_requests": len(touched)}

    return {"ignored": event}


# ------------------------------------------------------------------ sync --

class NothingToSync(GitError):
    """There is nowhere to read from — a setup problem, not a failure."""


class NoCredentials(GitError):
    """Neither an installation nor a token. The panel says how to fix it."""


async def sync(engine, *, only: str | None = None, pages: int = 2) -> dict:
    """Read pull requests and record them. Shared by the route and the worker.

    Reads as the connected GitHub App, which covers every repository the
    installation can see — including ones created after somebody stopped
    maintaining a list.
    """
    with engine.connect() as conn:
        installs = github_app.live(conn)
    if not installs:
        raise NoCredentials(
            "No GitHub organisation is connected yet. Connect one on the Git "
            "page — it is one click and nothing to paste.")
    return await _sync_via_app(engine, installs, only, pages)



def record_pull(conn: Connection, actor: Actor, repo_name: str, pr: dict) -> dict:
    """One GitHub pull request payload, recorded. Shared by sync and webhook so
    the two cannot disagree about what a PR means."""
    branch = ((pr.get("head") or {}).get("ref")) or ""
    return record(
        conn, actor, kind="pr", repo_name=repo_name, ref=str(pr.get("number")),
        title=pr.get("title") or "", url=pr.get("html_url") or "",
        state=_pr_state(pr), author=((pr.get("user") or {}).get("login")) or "",
        branch=branch, opened_at=pr.get("created_at"), merged_at=pr.get("merged_at"),
        found={
            "title": keys_in(pr.get("title") or ""),
            "branch": keys_in(branch),
            "body": keys_in(pr.get("body") or ""),
        })


def _pr_state(pr: dict) -> str:
    if pr.get("merged_at"):
        return "merged"
    if pr.get("state") == "closed":
        return "closed"
    return "draft" if pr.get("draft") else "open"


async def _sync_via_app(engine, installs: list[dict], only: str | None,
                        pages: int) -> dict:
    """The good path: read as the app, over every repository it can see.

    No list to maintain — "all repositories" on the installation means a repo
    created next month is covered without anybody remembering.
    """
    seen, linked, failed, repos_done = 0, 0, {}, []
    for install in installs:
        iid = install["installation_id"]
        try:
            names = await github_app.repositories(iid)
        except github_app.AppError as exc:
            failed[install["account_login"]] = str(exc)
            continue
        if only:
            names = [n for n in names if n == only]
        for name in names:
            try:
                pulls = await github_app.pulls(iid, name, pages=pages)
            except github_app.AppError as exc:
                failed[name] = str(exc)
                continue
            repos_done.append(name)
            with engine.begin() as conn:
                for pull in pulls:
                    seen += 1
                    linked += len(record_pull(conn, repo_mod.SYSTEM, name, pull)["issues"])
        with engine.begin() as conn:
            github_app.note_sync(
                conn, iid, f"{len(repos_done)} repos, {seen} pull requests, {linked} linked")
    return {"via": "app", "repos": repos_done, "pull_requests": seen,
            "links": linked, "failed": failed}
