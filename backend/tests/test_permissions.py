"""Who can see which project.

**These are regression tests for a real leak.** On 2026-08-22 a plain member
could read a project they had been explicitly kept out of by asking for a
colleague's queue: `/my-work?user_id=` and `/team-queue` both take somebody
else's id by design, and neither applied `visible_project_ids`. It was written
correctly on four screens and wrongly on two, and nothing could tell the
difference — which is the whole argument for this file.

The rest of the cases were already right when they were checked. They are here
so that stays true.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text

from app import db


def sql(statement: str, **params):
    with db.engine().begin() as conn:
        return conn.execute(text(statement), params)


def one(statement: str, **params):
    # `begin()`, not `connect()`: everything this is used for is an
    # INSERT ... RETURNING, and a plain connection rolls back when it closes —
    # so the rows appeared to exist inside the fixture and were gone by the
    # time anything looked for them.
    with db.engine().begin() as conn:
        return conn.execute(text(statement), params).scalar_one()


@pytest.fixture()
def world(store, person):
    """Two projects, one open and one shut, and an issue in each.

    Built with SQL rather than through the API because the API needs a workflow,
    statuses and a project template before it will make an issue — none of which
    this file is about.
    """
    admin, admin_password = person("boss", role="admin")
    member, member_password = person("nadia")

    kept_out = one("""
        INSERT INTO projects (key, name, visibility, position)
        VALUES ('SHUT', 'Kept out', 'restricted', 1) RETURNING id""")
    open_to_all = one("""
        INSERT INTO projects (key, name, visibility, position)
        VALUES ('OPEN', 'Open to all', 'everyone', 2) RETURNING id""")
    # The restricted one names the admin and nobody else.
    sql("""INSERT INTO project_access (project_id, kind, value, granted_by)
           VALUES (:p, 'user', :v, :g)""",
        p=kept_out, v=str(admin["id"]), g=admin["id"])

    status = one("""INSERT INTO statuses (key, name, category)
                    VALUES ('todo', 'To Do', 'todo') RETURNING id""")
    kind = one("""INSERT INTO issue_types (key, name, hierarchy_level)
                  VALUES ('task', 'Task', 0) RETURNING id""")

    for project, key, summary in ((kept_out, "SHUT-1", "A secret"),
                                  (open_to_all, "OPEN-1", "Not a secret")):
        sql("""INSERT INTO issues (project_id, key, summary, issue_type_id,
                                   status_id, priority, assignee_id, reporter_id)
               VALUES (:p, :k, :s, :t, :st, 'medium', :a, :a)""",
            p=project, k=key, s=summary, t=kind, st=status, a=admin["id"])

    return {
        "admin": admin, "admin_password": admin_password,
        "member": member, "member_password": member_password,
        "kept_out": kept_out, "open": open_to_all,
    }


def sign_in(client, username, password):
    r = client.post("/api/auth/login",
                    json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def keys_in(payload) -> set[str]:
    """Every issue key anywhere in a response, however it is nested."""
    found: set[str] = set()

    def walk(node):
        if isinstance(node, dict):
            key = node.get("key")
            if isinstance(key, str) and "-" in key:
                found.add(key)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(payload)
    return found


def test_a_member_is_not_offered_a_project_they_cannot_see(client, world):
    headers = sign_in(client, "nadia", world["member_password"])
    meta = client.get("/api/nox/meta", headers=headers).json()
    assert [p["key"] for p in meta["projects"]] == ["OPEN"]


def test_asking_for_somebody_elses_queue_does_not_leak_a_project(client, world):
    """The leak. `/my-work` takes a user_id so a lead can look at their team's
    work, and it used to answer with whatever *that* person could see."""
    headers = sign_in(client, "nadia", world["member_password"])
    body = client.get(f"/api/nox/my-work?user_id={world['admin']['id']}",
                      headers=headers).json()
    assert "SHUT-1" not in keys_in(body)


def test_the_team_queue_does_not_leak_a_project_either(client, world):
    headers = sign_in(client, "nadia", world["member_password"])
    body = client.get("/api/nox/team-queue", headers=headers).json()
    assert "SHUT-1" not in keys_in(body)


def test_an_admin_still_sees_everything(client, world):
    """The filter must not be so keen that it breaks the people it is for."""
    headers = sign_in(client, "boss", world["admin_password"])
    body = client.get("/api/nox/team-queue", headers=headers).json()
    assert "SHUT-1" in keys_in(body)


def test_naming_a_member_lets_them_in(client, world):
    """And the same route stops hiding it, so the filter is doing the work
    rather than the project being invisible by accident."""
    headers = sign_in(client, "nadia", world["member_password"])
    assert "SHUT-1" not in keys_in(
        client.get("/api/nox/team-queue", headers=headers).json())

    sql("""INSERT INTO project_access (project_id, kind, value, granted_by)
           VALUES (:p, 'user', :v, :g)""",
        p=world["kept_out"], v=str(world["member"]["id"]), g=world["admin"]["id"])

    assert "SHUT-1" in keys_in(
        client.get("/api/nox/team-queue", headers=headers).json())


def test_a_restricted_issue_does_not_admit_that_it_exists(client, world):
    """"No issue SHUT-1" rather than "forbidden": the second answer is itself
    information, and confirms a key somebody was guessing at."""
    headers = sign_in(client, "nadia", world["member_password"])
    r = client.get("/api/nox/issues/SHUT-1", headers=headers)
    assert r.status_code == 404
    assert "forbidden" not in r.text.lower()
    assert "permission" not in r.text.lower()


def test_search_does_not_reach_into_a_restricted_project(client, world):
    headers = sign_in(client, "nadia", world["member_password"])
    body = client.get("/api/nox/search?q=secret", headers=headers).json()
    assert "SHUT-1" not in keys_in(body)


def test_asking_the_board_for_a_project_you_cannot_see_gets_nothing_of_it(client, world):
    headers = sign_in(client, "nadia", world["member_password"])
    body = client.post("/api/nox/board",
                       json={"project_id": world["kept_out"],
                             "group_by": "status", "limit": 50},
                       headers=headers).json()
    assert "SHUT-1" not in keys_in(body)


def test_no_session_gets_nothing_at_all(client, world):
    for path in ("/api/nox/meta", "/api/nox/my-work", "/api/nox/team-queue"):
        assert client.get(path).status_code == 401


def test_a_member_cannot_use_the_admin_routes(client, world):
    headers = sign_in(client, "nadia", world["member_password"])
    assert client.get("/api/admin/users", headers=headers).status_code == 403
    assert client.get(f"/api/nox/people/{world['member']['id']}/projects",
                      headers=headers).status_code == 403
