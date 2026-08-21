"""Slowing down guessing.

Measured before this existed: **forty-five password attempts a second**, for as
long as anybody cared to keep going. Argon2 at the OWASP parameters costs about
14ms a try, which is the right cost for one login and no obstacle at all to a
machine with an evening spare.

In memory, with no dependency. Nox runs as one process behind one nginx, so a
dict and a lock are the whole implementation — and a rate limiter that needs
Redis to exist is one that does not get added.

**Two buckets, on purpose.** By address alone, an attacker with a botnet walks
straight through. By username alone, anybody can lock a colleague out of their
own account by typing the wrong password thirty times, which is a denial of
service wearing a security feature's clothes. So the address is held to a tight
count and the username to a loose one: together they slow a focused attack
without handing anybody a way to lock out a real person.
"""

from __future__ import annotations

import time
from threading import Lock

# (failures, window seconds). The address is the tight one because it is the
# one an attacker actually has to spend to get around.
BY_ADDRESS = (10, 5 * 60)
# Loose, so that "lock somebody out by guessing at them" costs a great deal more
# than it is worth, while a distributed run at one account still gets slowed.
BY_USERNAME = (30, 15 * 60)
# Registration is not guessing; this is only here so one machine cannot fill the
# accounts table overnight.
BY_REGISTRATION = (5, 60 * 60)

_hits: dict[str, list[float]] = {}
_lock = Lock()


class TooMany(Exception):
    """Refused for now. `retry_after` is in whole seconds, for the header."""

    def __init__(self, retry_after: int):
        super().__init__("Too many attempts.")
        self.retry_after = retry_after


def _prune(stamps: list[float], window: int, now: float) -> list[float]:
    return [t for t in stamps if now - t < window]


def check(key: str, rule: tuple[int, int]) -> None:
    """Raise if this key has spent its allowance. Does not record anything —
    checking and failing are different events, and only failures should cost."""
    limit, window = rule
    now = time.time()
    with _lock:
        stamps = _prune(_hits.get(key, []), window, now)
        _hits[key] = stamps
        if len(stamps) >= limit:
            # How long until the oldest one falls out of the window.
            raise TooMany(max(1, int(window - (now - stamps[0]))))


def record(key: str, rule: tuple[int, int]) -> None:
    """One failure against this key."""
    _, window = rule
    now = time.time()
    with _lock:
        _hits[key] = _prune(_hits.get(key, []), window, now) + [now]
        # Cheap housekeeping: without it a long-running process keeps a row per
        # address that ever mistyped a password.
        if len(_hits) > 4096:
            for k in [k for k, v in _hits.items() if not v]:
                del _hits[k]


def clear(*keys: str) -> None:
    """Getting it right proves it was not an attack."""
    with _lock:
        for key in keys:
            _hits.pop(key, None)


def address(request) -> str:
    """Who is actually asking.

    `request.client.host` is nginx, every time — the API is `expose`d rather
    than published, so every connection genuinely arrives from the proxy. nginx
    sets `X-Real-IP` from `$remote_addr`, which it controls and a client cannot
    forge.

    `X-Forwarded-For` is deliberately not used: it is built with
    `$proxy_add_x_forwarded_for`, which *appends* to whatever the client sent,
    so its first entry is whatever the attacker felt like typing.
    """
    real = (request.headers.get("X-Real-IP") or "").strip()
    if real:
        return real
    client = getattr(request, "client", None)
    return getattr(client, "host", "") or "unknown"
