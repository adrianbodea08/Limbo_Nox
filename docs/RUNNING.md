# Running the tracker

The tracker is the only part of this app with its own database. Everything else
reads SQLite (`notes.db`) exactly as it always has; nothing here touches it, and
no migration in `backend/alembic/` can reach it.

A missing or unreachable tracker database is a **state, not an error**. With no
`TRACKER_DATABASE_URL` set, the app boots normally, every `/api/tracker/*` route
answers `503` with a readable message, and the page shows "Not connected yet".
That is the current state on live, and it is deliberate — it is what let the
whole system be built and merged before devops provisions anything.

## Locally

`docker-compose.yml` includes a `tracker-db` service (Postgres 16). It is not in
`docker-compose.prod.yml`, so nothing about this reaches the deployed stack.

```bash
docker compose up -d tracker-db backend frontend
```

The backend's entrypoint brings the Postgres schema up to date on start, but
only when `TRACKER_DATABASE_URL` is set. Without it the step is skipped
entirely.

Then, signed in as an admin, open **Tracker** and press *Set the tracker up*.
That creates the statuses, issue types, the default workflow, the four projects
and two views each. It is idempotent — safe to press twice, and safe to run
again after new defaults are added.

### Environment

| Variable | Meaning |
|---|---|
| `TRACKER_DATABASE_URL` | `postgresql+psycopg://user:pass@host:5432/tracker`. Unset = the tracker is off. |
| `TRACKER_DB_PORT` | Host port for the local `tracker-db` container. Defaults to `5433`. |

> The port default is `5433` rather than something higher because Windows
> reserves ranges (`55396–55495` among them) that a bind will silently fail on.

### The demo people have accounts

`mock.py` invents seventeen colleagues and gives them sixty-six issues and eight
hundred events. They used to be *ghosts* — names on work that nobody could ever
be — so every screen that reasons about people rather than rows had a hole in
it. They have accounts now:

```
POST   /api/admin/placeholder-accounts     make them
DELETE /api/admin/placeholder-accounts     take them away again
```

**No merge was needed, because the ids already agree.** An account is projected
into the tracker keyed on its own id, so an account created at 900016 *is* the
person the demo data calls Ana Mihalache. Nothing moves — which is why this is
thirty lines rather than the two hundred that repointing twenty-six columns
would have taken, and why removing them again leaves the tracker exactly as it
was.

**Nobody can sign in as them.** The password is a random secret that is hashed
and then thrown away: not stored, not printed, not known to whoever ran it.
Creating accounts for people who never asked for one is only reasonable if
there is no way into them, and the way to guarantee that is to have no password
rather than a weak one. Verified — login refuses a guess and refuses an empty
one.

They are *approved*, not *pending*, so seventeen fictional people do not bury
the one real person standing in the approval queue, and their email is
`@mock.local` so which rows are placeholders is visible at a glance.

**One consequence worth knowing.** SQLite takes the next id from `max(rowid)`,
so once an account exists at 900016 the next person who registers gets 900017.
Resetting `sqlite_sequence` does not change that — it was tried. Nothing depends
on the range and no id is ever shown to anybody, so this is cosmetic; it is
written down because it is surprising.

**When the real person arrives**, they register like anybody else and an admin
approves them. The placeholder is then a historical record of invented work, and
can be suspended or removed. Nobody inherits the demo history, because the demo
history was invented.

## Demo data

The tracker starts empty. To fill it with something to look at — sixteen people
with generated faces, fifty issues walked through each board's real workflow
with backdated history, five releases and two automation rules:

```bash
curl -X POST localhost:8080/api/tracker/mock -H "authorization: Bearer $TOKEN"
```

Admin only. It **empties the tracker's own tables first**, including the
workflow tables, which is what lets a re-captured workflow take effect — so it
is a deliberate call, not something setup does. It cannot reach anything outside
the tracker database.

