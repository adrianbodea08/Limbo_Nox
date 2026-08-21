# Git: the half of the workflow nobody clicks

Why this is not an optional feature, what it does, and what it deliberately
does not do.

Written 2026-08-19. The numbers come from the live Jira, read-only: 1,200 issues
of changelog over 90 days.

---

## 1. Why this had to be built before anyone could use the tracker

We measured who actually moves issues in the Jira we are replacing.

| project | changes by automation | by people | automated |
|---|---:|---:|---:|
| DRC | 2,419 | 1,822 | **57%** |
| QA | 21 | 60 | 25% |
| MGT | 9 | 27 | 25% |
| AID | 0 | 356 | 0% |
| **all** | **2,451** | **2,443** | **50%** |

Half of every status change in their Jira is made by a robot. In DRC — the
main delivery board — it is well over half, and the moves it makes are
unmistakably git- and deploy-driven:

```
793  In Progress -> IN REVIEW      331  To Do -> In Progress
464  STAGING     -> LIVE           158  IN REVIEW -> Done
442  Done        -> STAGING         50  UNIFIED -> STAGING
```

A tracker without git does not lose a feature. It loses half the workflow and
hands it back to people as manual clicking — which is how a tool gets abandoned
in its second week, with everybody agreeing it was very nice.

So this is not "integrate with GitHub". It is: **make the robots work here too.**

## 2. The model

A pull request is one object that can touch several issues, and an issue can
have several branches and PRs. So the ref is a row and the link is a join:

```
git_refs(id, kind, repo, ref, title, url, state, checks, author, branch,
         opened_at, merged_at, updated_at)          unique(repo, kind, ref)

issue_git(issue_id, git_ref_id, found_in)
```

- **`kind`** is `branch` | `pr` | `commit`.
- **`state`** is `open` | `draft` | `merged` | `closed`, and empty for a branch,
  which has no state beyond existing.
- **`checks`** is its own column rather than folded into state. A merged pull
  request whose build failed is a thing that happens, and the two questions
  need separate answers.
- **`found_in`** records where the issue key was found — title, branch or body.
  A link made from a branch name is the one most likely to be wrong, and
  without this nobody can tell which those are.

Keys are matched with a bounded pattern (`[A-Z][A-Z0-9]{1,9}-\d+`) and then
**checked against real issues**. `COVID-19` matches the pattern; it is not an
issue, so it is dropped without ceremony.

## 3. Connecting: a GitHub App, not a token

The first version asked for a personal access token. It works, and it is wrong
for anything other people have to run:

- it authenticates as **a person**, so the integration dies the day they rotate
  it or leave, and nothing says why;
- covering ninety-two repositories means either a webhook each or a list
  somebody maintains by hand;
- somebody has to paste a secret into a settings box.

A **GitHub App** removes all three. An org owner authorises it once, picks *all
repositories*, and GitHub then delivers events for every repo — including ones
created next month — and issues short-lived tokens scoped to what the app
declares.

```
Connect  →  github.com/apps/<slug>/installations/new
         ←  redirect with ?installation_id=…
         →  POST /git/connected  (id checked against GitHub, then stored)
```

The id arrives in a query string, which makes it a **claim, not a fact** — so it
is verified against GitHub before anything is stored. Without that check, anyone
could post somebody else's installation id and have us read their repositories.

Auth is two hops. We hold a **private key** and sign a short JWT to prove we are
the app; that JWT buys an **installation token**, an hour long and scoped to one
installation, and that is what reads repositories. The private key never leaves
the server and the installation token expires on its own, so a leaked one is an
hour of exposure rather than forever.

Disconnecting marks the row and forgets the cached token. It deliberately does
**not** uninstall the app on GitHub — that is the org's decision to make in
their own settings, not ours to make for them.

A registered app is not required. With none, sync falls back to the API token,
which is what makes the integration usable on day one.

## 4. Two ways in

**The webhook** is the real mechanism and gives the state a second after it
changes. It is public — GitHub cannot hold a session — so the only thing
between it and the open internet is an HMAC over the raw body, compared with
`compare_digest`. **With no secret configured it refuses everything** rather
than trusting the caller: an open write endpoint is worse than a broken
integration, because nothing tells you it is open.

**The sync** (`POST /git/sync`) pulls the same data on demand. It is what makes
this usable before anybody has configured a webhook, and what repairs the record
after a delivery is missed. A repo that cannot be read is collected into
`failed` and the rest continue — one bad repo is not a failed sync.

Both go through the same recorder, so they cannot disagree about what a pull
request means. Recording is idempotent on `(repo, kind, ref)`: GitHub retries
deliveries and a sync re-reads everything, so replaying a day changes nothing.

