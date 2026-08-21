"""A real database, thrown away afterwards.

**Not SQLite, and not mocks.** Everything worth testing here is a thing Postgres
does: the twenty-seven foreign keys, `visible_project_ids` compiling to SQL, a
unique constraint refusing a second account. A stand-in that does not enforce
those would pass every test in this directory while the real thing failed.

**Not the live database either.** `nox_test` is created, migrated, used and
dropped, so running the suite never costs anybody their demo data — the version
of this that ran against `nox` would work perfectly right up until the first
person had real work in it.

The engine caches at module level and the config is read at import, so the URL
has to be chosen before anything from `app` is imported. That is why this file
sets the environment first and imports afterwards, against the usual habit.
"""

from __future__ import annotations

import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))

# Inside the compose network the database answers to `db`; from a host shell it
# is on localhost. One variable, so the suite runs from either.
ADMIN_URL = os.getenv("NOX_TEST_ADMIN_URL", "postgresql://nox:nox@db:5432/postgres")
TEST_DB = f"nox_test_{uuid.uuid4().hex[:8]}"
TEST_URL = ADMIN_URL.rsplit("/", 1)[0] + "/" + TEST_DB

os.environ["NOX_DATABASE_URL"] = TEST_URL
os.environ["NOX_AUTH_DB_PATH"] = "/tmp/unused-by-tests.db"


def _admin_engine():
    from sqlalchemy import create_engine

    return create_engine(
        ADMIN_URL.replace("postgresql://", "postgresql+psycopg://", 1),
        isolation_level="AUTOCOMMIT")


@pytest.fixture(scope="session", autouse=True)
def database():
    """One database for the whole run, built by the real migrations.

    By Alembic rather than `metadata.create_all`, because the migrations are
    what actually runs against the real database — testing a schema built a
    different way would leave the one people depend on untested.
    """
    engine = _admin_engine()
    with engine.connect() as conn:
        conn.exec_driver_sql(f'CREATE DATABASE "{TEST_DB}"')

    env = {**os.environ, "NOX_DATABASE_URL": TEST_URL}
    result = subprocess.run(
        ["alembic", "upgrade", "head"], cwd=BACKEND, env=env,
        capture_output=True, text=True)
    if result.returncode != 0:
        with engine.connect() as conn:
            conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{TEST_DB}"')
        raise RuntimeError(f"migrations failed:\n{result.stdout}\n{result.stderr}")

    yield TEST_URL

    from app import db as _db
    if getattr(_db, "_pool", None) is not None:
        _db._pool.dispose()
    with engine.connect() as conn:
        conn.exec_driver_sql(f'DROP DATABASE IF EXISTS "{TEST_DB}"')


@pytest.fixture()
def store():
    from app.auth_store import AuthStore

    return AuthStore()


@pytest.fixture(autouse=True)
def clean(database):
    """Empty the tables each test touches, before every one of them.

    Autouse, because the version that was not caught a leak on its first run:
    only the tests that asked for a client got a clean database, so the ones
    working directly against the store inherited the previous test's rows and
    failed on a unique constraint. A fixture that has to be remembered is one
    that will not be.

    Deliberately not a transaction rolled back around each test: several of
    these assert on what the *database* refuses, and a foreign key is checked at
    statement time inside whatever transaction is open — testing that through a
    layer that never commits would be testing the wrapper.
    """
    from sqlalchemy import text

    from app import db as _db

    with _db.engine().begin() as conn:
        # Every table, found rather than listed. The version with a list missed
        # `statuses`, which has no foreign key to `users` and so was not reached
        # by the cascade — and a list has to be updated by whoever adds the next
        # table, which is a thing nobody will remember to do.
        names = [r[0] for r in conn.execute(text("""
            SELECT tablename FROM pg_tables
            WHERE schemaname = 'public' AND tablename <> 'alembic_version'
        """))]
        if names:
            conn.execute(text(
                f"TRUNCATE {', '.join(names)} RESTART IDENTITY CASCADE"))
    yield


@pytest.fixture()
def client(clean):
    """The real app, with its middleware.

    Not entered as a context manager on purpose: that would run the lifespan and
    start the automation worker, which has nothing to do with any of this and
    would keep a thread alive between tests.
    """
    from fastapi.testclient import TestClient

    from app.main import app

    return TestClient(app)


@pytest.fixture(autouse=True)
def forget_rate_limits():
    """The limiter is a module-level dict, so one test's failures would count
    against the next one's."""
    from app import ratelimit

    ratelimit._hits.clear()
    yield
    ratelimit._hits.clear()


@pytest.fixture()
def person(store):
    """Somebody who can sign in. Returns (public dict, password)."""
    def make(username="somebody", *, role="member", status="approved",
             password="a-real-password"):
        return store.create_user(
            username, f"{username}@test.local", password,
            role=role, status=status), password
    return make
