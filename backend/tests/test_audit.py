"""Who granted what.

The tracker recorded every ticket move and none of this until 2026-08-22. These
tests exist because an audit log that quietly stops recording is worse than not
having one: it answers "nothing happened" to a question where the truth was
"something did", and nobody finds out from the outside.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from app import db
from app.nox import audit


def sign_in(client, username, password):
    r = client.post("/api/auth/login",
                    json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


@pytest.fixture()
def two(client, person):
    admin, admin_password = person("boss", role="admin")
    member, member_password = person("nadia")
    return {
        "admin": admin, "admin_headers": sign_in(client, "boss", admin_password),
        "member": member, "member_password": member_password,
    }


def test_making_somebody_an_admin_is_recorded_with_the_before(client, two):
    """"changed a role" is not an answer. "member to admin" is."""
    client.put(f"/api/admin/users/{two['member']['id']}/role?role=admin",
               headers=two["admin_headers"])

    entries = audit.recent()
    assert len(entries) == 1
    entry = entries[0]
    assert entry["kind"] == "account_role"
    assert entry["actor"] == "boss"
    assert entry["subject"] == "nadia"
    assert entry["was"] == "member"
    assert entry["now"] == "admin"


def test_approving_an_account_is_recorded(client, person):
    admin, admin_password = person("boss", role="admin")
    waiting, _ = person("nadia", status="pending")
    headers = sign_in(client, "boss", admin_password)

    client.put(f"/api/admin/users/{waiting['id']}/status?status=approved",
               headers=headers)

    entry = audit.recent()[0]
    assert entry["kind"] == "account_status"
    assert (entry["was"], entry["now"]) == ("pending", "approved")


def test_a_refused_change_leaves_no_trace(client, two):
    """Recorded after the change, so an attempt that did not happen does not
    appear to have happened."""
    r = client.put(f"/api/admin/users/{two['member']['id']}/role?role=wizard",
                   headers=two["admin_headers"])
    assert r.status_code == 400
    assert audit.recent() == []


def test_a_member_cannot_change_anything_and_nothing_is_recorded(client, two):
    headers = sign_in(client, "nadia", two["member_password"])
    r = client.put(f"/api/admin/users/{two['admin']['id']}/role?role=member",
                   headers=headers)
    assert r.status_code == 403
    assert audit.recent() == []


def test_a_member_cannot_read_the_log(client, two):
    """It is a list of who has power, which is not a list everybody needs."""
    headers = sign_in(client, "nadia", two["member_password"])
    assert client.get("/api/admin/audit", headers=headers).status_code == 403
    assert client.get("/api/admin/audit").status_code == 401
    assert client.get("/api/admin/audit",
                      headers=two["admin_headers"]).status_code == 200


def test_the_log_never_breaks_the_thing_it_records(client, two, monkeypatch):
    """An audit write that could fail a request teaches people to route around
    it. A missing row is a smaller problem than an admin who cannot approve an
    account because the log is unhappy — but it is shouted about in the log
    file, because a silently empty audit trail is the worst of the three."""
    def explode(*a, **k):
        raise RuntimeError("the audit table is on fire")

    monkeypatch.setattr(audit.repo_mod, "write_event", explode)
    r = client.put(f"/api/admin/users/{two['member']['id']}/role?role=admin",
                   headers=two["admin_headers"])
    assert r.status_code == 200, "the action itself must still succeed"
    assert r.json()["role"] == "admin"


def test_the_log_is_append_only_in_practice(client, two):
    """Nothing in the app updates or deletes one. This asserts the shape rather
    than a permission — Postgres would happily allow it, and the guarantee is
    that no code path does."""
    client.put(f"/api/admin/users/{two['member']['id']}/role?role=admin",
               headers=two["admin_headers"])
    client.put(f"/api/admin/users/{two['member']['id']}/role?role=member",
               headers=two["admin_headers"])

    entries = audit.recent()
    assert len(entries) == 2
    # Newest first, and the earlier one is untouched by the later.
    assert (entries[0]["was"], entries[0]["now"]) == ("admin", "member")
    assert (entries[1]["was"], entries[1]["now"]) == ("member", "admin")


def test_an_admin_who_granted_something_cannot_be_quietly_deleted(client, two):
    """A side effect of the foreign key, and a welcome one: you cannot remove
    the record of who handed out power by removing the person who did."""
    client.put(f"/api/admin/users/{two['member']['id']}/role?role=admin",
               headers=two["admin_headers"])

    with pytest.raises(Exception) as caught:
        with db.engine().begin() as conn:
            conn.execute(text("DELETE FROM users WHERE id = :i"),
                         {"i": two["admin"]["id"]})
    assert "foreign key" in str(caught.value).lower()


def test_the_log_says_who_rather_than_which_id(client, two):
    """Two integers do not answer "who made Radu an admin"."""
    client.put(f"/api/admin/users/{two['member']['id']}/role?role=admin",
               headers=two["admin_headers"])
    entry = audit.recent()[0]
    assert entry["actor"] == "boss"
    assert entry["subject"] == "nadia"
    assert isinstance(entry["what"], str) and " " in entry["what"]
