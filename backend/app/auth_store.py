"""Local user accounts, sessions, and registration approval.

**In Postgres, beside everything else, since 2026-08-22.** This was a separate
SQLite database until then, because Nox used to be one feature inside another
product and an instance could have accounts with no tracker database at all.
Standing on its own that state means "the app does nothing", so the split had no
job left — and it cost more than tidiness: twenty-six columns across the tracker
hold a user id and *not one of them could declare a foreign key*, because you
cannot declare one across two database engines. Deleting an account left its
issues, comments and events pointing at nobody, silently.

Registration is a request an admin approves — an issue tracker anybody can sign
themselves into is not a tracker — and the first account to register becomes the
admin, because somebody has to be able to approve the second.

The interface is unchanged from the SQLite version on purpose: same methods,
same `_public` shape, so the routes above it did not have to be rewritten to
follow the data.
"""

from __future__ import annotations

import hashlib
import logging
import random
import re
import secrets
import string
from datetime import datetime, timedelta, timezone
from threading import Lock

from sqlalchemy import text

log = logging.getLogger("nox.auth")

SESSION_TTL = 60 * 60 * 24 * 30  # 30 days

_ARGON = None


def _hasher():
    """The Argon2 hasher, built once and only if the library is there."""
    global _ARGON
    if _ARGON is None:
        from argon2 import PasswordHasher

        # OWASP's recommended minimum for Argon2id.
        _ARGON = PasswordHasher(
            time_cost=2, memory_cost=19_456, parallelism=1,
            hash_len=32, salt_len=16,
        )
    return _ARGON


def _gen_code(name: str, taken: set[str]) -> str:
    """A unique per-user prefix: 2-letter initials, else a 3-letter form
    (consonants, e.g. Limbo -> LMB), else a random 3-letter code."""
    letters = re.sub(r"[^A-Za-z]", "", name).upper()
    inits = "".join(w[0] for w in re.split(r"\s+", name.strip()) if w).upper()
    cons = re.sub(r"[AEIOU]", "", letters)
    candidates = []
    if len(inits) >= 2:
        candidates.append(inits[:2])
    if len(letters) >= 2:
        candidates.append(letters[:2])
    if len(cons) >= 3:
        candidates.append(cons[:3])
    if len(inits) >= 3:
        candidates.append(inits[:3])
    if len(letters) >= 3:
        candidates.append(letters[:3])
    for c in candidates:
        if len(c) >= 2 and c not in taken:
            return c
    while True:
        c = "".join(random.choices(string.ascii_uppercase, k=3))
        if c not in taken:
            return c


def _legacy_hash(password: str, salt: str) -> str:
    """The scheme before Argon2id. Kept only so `verify` can recognise an old
    row and replace it the one moment the plaintext is available."""
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode(), salt.encode(), 260_000).hex()


def _hash(password: str) -> str:
    return _hasher().hash(password)


