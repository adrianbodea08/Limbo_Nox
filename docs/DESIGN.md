# Nox — the design

> Extracted on 2026-08-21 from DrC Management, where this began life as one
> feature among five, into a product of its own. Everything below was written
> before the split. The reasoning holds — where it says "the tracker", read Nox.

**Status:** built and running; not yet deployed anywhere real.
**Lives in:** its own repository, its own Postgres, its own accounts.
**Last updated:** 2026-08-06.

> **A note for anyone else working in this repo — including other Claude
> sessions.** This system is being built by one dedicated session at the user's
> request. Read this document freely; do not modify `backend/app/tracker_db.py`,
> the `tracker-db` service in `docker-compose.yml`, or anything else named
> `tracker*` unless the user asks you to.

---

## 1. Why, and why now

Nox already mirrors Jira, pushes to it, and reports on it. Building
those reports taught us where Jira's data model actually hurts, and every design
decision below traces back to something concrete we hit:

| What we hit | What it cost | What we do instead |
|---|---|---|
| "Utility Points" is **five** custom field ids, one per project context | Every report needs a resolver map; two boards disagreed by 34.54 points because they resolved differently | Fields are **global**. One field, one id, forever |
| Jira keeps **no history** for the Test status field | The standup's queue can only ever show *now*; a past day is unreconstructable | **Append-only event log**. Every field change is a row |
| `fixVersion` is per-project | "Release 5 AUG 2026" is two version objects; one board matched by name, another by id, and a tester read 100.20 vs 65.66 | Releases are **first-class and cross-project** |
| `released` boolean is unreliable | `current_releases()` carries a comment explaining five stale candidates and a shipped release flagged unshipped | Release **state machine** + separate planned/actual dates |
| One field holds both the release and the component versions | One issue carried **twelve** fixVersions | Releases contain **artifacts** (component + version + its own ship date) |
| Nothing enforces data entry | 27 issues shipped with no tester; ~2,335 hours on tickets with an empty UP field | **Strict transitions** with validators |
| `→ LIVE` is a human dragging a card | The KPI's month boundaries measure when someone remembered, not when it shipped | Drive it from **deployment events** |

The theme: almost everything valuable reads **history**, not current state. So
history is a first-class citizen here, not an afterthought.

---

## 2. Architecture

### Two databases, on purpose

- **SQLite (`notes.db`)** keeps everything that exists today — accounts, tags,
  My Board, timesheet, stats snapshots. It suits that work and it is not a
  stepping stone to anything.
- **Postgres** serves the tracker alone. It needs four things SQLite cannot
  give: concurrent writers, indexed `JSONB` for custom fields, real full-text
  search, and `SELECT … FOR UPDATE SKIP LOCKED` for the job queue automations
  run on.

**The seam.** Users live in SQLite, so Postgres stores a bare `user_id` with no
foreign key, plus a small **projection table** (`id, display_name, active,
avatar`) so you can filter, sort and group by person in SQL. Transactions cannot
span the two — any cross-database operation must be idempotent and retryable,
with one side clearly the authority.

### The connection is optional, by design

Live has no Postgres and will not until devops provisions one properly. So:

- `TRACKER_DATABASE_URL` unset ⇒ every tracker route answers *"you are not
  connected yet"*. That is a **state, not an error**.
- Nothing connects at import; nothing raises at start-up.
- The container health check deliberately does **not** consult it — a database
  blip must never restart the app.
- A failed connection is remembered for 30s so a page refresh doesn't retry a
  dead host on every request.

`tracker-db` exists in `docker-compose.yml` only. Deploys run
`docker-compose.prod.yml`, which has no such service, so local Postgres cannot
reach live by accident. Host port **5433** — Windows reserves 55396–55495.

### Scaling to 50–100 users

