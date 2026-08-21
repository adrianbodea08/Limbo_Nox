"""Nox's configuration.

Deliberately small. This was extracted from an app that also talked to Jira,
Tempo and GitHub on behalf of four other features, and none of that came with
it — Nox needs a database to keep its own data in, a place for accounts, and
the GitHub App that reads pull requests.

Everything is optional at import time. A missing database is a *state* Nox
reports and carries on from, not a failure to boot; the same is true of the
GitHub App. That is what lets it deploy before anybody has provisioned
anything.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

# backend/.env sits next to the app package; secrets/github.env is loaded by
# compose. Both are optional.
_HERE = Path(__file__).resolve().parent.parent
load_dotenv(_HERE / ".env", override=False)


@dataclass(frozen=True)
class AppConfig:
    """Everything Nox reads from the environment, resolved once."""

    # Where Nox keeps its work: projects, issues, releases, git refs.
    database_url: str
    # Accounts live in SQLite beside the app — small, local, and not worth a
    # second Postgres round trip on every request.
    auth_db_path: str
    # The GitHub App. Absent is fine; the Git page explains what to do.
    github_app_id: str
    github_app_slug: str
    github_webhook_secret: str
    cors_origins: list[str]

    @property
    def tracker_database_url(self) -> str:
        """The name db.py grew up with, kept so it did not need rewriting."""
        return self.database_url


def load_config() -> AppConfig:
    origins = [o.strip() for o in os.getenv("NOX_CORS_ORIGINS", "").split(",") if o.strip()]
    return AppConfig(
        database_url=(os.getenv("NOX_DATABASE_URL")
                      or os.getenv("TRACKER_DATABASE_URL", "")).strip(),
        auth_db_path=os.getenv("NOX_AUTH_DB_PATH", "/data/nox.db"),
        github_app_id=os.getenv("TRACKER_GITHUB_APP_ID", "").strip(),
        github_app_slug=os.getenv("TRACKER_GITHUB_APP_SLUG", "").strip(),
        github_webhook_secret=os.getenv("TRACKER_GIT_WEBHOOK_SECRET", "").strip(),
        cors_origins=origins,
    )


config = load_config()
