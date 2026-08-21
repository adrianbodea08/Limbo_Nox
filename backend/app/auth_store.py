"""Local user accounts, sessions, and registration approval.

Passwords are hashed with **Argon2id**, which is what you want for a password:
it is deliberately expensive in *memory* as well as time, so the GPU and ASIC
farms that make short work of PBKDF2 get no leverage.

Accounts made before this used PBKDF2-HMAC-SHA256. Those hashes are still
accepted — and quietly replaced with an Argon2id one the next time the person
signs in, because that is the only moment the plaintext exists to rehash from.
Nobody is locked out and nobody is asked to reset anything; the old hashes drain
away as people use the app. A row that never logs in again keeps its PBKDF2
hash, which is exactly as safe as it was yesterday.
"""
from __future__ import annotations

import hashlib
import logging
import random
import re
import secrets
import sqlite3
import string
import time
from pathlib import Path
from threading import Lock

SESSION_TTL = 60 * 60 * 24 * 30  # 30 days

# The old scheme. Kept only to verify hashes made before the change.
_LEGACY_ITER = 120_000

log = logging.getLogger("nox.auth")

# OWASP's floor for Argon2id: 19 MiB of memory, two passes, one lane. The memory
# is the point — it is what a cracking rig cannot cheaply parallelise. Two
# passes over 19 MiB costs a login tens of milliseconds and costs an attacker
# roughly a thousand times what PBKDF2 did.
_ARGON = None


def _hasher():
    """The Argon2 hasher, built once and only if the library is there."""
    global _ARGON
    if _ARGON is None:
        from argon2 import PasswordHasher

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
    """PBKDF2-HMAC-SHA256, as accounts were hashed before Argon2id."""
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), _LEGACY_ITER
    ).hex()


def _hash(password: str) -> str:
    """An Argon2id hash. Self-describing — it carries its own parameters and
    salt — so the `salt` column is left empty for anything hashed this way."""
    return _hasher().hash(password)


