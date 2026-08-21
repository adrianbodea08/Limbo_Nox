# Asks

> **Status:** designed, not built. Written 2026-08-21.
>
> Filed under "review" in conversation, and the name did not survive contact
> with the four things it is actually for. Two of them are not reviews.

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
