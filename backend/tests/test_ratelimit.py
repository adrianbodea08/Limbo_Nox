"""Guessing at passwords.

Before the limiter existed this was measured at **forty-five attempts a
second**, indefinitely. The code that stops that is a dozen lines of arithmetic
over a dict, which is exactly the sort of thing that can be refactored into
doing nothing while still looking correct — the failure is silent and it is a
security failure, so it is worth a test that would notice.
"""

from __future__ import annotations

from app import ratelimit

WRONG = {"username": "nadia", "password": "not-it"}


def _login(client, **body):
    return client.post("/api/auth/login", json={**WRONG, **body})


def test_guessing_is_refused_before_the_allowance_would_let_it_through(client, person):
    person("nadia")
    limit, _ = ratelimit.BY_ADDRESS

    codes = [_login(client).status_code for _ in range(limit)]
    assert codes == [401] * limit, "the allowance itself must not refuse early"

    refused = _login(client)
    assert refused.status_code == 429
    # A number, so a client can wait rather than hammer.
    assert int(refused.headers["Retry-After"]) > 0


def test_the_refusal_costs_no_password_check(client, person, monkeypatch):
    """Argon2 is 14ms a go — the CPU an attacker would be spending on our
    behalf. Once the allowance is gone, nothing should reach the hash at all."""
    person("nadia")
    for _ in range(ratelimit.BY_ADDRESS[0]):
        _login(client)

    from app import main

    called = []
    monkeypatch.setattr(main.auth, "verify",
                        lambda *a, **k: called.append(1) or False)
    assert _login(client).status_code == 429
    assert called == [], "a refused attempt must not verify a password"


def test_getting_it_right_clears_the_count(client, person):
    """Otherwise somebody who mistypes five times and then succeeds spends the
    rest of the window one mistake away from being locked out of their own
    account."""
    _, password = person("nadia")
    for _ in range(5):
        _login(client)

    assert _login(client, password=password).status_code == 200

    codes = [_login(client).status_code for _ in range(6)]
    assert codes == [401] * 6, "the count should have restarted, not resumed at five"


def test_one_person_cannot_lock_another_out(client, person):
    """The reason the per-username allowance is loose.

    A tight one turns "type the wrong password at a colleague thirty times"
    into a way to lock them out of their own account — a denial of service
    wearing a security feature's clothes. The address runs out first, and it is
    the attacker's address, not the victim's account.
    """
    _, password = person("nadia")
    assert ratelimit.BY_USERNAME[0] > ratelimit.BY_ADDRESS[0]

    for _ in range(ratelimit.BY_ADDRESS[0] + 2):
        _login(client)

    # The victim, from somewhere else, still gets in.
    from_elsewhere = client.post(
        "/api/auth/login",
        json={"username": "nadia", "password": password},
        headers={"X-Real-IP": "10.9.9.9"})
    assert from_elsewhere.status_code == 200


def test_the_address_comes_from_the_header_nginx_controls(client, person):
    """`X-Forwarded-For` is built with `$proxy_add_x_forwarded_for`, which
    appends to whatever the client sent — so its first entry is attacker
    supplied. `X-Real-IP` is set from `$remote_addr` and cannot be forged."""
    person("nadia")
    for _ in range(ratelimit.BY_ADDRESS[0]):
        client.post("/api/auth/login", json=WRONG, headers={"X-Real-IP": "10.0.0.1"})

    spent = client.post("/api/auth/login", json=WRONG,
                        headers={"X-Real-IP": "10.0.0.1"})
    assert spent.status_code == 429

    # Claiming a different X-Forwarded-For must not buy a fresh allowance.
    still_spent = client.post(
        "/api/auth/login", json=WRONG,
        headers={"X-Real-IP": "10.0.0.1", "X-Forwarded-For": "1.2.3.4"})
    assert still_spent.status_code == 429

    # A genuinely different client gets its own.
    elsewhere = client.post("/api/auth/login", json=WRONG,
                            headers={"X-Real-IP": "10.0.0.2"})
    assert elsewhere.status_code == 401


def test_a_wrong_name_and_a_wrong_password_look_the_same(client, person):
    """Otherwise this is a way to find out who has an account."""
    _, _ = person("nadia")
    no_such = client.post("/api/auth/login",
                          json={"username": "nobody-here", "password": "x"})
    wrong_password = client.post("/api/auth/login",
                                 json={"username": "nadia", "password": "x"})
    assert no_such.status_code == wrong_password.status_code == 401
    assert no_such.json() == wrong_password.json()
