# Nox by Limbo

An issue tracker. Projects, workflows that actually constrain, boards whose
columns are containers of statuses, releases that span projects, automations,
and a git integration that does the half of the work nobody should be clicking.

Built to replace Jira for a team that measured what Jira was doing for them and
found that **half of every status change was made by automation** — so the git
integration is not a feature here, it is the point.

## Running it

```bash
docker compose up -d --build
```

Then <http://localhost:8090>. The first account you register is approved on the
spot and becomes the admin; everyone after it needs approving.

| | |
|---|---|
| Web | `${NOX_PORT:-8090}` |
| Postgres | `${NOX_DB_PORT:-5434}` |
| API | internal only, proxied at `/api` |

## Connecting GitHub

Nox reads pull requests through a **GitHub App** — one authorisation by an org
owner, no tokens pasted anywhere. The Git page inside Nox lists the setup steps,
and `docs/GIT.md` explains why it works that way.

Settings go in `secrets/github.env`; the private key is a file at
`secrets/github-app.pem`. Neither is committed.

After changing either, recreate the container rather than restarting it:

```bash
docker compose up -d api      # re-reads env_file
docker compose restart api    # does NOT — it reuses the old config
```

`restart` keeps the container's original environment, so a new app id or secret
will not be picked up and Nox will still report that no App is registered.

## Documentation

| | |
|---|---|
| [docs/STATE.md](docs/STATE.md) | **Start here.** What exists, what is next, and the decisions behind it |
| [docs/DESIGN.md](docs/DESIGN.md) | The whole design, and why each decision was made |
| [docs/GIT.md](docs/GIT.md) | The git integration, and the numbers that justified it |
| [docs/RELEASES.md](docs/RELEASES.md) | Releases and the timeline |
| [docs/ASKS.md](docs/ASKS.md) | Asks and notifications — why neither one is code review |
| [docs/EDITOR.md](docs/EDITOR.md) | The text editor, and why it renders to elements not HTML |
| [docs/LABELS.md](docs/LABELS.md) | Labels, and why nobody creates one |
| [docs/VIEWS.md](docs/VIEWS.md) | Saved views — yours unless you say otherwise |
| [docs/ANALYTICS.md](docs/ANALYTICS.md) | Insights, and the numbers behind each chart |
| [docs/DESIGN_M3.md](docs/DESIGN_M3.md) | The Material 3 rules the interface follows |
| [docs/LAYOUT.md](docs/LAYOUT.md) | Narrow windows — what changes under 840px and 600px |
| [docs/SECURITY.md](docs/SECURITY.md) | What was checked, what was found, and what is knowingly accepted |
| [docs/RUNNING.md](docs/RUNNING.md) | Local development |

## History

Nox was one feature inside DrC Management until 2026-08-21, when it was
extracted. That app is untouched and still runs; nothing here reaches back into
it.
