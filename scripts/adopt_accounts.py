#!/usr/bin/env python3
"""Move the accounts out of SQLite and into Postgres. Once.

    docker compose exec -T api python /app/../scripts/adopt_accounts.py
    (or:  python scripts/adopt_accounts.py   from the host)

Accounts and sessions lived in `/data/nox.db` while everything they refer to
lived in Postgres, and this table was a copy of them kept in sync on every
request. Migration `f2a7c9d40b13` added the columns and the twenty-six foreign
keys that were impossible while the two were apart; this brings the rows.

**Nothing is repointed.** `users.id` in Postgres has always been the account id,
so every one of those twenty-six columns already names the right row. This fills
in the other half of rows that already exist.

**Idempotent.** Run it twice and the second run updates the same rows to the
same values. It does not delete the SQLite file — that is a separate decision,
made after somebody has looked at the result.
"""

from __future__ import annotations

import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from sqlalchemy import text  # noqa: E402

from app import db  # noqa: E402
from app.config import config  # noqa: E402

COLUMNS = [
    "username", "email", "password_hash", "salt", "role", "status",
    "nickname", "tags", "code", "myboard_enabled", "releases_enabled",
    "jira_account_id", "bug_rate",
]


def when(epoch) -> datetime:
    """SQLite kept these as a unix float; Postgres wants a moment in time."""
    try:
        return datetime.fromtimestamp(float(epoch), tz=timezone.utc)
    except (TypeError, ValueError):
        return datetime.now(timezone.utc)


def main() -> int:
    src = sqlite3.connect(config.auth_db_path)
    src.row_factory = sqlite3.Row
    engine = db.engine()
    if engine is None:
        raise SystemExit("no tracker database to adopt into")

    people = src.execute("SELECT * FROM users ORDER BY id").fetchall()
    live = src.execute(
        "SELECT * FROM sessions WHERE expires_at > strftime('%s','now')").fetchall()

    moved = updated = 0
    with engine.begin() as conn:
        for row in people:
            values = {c: row[c] for c in COLUMNS}
            # SQLite has no boolean type and kept these as 0 and 1. Postgres
            # has one and will not quietly take an integer for it.
            for flag in ("myboard_enabled", "releases_enabled"):
                values[flag] = bool(values[flag])
            values["id"] = row["id"]
            values["created_at"] = when(row["created_at"])
            values["avatar"] = row["avatar"] or ""
            # What every screen shows. `_project_user` used to write this on
            # each request; now it is set here and maintained by the store.
            values["display_name"] = row["nickname"] or row["username"] or ""
            # A person is offered in the pickers when their account works.
            values["active"] = row["status"] == "approved"

            existing = conn.execute(
                text("SELECT display_name FROM users WHERE id = :id"),
                {"id": row["id"]}).first()
            if existing:
                # Keep the tracker's own display name: the seeded people are
                # "Ana Mihalache" there and `ana.mihalache` in the account, and
                # the first is the one anybody recognises.
                values["display_name"] = existing[0] or values["display_name"]
                sets = ", ".join(f"{k} = :{k}" for k in values if k != "id")
                conn.execute(text(f"UPDATE users SET {sets} WHERE id = :id"), values)
                updated += 1
            else:
                cols = ", ".join(values)
                binds = ", ".join(f":{k}" for k in values)
                conn.execute(text(f"INSERT INTO users ({cols}) VALUES ({binds})"), values)
                moved += 1

        kept = 0
        for s in live:
            conn.execute(text("""
                INSERT INTO sessions (token, user_id, expires_at)
                VALUES (:t, :u, :e)
                ON CONFLICT (token) DO UPDATE SET expires_at = EXCLUDED.expires_at
            """), {"t": s["token"], "u": s["user_id"], "e": when(s["expires_at"])})
            kept += 1

    src.close()
    print(f"  accounts: {moved} new, {updated} filled in")
    print(f"  sessions: {kept} still valid, carried over")
    print("\n  The SQLite file is untouched. Delete it once this looks right.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