The load is small (~3 req/s average, ~30 peak). The problem is not throughput,
it is that **the app currently cannot run more than one process**: job-claim
sets, field caches and the SSE `Broadcaster` all live in module globals. Two
workers would double-run sweeps, drift their caches, and drop SSE events.

Order of work: shared state out of process memory → multiple workers →
a real job runner (`jobs` table + `SKIP LOCKED`). **No Redis** — Postgres does
the fanout (`LISTEN/NOTIFY`) and the queue at this size.

---

## 3. Data model

### Issues

Anything every issue has is a **real column**, not a custom field:

```
issues(id, project_id, key, type_id, status_id, summary, description,
       reporter_id, assignee_id, tester_id, priority, parent_id, rank,
       team_id, plan_priority, urgent_at, urgent_by, urgent_reason,
       custom jsonb,
       created_at, updated_at, resolved_at, archived_at)
```

`tester_id` is a column and not a custom field for the same reason
`assignee_id` is: every issue type on every board wants one, and a field that
always exists should not be something each project remembers to add. It is
deliberately a different person from the assignee — the card says so when they
are the same — and it is indexed, because "what am I testing" is asked as often
as "what am I building".

`key` is `PREFIX-N`, allocated per project by incrementing a counter in the same
transaction as the insert.

### Custom fields — dynamic, but global

The user needs to add fields and issue types at runtime. That is fine. What
caused the pain in Jira was **scoping**, not dynamism.

```
field_defs(id, key, name, kind, options, archived_at)
      key   'utility_points'   stable, machine-facing, never changes
      name  'Utility Points'   display, rename freely
      kind  number | text | select | multi | user | date | checkbox

field_usage(field_id, project_id?, issue_type_id?, required, position)
      where it appears — presentation only, never identity
```

Values live in `issues.custom` keyed by `key`. GIN index for containment, plus
targeted expression indexes on the two or three fields people filter and sort by
heavily.

**Four rules that stop this becoming Jira again:**

1. Never hard-delete a field — **archive** it. Values stay, old reports work.
2. Never change a field's `kind`. Create a new field and migrate deliberately.
3. Rename freely — that is why `key` and `name` are separate.
4. Admin-only creation, with a required reason. Enough friction for 20 fields in
   two years instead of 200.

Issue types follow the same shape, plus a `hierarchy_level` so epic → story →
subtask is a real relationship rather than a naming convention.

### The event log

```
events(id, entity_type, entity_id, batch_id, actor_id, actor_kind, at,
       kind, field, from_value, to_value, payload jsonb)
```

- **`entity_type` from day one.** Releases, projects and comments emit events
  too — "release created" is a real automation trigger. Issue-only would need a
  rewrite of every trigger.
- **One row per field change**, with `batch_id` grouping one save. Jira stores
  one entry per save containing many items, which is exactly why "when did
  status become Live" is awkward there.
- **Not event sourcing.** The issue row is the truth; events are written in the
  same transaction. All writes go through one repository function so nothing can
  change an issue without leaving a trace.
- `actor_kind` distinguishes human / automation / integration — load-bearing for
  automation loop prevention.

Volume: roughly 5–10M rows a year at this team size. Postgres does not care.
Index `(entity_type, entity_id, at)` and `(at)`. Revisit partitioning in year
three.

What it unlocks: cycle time, time-in-status, "what changed since I looked",
bug lifecycle — all one query. And `state_at(entity, timestamp)`, which is the
thing Jira cannot do.

Comments get their own table (editable, deletable, own permissions) but still
emit events, so the activity feed stays one query. Issues **archive**, never
delete, because events point at them.

---

## 4. Workflow

Statuses are **global**; a workflow is an arrangement of them. In Jira, DRC's
`IN REVIEW` and AIW's `In review` are two different statuses — which is why
cross-project reporting there is miserable.

Every status carries a **category** (`todo | in_progress | done`). This is the
single most load-bearing field in the model. Two things we hand-coded today —
`OPEN_CATEGORIES` in the standup, and "DRC ships to LIVE but QA ends at Done" —
become data instead of special cases.

