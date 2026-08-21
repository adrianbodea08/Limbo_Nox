# Asks

> **Status:** built and running, 2026-08-21. Designed first.
>
> Filed under "review" in conversation, and the name did not survive contact
> with the four things it is actually for. Two of them are not reviews.
>
> `backend/app/nox/asks.py` owns it, `frontend/src/components/nox/Asks.tsx`
> draws it. Notifications (section 5) are built too —
> `backend/app/nox/notify.py` and `Notifications.tsx`, with `Mentions.tsx`
> completing the names.

---

## 1. This is not code review

Code review is automated on git — bots, required checks, auto-review. A queue of
diffs waiting on a human is not the problem this product has, and building one
would have put a job nobody does on everybody's screen.

The thing that *is* a problem is a different shape entirely. Four examples, as
they were given:

| Who | What they say | What they need back |
|---|---|---|
| **QA** | "I have this bug — is it really a bug?" | a verdict |
| **PO** | "I have this epic and some questions, can you explain?" | an answer |
| **Design** | "I have some design issues here, can we talk?" | a conversation |
| **Dev → CEO** | "I have an epic done, can we present it to you?" | a slot, then a sign-off |

None of those is a diff. All four are the same underlying act: **somebody needs a
named person to look at something and come back to them**, and the work usually
waits until they do.

Today all four are comments. There are fifty comments in this database and not
one of them is a thing you can be *waiting on* — a comment has no state, no
owner, and no way of telling you it was never answered. That is where these go
to die, and it is why an ask has to be an object rather than a sentence.

---

## 2. The model

One table. An **ask** is a question, directed at a person, about an issue, with
a state.

| Column | |
|---|---|
| `issue_id` | what it is about |
| `asked_by` / `asked_of` | who wants something, and who from |
| `kind` | `confirm` \| `explain` \| `discuss` \| `present` |
| `question` | in their words. Never optional — an ask with no question is a nudge |
| `state` | `open` \| `answered` \| `declined` \| `withdrawn` |
| `answer` | what came back |
| `blocking` | whether the work stops until it is answered |
| `asked_at` / `answered_at` | the two timestamps every number on this page comes from |

The four kinds are the four rows in the table above, and they exist because the
answer is a different *shape* each time — a verdict, an explanation, a
conversation, a sign-off — and because "which of these waits longest" is a
question worth being able to ask. They are not a taxonomy to be extended lightly;
a fifth kind needs a fifth shape of answer.

### The one that is also a verdict

`confirm` closes a hole this product has had since it was designed.
`docs/ANALYTICS.md` says it plainly: *"Jira's missing verdict history is a
permanent hole in the standup."* Today `In Review → In Progress` is
indistinguishable from a rollback, a mistake, and "no, that is working as
intended". An answered `confirm` is that missing record, and it arrives as a
by-product of somebody doing the thing they were going to do anyway.

### Where git still helps

Nothing here depends on git, which is the point — half the work in this
workspace has no pull request and mock data has almost none. But where a repo
*is* connected, a PR review event carries a verdict, and it can answer a
`confirm` without anybody typing. Git feeds the model; it does not define it.

---

## 3. Three ways to not be moving

An ask must not become a fourth overlapping way of saying "stuck". It is not,
and the difference matters because each has a different fix:

| | What is in the way | What unsticks it |
|---|---|---|
| `issue_links.blocks` | **another issue** | finish that one |
| `issue_pauses` | **the person**, who put it down for something else | give them the time back |
| **an open ask** | **a different person**, who has not answered | ask them again, or ask somebody else |

The third is the only one that names somebody who does not know they are the
bottleneck. That is the whole reason to build it.

A blocking ask counts towards an issue's blocked state, so the board badge and
My work's Blocked band already know what to do with it.

---

## 4. What you see

### On My work — "Waiting on you"

A band, above Next, of asks directed at you. Everyone gets it: a developer being
asked to explain, a PO being asked to clarify, QA being asked to confirm, a CEO
being asked for twenty minutes. It shows who asked, what they asked, how long
ago, and — the part that does the work — **how long they have been waiting**.

This is the band that makes My work honest. It currently answers "what am I
doing" and "what is next" and nothing about what other people need from me,
which is most of what a day actually contains.

### On the issue — near the top, not in the comments

An open ask sits with the issue's own facts, not in the discussion. It says who
is waiting, on whom, for what, and since when. Answering is two clicks and a
sentence, from the issue or from My work.

`present` is the odd one and gets an odd affordance: what it needs is a slot in
somebody's calendar, so it says *waiting to be shown* rather than pretending a
text box will do. Scheduling is out of scope; naming what it is waiting for is
not.

### On a board card

One mark when something is waiting on a person, in the slot the blocked mark
already uses. A card that is stuck on somebody should look stuck.

---

## 5. Notifications

An ask is the first thing in this product worth interrupting somebody for, which
is what finally makes notifications buildable. The trigger list is short on
purpose:

- **an ask directed at you**
- **an ask of yours was answered**
- **an issue assigned to you**
- **you were mentioned**

That is the whole list. Nothing about status changes, nothing about issues you
once touched, nothing about configuration. The criteria this product is measured
against warn about notification spam before they ask for notifications at all,
and the failure mode is not "too few" — it is a person who has learned to ignore
the badge.

Everything on the list is either somebody waiting on you or somebody answering
you. Anything that fails that test needs an argument before it is added.

### How it is wired

**One funnel.** `notify.consider` is called from `repo.write_event`, so every
notification this product sends is decided in one place and the four triggers
cannot drift apart between the four callers that cause them. The overwhelming
majority of events reach it and fall straight through without disturbing
anybody, which is the intended shape.

Three rules earn their place there:

