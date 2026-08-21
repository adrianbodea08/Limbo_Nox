"""Accounts, passwords and sessions.

This file exists because the whole of `auth_store.py` was rewritten on
2026-08-22 — moved from SQLite to Postgres — and verified entirely by hand. Hand
verification stops being true the moment somebody edits the file, which is
exactly when it matters.
"""

from __future__ import annotations

import time

import pytest
from sqlalchemy import text


def test_password_is_never_stored_in_the_clear(store, person):
    account, password = person("nadia")
    row = store.by_username("nadia")
    assert password not in (row["password_hash"] or "")
    # Argon2id specifically, not "some hash". The parameters are a security
    # decision and a silent downgrade to something cheap would still pass a
    # test that only checked the password was absent.
    assert row["password_hash"].startswith("$argon2id$")
    assert "m=19456" in row["password_hash"]
    assert account["username"] == "nadia"


def test_verify_accepts_the_password_and_nothing_else(store, person):
    _, password = person("nadia")
    row = store.by_username("nadia")
    assert store.verify(row, password) is True
    assert store.verify(row, password + " ") is False
    assert store.verify(row, "") is False
    assert store.verify(row, password.upper()) is False


def test_a_session_identifies_its_owner(store, person):
    account, _ = person("nadia")
    token = store.create_session(account["id"])
    who = store.session_user(token)
    assert who is not None
    assert who["id"] == account["id"]
    assert store.session_user(token + "x") is None
    assert store.session_user(None) is None


def test_an_expired_session_is_nobody(store, person):
    account, _ = person("nadia")
    token = store.create_session(account["id"])
    with store._engine().begin() as conn:
        conn.execute(text("UPDATE sessions SET expires_at = now() - interval '1 second' "
                          "WHERE token = :t"), {"t": token})
    assert store.session_user(token) is None


@pytest.mark.parametrize("status", ["pending", "suspended", "banned", "rejected"])
def test_only_an_approved_account_has_a_session(store, person, status):
    """Suspending somebody has to take effect now, not in thirty days.

    The session row can outlive the decision, so the account is re-read on every
    request rather than trusted from when the token was issued.
    """
    account, _ = person("nadia")
    token = store.create_session(account["id"])
    assert store.session_user(token) is not None

    store.set_status(account["id"], status)
    assert store.session_user(token) is None


def test_deleting_somebody_takes_their_sessions_with_them(store, person):
    account, _ = person("nadia")
    store.create_session(account["id"])
    store.create_session(account["id"])
    with store._engine().connect() as conn:
        before = conn.execute(text("SELECT count(*) FROM sessions WHERE user_id = :u"),
                              {"u": account["id"]}).scalar_one()
    assert before == 2

    store.delete_user(account["id"])
    with store._engine().connect() as conn:
        after = conn.execute(text("SELECT count(*) FROM sessions WHERE user_id = :u"),
                             {"u": account["id"]}).scalar_one()
    assert after == 0, "the ON DELETE CASCADE on sessions.user_id"


def test_a_username_cannot_be_taken_twice(store, person):
    person("nadia")
    with pytest.raises(Exception):
        store.create_user("nadia", "someone.else@test.local", "another-password")


def test_an_account_with_no_password_cannot_be_signed_into(store):
    """The seeded demo people. The point of them is that they own work and
    nobody can be them, which is only true if there is no password to find."""
    account = store.create_at_id(
        900_000, "andrei.lupescu", "andrei@mock.local",
        nickname="Andrei Lupescu", avatar="")
    row = store.by_id(account["id"])
    for guess in ("", "password", "andrei", "andrei.lupescu", "mock.local"):
        assert store.verify(row, guess) is False


def test_the_name_on_the_card_follows_the_profile(store, person):
    """`display_name` is what every tracker screen shows. It used to be copied
    from the account on every request by a projection that no longer exists, so
    the store maintains it — and a stale one would put the wrong name on
    somebody's issues."""
    account, _ = person("nadia")
    store.update_profile(account["id"], "Nadia Petrescu", "")
    with store._engine().connect() as conn:
        shown = conn.execute(text("SELECT display_name FROM users WHERE id = :i"),
                             {"i": account["id"]}).scalar_one()
    assert shown == "Nadia Petrescu"


def test_only_accounts_are_counted(store):
    """`count()` decides whether the very first registration becomes the admin.

    A person with no login — which the schema allows — must not make the app
    think somebody has already registered, or the first real person lands as a
    pending member with nobody able to approve them.
    """
    assert store.count() == 0
    with store._engine().begin() as conn:
        conn.execute(text("INSERT INTO users (id, display_name) VALUES (5, 'No login')"))
    assert store.count() == 0

    store.create_user("first", "first@test.local", "a-real-password")
    assert store.count() == 1


def test_created_at_stays_a_number(store, person):
    """The frontend has read a unix timestamp since the first version. Postgres
    returns a datetime, and letting that through would be the storage leaking
    into the wire format."""
    account, _ = person("nadia")
    assert isinstance(account["createdAt"], float)
    assert abs(account["createdAt"] - time.time()) < 60