```
statuses(id, key, name, category)
workflows(id, name)
workflow_statuses(workflow_id, status_id, position)
transitions(id, workflow_id, from_status_id?, to_status_id, name,
            conditions, validators, post_actions)
project_workflows(project_id, issue_type_id?, workflow_id)
```

Workflow per project, optionally overridden per issue type — not Jira's
project → scheme → type chain. `from_status_id = NULL` means "from anywhere"
(Won't Do, reopen).

**Transitions are strict** (user's decision). Jira's three-part split is worth
copying because the distinction is real:

- **Condition** — is the transition offered? *"Only the assignee can start work."*
- **Validator** — is the submit accepted, and why not? *"Can't reach LIVE: Tested by is empty."*
- **Post-action** — what happens after. *"Set resolved_at, notify watchers."*

Rules are **data**, evaluated by a small condition tree:

```json
{"all": [{"actor": "assignee"},
         {"field_set": "tested_by"},
         {"field_eq": {"test_status": "Test passed"}}]}
```

The same evaluator serves automations. Build it once.

**Two things that keep strict tolerable:** never silently hide a transition —
show it disabled with the reason; and give leads a **logged override** that
records who forced it and why. Rules you cannot break get worked around outside
the system.

Put validators where the information exists: requiring UP at creation is
obnoxious, requiring it before the ticket leaves In Progress is reasonable.

### What the capture found

The four workflows were read out of the live Jira rather than designed. Three
things it turned up, each of which is an argument the design doc was already
making in the abstract:

**One step, several spellings.** `IN REVIEW` (DRC), `In review` (AIW) and
`Review` (QA) are three separate statuses with three ids. Nothing can ask "what
is in review" across the company. Here they are one global status. Genuinely
different gates stay separate — AID's `Code Review` and `Tech Review` really are
two things.

**Categories that are wrong.** Jira has `STAGING` categorised as *done*, and so
are AID's `Master Sign-off`, `Pre-Release` and `Release Ready` — every one of
them a step that happens before anything ships. Category is the field the whole
reporting story rests on, so these are corrected in the capture and the changes
are listed in `jira_workflows.py`. `UNIFIED` is left alone because nobody has
told us what it means.

**QA has no workflow.** Every status transitions to every other one, which is
what Jira does when nobody configures anything. That is preserved rather than
tidied: the board should say out loud that it has no rules.

Transitions were learned by sampling — one live issue per status, asked what it
may do next. Three AID statuses had nothing sitting in them, so their outgoing
moves are inferred (forward one step, plus abandon) and flagged as such in
`transitions.conditions`. Re-run the capture when AID has work there.


---

## 5. Releases

```
components(id, name, repo)
releases(id, name, kind, state, cycle_start, planned_at, shipped_at)
release_artifacts(release_id, component_id, version, shipped_at, state)
release_issues(release_id, issue_id)
```

- **Cross-project by construction.** One release, issues from anywhere.
- **A release whose artifact list has one entry is a component release.** A
  backend hotfix is a release containing `backend 34.0.1`. An Android release is
  a release containing `drc-android 33.1.0`. One concept that can be narrow —
  not two concepts.
- **`release_artifacts.shipped_at` earns its keep.** Mobile ships when Apple
  says so. Staggered delivery inside one release is what the twelve-fixVersion
  tagging was working around.
- **One release of each kind per issue.** A fix that ships in the 34.0.1
  hotfix and again in the next standard release is a real thing, and both
  facts are worth recording. The same fix on two standard releases is
  somebody having lost track, and it makes "which release contains this"
  unanswerable — which is the question the whole model exists to answer.
- **Issues link to the release, not to artifacts.** "Which app version has my
  fix" is derivable. Per-issue-per-artifact granularity is deferred — it is
  purely additive later.
- **Release actions are a runbook**, not a time bucket. `DRC-3051 "Release"`
  currently absorbs 153 hours a year as an undifferentiated number. Ordered
  checklist items with owner and done-at make "what's left before we ship" a
  query.
- Notes generate from the issues, grouped by type, editable before publishing.

---

## 6. Automations

Trigger → condition → action. Triggers come from the event log for free.

Sources: entity events, schedule, external webhook (git, CI, deploy), manual.

**Never inline.** Event → job → worker. Automations are slow, they fail, they
cascade; none of that belongs in a request a human is waiting on.

**The three hard problems:**

1. **Loops.** Events carry `actor_kind`; rules ignore automation-caused events by
   default; hard depth cap per originating event; circuit breaker disables a rule
   after N consecutive failures.
2. **Idempotency.** The runner retries — that is what makes it reliable. Dedupe
   key on `(rule_id, event_id)` so a retry is a no-op. Skip this and you get
   duplicate comments forever.
3. **Per-issue serialisation.** The queue keys on `issue_id`; one job in flight
   per issue.

**The audit log ships in v1, not later.** Rule, triggering event, condition
outcome, each action, result, error. Jira Automation is only tolerable because
you can see why a rule did something.

Also: dry-run against a real past event, a confirmation when a rule would touch
more than ~50 issues, per-rule disable, and rules acting as a **service actor**
rather than as whoever triggered them.

**Authoring is a UI block builder** — no code. Blocks are typed, and the UI only
offers valid values (pick "transition" and the status list shows only statuses in
that issue type's workflow). Variables are click-to-insert, never free text.
**`for-each` is not optional** — half the useful rules iterate over a release's
issues.

Worked example:

```
WHEN   release created
IF     name contains "Release"
THEN   create issue
         project: QA   type: Task
         summary: Manual Testing for [{{release.name}}]
         link to: {{release}}
```

That summary format matters: `hours_stats.classify` parses `"manual testing"` out
of `QA-*` summaries to bucket hours. Do not "tidy" the wording.

---

## 7. Git

> **Deferred.** Designed, not built — everything else came first. The
> section below stands as the plan for when it is picked up.

**Webhooks, not polling** — there are 92 repos in the org. One org-level webhook:
`push`, `pull_request`, `workflow_run`, `deployment`, `release`.

**Use a GitHub App, not a PAT.** The current token belongs to a person, can read
all 92 repos including `drcarmen-iac`, `tf-infra` and `devops`, and dies when
they leave.

**Link by branch name first.** Current traceability is 82.57%, and only because
PR titles and bodies are parsed too — the automation PRs put the key in the
description while the squash commit says nothing. A branch `DRC-1234-fix-cart`
is set once and carries through every commit and the PR. Message/PR parsing is
the backup; manual link is the floor.

```
git_pulls(repo_id, number, title, branch, state, draft, author_identity,
          opened_at, merged_at, merge_sha, url)
git_checks(repo_id, sha, name, status, conclusion, url, at)
git_deployments(repo_id, environment, sha, state, at)
issue_git_links(issue_id, kind, ref_id, source)
git_identities(user_id, email, login)
```

**Mirror state; never call GitHub on read.** The development panel is a local
join.

**Builds attach to a SHA, not a PR** — check → sha → commit → issue, latest per
`(sha, workflow)` wins, or a red result survives a green rerun.

**Webhooks retry and arrive out of order.** Dedupe on delivery id; decide current
state by the event's own timestamp, not arrival order.

**Identity properly, not heuristically.** Today an identity's owner is inferred
from the assignees of QA tickets its commits reference, which fails often enough
that "commits with no confident owner" is a visible section in the standup.

**Never swallow an integration failure.** The commits pull returned `[]` on any
exception, so an expired token was indistinguishable from a quiet quarter.

**The biggest single win:** drive `→ LIVE` from `deployment` events. The KPI
stops depending on someone remembering to drag a card, and the timestamp becomes
when it actually shipped.

---

## 8. Interface

- Page with a **left panel of projects**. Initial set: Classic Dev, AI First
  Development, QA Board, DevOps Board. These are *ways of working*, not products
  — a deliberate departure from AID/DRC/OPS.
- A project owns: key prefix, issue types, workflow, visible fields, its views,
  permissions.
- **Boards are saved views, not code:**

```
views(id, project_id?, name, filter, group_by, renderer, columns, sort, wip_limits)
      renderer: columns | table | timeline | swimlanes
      project_id NULL = cross-project
```

  "I don't know how the board should look yet" is exactly why this is data. A new
  arrangement is ten seconds in the UI, not a deploy.

- **The left rail is on every tracker page** — board, My work, Team Management,
  an issue's own page, project settings. A page without it reads as somewhere
  you have left the tracker rather than somewhere inside it.
- **Team Management is one page with three tabs: All, Rocket, Sparta.** Two rail
  entries for two teams made "what is the other team carrying" a navigation
  problem; it is a tab now. All is the same screen with the scope widened —
  same columns, same numbers, plus a Team column — so there is no second code
  path to keep in step. The old `/tracker/team/<KEY>` links redirect to their
  tab.
  **Who may change what is answered per row, not per screen.** A lead sees both
  teams on All and may only edit their own team's rows; one flag would either
  lock them out of their own work or let them reorder somebody else's. Free-for-
  all work is read-only on All too — it is pulled *for* a team, and All is not
  one, so it is taken from a team's own tab.
- **One search box, in the header, on every tracker page.** Global rather than
  per-board: the times you need search most are the times you do not know which
  board the thing is on. It matches summary, **description and comments**, and
  each result says which of the three it matched and shows that line — a hit
  whose title looks unrelated otherwise reads as a broken search. Scoped to the
  projects the viewer may see, like every other read.
- **The board card is one fixed height** (166px in a 320px column), so a column
  scans as a grid rather than a ragged stack: a key row carrying the type, the
  key and — when it has one — its parent's name as a pill, then two lines of
  title and two of description, both clamped, then a badge row along the bottom.
- **The parent pill is colour-coded from the parent's key**, not from the issue
  type — every epic shares a type colour, so it could not tell two of them
  apart. Derived rather than stored: stable across boards and sessions, with no
  column to maintain. If an epic's colour ever needs to be *chosen*, this
  becomes its default.
- **The badge row** shows what you would otherwise open the issue to learn:
  blocked (in the error colour, and counting only blockers that are *not*
  finished — a shipped blocker is history), child issues, links, comments. It is
  always rendered, empty or not, because a card that changes height as work
  happens to it breaks the grid — and that reserved space is where a pull
  request goes once git integration lands. The counts are four small aggregates
  over the page of issues just fetched, not correlated subqueries on the main
  select, which is the one that has to stay fast. The pill is the only thing on that
  row that gives up width; the priority and the face after it are fixed points a
  board is read by. Every flex item from the column down carries `min-width: 0`,
  because a nowrap pill otherwise propagates its min-content width upward and
  stretches the whole column. Only the **assignee**'s face is on it — two unlabelled
  pictures on something that small is a puzzle, and the tester keeps its own
  named column in the table view.
- **A board is always in priority order**, and a drag can only change where a
  card sits *among its equals*. A placeholder stands where the card would land,
  so the others move aside and the result is visible before committing to it —
  and when that place is out of bounds it turns red and says why, naming the
  card in the way: *"Medium can't go above high — the board is in priority
  order"*. Drawn where the pointer actually is rather than sliding back to the
  nearest legal spot, because a card that quietly snaps elsewhere leaves
  somebody wondering whether the drag registered at all; a refusal in the place
  they tried teaches the rule in one go. **The rule is written once and reused.**
  `useBandReorder` owns everything about how a drag behaves — where the
  placeholder goes, when it becomes a refusal, what the refusal says — and both
  the board and My work use it, so they cannot drift apart. The same is true on
  the server, where both reorder endpoints call `work._reorder_within_band`.

  A band is one priority inside one visible list: (project, the column's
  statuses) on a board, (person) on My work. The order sent is deliberately a
  **subset** — a screen shows what it shows and cannot know about the issues it
  is not displaying, of which finished work older than a fortnight is the
  obvious case. The server rearranges the listed issues among the positions
  they already occupy and leaves the rest untouched. That is also what makes
  the rule unbreakable: positions are only ever swapped between members of the
  same band, so no drag can put a medium above a high. It still refuses an
  issue that is not a member, and an id listed twice.
- **The board filters** are assignee, tester (both including the "nobody" case),
  priority and type, and they reset when you change project — the people and types on one
  board are not the ones on the next, so carrying a filter across would show an
  empty board with no visible reason. There is no "group by" control: a
  project's own board columns decide what the columns are, which is a better
  answer than a dropdown.
- **The issue card offers no Parent field on a type nothing sits above.** An
  epic is the top of the tree, so a parent picker there is a field that can
  never be filled — worse than a missing one. Asked of the issue types'
  hierarchy levels rather than hard-coded against "epic", so a new level added
  later needs no change. The server refuses the same arrangement anyway; this
  stops it being offered.
- **The issue type lives in the card header, as an icon and a name**, beside the
  key — it is identity rather than data, read to know what you are looking at
  the way the key is, and it had been taking a full-width form field to say one
  word. Clicking it changes it. The compact chip is the same `Picker` component
  in a `chip` variant, so the trigger differs and the menu, search and keyboard
  behaviour cannot drift from the fields that still use the field form.
- **The card's own actions are a vertical menu in its top corner**, where the
  close button used to be. Closing is the scrim, Escape, or the button in the
  footer — three ways already, and the corner is better spent on what you can
  *do* to an issue than a fourth way to leave it.
- **Issue keys are permanent** and leak into git branches, commit messages and
  bookmarks forever. 2–4 characters, chosen deliberately.
- **Clean start — nothing is imported from Jira.** Keys are therefore free.

---

## 9. Day one vs deferred

**Must be right immediately** — retrofitting these is a rewrite, not an addition:

- Events keyed by `entity_type + entity_id`
- Field definitions global, never per-project
- Every status carries a category
- Releases cross-project
- Per-artifact ship dates

**Safe to defer** — each is additive:

- Per-issue-per-artifact granularity
- Redis
- Event table partitioning
- Automation blocks beyond the first ~15
- Rules-as-code
- Email / Slack notifications (in-app first)

Rule of thumb: anything that changes the **shape of an identifier** must be right
early. Anything that adds a table or a column can wait.

---

## 10. What is built

Everything below runs today against a local Postgres, behind the `tracker` tag,
and answers a readable "not connected yet" on any environment without a
database. Nothing here touches `notes.db`.

| Area | State | Where |
|---|---|---|
| Connection as an optional state | done | `tracker_db.py` |
| Schema + migrations | done, 10 revisions | `tracker/schema.py`, `alembic/versions/` |
| Write path with a mandatory event log | done | `tracker/repo.py` |
| Reads + the saved-view filter compiler | done | `tracker/query.py` |
| First-run seed | done — **workflows captured from Jira** | `tracker/seed.py`, `tracker/jira_workflows.py` |
| Demo data (people, issues, history, releases) | done | `tracker/mock.py` |
| Project settings: columns, flow, access, types & fields | done, admin-only | `tracker/admin.py`, `components/tracker/ProjectSettings.tsx` |
| Per-project visibility, enforced on every read | done | `admin.visible_project_ids` |
| Teams, and the three-lever ordering (PO / lead / developer) | done | `tracker/work.py` |
| My work, team queue, urgency and the interruption measure | done | `components/tracker/MyWork.tsx`, `TeamQueue.tsx` |
| HTTP surface | done | `tracker/api.py` |
| Page: projects, three board layouts, issue detail | done | `components/tracker/` |
| Releases: cross-project, artifacts, runbook, notes | done | `tracker/releases.py` |
| Automations: blocks, queue, worker, audit log | done | `tracker/automation.py`, `worker.py` |
| Issue hierarchy and typed links | done | `tracker/links.py` |
| Board columns as containers of statuses | done | `admin.set_board`, `query.board` |
| Tester, on every issue type | done | `issues.tester_id`, `IssueCard.tsx` |
| Global search over summary, description and comments | done | `query.search_everything`, `TrackerSearch.tsx` |
| Git integration | done — PRs, branches, checks, and git triggers for automations | `tracker/git.py`, [docs](GIT.md) |
| Dynamic field admin UI | done — define a field, and set which types ask for it | `field_defs`, `field_usage` |
| Asks, and the four notifications | done — confirm / explain / discuss / present | `nox/asks.py`, `nox/notify.py`, [docs](ASKS.md) |
| Labels | done — created by use, folded on the way in, filtered by EXISTS | `nox/labels.py`, [docs](LABELS.md) |
| Text editor | done — Markdown rendered at last, to elements rather than HTML | `Markdown.tsx`, [docs](EDITOR.md) |
| Insights | done — flow, waiting, automation share | `nox/insights.py`, [docs](ANALYTICS.md) |
| Getting a team in | done — invitations, and a real account claims a seeded person | `nox/identity.py`, [docs](JOINING.md) |
| Saved views as first-class UI | done — private by default, shareable, whole arrangement | `nox/views.py`, [docs](VIEWS.md) |

Verified end to end rather than assumed: issue keys allocate per project from 1;
a refused transition names what *is* available; only real changes become events;
artifacts ship independently and the release state follows them both ways; an
automation runs once per event no matter how many times the queue is drained;
a rule that would trip itself stops after one hop; a board column holding two
statuses shows both, and a status in no column keeps its issues off the board.

Two bugs the same verification turned up, both fixed: `is_empty` compiled to
`col = ''`, which is an *error* rather than a false condition on an integer
column — so "unassigned" returned a 500 instead of an answer; and the seed
swallowed every exception while shaping the demo board, so a layout that never
applied looked exactly like one that had.

---

## 11. Open questions

1. **Field audit.** Sweep AID/DRC/QA per issue type: fill rate per field, last
   set, and who actually reads it. Decide what survives. We have the machinery
   (`list_fields` + a search sweep) — this is a cheap, real deliverable. *Still
   open.* The equivalent sweep for **statuses and workflows** is done: see
   `jira_workflows.py`.
2. ~~**Project keys.**~~ **Answered: `CD`, `AIF`, `QAB`, `DVO`.** Seeded, and
   permanent from the first issue onward. Change them in `seed.PROJECTS` only
   while a database is still empty.
3. ~~**SQLAlchemy or raw SQL.**~~ **Answered: SQLAlchemy Core + Alembic.** Not
   the ORM — queries stay explicit and readable like the rest of the codebase,
   and a saved view's filter compiles to composable SQL expressions instead of
   concatenated strings. The existing SQLite stores stay raw and untouched.
4. **Postgres in the estate.** Is there an existing cluster to get a database on?
   Changes the devops ask from a provisioning project to a one-line request.
   *Still open — the only thing standing between this and live.*

---

## Accounts and passwords

Accounts live in SQLite beside the app — `users` and `sessions` — not in
Postgres. Postgres has a `users` table, but it is the tracker's people
directory: id, display name, avatar. **No password, no email, no session.** A
dump of the tracker database contains no credentials at all.

Passwords are hashed with **Argon2id** at OWASP's floor — 19 MiB of memory, two
passes, one lane — which costs about 19 ms a login here and costs an attacker
roughly a thousand times what the PBKDF2 scheme did. The memory is the point: it
is what a GPU or ASIC farm cannot cheaply parallelise.

Accounts made before the change used PBKDF2-HMAC-SHA256 at 120,000 iterations.
Those hashes are still accepted, and are **replaced with an Argon2id one the
next time that person signs in** — the only moment the plaintext exists to
rehash from. No downtime, no reset emails, no migration script; the old hashes
drain away as people use the app. A row that never signs in again keeps its
PBKDF2 hash, which is exactly as safe as it was before. The `salt` column is
what tells the two apart: Argon2 carries its own salt, so the column is empty
for anything hashed the new way.

`check_needs_rehash` runs on every Argon2 login too, so raising the parameters
later migrates everyone the same way.

## 12. Decision log

| Date | Decision |
|---|---|
| 2026-08-06 | Built inside DrC Management, not as a separate product |
| 2026-08-21 | **Reversed:** extracted into its own repo, image and database |
| 2026-08-06 | Tag-gated on `main` like Timesheet/Sales — no long-lived branch |
| 2026-08-06 | Postgres for the tracker; SQLite keeps the rest, untouched |
| 2026-08-06 | Optional connection; "not connected" is a state, never an error |
| 2026-08-06 | Mutable rows + append-only event log; not event sourcing |
| 2026-08-06 | Fields dynamic but **global**; `key` separate from `name` |
| 2026-08-06 | Strict transitions with condition / validator / post-action |
| 2026-08-06 | Releases first-class, cross-project, containing artifacts |
| 2026-08-06 | Automations: UI block builder, jobs on a queue, audit log in v1 |
| 2026-08-06 | Git: GitHub App + webhooks, branch-name linking first |
| 2026-08-06 | Boards are saved views |
| 2026-08-07 | A board column is a container of statuses, not a status; unmapped = hidden |
| 2026-08-07 | Hierarchy is a tree (parent_id, by type level); links are a graph — kept apart |
| 2026-08-07 | Links stored once and directional; `blocks` refuses cycles and feeds the queue |
| 2026-08-06 | Clean start — no Jira import |
| 2026-08-06 | SQLAlchemy **Core** (not the ORM) + Alembic; SQLite stores stay raw |
| 2026-08-06 | Project keys fixed: `CD`, `AIF`, `QAB`, `DVO` |
| 2026-08-06 | Boards ship as three renderers (columns / table / list) while the right shape is still unknown |
| 2026-08-06 | Drag-and-drop shows which columns a card may legally reach, mid-drag |
| 2026-08-06 | Release state is **derived** from its artifacts, never typed |
| 2026-08-06 | Automations poll the event log rather than firing from the write path |
| 2026-08-06 | Git integration deferred; everything else built first |
| 2026-08-06 | Workflows captured from Jira (DRC/AID/QA/OPS), not designed — one per project |
| 2026-08-06 | Wrong status categories corrected on capture; every correction listed in code |
| 2026-08-06 | Demo data generated, walked through each board's real workflow with backdated history |
| 2026-08-06 | Project settings are admin-only, and each change answers with the whole settings object |
| 2026-08-06 | Visibility enforced on every read, not just in the sidebar; a hidden issue 404s rather than 403s |
| 2026-08-06 | Destructive settings changes refuse with a reason rather than cascading |
| 2026-08-06 | Workflow shown as a diagram with a per-status panel; the grid stays for bulk edits |
| 2026-08-06 | Diagram layout stored on the workflow, not per person — a shared picture to point at |
| 2026-08-06 | Two priorities: PO's plan order for teams, lead's order for one developer |
| 2026-08-06 | Order is owned, never computed — a score is arguable, a lead's list is not |
| 2026-08-06 | `urgent` above the five *is* the interrupt; no second escalation concept |
| 2026-08-06 | Parking is a person's click, not automatic, or the interruption figure is meaningless |
