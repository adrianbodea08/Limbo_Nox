# Analytics

> **Status:** built and running, 2026-08-21. Designed first, after reading how
> [Plane](https://github.com/makeplane/plane) and
> [Devlane](https://github.com/Devlaner/devlane) do theirs.
>
> `backend/app/nox/insights.py` computes it, `frontend/src/components/nox/`
> `Insights.tsx` and `Charts.tsx` draw it, and it lives in the rail as
> **Insights** — the room, with **Overview** and **Flow** as its two tabs. The
> doc originally called the room "Flow" too, which would have been a room and a
> tab inside it sharing a name.

---

## 1. Why ours can answer questions theirs cannot

Both of those tools ship an analytics page. Both pages count things that are
true **right now**: how many work items are open, how they split by priority, by
assignee, by state, and — the one exception — created versus resolved over time.
Plane's is a pair of tabs (Overview, Work items) built from an insight card, a
priority chart, a created-vs-resolved chart and a pivot table with an X-axis and
a Y-axis you choose.

That is what you can build when the database stores the present. Ask either of
them "how long does a ticket sit in code review", "which column is where things
go to die", or "how much of this board is being moved by a person rather than by
a rule" and there is no answer, because the information was never kept.

Nox keeps it. Every mutation writes a row to `events` in the same transaction:

| Column | What it gives us |
|---|---|
| `at` | when, to the second |
| `field`, `from_value`, `to_value` | *which* status it left and *which* it entered |
| `actor_kind` | `human` \| `automation` \| `integration` |
| `batch_id` | changes made in one save, so a status-and-assignee edit counts once |
| `entity_type` | issues, releases and projects all emit, so this is not issue-only |

This is not a feature we would add for analytics. It is already there, it has
been there since the first commit, and the reason it is there is that **every
valuable question turned out to be about history rather than state** — which is
also why Jira's missing verdict history is a permanent hole in the standup.

The measurement that started all of this: in the real Jira, **half of all status
changes are made by automation** (57% in DRC). In this repository's own database
today it is 136 human status changes to 10 automated ones. Either number is a
fact about how a team works that no tool storing only current state can produce.

**So the rule for this page: if a chart can be drawn from current state alone,
it is table stakes and it goes in the Overview tab. Everything that needs the
event log is why the page exists, and it gets the room.**

---

## 2. The four questions

Not "what charts could we draw". Four questions somebody actually asks in a
retro, and the page exists to answer them.

### Where does work wait?

**Time in status.** Reconstruct each issue's status history from
`events where kind='field_changed' and field='status_id'`, ordered by `at`. Each
consecutive pair is an interval; the last one runs to `resolved_at` or to now.
Sum per status, per issue.

The first interval is the one nothing recorded: an issue is created *in* a
status and the log only writes on change, so the opening status is the
`from_value` of the earliest transition — or, for an issue that has never moved,
simply where it still is.

Intervals are counted **in full, not clipped to the window**. Clipping was the
first implementation and it made every stale status report exactly the window
length: a wall of identical "4w / 4w" bars that said nothing. Something that has
sat for six months waited six months whichever thirty days you happen to be
looking at. The window decides which spans are *relevant*, not how long they
were.

Shown as a horizontal bar per status — median and the p85 next to it, because
the mean is the number that hides the problem. A column whose median is four
hours and whose p85 is nine days is not a slow column, it is a column with a
trapdoor, and those are different problems with different fixes.

The status `category` (`todo` / `in_progress` / `done`) splits this into
**working time** and **waiting time**. Waiting is the interesting half and
nobody measures it.

### How long does the whole thing take?

**Cycle time** — first entry into an `in_progress` status until first entry into
a `done` one. **Lead time** — `created_at` until the same. Both as a
distribution, not an average: a scatter of one dot per issue against its
completion date, with the median and p85 drawn across it. The shape of the cloud
says more than any single number, and an outlier is a ticket somebody can click.

### Who is moving it?

**Human, automation, integration**, straight off `actor_kind`. Two readings:

- the **share** of status changes each accounts for, over time
- **which transitions** are automated, so "a merge moves it to Done" shows up as
  a fact about the board rather than as a rule somebody half-remembers writing

A rising automation share is usually good and occasionally a warning — it can
also mean a rule is flapping. The chart does not editorialise; it shows the line
and the transition breakdown underneath it.

### What does an interruption cost?

`issue_pauses` already records `paused_at`, `resumed_at`, `paused_for_issue_id`
and `reason` — Nox is the only one of the three tools that models being pulled
off something at all. Two numbers: hours lost to interruption in the period, and
the count of distinct pieces of work that were put down. Plus the pairs: what
keeps interrupting what.

**Nobody types any of it.** Until 2026-08-23 a pause was a person's click: an
urgent item raised a banner, the banner offered a dialog, and the dialog asked
which of your open work you were putting down. The decision log said parking had
to be manual "or the interruption figure is meaningless" — the worry being that
an automatic pause measures a flag flip rather than somebody genuinely putting
something down.

That worry was about pausing on *escalation*, which is indeed a flag flip.
Deriving it from a **status move** is not: starting something else is the person
actually doing the thing the number is about, and it is a better signal than a
checkbox ticked to make a modal go away. Two rules, in `work.follow_move`:

* something reaches done → whatever was put down for it picks itself up;
* something starts and **outranks** what you already had open → that gets put
  down, for this.

"Outranks" is doing real work there. Switching between two mediums is not an
interruption, it is working badly, and counting it would bury the real ones.
And the case the dialog handled worst — you are an hour from finishing, so you
finish, *then* pick up the urgent one — now records nothing at all, because
nothing was interrupted. It needs no special handling; it is what the rule
already says.

---

## 3. What you see

Two tabs, following Plane's split because it is the right one — the first tab is
for anybody, the second is for whoever is trying to fix something.

### Overview

The table-stakes half. A row of **insight cards** — open, done in the period,
median cycle time, hours lost to interruption — each with a **trend against the
previous period of the same length**. A number with no comparison is a number
nobody can act on; this is the one piece of Plane's analytics design worth
taking wholesale.

Then created versus resolved over the period, as two lines. If resolved is
below created for long enough, nothing else on the page matters.

### Flow

The half that needs the event log: time in status, the cycle-time distribution,
who is moving the board, and interruptions. Each section says in one sentence
what it is showing and what a bad shape looks like, because a chart nobody can
read is decoration.

### Controls

One **duration** selector scoping the whole page (7 / 30 / 90 days, this
quarter), and one **project** selector. Both from Plane, both obviously right.

Not taking their X-axis/Y-axis pivot. It is a good escape hatch for a product
that has to serve everybody, and it is how you end up with a page that can draw
four hundred charts and recommends none of them. Nox has a saved-views engine
already; when somebody wants a cut we have not thought of, that is where it
belongs.

**Empty states are real.** Plane ships a drawn illustration per chart type and
it is worth copying the intent, if not the artwork: a blank rectangle reads as
broken, and "no work has moved in this period" is information.

---

## 4. Drawn by hand, not by a library

Plane and Devlane both pull in Recharts. Nox will not.

`frontend/package.json` has three dependencies — `react`, `react-dom`,
`react-router-dom` — and the app already hand-draws its two most complex
visuals, the release timeline and the workflow flow diagram, in plain SVG. A
chart library arrives with its own type scale, its own palette, its own tooltip
and its own idea of a rounded corner, and every one of those fights the design
system we just spent a day making machine-checkable. Four chart shapes are
needed here: a horizontal bar, two lines, a scatter and a stacked area. Each is
under a hundred lines of SVG against tokens that already exist.

The bar is that this is not a data-exploration product. If it ever becomes one,
revisit.

---

## 5. Where it lives

A **Flow** entry in the left rail under PLAN, beside Releases and Automations —
it is a planning instrument, not a report you go and fetch. Project-scoped by
default, with an all-projects option, because the questions are usually about
one team's board.

Reads only. No new tables, no new writes, nothing to migrate: every number on
the page is a query against `events`, `issues`, `statuses` and `issue_pauses`.

One thing to watch: reconstructing status history per issue is a self-join over
the event log, and the log only grows. The first version computes on request and
we measure it; if a project with fifty thousand events makes the page slow, the
fix is a materialised interval table maintained by the existing worker, not a
different design. **Not building that until it is needed** — an optimisation for
a load nobody has is a second source of truth that can drift from the first.

---

## 6. Deliberately not built

- **A pivot builder.** See above. Saved views are where an unanticipated cut
  belongs.
- **Estimates and velocity.** `issues.estimate` exists and is barely used. A
  velocity chart drawn from estimates almost nobody fills in is a chart that
  lies. Cycle time measures the same thing from data that is always there.
- **Per-person leaderboards.** Every metric here is per *status*, per
  *transition*, per *project*. The event log knows who did what, and a page that
  ranks people by tickets closed changes what people do, in the direction of
  closing more tickets. Assignee appears as a filter, never as a ranking.
- **Export.** Plane has it. Add it when somebody asks.

---

## 7. Decision log

| Decision | Why |
|---|---|
| Event log, not current state | It is what makes this page worth having. Both comparable tools can only count what is true now. |
| Median and p85, never the mean | The mean hides the trapdoor column. p85 is where the pain is. |
| Distribution, not one number | A cycle-time average of three days made of one-day and fifteen-day tickets is two different processes reported as one. |
| Waiting time split from working time | `status.category` makes it free, and waiting is the half that is fixable. |
| `actor_kind` promoted to a headline | Half of all real status changes are automation. That is a fact about the team, not an implementation detail. |
| Two tabs — Overview, Flow | Plane's split, and correct: table stakes for anybody, the real instrument for whoever is fixing something. |
| Insight cards carry a trend | Taken from Plane. A number without a comparison cannot be acted on. |
| No pivot builder | A page that can draw anything recommends nothing. |
| No chart library | Three dependencies today, a design system that is now machine-checked, and four chart shapes to draw. |
| No leaderboards | Measuring people by tickets closed produces more tickets, not more work done. |
| Compute on request first | An optimisation for a load nobody has is a second source of truth waiting to drift. |
