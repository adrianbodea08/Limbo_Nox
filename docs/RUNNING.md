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

## Access

Gated by the `tracker` account tag, granted in Admin → Accounts. Admins bypass
it, as with every other tag. The gate is enforced in the auth middleware, so it
covers every route under `/api/tracker` including ones added later.

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
