"""The background loop that runs automations.

An asyncio task rather than a separate process, because this backend already
runs single-worker for the same reason its other stores do — in-process state
that cannot be shared. When that changes, this becomes the first thing to move
out, and `claim()` is already written for several runners: it takes jobs with
`FOR UPDATE SKIP LOCKED`, so a second worker is safe the day one exists.

The loop is deliberately dull: tick, sleep, tick. Everything interesting is in
automation.py, and a tick that throws logs and carries on rather than killing
the task — a worker that dies quietly is indistinguishable from a rule that
never fires.
"""
from __future__ import annotations

import asyncio
import logging

from .. import db
from . import automation, git

log = logging.getLogger("tracker.worker")

# Long enough that an idle instance is not spinning, short enough that a person
# who moves a card sees the automation land while still looking at the page.
INTERVAL = 3.0

# How often to pull pull requests. The webhook is what makes this near-instant;
# the poll is the safety net that repairs a missed delivery and covers anyone
# who never configured a webhook. Five minutes is far below any GitHub rate
# limit and far above "somebody is waiting for it".
SYNC_EVERY = 300.0
_last_sync = 0.0

_task: asyncio.Task | None = None


async def _loop() -> None:
    idle = 0
    while True:
        try:
            engine = db.engine()
            if engine is None:
                # No database is a normal state on live, not an error. Back off
                # rather than retrying every three seconds forever.
                await asyncio.sleep(30)
                continue
            await _maybe_sync(engine)
            with engine.begin() as conn:
                result = automation.tick(conn)
            if result["queued"] or result.get("ran"):
                log.info("automation tick: %s", result)
                idle = 0
            else:
                idle = min(idle + 1, 10)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - the loop must outlive any one failure
            log.exception("automation tick failed")
            idle = 10
        # Quiet instances poll slowly; a busy one stays responsive.
        await asyncio.sleep(INTERVAL * (1 + idle))


async def _maybe_sync(engine) -> None:
    """Pull pull requests, occasionally.

    Failures are logged and swallowed: GitHub being unreachable must not stop
    automations from running, and a sync that fails now succeeds in five
    minutes. Nothing here is the only path to the data — the webhook is.
    """
    global _last_sync
    now = asyncio.get_running_loop().time()
    if now - _last_sync < SYNC_EVERY:
        return
    _last_sync = now
    try:
        result = await git.sync(engine)
        if result.get("pull_requests"):
            log.info("git sync: %s", result)
    except (git.NoCredentials, git.NothingToSync):
        # Nothing is connected yet. Normal before setup, and not worth a line
        # in the log every five minutes.
        pass
    except Exception:  # noqa: BLE001 - never let a sync kill the worker
        log.exception("git sync failed")


def start() -> None:
    global _task
    if _task is None or _task.done():
        _task = asyncio.create_task(_loop(), name="tracker-automation-worker")
        log.info("tracker automation worker started")


async def stop() -> None:
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass
    _task = None
