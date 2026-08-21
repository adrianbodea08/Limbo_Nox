"""Connecting to GitHub the way a product should: one click, no tokens.

The alternative we started with was a personal access token pasted into
settings. It works, and it is wrong for anything anybody else has to run: it
authenticates as *a person*, so the integration dies quietly the day they
rotate it or leave, and covering ninety-two repositories means either a hook per
repository or a list somebody maintains by hand.

A GitHub App fixes all three. An org owner authorises it once and picks "all
repositories"; GitHub then delivers events for every repo, including ones
created tomorrow, and hands us short-lived tokens scoped to exactly the
permissions the app declares. Nobody types a secret anywhere.

    ┌ install ─────────────────────────────────────────────┐
    │ /git/connect  →  github.com/apps/<slug>/installations │
    │                  ← redirect with ?installation_id=…   │
    │ /git/connected →  recorded, done                      │
    └───────────────────────────────────────────────────────┘

Auth is two hops, which is the part worth understanding. We hold a **private
key**, and sign a short JWT with it to prove we are the app. That JWT buys an
**installation token** — an hour long, scoped to one installation — and that is
what actually reads repositories. The private key never leaves us and the
installation token expires on its own, so a leaked one is an hour of exposure
rather than forever.

Unconfigured is a state, not an error — the same rule the database follows. With
no app registered, every function here says so and the page offers the steps.
"""
from __future__ import annotations

import time
from typing import Any

import httpx
from sqlalchemy import Connection, select, text

from .schema import git_installations

API = "https://api.github.com"

# An installation token lasts an hour. Refreshed a minute early so a request
# never starts with a token that expires mid-flight.
_TOKEN_SKEW = 60
_tokens: dict[int, tuple[str, float]] = {}


class AppError(Exception):
    """Something the person configuring this can act on."""


# ------------------------------------------------------------------ config --

def settings() -> dict:
    """Where the app's identity comes from.

    Environment, not the database: a private key is a credential, and the one
    thing worse than storing it is storing it somewhere that gets dumped into a
    demo database.
    """
    import os

    key = os.getenv("TRACKER_GITHUB_APP_KEY", "")
    # A PEM is multi-line and environments mangle newlines, so \n is accepted.
    if key and "\\n" in key and "-----BEGIN" in key:
        key = key.replace("\\n", "\n")
    if not key:
        path = os.getenv("TRACKER_GITHUB_APP_KEY_FILE", "").strip()
        if path:
            try:
                with open(path, encoding="utf-8") as handle:
                    key = handle.read()
            except OSError as exc:
                raise AppError(f"cannot read the private key at {path}: {exc}")
    return {
        "app_id": os.getenv("TRACKER_GITHUB_APP_ID", "").strip(),
        "slug": os.getenv("TRACKER_GITHUB_APP_SLUG", "").strip(),
        "key": key.strip(),
    }


def configured() -> bool:
    try:
        cfg = settings()
    except AppError:
        return False
    return bool(cfg["app_id"] and cfg["key"])


def install_url() -> str:
    """Where the Connect button sends somebody."""
    slug = settings()["slug"]
    if not slug:
        raise AppError("TRACKER_GITHUB_APP_SLUG is not set, so there is no app to install")
    return f"https://github.com/apps/{slug}/installations/new"


# --------------------------------------------------------------------- auth --

def _app_jwt() -> str:
    """Proof that we are the app. Ten minutes is GitHub's maximum; we ask for
    less because the only thing it is used for is the token exchange."""
    try:
        import jwt
    except ImportError:  # pragma: no cover - a deployment that skipped the dep
        raise AppError("PyJWT is not installed, so the GitHub App cannot authenticate")

    cfg = settings()
    if not cfg["app_id"] or not cfg["key"]:
        raise AppError("no GitHub App is configured")
    now = int(time.time())
    return jwt.encode(
        # 60s back-dated: GitHub rejects a token whose iat is even slightly
        # ahead of its clock, and container clocks drift.
        {"iat": now - 60, "exp": now + 480, "iss": cfg["app_id"]},
        cfg["key"], algorithm="RS256")


