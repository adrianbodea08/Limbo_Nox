"""Alembic environment for the tracker.

The database URL comes from NOX_DATABASE_URL, never from alembic.ini. If it
is unset there is nothing to migrate and we say so and exit cleanly — that is
the normal state on live until a database is provisioned, and a deploy must not
fail because of it.
"""
from __future__ import annotations

import os
import sys
from logging.config import fileConfig
from pathlib import Path

from alembic import context
from sqlalchemy import engine_from_config, pool

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.nox.schema import metadata  # noqa: E402

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = metadata

DB_URL = (os.getenv("NOX_DATABASE_URL")
          or os.getenv("TRACKER_DATABASE_URL", "")).strip()


def _url() -> str:
    if not DB_URL:
        print("NOX_DATABASE_URL is not set — nothing to migrate.", file=sys.stderr)
        raise SystemExit(0)
    # psycopg3, not the default psycopg2 that SQLAlchemy assumes.
    if DB_URL.startswith("postgresql://"):
        return DB_URL.replace("postgresql://", "postgresql+psycopg://", 1)
    return DB_URL


def run_migrations_offline() -> None:
    context.configure(
        url=_url(),
        target_metadata=target_metadata,
        literal_binds=True,
        compare_type=True,
        dialect_opts={"paramstyle": "named"},
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    section = config.get_section(config.config_ini_section) or {}
    section["sqlalchemy.url"] = _url()
    engine = engine_from_config(section, prefix="sqlalchemy.", poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(
            connection=connection,
            target_metadata=target_metadata,
            # Catch a column whose type drifted from the schema, not just
            # missing tables.
            compare_type=True,
        )
        with context.begin_transaction():
            context.run_migrations()
    engine.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