The people exist only in the tracker's `users` projection; they are not app
logins, so there is nothing to clean up elsewhere. Their profile pictures are
generated SVG data URIs rather than fetched, so the demo looks the same on a
machine with no internet.

## Re-capturing the workflows from Jira

`tracker/jira_workflows.py` was generated from the live Jira. To refresh it —
after AID gets work into the three statuses that could not be sampled, say —
re-run the capture and regenerate, then `POST /api/tracker/mock` to rebuild
against the new workflows. The capture is read-only: it calls
`/project/{key}/statuses` and `/issue/{key}/transitions` and writes nothing.

## Getting in, and what you can see

**Anybody can ask; an admin says yes.** Somebody registers, lands as *pending*,
and an admin approves them in Accounts. An issue tracker anybody can sign
themselves into is not a tracker, so there is no open door — and the very first
account is approved on the spot and made admin, because otherwise there is
nobody to approve the second.

Nobody is ever handed a password. An admin decides *whether* somebody may in,
not *what their password is*.

Accounts and sessions live in Postgres, in `users` and `sessions`, beside
everything they refer to. Until 2026-08-22 they were a separate SQLite database
and `users` was a copy kept in sync on every request — a leftover from when Nox
was one feature inside another product and an instance could have accounts with
no tracker at all. The cost of the split was not tidiness: **twenty-six columns
hold a user id and not one could declare a foreign key**, because you cannot
declare one across two engines, so deleting an account silently left its issues,
comments and events pointing at nobody. There are twenty-seven foreign keys now
and the database refuses.

### What a person can see

Two things decide it, and admins skip both:

| | |
|---|---|
| `projects.visibility` | `everyone`, or `restricted` |
| `project_access` | who is named on a restricted project — by **user**, or by **tag** |

A restricted project must name at least one tag or person, or the act of
restricting it would lock out the person doing it.

There are two screens over that one table, because there are two real questions
and neither is a good way to ask the other:

- **Project settings → Who can see it** — *who can see this project.* The
  project's whole list, edited as a list.
- **Accounts → Can see → Change** — *what can this person see.* The question you
  have while looking at somebody you have just approved.

The second one adds and removes a single name and touches nothing else. It
deliberately does not go through `set_access`, which replaces a project's entire
list and its visibility: naming one person must not silently drop the tag that
lets their whole team in.

A project that is open to everyone, or that somebody reaches through one of
their tags, shows as ticked and **inert** on that screen. Unticking it would not
take the access away, and a control that lies about what it does is worse than
one that is not there.

### Restarting the api does not sign anybody out

It used to. `docker compose up -d --build web` recreates the api container, and
if a browser reloaded inside that window `GET /api/auth/me` never completed —
which the boot check treated as "your session is over" and threw the token away.
The API log had no 401 in it, because there was nothing there to say no, and the
session row was good for another 29 days.

Only a **401** means the server stopped believing a session. A network failure
or a 5xx means the server could not be asked, which is a different sentence, so
boot now retries (400ms, 1.2s, then every 3s) and shows *"Nox is not answering"*
while keeping the token. It recovers on its own when the container comes back —
no reload, no signing in again.

`ApiError` in `api.ts` is what makes the two distinguishable: `status` is what
the server answered, and status `0` means it never answered. Before that,
everything arrived as a bare `Error` and no caller *could* tell them apart.

## Tests

```
docker compose run --rm test          # everything
docker compose run --rm test -k auth  # or a slice
```

Thirty-nine of them, over the four things where a silent regression is a
security incident: **auth** (hashing, sessions, suspension taking effect now
rather than in thirty days), **the rate limiter**, **who can see which project**,
and **the audit log** — which fails in the quietest way of all, by answering
"nothing happened" to a question where something did.

Three facts about how they run, each of them deliberate:

- **A real Postgres.** Everything worth testing here is something Postgres does
  — twenty-seven foreign keys, visibility compiling to SQL, a unique constraint
  refusing a second account. A stand-in that enforced none of those would pass
  the whole suite while the real thing failed.