async def installation_token(installation_id: int) -> str:
    """A token scoped to one installation, cached until just before it expires."""
    cached = _tokens.get(installation_id)
    if cached and cached[1] - _TOKEN_SKEW > time.time():
        return cached[0]

    headers = {"Authorization": f"Bearer {_app_jwt()}",
               "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    async with httpx.AsyncClient(base_url=API, headers=headers, timeout=30.0) as client:
        resp = await client.post(f"/app/installations/{installation_id}/access_tokens")
    if resp.status_code >= 400:
        raise AppError(f"GitHub refused a token for installation {installation_id}: "
                       f"{resp.status_code} {resp.text[:160]}")
    body = resp.json()
    expires = time.time() + 3600
    exp_text = body.get("expires_at")
    if exp_text:
        try:
            from datetime import datetime
            expires = datetime.fromisoformat(exp_text.replace("Z", "+00:00")).timestamp()
        except ValueError:
            pass
    _tokens[installation_id] = (body["token"], expires)
    return body["token"]


def forget(installation_id: int) -> None:
    """Drop a cached token — on disconnect, or when GitHub says it is revoked."""
    _tokens.pop(installation_id, None)


# ------------------------------------------------------------ installations --

async def describe(installation_id: int) -> dict:
    """Who this installation belongs to, straight from GitHub.

    Asked rather than trusted from the redirect: the browser hands us an id in a
    query string, and an id in a query string is a claim, not a fact.
    """
    headers = {"Authorization": f"Bearer {_app_jwt()}",
               "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    async with httpx.AsyncClient(base_url=API, headers=headers, timeout=30.0) as client:
        resp = await client.get(f"/app/installations/{installation_id}")
    if resp.status_code >= 400:
        raise AppError(f"GitHub does not recognise installation {installation_id}: "
                       f"{resp.status_code} {resp.text[:160]}")
    body = resp.json()
    account = body.get("account") or {}
    return {
        "installation_id": installation_id,
        "account_login": account.get("login") or "",
        "account_type": account.get("type") or "",
        "repo_selection": body.get("repository_selection") or "",
        "suspended": bool(body.get("suspended_at")),
    }


async def repositories(installation_id: int) -> list[str]:
    """Every repository this installation can see.

    This is what replaces the hand-kept list: choose "all repositories" once and
    a repo created next month is covered without anybody remembering.
    """
    token = await installation_token(installation_id)
    headers = {"Authorization": f"Bearer {token}",
               "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    names: list[str] = []
    async with httpx.AsyncClient(base_url=API, headers=headers, timeout=40.0) as client:
        for page in range(1, 11):
            resp = await client.get("/installation/repositories",
                                    params={"per_page": 100, "page": page})
            if resp.status_code >= 400:
                raise AppError(f"listing repositories failed: {resp.status_code} "
                               f"{resp.text[:160]}")
            batch = resp.json().get("repositories") or []
            names.extend(r["full_name"] for r in batch)
            if len(batch) < 100:
                break
    return names


async def pulls(installation_id: int, repo_name: str, pages: int = 2) -> list[dict]:
    """Recent pull requests, read as the app rather than as a person."""
    token = await installation_token(installation_id)
    headers = {"Authorization": f"Bearer {token}",
               "Accept": "application/vnd.github+json",
               "X-GitHub-Api-Version": "2022-11-28"}
    out: list[dict] = []
    async with httpx.AsyncClient(base_url=API, headers=headers, timeout=40.0) as client:
        for page in range(1, pages + 1):
            resp = await client.get(f"/repos/{repo_name}/pulls", params={
                "state": "all", "per_page": 100, "page": page,
                "sort": "updated", "direction": "desc"})
            if resp.status_code >= 400:
                raise AppError(f"{repo_name}: {resp.status_code} {resp.text[:120]}")
            batch = resp.json()
            if not isinstance(batch, list) or not batch:
                break
            out.extend(batch)
            if len(batch) < 100:
                break
    return out


# -------------------------------------------------------------- the record --

def remember(conn: Connection, actor_id: int | None, described: dict) -> dict:
    """Store an installation, or update what we know about it."""
    conn.execute(text("""
        INSERT INTO git_installations
            (installation_id, account_login, account_type, repo_selection,
             connected_by, suspended)
        VALUES (:iid, :login, :atype, :sel, :by, :susp)
        ON CONFLICT (installation_id) DO UPDATE SET
            account_login = EXCLUDED.account_login,
            account_type = EXCLUDED.account_type,
            repo_selection = EXCLUDED.repo_selection,
            suspended = EXCLUDED.suspended,
            removed_at = NULL
    """), {"iid": described["installation_id"], "login": described["account_login"],
           "atype": described["account_type"], "sel": described["repo_selection"],
           "by": actor_id, "susp": described["suspended"]})
    return described


def live(conn: Connection) -> list[dict]:
    """Installations still connected."""
    return [dict(r) for r in conn.execute(
        select(git_installations)
        .where(git_installations.c.removed_at.is_(None))
        .order_by(git_installations.c.account_login)).mappings()]


def remove(conn: Connection, installation_id: int) -> None:
    """Forget an installation on this side.

    Marked, not deleted: the pull requests it brought in stay, and a row that
    says when the connection ended is the only way to explain a gap in them.
    """
    conn.execute(git_installations.update()
                 .where(git_installations.c.installation_id == installation_id)
                 .values(removed_at=text("now()")))
    forget(installation_id)


def note_sync(conn: Connection, installation_id: int, summary: str) -> None:
    conn.execute(git_installations.update()
                 .where(git_installations.c.installation_id == installation_id)
                 .values(last_sync_at=text("now()"), last_sync=summary[:400]))
