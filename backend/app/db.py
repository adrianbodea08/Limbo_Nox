"""Nox's database, and the fact that it might not be there.

Postgres, because Nox needs the things SQLite cannot give it: JSONB for custom
fields, real concurrency for the automation worker, and window functions for the
queries that rank work.

A missing database is a **state**, not an error. `engine()` returns None and
every caller is expected to handle it — the API answers 503 with a readable
sentence and the page says "not connected yet". That is what lets Nox be
deployed before anybody has provisioned anything, and it is why the connection
is retried lazily rather than demanded at boot.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any

from .config import config

log = logging.getLogger("uvicorn.error")

# How long a failed connection is remembered before trying again, so a page
# refresh doesn't retry a dead host on every request.
_RETRY_AFTER = 30.0

_pool: Any = None
_pool_lock = threading.Lock()
_last_error: str = ""
_last_attempt: float = 0.0


def configured() -> bool:
    """Whether a database has been provisioned for us at all."""
    return bool(config.tracker_database_url)


def _dsn() -> str:
    """SQLAlchemy needs the driver named; plain postgresql:// means psycopg2."""
    url = config.tracker_database_url
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


def _connect() -> Any:
    """Build the engine. Only ever called with a URL set, and under the lock."""
    from sqlalchemy import create_engine

    return create_engine(
        _dsn(),
        # One worker's share of the server's connection limit. Raise this and
        # the worker count together, never one alone.
        pool_size=5,
        max_overflow=5,
        pool_pre_ping=True,      # a connection idle through a restart is dead
        pool_recycle=1800,
        connect_args={"connect_timeout": 5},
    )


def engine() -> Any | None:
    """The SQLAlchemy engine, or None when there is nothing to connect to.

    Callers must handle None — that is the "not connected yet" path, not an
    exceptional one.
    """
    global _pool, _last_error, _last_attempt
    if not configured():
        return None
    if _pool is not None:
        return _pool
    with _pool_lock:
        if _pool is not None:  # another thread won the race
            return _pool
        if time.time() - _last_attempt < _RETRY_AFTER:
            return None  # recently failed; don't hammer it
        _last_attempt = time.time()
        try:
            eng = _connect()
            # create_engine is lazy, so prove the connection before we call it
            # good — otherwise the first real query is where it fails.
            with eng.connect() as conn:
                conn.exec_driver_sql("SELECT 1")
            _pool = eng
            _last_error = ""
            log.info("tracker: connected to Postgres")
        except Exception as exc:  # noqa: BLE001 — any failure is the same state
            _last_error = str(exc)[:300]
            log.warning("tracker: could not connect to Postgres — %s", _last_error)
            return None
    return _pool


def status() -> dict:
    """What the tracker page needs to decide between a board and a message.

    Runs a real query rather than trusting the pool object, because a pool that
    was healthy at start-up says nothing about a database that has since gone.
    """
    if not configured():
        return {
            "configured": False,
            "connected": False,
            "message": "You are not connected yet — no database has been set up for the tracker.",
        }
    eng = engine()
    if eng is None:
        return {
            "configured": True,
            "connected": False,
            "error": _last_error,
            "message": "A database is configured but cannot be reached.",
        }
    try:
        with eng.connect() as conn:
            version = conn.exec_driver_sql("SELECT version()").scalar() or ""
            revision = conn.exec_driver_sql(
                "SELECT version_num FROM alembic_version"
            ).scalar()
        return {
            "configured": True,
            "connected": True,
            "server": version.split(",")[0],
            "schema": revision,
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "configured": True,
            "connected": False,
            "error": str(exc)[:300],
            "message": "A database is configured but the connection failed.",
        }


def close() -> None:
    """Dispose the engine on app exit. Safe when nothing was ever opened."""
    global _pool
    with _pool_lock:
        if _pool is not None:
            try:
                _pool.dispose()
            finally:
                _pool = None