- **Its own database**, created and dropped per run, so the suite never costs
  anybody their demo data.
- **Built by the real migrations**, not by `metadata.create_all`. The migrations
  are what runs against the real database; a schema built another way would
  leave the one people depend on untested.

### They have been proved to fail

The permission tests are regressions for a leak that existed on 2026-08-22, and
a regression test that has never seen its bug is a guess. The fix was put back
to how it was and the suite run again: **exactly those three failed and the
other twenty-seven passed.** That is the evidence that they are watching the
right thing.

Writing them also found two bugs in themselves, which is the ordinary way of it:
a fixture that only cleaned the database for tests that asked for a client, and
a helper that used `connect()` where it needed `begin()`, so every row it
inserted rolled back on close.

## Backups

The flow exists; nothing is scheduled. Running it is a decision for whenever
this stops being a toy.

```
python scripts/backup.py                   -> ./backups/nox-<utc>.tar.gz
python scripts/backup.py --keep 10         -> and prune older ones
python scripts/restore.py <archive>        -> report only, changes nothing
python scripts/restore.py <archive> --yes  -> replace everything
```

**One database, one dump.** It used to be two: accounts and sessions lived in a
separate SQLite file, and the script carried a long note about WAL mode, about
never copying that file, and about which store had to be captured first so a
race between them healed itself rather than orphaning somebody.

All of that went away when the accounts moved into Postgres. It is worth
remembering as the reason the split was worth ending: **a backup of two stores
is not a backup of one system**, because nothing makes the two snapshots agree.

### It has been restored

Not just written. A backup nobody has restored is a hope, and the first restore
found a real bug — `docker compose cp` writes as root, the app ran as its own
user, and SQLite opened a file it could not write as *readonly* rather than
failing, so the container came back up crash-looping on "attempt to write a
readonly database". That whole class of problem is gone with the file.

The test worth repeating: take a backup, make a visible change the backup does
not contain, restore, and check the change is gone. A restore that silently does
nothing looks exactly like one that worked.

A restore now also brings the sessions back, so whoever ran it is still signed
in afterwards. That was not true when they lived in a different file.

## Migrations

```bash
docker compose exec backend alembic revision --autogenerate -m "what changed"
docker compose exec backend alembic upgrade head
```

Autogenerate compares the database against `backend/app/tracker/schema.py` **as
the container sees it** — rebuild the backend image after editing the schema, or
you will get an empty migration and no error explaining why.

Copy the generated file out of the container before committing it:

```bash
docker compose cp backend:/app/alembic/versions/<file>.py backend/alembic/versions/
```

## The automation worker

Started with the app, in-process. With no tracker database it sleeps in 30s
increments; otherwise it scans the event log every few seconds, enqueues jobs
and runs them.

This works because the backend runs single-worker (`uvicorn app.main:app` with
no `--workers`), which is already true for other reasons — the SSE broadcaster
and several in-memory caches. When that changes, the worker is the first thing
to move to its own process: `claim()` already takes jobs with `FOR UPDATE SKIP
LOCKED`, so a second runner is safe the day one exists.

To run the queue immediately instead of waiting (admin only):

```bash
curl -X POST localhost:8080/api/tracker/automation/tick -H "authorization: Bearer $TOKEN"
```

## Going live, when the time comes

1. Ask devops for a Postgres database — one database, one role. If the estate
   already has a cluster this is a one-line request rather than a project.
2. Put `TRACKER_DATABASE_URL` in Vault alongside the other secrets.
3. Deploy. The entrypoint creates the schema on first boot.
4. An admin presses *Set the tracker up* once.
5. Grant the `tracker` tag to whoever should see it.

Nothing in steps 1–5 affects the existing app. If step 2 is skipped or wrong,
the tracker says it is not connected and everything else carries on.
