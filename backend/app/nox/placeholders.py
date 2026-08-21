"""Giving the demo people accounts, so the app behaves like a real one now.

`mock.py` invents seventeen colleagues and gives them sixty-six issues, fifty
comments and eight hundred events. None of them had an account, so every one of
them was a ghost: a name on work that nobody could ever be, and a hole in every
screen that reasons about *people* rather than about rows.

This gives each of them one.

**No merge, because the ids already agree.** The tracker projects an account
into its own `users` table keyed on the account's id, so an account created at
900016 *is* the person the demo data has been calling Ana Mihalache. Nothing
moves. That is the whole trick, and it is why this is thirty lines rather than
the two hundred that repointing twenty-six columns took.

**Nobody can sign in as them.** The password is a random secret that is hashed
and then thrown away — not stored anywhere, not printed, not known to whoever
ran this. An account for somebody who has not asked for one is only reasonable
if there is no way into it, and the way to guarantee that is to never have a
password rather than to have a weak one.

They are *approved* rather than *pending* on purpose: pending means "waiting for
an admin", and seventeen fictional people in that queue would bury the one real
person standing in it. Their email says `@mock.local`, so which rows are
placeholders is visible at a glance in Accounts rather than being something you
have to know.

Reversible. `remove()` takes them all away again, and because nothing ever
moved, taking them away leaves the tracker exactly as it was.
"""

from __future__ import annotations

import logging
import re
import unicodedata

from sqlalchemy import text

from .. import db

log = logging.getLogger(__name__)

# The seeded people live here — see `mock.py`, which numbers them from 900000.
SEEDED_FROM = 900_000

# Says "this is not a person" at a glance, in the one column an admin reads.
DOMAIN = "mock.local"


def _slug(name: str) -> str:
    """`Mihaela Cîrstea` -> `mihaela.cirstea`.

    The accents are folded rather than dropped. Stripping them turned Cîrstea
    into `c.rstea`, which is what somebody would have read in the email column
    every day — and these are the names the team actually has.
    """
    flat = unicodedata.normalize("NFKD", name or "")
    flat = "".join(c for c in flat if not unicodedata.combining(c))
    # The few Romanian letters NFKD does not decompose.
    flat = flat.replace("ș", "s").replace("ş", "s").replace("ț", "t").replace("ţ", "t")
    return re.sub(r"[^a-z0-9]+", ".", flat.lower()).strip(".") or "someone"


def _people() -> list[dict]:
    engine = db.engine()
    if engine is None:
        return []
    with engine.connect() as conn:
        return [dict(r) for r in conn.execute(text("""
            SELECT id, display_name, avatar FROM users
            WHERE id >= :from_id ORDER BY id
        """), {"from_id": SEEDED_FROM}).mappings()]


def create(auth) -> dict:
    """One account per seeded person, at the id the tracker already knows them
    by. Idempotent: anybody who already has one is left alone."""
    have = {row["id"] for row in auth.all_rows()}
    taken = {row["username"] for row in auth.all_rows()}
    made, skipped = [], []

    for person in _people():
        if person["id"] in have:
            skipped.append(person["display_name"])
            continue
        username = _slug(person["display_name"])
        # Two colleagues could share a name; the id is what makes them distinct
        # everywhere else, so it is what distinguishes them here too.
        if username in taken:
            username = f"{username}.{person['id']}"
        taken.add(username)
        auth.create_at_id(
            person["id"], username, f"{username}@{DOMAIN}",
            nickname=person["display_name"], avatar=person["avatar"] or "",
        )
        made.append(person["display_name"])

    log.info("placeholder accounts: made %s, already had %s", len(made), len(skipped))
    return {"made": made, "already_had": skipped}


def remove(auth) -> dict:
    """Take them away again.

    Only the ones this made — matched on the email domain, not on the id range,
    because a real person who registered after these exist has an id in the same
    range and deleting them would be the worst possible outcome of a cleanup.
    """
    gone = []
    for row in auth.all_rows():
        if (row["email"] or "").endswith(f"@{DOMAIN}"):
            auth.delete_user(row["id"])
            gone.append(row["nickname"] or row["username"])
    log.info("placeholder accounts: removed %s", len(gone))
    return {"removed": gone}
