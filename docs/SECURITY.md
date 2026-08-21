# Security

> **Status:** reviewed 2026-08-22, at PoC. Two real findings, both fixed and
> both re-tested. This is a record of what was actually checked, not a policy —
> the value of it is that somebody can tell the difference between "we thought
> about this" and "we tried it".

Nox is a development-stage tool holding a team's real work. That is enough to be
worth doing properly, and not enough to justify infrastructure nobody is running
yet: everything here is in the application, none of it needs a deployment.

---

## 1. What was found

### A restricted project leaked through the queue screens — fixed

`/api/nox/my-work?user_id=` and `/api/nox/team-queue` both went to
`work._queue_select()`, which never knew who was **asking**. So:

```
member on AIF/QAB/DVO, deliberately kept off Classic Dev
  GET /api/nox/meta                    -> AIF, QAB, DVO      correct
  GET /api/nox/my-work?user_id=1       -> AIF, CD, DVO       LEAKED
  GET /api/nox/team-queue              -> AIF, CD, DVO, QAB  LEAKED
```

Both screens take somebody else's id by design — a lead looks at their team's
work — and neither applied `visible_project_ids`. Asking for a colleague's queue
was a way to read a project an admin had explicitly kept you out of: keys,
summaries, priorities, statuses, and the open asks directed at them.

Fixed in `_queue_select()` rather than at the four call sites, because every
query in that file goes through it and the next screen somebody adds gets the
filter without being told. Re-tested afterwards: the member sees AIF and DVO,
the admin still sees all four.

### Passwords could be guessed at 45 a second — fixed

Measured, not estimated. Argon2 costs about 14ms a verify, which is right for
one login and no obstacle at all to a machine with an evening spare, and nothing
counted the attempts.

`ratelimit.py`: in memory, no dependency, two buckets.

| Bucket | Allowance | Why that shape |
|---|---|---|
| by address | 10 in 5 minutes | Tight, because it is the one an attacker has to spend real resources to get around |
| by username | 30 in 15 minutes | Loose **on purpose** — a tight per-username lock lets anybody lock a colleague out by typing the wrong password at them, which is a denial of service wearing a security feature's clothes |
| registration | 5 an hour, by address | Not guessing; only so one machine cannot fill the accounts table overnight |

Checked **before** the password is verified, so a refused attempt costs no CPU.
Cleared on success, so a real person who mistypes five times and then gets it
right is not left with a spent allowance. All three behaviours re-tested,
including that a correct login still works and resets the count.

The address comes from `X-Real-IP`, which nginx sets from `$remote_addr`.
`X-Forwarded-For` is deliberately **not** used: it is built with
`$proxy_add_x_forwarded_for`, which appends to whatever the client sent, so its
first entry is whatever an attacker felt like typing. `X-Real-IP` is trustworthy
here only because the API is `expose`d and not published — nginx is the only way
in.

---

## 2. What was checked and was already right

Worth writing down, so the next review does not start from zero.