class AuthStore:
    """Accounts and sessions, on the tracker's own database.

    `db_path` is accepted and ignored — it named the SQLite file, and dropping
    the parameter would have meant changing the one line in `main.py` that
    builds this, for no gain. It goes when the last mention of that file does.
    """

    def __init__(self, db_path: str | None = None) -> None:
        self._lock = Lock()
        self._db_path = db_path

    # --- plumbing ---------------------------------------------------------

    def _engine(self):
        from . import db as _db

        engine = _db.engine()
        if engine is None:
            # Nothing sensible to do: accounts live here now, so no database
            # means nobody can sign in and saying so plainly beats a stack
            # trace from three layers further down.
            raise RuntimeError("the database is unreachable — accounts live there")
        return engine

    def _one(self, sql: str, **params):
        with self._engine().connect() as conn:
            return conn.execute(text(sql), params).mappings().first()

    def _all(self, sql: str, **params) -> list:
        with self._engine().connect() as conn:
            return list(conn.execute(text(sql), params).mappings())

    def _write(self, sql: str, **params) -> None:
        with self._engine().begin() as conn:
            conn.execute(text(sql), params)

    def _after(self, user_id: int) -> dict | None:
        """Every setter ends the same way: read the row back and hand out the
        public shape, so a caller never has to guess what the write did."""
        row = self.by_id(user_id)
        return self._public(row) if row else None

    @staticmethod
    def _public(row) -> dict:
        created = row["created_at"]
        return {
            "id": row["id"],
            "username": row["username"],
            "email": row["email"],
            "role": row["role"],
            "status": row["status"],
            # A float, as it always was. Postgres hands back a datetime and the
            # frontend has been reading a unix timestamp since the first
            # version; changing the wire format to suit the storage would be
            # the storage leaking upwards.
            "createdAt": created.timestamp() if hasattr(created, "timestamp") else created,
            "nickname": row["nickname"],
            "avatar": row["avatar"],
            "myboardEnabled": bool(row["myboard_enabled"]),
            "releasesEnabled": bool(row["releases_enabled"]),
            "code": row["code"],
            "tags": [t for t in (row["tags"] or "").split(",") if t],
            "jiraAccountId": row["jira_account_id"],
        }

    @staticmethod
    def _shown(nickname: str | None, username: str | None) -> str:
        """What the tracker puts on a card.

        Maintained here now. It used to be written into a copy of this row on
        every single request by `_project_user`, which existed only because the
        two halves of a person lived in different databases.
        """
        return (nickname or "").strip() or (username or "").strip()

    # --- users -----------------------------------------------------------

    def count(self) -> int:
        row = self._one("SELECT count(*) AS n FROM users WHERE username IS NOT NULL")
        return int(row["n"]) if row else 0

    def create_user(self, username: str, email: str, password: str,
                    role: str = "member", status: str = "pending") -> dict:
        # No sequence on `users.id`: the column has always been the account id
        # and the seeded people hold 900000 upwards, so the next one continues
        # from the highest. One statement, so two registrations at once cannot
        # both read the same maximum.
        with self._engine().begin() as conn:
            row = conn.execute(text("""
                INSERT INTO users (id, username, email, password_hash, salt, role,
                                   status, created_at, display_name, active)
                SELECT COALESCE(MAX(id), 0) + 1, :username, :email, :hash, '',
                       :role, :status, now(), :shown, :active
                FROM users
                RETURNING *
            """), {
                "username": username, "email": email, "hash": _hash(password),
                "role": role, "status": status,
                "shown": self._shown(None, username),
                "active": status == "approved",
            }).mappings().one()
        return self._public(row)

    def create_at_id(self, user_id: int, username: str, email: str, *,
                     nickname: str, avatar: str, role: str = "member",
                     status: str = "approved") -> dict:
        """An account at a chosen id, with **no usable password**.

        For the seeded demo people, whose ids the tracker already knows them by.
        The password is a random secret that is hashed and then dropped on the
        floor: nobody has it, so the account exists and owns its work but cannot
        be signed into by anyone.
        """
        with self._engine().begin() as conn:
            row = conn.execute(text("""
                INSERT INTO users (id, username, email, password_hash, salt, role,
                                   status, created_at, nickname, avatar,
                                   display_name, active)
                VALUES (:id, :username, :email, :hash, '', :role, :status, now(),
                        :nickname, :avatar, :shown, :active)
                ON CONFLICT (id) DO UPDATE SET
                    username = EXCLUDED.username, email = EXCLUDED.email,
                    password_hash = EXCLUDED.password_hash, role = EXCLUDED.role,
                    status = EXCLUDED.status, nickname = EXCLUDED.nickname,
                    display_name = EXCLUDED.display_name, active = EXCLUDED.active
                RETURNING *
            """), {
                "id": user_id, "username": username, "email": email,
                "hash": _hash(secrets.token_urlsafe(48)),
                "role": role, "status": status, "nickname": nickname,
                "avatar": avatar or "",
                "shown": self._shown(nickname, username),
                "active": status == "approved",
            }).mappings().one()
        return self._public(row)

    def delete_user(self, user_id: int) -> None:
        """Really delete — and the database now refuses if they wrote anything.

        That refusal is the point of moving in here. Before the foreign keys
        existed this quietly left their issues, comments and events pointing at
        an id that no longer meant anybody.
        """
        self._write("DELETE FROM users WHERE id = :id", id=user_id)

    def all_rows(self) -> list:
        return self._all("SELECT * FROM users ORDER BY id")

    def by_username(self, username: str):
        return self._one("SELECT * FROM users WHERE username = :v", v=username)

    def by_email(self, email: str):
        return self._one("SELECT * FROM users WHERE email = :v", v=email)

    def by_id(self, user_id: int):
        return self._one("SELECT * FROM users WHERE id = :v", v=user_id)

    def verify(self, row, password: str) -> bool:
        """Check a password, and quietly modernise the hash while we can.

        A correct password is the only moment the plaintext exists, so it is the
        only moment an old hash can be replaced. Doing it here means the
        migration needs no downtime, no reset emails and no migration script —
        it happens as people sign in.
        """
        stored = row["password_hash"] or ""

        if stored.startswith("$argon2"):
            from argon2.exceptions import InvalidHashError, VerifyMismatchError

            try:
                _hasher().verify(stored, password)
            except (VerifyMismatchError, InvalidHashError):
                return False
            except Exception:  # noqa: BLE001 - a broken hash is a failed login
                log.exception("argon2 verify failed for user %s", row["id"])
                return False
            # Parameters get raised over time; when they are, this rehashes.
            if _hasher().check_needs_rehash(stored):
                self.set_password(row["id"], password)
            return True

        # Pre-Argon2id. Constant-time compare, then upgrade in place.
        if not row["salt"]:
            return False
        if not secrets.compare_digest(_legacy_hash(password, row["salt"]), stored):
            return False
        try:
            self.set_password(row["id"], password)
            log.info("rehashed user %s from pbkdf2 to argon2id", row["id"])
        except Exception:  # noqa: BLE001 - never fail a good login over this
            log.exception("could not rehash user %s", row["id"])
        return True

    def list_users(self) -> list[dict]:
        return [self._public(r) for r in
                self._all("SELECT * FROM users WHERE username IS NOT NULL "
                          "ORDER BY created_at DESC")]

    def set_password(self, user_id: int, password: str,
                     revoke_sessions: bool = False) -> None:
        with self._engine().begin() as conn:
            conn.execute(text(
                # Clearing the salt is what retires the row from the old scheme.
                "UPDATE users SET password_hash = :h, salt = '' WHERE id = :id"),
                {"h": _hash(password), "id": user_id})
            if revoke_sessions:
                conn.execute(text("DELETE FROM sessions WHERE user_id = :id"),
                             {"id": user_id})

    def set_status(self, user_id: int, status: str) -> dict | None:
        with self._engine().begin() as conn:
            conn.execute(text(
                # `active` is what the tracker's pickers read, and it means
                # "this account works" — so it follows status rather than being
                # a second thing somebody has to remember to set.
                "UPDATE users SET status = :s, active = :a WHERE id = :id"),
                {"s": status, "a": status == "approved", "id": user_id})
            if status in ("rejected", "banned", "suspended"):
                conn.execute(text("DELETE FROM sessions WHERE user_id = :id"),
                             {"id": user_id})
        return self._after(user_id)

    def update_profile(self, user_id: int, nickname: str, avatar: str) -> dict | None:
        row = self.by_id(user_id)
        if not row:
            return None
        self._write(
            "UPDATE users SET nickname = :n, avatar = :a, display_name = :d "
            "WHERE id = :id",
            n=nickname, a=avatar, id=user_id,
            d=self._shown(nickname, row["username"]))
        return self._after(user_id)

    def set_myboard_enabled(self, user_id: int, enabled: bool) -> dict | None:
        self._write("UPDATE users SET myboard_enabled = :v WHERE id = :id",
                    v=bool(enabled), id=user_id)
        return self._after(user_id)

    def set_releases_enabled(self, user_id: int, enabled: bool) -> dict | None:
        self._write("UPDATE users SET releases_enabled = :v WHERE id = :id",
                    v=bool(enabled), id=user_id)
        return self._after(user_id)

    def ensure_code(self, user_id: int) -> str | None:
        """The user's My Board prefix, assigning a unique one on first use."""
        with self._lock:
            row = self.by_id(user_id)
            if not row:
                return None
            if row["code"]:
                return row["code"]
            taken = {r["code"] for r in
                     self._all("SELECT code FROM users WHERE code IS NOT NULL")}
            code = _gen_code(
                (row["nickname"] or row["username"] or "").strip(), taken)
            self._write("UPDATE users SET code = :c WHERE id = :id",
                        c=code, id=user_id)
            return code

    def set_tags(self, user_id: int, tags: list[str]) -> dict | None:
        # Normalize: lowercase slugs, deduped, order-preserved.
        seen: list[str] = []
        for t in tags:
            slug = re.sub(r"[^a-z0-9_]", "", str(t).strip().lower())
            if slug and slug not in seen:
                seen.append(slug)
        self._write("UPDATE users SET tags = :t WHERE id = :id",
                    t=",".join(seen), id=user_id)
        return self._after(user_id)

    def set_jira_account(self, user_id: int, account_id: str | None) -> dict | None:
        """Link (or unlink, with None) a local account to its Jira roster dev."""
        self._write("UPDATE users SET jira_account_id = :a WHERE id = :id",
                    a=account_id or None, id=user_id)
        return self._after(user_id)

    def set_role(self, user_id: int, role: str) -> dict | None:
        self._write("UPDATE users SET role = :r WHERE id = :id",
                    r=role, id=user_id)
        return self._after(user_id)

    # --- sessions --------------------------------------------------------

    def create_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        self._write(
            "INSERT INTO sessions (token, user_id, expires_at) "
            "VALUES (:t, :u, :e)",
            t=token, u=user_id,
            e=datetime.now(timezone.utc) + timedelta(seconds=SESSION_TTL))
        return token

    def session_user(self, token: str | None) -> dict | None:
        if not token:
            return None
        # One query rather than two: the session and the person are in the same
        # database now, which is the smallest and most ordinary benefit of
        # having moved them there.
        row = self._one("""
            SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token = :t AND s.expires_at > now()
        """, t=token)
        if not row or row["status"] != "approved":
            return None
        return self._public(row)

    def delete_session(self, token: str | None) -> None:
        if not token:
            return
        self._write("DELETE FROM sessions WHERE token = :t", t=token)

    def purge_expired_sessions(self) -> int:
        """Housekeeping. The old file grew a row per sign-in for ever."""
        with self._engine().begin() as conn:
            return conn.execute(
                text("DELETE FROM sessions WHERE expires_at <= now()")).rowcount