class AuthStore:
    def __init__(self, db_path: str):
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=4000")
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                username      TEXT UNIQUE NOT NULL,
                email         TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                salt          TEXT NOT NULL,
                role          TEXT NOT NULL DEFAULT 'user',
                status        TEXT NOT NULL DEFAULT 'pending',
                created_at    REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token      TEXT PRIMARY KEY,
                user_id    INTEGER NOT NULL,
                expires_at REAL NOT NULL
            );
            """
        )
        # Profile fields added later — migrate existing databases in place.
        for col, decl in (("nickname", "TEXT NOT NULL DEFAULT ''"),
                          ("avatar", "TEXT NOT NULL DEFAULT ''"),
                          ("myboard_enabled", "INTEGER NOT NULL DEFAULT 1"),
                          ("releases_enabled", "INTEGER NOT NULL DEFAULT 1"),
                          ("code", "TEXT"),  # unique per-user prefix for My Board keys
                          ("tags", "TEXT NOT NULL DEFAULT ''"),  # comma-separated account tags (e.g. time_management)
                          ("jira_account_id", "TEXT"),  # linked Jira roster dev (drives the private Dev Profile)
                          ("bug_rate", "REAL")):  # the dev's private €/h bug-cost rate (null => default)
            try:
                self._conn.execute(f"ALTER TABLE users ADD COLUMN {col} {decl}")
            except sqlite3.OperationalError:
                pass  # column already exists
        self._conn.commit()

    # --- users -----------------------------------------------------------

    @staticmethod
    def _public(row: sqlite3.Row) -> dict:
        return {
            "id": row["id"],
            "username": row["username"],
            "email": row["email"],
            "role": row["role"],
            "status": row["status"],
            "createdAt": row["created_at"],
            "nickname": row["nickname"],
            "avatar": row["avatar"],
            "myboardEnabled": bool(row["myboard_enabled"]),
            "releasesEnabled": bool(row["releases_enabled"]),
            "code": row["code"],
            "tags": [t for t in (row["tags"] or "").split(",") if t],
            "jiraAccountId": row["jira_account_id"],
        }

    def count(self) -> int:
        with self._lock:
            return self._conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]

    def create_user(
        self,
        username: str,
        email: str,
        password: str,
        role: str = "user",
        status: str = "pending",
    ) -> dict:
        now = time.time()
        with self._lock:
            cur = self._conn.execute(
                """INSERT INTO users (username, email, password_hash, salt, role, status, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                # Argon2 embeds its own salt, so the column stays empty. Its
                # presence is what marks a row as the old scheme.
                (username, email, _hash(password), "", role, status, now),
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM users WHERE id = ?", (cur.lastrowid,)
            ).fetchone()
        return self._public(row)

    def _by(self, field: str, value) -> sqlite3.Row | None:
        with self._lock:
            return self._conn.execute(
                f"SELECT * FROM users WHERE {field} = ?", (value,)
            ).fetchone()

    def by_username(self, username: str) -> sqlite3.Row | None:
        # Usernames are matched case-insensitively.
        with self._lock:
            return self._conn.execute(
                "SELECT * FROM users WHERE username = ? COLLATE NOCASE", (username,)
            ).fetchone()

    def by_email(self, email: str) -> sqlite3.Row | None:
        return self._by("email", email)

    def by_id(self, user_id: int) -> sqlite3.Row | None:
        return self._by("id", user_id)

    def verify(self, row: sqlite3.Row, password: str) -> bool:
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
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM users ORDER BY created_at DESC"
            ).fetchall()
        return [self._public(r) for r in rows]

    def set_password(
        self, user_id: int, password: str, revoke_sessions: bool = False
    ) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE users SET password_hash = ?, salt = ? WHERE id = ?",
                # Clearing the salt is what retires the row from the old scheme.
                (_hash(password), "", user_id),
            )
            if revoke_sessions:
                self._conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
            self._conn.commit()

    def set_status(self, user_id: int, status: str) -> dict | None:
        with self._lock:
            self._conn.execute(
                "UPDATE users SET status = ? WHERE id = ?", (status, user_id)
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            if status in ("rejected", "banned"):
                self._conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
                self._conn.commit()
        return self._public(row) if row else None

    def update_profile(self, user_id: int, nickname: str, avatar: str) -> dict | None:
        with self._lock:
            self._conn.execute(
                "UPDATE users SET nickname = ?, avatar = ? WHERE id = ?",
                (nickname, avatar, user_id),
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        return self._public(row) if row else None

    def set_myboard_enabled(self, user_id: int, enabled: bool) -> dict | None:
        with self._lock:
            self._conn.execute(
                "UPDATE users SET myboard_enabled = ? WHERE id = ?",
                (1 if enabled else 0, user_id),
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        return self._public(row) if row else None

    def set_releases_enabled(self, user_id: int, enabled: bool) -> dict | None:
        with self._lock:
            self._conn.execute(
                "UPDATE users SET releases_enabled = ? WHERE id = ?",
                (1 if enabled else 0, user_id),
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        return self._public(row) if row else None

    def ensure_code(self, user_id: int) -> str | None:
        """Return the user's My Board prefix, assigning a unique one on first use."""
        with self._lock:
            row = self._conn.execute(
                "SELECT code, nickname, username FROM users WHERE id = ?", (user_id,)
            ).fetchone()
            if not row:
                return None
            if row["code"]:
                return row["code"]
            taken = {
                r["code"]
                for r in self._conn.execute(
                    "SELECT code FROM users WHERE code IS NOT NULL"
                ).fetchall()
            }
            code = _gen_code((row["nickname"] or row["username"] or "").strip(), taken)
            self._conn.execute("UPDATE users SET code = ? WHERE id = ?", (code, user_id))
            self._conn.commit()
            return code

    def set_tags(self, user_id: int, tags: list[str]) -> dict | None:
        # Normalize: lowercase slugs, deduped, order-preserved.
        seen: list[str] = []
        for t in tags:
            slug = re.sub(r"[^a-z0-9_]", "", str(t).strip().lower())
            if slug and slug not in seen:
                seen.append(slug)
        with self._lock:
            self._conn.execute(
                "UPDATE users SET tags = ? WHERE id = ?", (",".join(seen), user_id)
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        return self._public(row) if row else None

    def set_jira_account(self, user_id: int, account_id: str | None) -> dict | None:
        """Link (or unlink, with None) a local account to its Jira roster dev."""
        with self._lock:
            self._conn.execute(
                "UPDATE users SET jira_account_id = ? WHERE id = ?",
                (account_id or None, user_id),
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        return self._public(row) if row else None

    def set_role(self, user_id: int, role: str) -> dict | None:
        with self._lock:
            self._conn.execute(
                "UPDATE users SET role = ? WHERE id = ?", (role, user_id)
            )
            self._conn.commit()
            row = self._conn.execute(
                "SELECT * FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        return self._public(row) if row else None

    # --- sessions --------------------------------------------------------

    def create_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._conn.execute(
                "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
                (token, user_id, time.time() + SESSION_TTL),
            )
            self._conn.commit()
        return token

    def session_user(self, token: str | None) -> dict | None:
        if not token:
            return None
        with self._lock:
            s = self._conn.execute(
                "SELECT * FROM sessions WHERE token = ?", (token,)
            ).fetchone()
            if not s or s["expires_at"] < time.time():
                return None
            row = self._conn.execute(
                "SELECT * FROM users WHERE id = ?", (s["user_id"],)
            ).fetchone()
        if not row or row["status"] != "approved":
            return None
        return self._public(row)

    def delete_session(self, token: str | None) -> None:
        if not token:
            return
        with self._lock:
            self._conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            self._conn.commit()