| | |
|---|---|
| **Password storage** | Argon2id at `t=2, m=19 MiB, p=1` — the OWASP minimum, deliberately chosen. 13.9ms a verify, measured. |
| **Session tokens** | `secrets.token_urlsafe(32)`, checked for expiry on every request. |
| **Suspension is immediate** | `session_user` re-reads the account and refuses anything that is not `approved`, so suspending somebody kills their live sessions rather than waiting 30 days for the token. |
| **Login does not confirm usernames** | Same sentence for a wrong password and a name that does not exist. |
| **The git webhook is signed** | HMAC-SHA256 over the raw body, and with no secret configured it refuses *everything* rather than accepting anything. |
| **CORS** | Defaults to no origins at all; only what `NOX_CORS_ORIGINS` names. |
| **Public paths** | An exact-match set, not a prefix test — `/api/auth/login-anything` is not public. |
| **Issues, search and boards** | Enforce `visible_project_ids`. A restricted issue fetched directly answers *"No issue CD-3"* rather than *"forbidden"*, so the endpoint does not confirm that it exists. |
| **SQL** | SQLAlchemy Core throughout. The handful of `text(f"…")` are intervals built from `int()`-cast numbers, not from anything a caller supplies. |
| **XSS** | No `dangerouslySetInnerHTML` anywhere. `Markdown.tsx` renders to React elements, so text somebody else wrote never becomes markup — see [EDITOR.md](EDITOR.md) §2. |
| **Secrets** | Nothing committed. `/secrets/*` is ignored, and the GitHub App key is mounted as a file rather than passed as an environment variable. |
| **Referential integrity** | Twenty-seven foreign keys to `users`, added when accounts moved into Postgres. There were **zero** before, because the two halves of a person lived in different engines — deleting an account silently orphaned everything it owned. The database now refuses. |
| **Mass assignment** | A view's `owner_id` comes from the session, never the body — checked by posting somebody else's id and getting our own back. |

---

### Admin actions were invisible — fixed

The tracker's event log recorded every ticket move, every reassignment, every
comment — eight hundred rows of it — and was **completely silent about
permissions**. Approving an account, making somebody an admin, letting a person
into a restricted project: none of it was written down anywhere.

That is the wrong way round. Who moved a ticket on Tuesday is interesting; who
gave themselves admin on Tuesday is the question somebody asks under pressure,
and it was unanswerable.

`audit.py` writes to the **same** `events` table rather than a new one. It has
carried `entity_type` since the first migration — the comment on the column says
releases and projects emit events too — so an account event is what it was built
for, and one append-only log means one set of guarantees instead of two.

Six kinds, a closed list so the reader can group rather than guess at spellings:
a status changed, a role changed, an account created or deleted, who can see a
project, and a project's visibility. Each row keeps the **before** as well as
the after, because *"changed a role"* is not an answer and *"member to admin"*
is. Readable at Accounts → *Show what admins have changed*, admin-only, since it
is a list of who has power.

Three decisions inside it:

- **Recorded after the change**, so an attempt that was refused leaves no trace
  of having happened.
- **It can never fail the thing it records.** An audit write that could break a
  request teaches people to route around it; a missing row is a smaller problem
  than an admin who cannot approve somebody because the log is unhappy. It is
  shouted into the log file instead, because a silently empty audit trail is the
  worst of the three.
- **The `actor_id` foreign key means an admin who granted something cannot be
  quietly deleted.** A side effect of moving accounts into Postgres, and a
  welcome one: you cannot remove the record of who handed out power by removing
  the person who did.

---

## 3. It is now watched

`backend/tests` — thirty-nine tests over auth, the rate limiter, who can see
which project, and the audit log. Run with `docker compose run --rm test`, and in CI on every push.

Both findings above are regression tests, and both have been **proved to fail**
against the code as it was before the fix: putting the visibility bug back made
exactly three tests fail and left the other twenty-seven passing. A regression
test that has never seen its bug is a guess.

This is what makes the rest of this document keep being true. A security fix in
a codebase with no tests is one refactor away from being quietly undone, and
nobody would find out from the outside.

---

## 4. Known and accepted, for now

Written down because an undocumented tradeoff is indistinguishable from an
oversight.

- **The session token lives in `localStorage`**, so any XSS would hand it over.
  The mitigation is that there is no XSS vector, which is a stronger claim than
  it sounds given nothing in the app builds HTML from text. Moving to an
  httpOnly cookie brings CSRF back and is a bigger change than a PoC warrants.
- **Sessions last 30 days** with no idle timeout.
- **Passwords need six characters** and nothing else.
- **No HTTPS**, because there is no deployment. This is also what makes real
  push notifications impossible — see [ASKS.md](ASKS.md) §5.
- **Backups are not scheduled.** The flow exists and has been restored end to
  end; nothing runs it on a timer yet.