Sync also runs **on a timer** — every five minutes in the same worker that
drains automations. The webhook is what makes this near-instant; the poll is the
safety net that repairs a missed delivery and covers anyone who never configured
a webhook. A failure there is logged and swallowed: GitHub being unreachable
must not stop automations from running.

## 5. Events, and why automations can see them

Git writes events on the linked issues — `pr_opened`, `pr_merged`, `pr_closed`,
`branch_created`, `build_failed`, `build_passed` — and those are triggers like
any other. The automation engine needed no new concept to accept them.

Two decisions worth keeping:

**Only on a real change.** A webhook fires every time anybody edits a PR
description. Announcing "merged" on each of those would have every rule running
constantly, so an event is written only when the state actually moved.

**Announce to everything on the ref, not to what the payload named.** A check
result arrives against a *pull request* and carries no issue keys at all. The
first version announced to the keys found in the payload, so a build could never
fail as far as any issue was concerned — the feature was silently half-dead.

**Git events are exempt from the automation loop guard.** `scan()` ignores
events whose actor is not human, which is the cheapest of the three defences
against a rule triggering itself. Git records as `repo.SYSTEM`, so that guard
would have silenced the entire integration — rules sitting enabled, never
running, nothing in any log to say why. A git event is an external fact and
nothing in `ACTIONS` can produce one, so it cannot close a loop. `EXTERNAL_KINDS`
names them.

Proven end to end with the two rules DRC runs about 950 times a quarter:

```
CD-3 start:             To Do
      PR opened   ->    In Review
      PR merged   ->    Done
```

## 6. What you see

- **On an issue**: a Development panel — pull requests first, branches after,
  each with its state, its checks, and a link out. Shown only when there is
  something; an empty box on every issue teaches nothing.
- **On a board card**: one badge in the footer slot reserved for it. Where an
  issue has several PRs the badge shows the worst news — failing beats pending
  beats passing, open beats merged — for the same reason "blocked" is loud: it
  is the one that changes what somebody does next.

## 7. Deliberately not built

- **Writing to GitHub.** Nothing here creates a branch or a PR. The tracker
  reads what git did; git is not ours to drive.
- **Commit ingestion.** The `commit` kind exists in the schema and nothing
  populates it. Squash-merge means the PR already carries the story, and a row
  per commit is a lot of rows to say the same thing.
- **Deploy events.** `STAGING -> LIVE` is 464 of their moves and belongs here
  eventually, but a deployment is not a GitHub concept in their setup — it needs
  a conversation about where that signal comes from first.

## 8. Configuration

| | |
|---|---|
| `TRACKER_GITHUB_APP_ID` | The app's numeric id. |
| `TRACKER_GITHUB_APP_SLUG` | Its URL name, for the Connect button. |
| `TRACKER_GITHUB_APP_KEY` | The private key PEM. `
` escapes are accepted, because environments mangle newlines. |
| `TRACKER_GITHUB_APP_KEY_FILE` | Or a path to it, if a file suits the deployment better. |
| `TRACKER_GIT_WEBHOOK_SECRET` | HMAC secret. Unset means the webhook refuses everything. |
| GitHub API key | The existing `api_keys.github`, used only by the fallback sync. |
| Repositories | From the installation when an app is connected; from `components.repo` otherwise. |

**Registering the app** (an org owner, once): Settings → Developer settings →
GitHub Apps → New GitHub App. Permissions **Contents: read**, **Pull requests:
read**, **Checks: read** — nothing needs write, this only ever reads. Subscribe
to `pull_request`, `create` and `check_suite`. Point its webhook at
`/api/tracker/git/webhook` and set the same secret. The Git page lists these
steps too, so nobody has to find this file.

## 9. Decision log

| Date | Decision |
|---|---|
| 2026-08-19 | Build git because 57% of DRC's workflow is automated, not as a feature |
| 2026-08-19 | A ref is a row, the link is a join — a PR can touch many issues |
| 2026-08-19 | `checks` separate from `state`; a merged PR can have a red build |
| 2026-08-19 | Webhook refuses everything when no secret is set |
| 2026-08-19 | Git events are external, exempt from the automation loop guard |
| 2026-08-19 | Read only — the tracker never writes to GitHub |
| 2026-08-19 | A GitHub App, not a token: auth must not be tied to a person |
| 2026-08-19 | The installation id from the redirect is verified before it is trusted |
| 2026-08-19 | Disconnect never uninstalls on GitHub — that is the org's call |
| 2026-08-19 | Sync on a five-minute timer as the webhook's safety net |