- **Never tell somebody about their own doing.** Without this, every trigger
  fires on the person who caused it and the badge becomes an echo.
- **Backfills are silent.** `write_event` takes an `at` for imports and
  generated data; when it is set, nothing rings. History should not ring a bell.
- **Automations count.** Being handed work by a rule is exactly as worth knowing
  as being handed it by a person, so an automated assignment notifies — and
  says "Something" rather than inventing a person to blame.

**Mentions** match `@Name` against display names, longest first, so
`@Ana Mihalache` reaches Ana rather than every Ana. An ambiguous first name
reaches nobody rather than the wrong person, and a name matching nobody is left
alone — an email address in a comment is not a mention.

They fire from **every box that lets you type prose** — a comment, an ask's
question, an ask's answer, a description — not just comments. Two details make
that safe:

- **A description is edited over and over,** so only names that were not in the
  previous version count. Otherwise everybody named in it is notified again
  every time somebody fixes a typo three paragraphs away.
- **One row per act.** Somebody who is both asked something and named inside the
  question gets the ask, not the ask *and* a mention.

### Completing the name

`Mentions.tsx` — a textarea that completes `@names`. Type `@`, keep typing,
press **Tab**. Arrows move, Enter also inserts, Escape dismisses the list
without closing the dialog behind it. Tab is only intercepted while the list is
up; the rest of the time it moves focus like it does everywhere else.

This is not a convenience. Matching is against real display names, so a mention
that is spelled almost right reaches *nobody* — and the person who typed it has
no way to find out. They believe they asked; the notification never arrives; the
thing they were waiting on does not happen. Completion is what makes the
matching rule above a promise the product can keep, and it is why the mention
triggers were widened at the same time: an autocomplete in a box that cannot
notify anybody would be worse than none.

The list is anchored at the caret, not at the field, because the word being
completed is in the middle of a sentence and a menu pinned under a twelve-line
description is nowhere near it. Ranking is whole-name, then any word of the
name, then anywhere — somebody typing "mi" means Mihalache far more often than
they mean Du*mi*tru.

### Getting past the bell

The bell is only seen by somebody already looking at Nox. An ask that stops
somebody's work is worth more reach than that, and **none of it is email**.

| | Works where | Permission |
|---|---|---|
| The tab's title — `(3) Nox by Limbo` | everywhere | none |
| A dot on the favicon | everywhere | none |
| A toast, when something lands while you are looking | everywhere | none |
| A desktop notification | secure origins only | asked for, once, from a click |

The first three are the ones that reach the whole team today, which is why they
are on for everybody and cannot be turned off: they cost nothing and interrupt
nobody.

**Real push is not possible yet, and it is worth knowing why.** The Push API
needs a service worker, a service worker needs a secure context, and the team
reaches Nox at `http://<machine>:8090`. Checked rather than assumed — at that
origin `isSecureContext` is `false` and `navigator.serviceWorker` is not merely
unusable, it is **absent**. Localhost is exempt from the rule, which is exactly
the trap: it works perfectly for whoever is running the server and for nobody
else. Push arrives with HTTPS and not before.

Two smaller decisions inside that:

- **Nothing is announced on the first poll of a session.** There is no "since"
  yet, and arriving to eleven toasts for things that happened last week is not
  news. Only a count that has gone up since the previous look produces anything.
- **The desktop permission is only ever asked for from a click.** A prompt
  somebody did not expect is the reason people press Block without reading, and
  Block cannot be undone from inside the page — so the setting says that
  plainly rather than offering a switch that silently does nothing.

**Four switches** in Settings, defaulting to on. The list is short enough that
the setting exists to turn one off, not to opt in.

---

## 6. What it lets us measure, later

Not built yet, and worth not throwing away in the meantime. Two timestamps per
ask give:

- **who is the bottleneck** — asks waiting on each person, and for how long
- **which kind waits longest** — a `discuss` that nobody schedules is a different
  disease from a `confirm` nobody answers
- **the honest split** that `docs/ANALYTICS.md` cannot make today: an issue in
  review for fifty-four days was either ignored for fifty-three or answered five
  times, and those need opposite fixes

The measurement is deferred by agreement. The two columns it needs are in the
model from the start, because adding a timestamp later means having none of the
history.

---

## 7. Deliberately not built

- **A code-review queue.** Automated on git. Building one would put a job nobody
  does on everybody's screen.
- **Scheduling.** A `present` ask says it is waiting for a slot. Finding the slot
  is a calendar's job.
- **Reassigning an ask.** Ask somebody else instead — it is one action and it
  leaves a truer record than an ask that quietly changed hands.
- **Ask templates.** Four kinds is already the structure. A form to fill in
  before you may ask a question is the thing this is meant to replace.

---

## 8. Decision log

| Decision | Why |
|---|---|
| An object, not a comment | Fifty comments in this database, none of them something you can be waiting on. A comment has no state, no owner and no age. |
| Four kinds, fixed | The answer is a different shape each time — verdict, explanation, conversation, sign-off — and "which waits longest" is worth asking. A fifth kind needs a fifth shape of answer. |
| The question is required | An ask with no question is a nudge, and a nudge does not deserve a notification. |
| Not code review | It is automated on git here. |
| Git feeds it, does not define it | Half this workspace has no pull request; mock data has almost none. A model that needs git would be empty. |
| Separate from `blocks` and `pauses` | Three different things are in the way — another issue, your own attention, someone else's. Each has a different fix. |
| `tester_id` stays as it is | A standing responsibility for testing an issue is not the same as a one-off question, and it is where a QA ask defaults to. |
| Notifications limited to four triggers | The failure mode is not too few; it is somebody who has learned to ignore the badge. |
| Named "asks", not "reviews" | Two of the four are not reviews. One word, and easy to change if the team says otherwise. |
