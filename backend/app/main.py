"""Nox — the API.

Two things live here and nothing else: **accounts** and **the tracker**. Nox was
extracted from an app that also carried Jira reporting, Tempo timesheets, a
product importer and four dashboards; none of that came with it, and the whole
point of the split is that none of it comes back.

Accounts kept their behaviour deliberately. Registration is a request an admin
approves — an issue tracker where anybody can sign themselves in is not a
tracker, it is a wiki with tickets — and the first account to register becomes
the admin, because somebody has to be able to approve the second.

The tracker's own database is optional at boot. Without one every `/api/nox`
route answers 503 with a sentence a person can read, and the page says "not
connected yet" instead of erroring. That is what lets Nox deploy before anybody
has provisioned Postgres.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from . import db
from .auth_store import AuthStore
from .config import config
from .nox import worker as nox_worker
from .nox.api import router as nox_router

log = logging.getLogger("nox")

auth = AuthStore(config.auth_db_path)

# Everything else needs a session. The webhook cannot have one — GitHub has no
# way to hold a login — so it authenticates by HMAC over the raw body instead;
# see nox/git.py:verify, which refuses everything when no secret is set.
PUBLIC_PATHS = {
    "/api/auth/login",
    "/api/auth/register",
    "/api/health",
    "/api/setup/status",
    "/api/nox/git/webhook",
}


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Safe to start unconditionally: with no database the worker backs off and
    # sleeps rather than erroring.
    nox_worker.start()
    yield
    await nox_worker.stop()


app = FastAPI(title="Nox by Limbo", lifespan=lifespan)

if config.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.middleware("http")
async def authenticate(request: Request, call_next):
    path = request.url.path
    # Setup is open only during the genuine bootstrap — while no account exists
    # to authenticate with. The moment one does, this closes for good.
    bootstrap = path == "/api/setup" and auth.count() == 0
    if (
        request.method != "OPTIONS"
        and path.startswith("/api/")
        and path not in PUBLIC_PATHS
        and not bootstrap
    ):
        header = request.headers.get("Authorization", "")
        token = header[7:] if header.startswith("Bearer ") else None
        user = auth.session_user(token)
        if not user:
            return JSONResponse({"detail": "Not authenticated"}, status_code=401)
        request.state.user = user
    return await call_next(request)


app.include_router(nox_router)


# ------------------------------------------------------------------ health --

@app.get("/api/health")
async def health() -> dict:
    return {"ok": True, "app": "nox"}


@app.get("/api/setup/status")
async def setup_status() -> dict:
    """Whether anybody has registered yet. The sign-in page asks before it
    decides whether to offer 'create the first account'."""
    return {"needsFirstAccount": auth.count() == 0}


# ------------------------------------------------------------- accounts --

class RegisterRequest(BaseModel):
    username: str
    email: str
    password: str = Field(min_length=6)


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    currentPassword: str
    newPassword: str = Field(min_length=6)


def current_user(request: Request) -> dict:
    user = getattr(request.state, "user", None)
    if not user:
        raise HTTPException(401, "Not authenticated")
    return user


def require_admin(request: Request) -> dict:
    user = current_user(request)
    if user.get("role") != "admin":
        raise HTTPException(403, "Only an admin can do that.")
    return user


@app.post("/api/admin/placeholder-accounts")
async def make_placeholder_accounts(request: Request) -> dict:
    """Give the seeded demo people accounts, so the app behaves like a real one.

    Lives with the accounts rather than with the tracker because that is what it
    creates. Nobody can sign in as them — see `placeholders.py`.
    """
    require_admin(request)
    from .nox import placeholders
    return placeholders.create(auth)


@app.delete("/api/admin/placeholder-accounts")
async def drop_placeholder_accounts(request: Request) -> dict:
    require_admin(request)
    from .nox import placeholders
    return placeholders.remove(auth)


@app.post("/api/auth/register")
async def register(req: RegisterRequest) -> dict:
    username = req.username.strip()
    email = req.email.strip().lower()
    if not username or not email or not req.password:
        raise HTTPException(400, "Username, email and password are required.")
    if auth.by_username(username):
        raise HTTPException(400, "That username is already taken.")
    if auth.by_email(email):
        raise HTTPException(400, "That email is already registered.")

    # The first person through the door is the admin, and approved — otherwise
    # there is nobody to approve them and the app is unusable on day one.
    first = auth.count() == 0
    user = auth.create_user(username, email, req.password)
    if first:
        auth.set_status(user["id"], "approved")
        auth.set_role(user["id"], "admin")
        row = auth.by_id(user["id"])
        return {"status": "approved", "first": True,
                "token": auth.create_session(row["id"]), "user": auth._public(row)}
    return {"status": "pending",
            "message": "Registration submitted — an admin needs to approve it."}


@app.post("/api/auth/login")
async def login(req: LoginRequest) -> dict:
    row = auth.by_username(req.username.strip())
    if not row or not auth.verify(row, req.password):
        raise HTTPException(401, "Invalid username or password.")
    if row["status"] == "pending":
        raise HTTPException(403, "Your account is awaiting admin approval.")
    if row["status"] != "approved":
        raise HTTPException(403, f"Your account is {row['status']}.")
    return {"token": auth.create_session(row["id"]), "user": auth._public(row)}


@app.post("/api/auth/logout")
async def logout(request: Request) -> dict:
    header = request.headers.get("Authorization", "")
    auth.delete_session(header[7:] if header.startswith("Bearer ") else None)
    return {"ok": True}


@app.get("/api/auth/me")
async def me(request: Request) -> dict:
    return current_user(request)


@app.put("/api/auth/password")
async def change_password(req: ChangePasswordRequest, request: Request) -> dict:
    user = current_user(request)
    row = auth.by_id(user["id"])
    if not row or not auth.verify(row, req.currentPassword):
        raise HTTPException(400, "That is not your current password.")
    auth.set_password(user["id"], req.newPassword)
    return {"ok": True}


@app.put("/api/auth/profile")
async def update_profile(request: Request, nickname: str = "", avatar: str = "") -> dict:
    user = current_user(request)
    return auth.update_profile(user["id"], nickname, avatar) or user


# --------------------------------------------------------------- admin --

@app.get("/api/admin/users")
async def list_users(request: Request) -> list[dict]:
    require_admin(request)
    return auth.list_users()


@app.put("/api/admin/users/{user_id}/status")
async def set_status(user_id: int, request: Request, status: str) -> dict:
    """Approve, suspend or ban. The one lever that makes registration safe."""
    admin = require_admin(request)
    if user_id == admin["id"] and status != "approved":
        raise HTTPException(400, "You cannot lock yourself out.")
    if status not in ("approved", "pending", "suspended", "banned"):
        raise HTTPException(400, f"unknown status: {status}")
    updated = auth.set_status(user_id, status)
    if not updated:
        raise HTTPException(404, "No such account.")
    return updated


@app.put("/api/admin/users/{user_id}/role")
async def set_role(user_id: int, request: Request, role: str) -> dict:
    admin = require_admin(request)
    if user_id == admin["id"] and role != "admin":
        raise HTTPException(400, "You cannot remove your own admin.")
    if role not in ("admin", "member"):
        raise HTTPException(400, f"unknown role: {role}")
    updated = auth.set_role(user_id, role)
    if not updated:
        raise HTTPException(404, "No such account.")
    return updated


@app.get("/api/status")
async def app_status() -> dict:
    """One place to see whether Nox has what it needs."""
    return {"app": "Nox by Limbo", "accounts": auth.count(), "database": db.status()}
