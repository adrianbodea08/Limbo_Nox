# Where Nox is

> **Last read against the code on 2026-08-22.** Every claim here was checked
> against the repository rather than remembered. Where something is not built,
> it says so; where something was deliberately *not* built, it says why.

One page, for somebody who has not been here. What Nox is, what of it exists,
what is being worked on, what is not, and the handful of decisions that shaped
the rest. The deeper documents are linked from each section — this one is the
map, not the territory.

---

## 1. What it is

An issue tracker for one team of about twenty people, built to replace Jira.

It is a real product and not a demo: 52 commits, 16 migrations, its own
Postgres, its own accounts, a GitHub App, a background worker, and a test suite
that runs on every push. It runs today at `http://localhost:8090` and on the
LAN.

It is **not deployed** anywhere with a domain or a certificate, and that is on
purpose — see [§5](#5-what-is-deliberately-not-built).

**Why it exists.** Not "Jira is annoying". The team measured what Jira was
doing for them and found that **half of every status change was made by
automation**, that "Utility Points" was five different custom field ids, and
that the field recording who tested something kept no history at all. Every
decision in [DESIGN.md](DESIGN.md) traces to one of those measurements.

---

## 2. What exists

Everything in this table is built, running, and reachable in the interface.
The link is the document that explains the reasoning; the path is where it
lives.

| | What it does | |
|---|---|---|
| **Projects and boards** | Three layouts — columns, table, list. A board column is a *container of statuses*, not a status, so two statuses can share a column and a status in no column stays off the board. | `nox/query.py` |
| **Workflow** | Transitions that actually refuse. Captured from the team's real Jira workflows rather than invented. | `nox/jira_workflows.py` |
| **Issues** | Type, priority, assignee, **tester**, labels, custom fields, hierarchy, typed links, comments, an activity trail. | `nox/repo.py` |
| **The event log** | Append-only. Every field change is a row, so history is reconstructable — the thing Jira could not do. | `nox/repo.py` |
| **Custom fields** | Global by construction: one field, one id, forever. An admin defines a field and picks which issue types ask for it. | `nox/admin.py` |
| **Releases** | Cross-project and first-class, with artifacts that ship independently, a state machine, and separate planned/actual dates. | [RELEASES.md](RELEASES.md) |
| **Automations** | Blocks, a job queue, a worker, and an audit trail. Git events are triggers. | `nox/automation.py` |
| **Git** | A GitHub App — pull requests, branches, builds through the Checks API, branch-name linking. Not a feature; the point. | [GIT.md](GIT.md) |
| **Asks** | Four kinds — confirm, explain, discuss, present. Deliberately *not* code review. | [ASKS.md](ASKS.md) |
| **Notifications** | In-app, with a bell, a title badge and a redrawn favicon. No email. | [ASKS.md](ASKS.md) §5 |
| **Labels** | Created by use rather than by an admin, folded on the way in so `Flaky` and `flaky` are one. | [LABELS.md](LABELS.md) |
| **Text editor** | TipTap. Types Markdown as you write it, renders to React elements rather than HTML, and survives a round trip — which is gated in CI. | [EDITOR.md](EDITOR.md) |
| **Saved views** | A whole arrangement — filters *and* layout. Private by default, shareable. | [VIEWS.md](VIEWS.md) |
| **Search** | Summary, description **and comments**, because half of what anybody remembers about an issue was said underneath it. | `nox/query.py` |
| **Insights** | Flow, waiting time, and how much of the movement is automation. | [ANALYTICS.md](ANALYTICS.md) |
| **My work / Team queue** | What one person should do next, and what a team is carrying, with an urgency lever and an interruption measure. | `nox/work.py` |
| **Accounts** | Register → an admin approves → an admin grants project access. Argon2id, rate-limited, sessions in the database. | [SECURITY.md](SECURITY.md) |
| **Admin audit** | Who changed a role, a status, or who can see a project — with the *before* as well as the after. | `nox/audit.py` |
| **Backups** | A flow that has actually been restored end to end. Nothing runs it on a timer. | `scripts/backup.py` |
| **Responsive** | Works from 320px up. Navigation becomes a sheet under 840px. | [LAYOUT.md](LAYOUT.md) |

**Held to, mechanically.** Four gates run on every build, and each exists
because of a regression that actually happened:

| `npm run build` | round trip → types → bundle, in that order |
| --- | --- |
| `node m3_audit.mjs src` | seven checks from [DESIGN_M3.md](DESIGN_M3.md); prints 0 |
| `node prune_css.mjs src` | dead CSS; reports, never fails a branch |
| `docker compose run --rm test` | 39 tests over auth, rate limiting, permissions and the audit log |

All four run in GitHub Actions on every push as well as locally — first green
run 2026-08-22. See [RUNNING.md](RUNNING.md) for why pushing the workflow file
needed an SSH remote.

---

## 3. What is being worked on

Nothing is half-finished. The status table in [DESIGN.md](DESIGN.md) §10 has no
unfinished row, and that is the honest position: **the next thing Nox needs is
not a feature, it is a second user.**

Nineteen accounts exist and one human has ever signed in. Asks, notifications,
mentions, shared views and the permission model have never met two people at
once. Until they have, any ranking of what to build next is a guess — including
this document's.

---

## 4. What is planned

In the order it makes sense to do them.

1. **Somebody else uses it.** It answers on the LAN today, so a colleague can
   register and be approved without any deployment at all. Everything below is
   less valuable than this.
2. **Rotate the GitHub App key.** It went into a chat transcript on
   2026-08-21. Nothing is known to have used it; that is not a reason to keep
   it.
3. **A field audit.** Fill rate per field, last set, and who reads it — then
   decide what survives. The machinery exists (`list_fields` plus a search
   sweep). The equivalent sweep for statuses and workflows is already done.
4. **Deployment.** A domain, a certificate, and a scheduled backup. Everything
   in [§5](#5-what-is-deliberately-not-built) that is blocked on HTTPS unblocks
   here.

*(CI was second on this list until 2026-08-22, when it started running.)*

---

## 5. What is deliberately not built

An undocumented gap is indistinguishable from an oversight, so:

| | Why not |
|---|---|
| **Email notifications** | The team did not want another mailbox. In-app plus the tab title was the ask. |
| **Real push notifications** | Impossible, not skipped: the Push API needs a secure context, and there is no HTTPS without a deployment. Verified by checking `isSecureContext` on the LAN address, not assumed. |
| **Discord / Slack** | Discord after it is live. Slack, never — asked for and declined. |
| **A command palette** | Recommended twice and dropped twice. Nox has seven destinations; a palette is for products where you cannot find things. |
| **Ask metrics** | Explicitly postponed. See [ASKS.md](ASKS.md) §7. |
| **Jira sync** | Nox replaces Jira. A two-way sync would make it a second place to look, which is the problem. |
| **Invitations** | Reverted after being built. The team's model is register → approve → grant, and an invitation is a different product. |

---

## 6. The decisions that shaped everything else

Ten, with the reason. The long versions are in [DESIGN.md](DESIGN.md) §12.

**1. History is a first-class citizen.** Almost everything worth knowing reads
history rather than current state, so every write goes through an append-only
event log. This is the decision the whole data model hangs off.

**2. One database, and it is Postgres.** Accounts lived in a separate SQLite
file until 2026-08-22, because Nox began as one feature inside another product.
Standing alone that split had no job left and it cost something concrete:
twenty-six columns held a user id and **not one could declare a foreign key**,
because you cannot declare one across two engines. Deleting an account silently
orphaned everything it owned. There are twenty-seven foreign keys now.

**3. SQLAlchemy Core, not the ORM.** Queries stay explicit and readable, and a
saved view's filter compiles to composable SQL expressions rather than
concatenated strings.

**4. Material 3, and a script that proves it.** The design system is not a
preference somebody remembers — `m3_audit.mjs` checks radius, elevation,
motion, type, colour, hit area and undefined tokens, and exits non-zero. It
once reported 0 for the wrong reason and had to be re-proved against five
deliberate violations.

**5. Registration is a request.** An issue tracker anybody can sign themselves
into is not a tracker. The first account to register becomes the admin, because
somebody has to be able to approve the second.

**6. Permissions are enforced in the query builder, not at the call sites.**
They were written correctly on four screens and wrongly on two, and nothing
could tell the difference. That leak is now three regression tests that have
been **proved to fail** against the code as it was.

**7. A restricted issue does not admit that it exists.** *"No issue CD-3"*
rather than *"forbidden"* — the second answer is itself information.

**8. Nothing renders text as HTML.** The editor renders to React elements, so
something somebody else wrote can never become markup. This is why the session
token in `localStorage` is an accepted risk rather than an open door.

**9. Git drives the tracker, not the other way round.** Half the team's status
changes were already automation. The GitHub App means one authorisation by an
org owner and no tokens pasted anywhere.

**10. Recreate rather than reuse.** Nox shares no code with DrC Management,
which it was extracted from. Copying would have coupled two products that are
now going different places — DrC must stay untouched.

---

## 7. Where the truth lives

When two documents disagree, believe them in this order:

1. **The code**, always.
2. **This file** and the topic documents — written against the code.
3. **[DESIGN.md](DESIGN.md)** — the reasoning, most of it written *before* the
   split into a separate product. It is a record of why, and parts of it
   describe an architecture that has since changed. §2 still describes accounts
   as living in SQLite; they moved into Postgres on 2026-08-22, and decision 2
   above is the current answer. Paths in it that say `tracker/` are now `nox/`.
