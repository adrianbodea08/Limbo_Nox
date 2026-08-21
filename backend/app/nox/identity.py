"""Claiming a person — joining a real account to the work already under a name.

The tracker was populated before anybody could sign in: seventeen people own
sixty-six issues, fifty-four comments and eight hundred events, and not one of
them has an account. When the real Ana joins she is a *new* person, and the Ana
who wrote all that history is a ghost with her name.

So an invitation can say *you are this person*, and joining moves everything
across.

**The columns are discovered, never listed.** Accounts live in SQLite, so there
is no foreign key from Postgres to lean on — twenty-six columns hold a user id
and none of them declares it. A hand-written list would be wrong the first time
somebody adds `issues.closed_by`, and wrong silently: the merge would succeed,
report success, and leave a row pointing at somebody who no longer exists. So
the list comes from `information_schema` every time this runs.

Two columns do not look like user ids and are handled by name, because no sweep
would find them:

  * `project_access.value` — a *text* column holding a user id when `kind` is
    `'user'`. Missing it would silently take away somebody's access to a
    project on the day they joined.

Two more can collide, because a user id is part of their key:

  * `notification_prefs.user_id` is the primary key
  * `team_members (team_id, user_id)` is the primary key

If both the account and the person being claimed have a row, repointing one on
top of the other violates the key. The account's own row wins — it is the one
that person has actually been using.
"""

from __future__ import annotations

import logging

from sqlalchemy import text

from .. import db

log = logging.getLogger(__name__)

# Columns whose name says they hold a user id. Deliberately a shape rather than
# a list — see the note above.
DISCOVER = text("""
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.data_type IN ('integer', 'bigint')
      AND (c.column_name LIKE '%\\_by' ESCAPE '\\'
           OR c.column_name LIKE '%\\_of' ESCAPE '\\'
           OR c.column_name IN ('user_id', 'owner_id', 'actor_id', 'assignee_id',
                                'reporter_id', 'tester_id', 'author_id', 'lead_id'))
      AND c.table_name <> 'users'
    ORDER BY c.table_name, c.column_name
""")

# Where a user id is part of a key, so two rows cannot become one.
COLLIDES = {
    ("notification_prefs", "user_id"): "user_id = :account",
    ("team_members", "user_id"): "user_id = :account AND team_id IN "
                                 "(SELECT team_id FROM team_members WHERE user_id = :person)",
}


class ClaimError(Exception):
    """Something a caller can act on, and a sentence they can read."""


def claim(account_id: int, person_id: int, display_name: str | None = None) -> dict:
    """Move everything `person_id` owns onto `account_id`, then retire them.

    Returns what moved, per column, so the result can be read rather than
    trusted.
    """
    if account_id == person_id:
        raise ClaimError("That account is already that person.")

    engine = db.engine()
    if engine is None:
        raise ClaimError("The tracker has no database to claim anybody in.")

    moved: dict[str, int] = {}
    with engine.begin() as conn:
        person = conn.execute(
            text("SELECT id, display_name, avatar FROM users WHERE id = :id"),
            {"id": person_id}).mappings().first()
        if person is None:
            raise ClaimError("There is no such person in the tracker.")

        # The account's own projected row has to exist before anything points
        # at it — `_project_user` writes it on the way past, but a brand new
        # account may not have made a request yet.
        conn.execute(
            text("""INSERT INTO users (id, display_name, avatar, active)
                    VALUES (:id, :name, :avatar, TRUE)
                    ON CONFLICT (id) DO NOTHING"""),
            {"id": account_id,
             "name": display_name or person["display_name"],
             "avatar": person["avatar"] or ""},
        )

        for table, column in conn.execute(DISCOVER).all():
            where = COLLIDES.get((table, column))
            if where:
                # Drop the account's own row first, so repointing the person's
                # cannot land on top of it.
                conn.execute(
                    text(f"DELETE FROM {table} WHERE {where}"),  # noqa: S608 - names from information_schema
                    {"account": account_id, "person": person_id},
                )
            n = conn.execute(
                text(f"UPDATE {table} SET {column} = :account WHERE {column} = :person"),  # noqa: S608
                {"account": account_id, "person": person_id},
            ).rowcount
            if n:
                moved[f"{table}.{column}"] = n

        # The one that hides in a text column.
        n = conn.execute(
            text("""UPDATE project_access SET value = :account
                    WHERE kind = 'user' AND value = :person"""),
            {"account": str(account_id), "person": str(person_id)},
        ).rowcount
        if n:
            moved["project_access.value"] = n

        # Only now, and only if nothing still points at them. With no foreign
        # key anywhere, a missed reference would not raise — it would sit there
        # pointing at an id that no longer exists, and show up months later as a
        # blank name on somebody's oldest issue. Raising here rolls the whole
        # transaction back, so the sentence below is true.
        left = _references(conn, person_id)
        if left:
            raise ClaimError(
                "Not everything moved: " + ", ".join(f"{k} ({v})" for k, v in left.items())
                + ". Nothing has been changed.")

        conn.execute(text("DELETE FROM users WHERE id = :id"), {"id": person_id})

    log.info("account %s claimed person %s: %s", account_id, person_id, moved)
    return {"account_id": account_id, "person_id": person_id,
            "name": person["display_name"], "avatar": person["avatar"] or "",
            "moved": moved}


def _references(conn, person_id: int) -> dict[str, int]:
    """Anything still pointing at this person."""
    left: dict[str, int] = {}
    for table, column in conn.execute(DISCOVER).all():
        n = conn.execute(
            text(f"SELECT count(*) FROM {table} WHERE {column} = :id"),  # noqa: S608
            {"id": person_id}).scalar_one()
        if n:
            left[f"{table}.{column}"] = n
    n = conn.execute(
        text("SELECT count(*) FROM project_access WHERE kind = 'user' AND value = :id"),
        {"id": str(person_id)}).scalar_one()
    if n:
        left["project_access.value"] = n
    return left


def unclaimed() -> list[dict]:
    """People in the tracker who nobody signs in as.

    The 900000s are the seeded ones; anybody below that came from an account.
    Offered when writing an invitation, so "you are this person" is a pick from
    a list rather than an id somebody has to look up.
    """
    engine = db.engine()
    if engine is None:
        return []
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT u.id, u.display_name, u.avatar,
                   (SELECT count(*) FROM issues i WHERE i.assignee_id = u.id) AS issues
            FROM users u
            WHERE u.id >= 900000 AND u.active
            ORDER BY u.display_name
        """)).mappings().all()
    return [dict(r) for r in rows]
