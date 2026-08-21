# Releases: a timeline of our own

Why we are building the thing Swanly is bought for, rather than integrating
with Swanly — and what the real data says the shape has to be.

Written 2026-08-19. Evidence gathered read-only from the live Jira
(4,429 versions across 8 projects; 1,200 issues of changelog over 90 days).

---

## 1. What Swanly is actually for

Jira has no concept of a release. It has **versions**, and a version belongs to
exactly one project. A real release does not: it ships work from several
projects at once, as several artifacts, on one date.

So every release has to be typed into Jira once per project, under the same
name, and kept in step by hand. Swanly is an app you buy to draw a timeline
over that duplication and pretend it is one thing.

We are not integrating with it. The duplication is a modelling mistake we do
not have to inherit — our releases already span projects — so what is worth
taking from Swanly is the **view**, not the data model.

## 2. What the real data says

### Releases are duplicated across projects, at scale

| | |
|---|---|
| Version rows across 8 projects | **4,429** |
| Distinct release names | **1,697** |
| Names appearing in more than one project | **1,179** (69%) |
| Duplicated rows those account for | **3,911** |

`Release 24 AUG 2026` exists in AID, DRC and OPS. `DRC iOS 3.20.0` exists in
DEV, TDV, TRK and TSP. Same release, four rows, four sets of dates to keep in
step.

### A release is an umbrella over component builds

This is the finding that decides the design. Group every version by the window
it ships in, and the structure falls out:

```
2026-08-19 -> 2026-08-24   Release 24 AUG 2026
                           A-25.1.0, Courier Base 7.8.0,
                           DAI Android 35.1.0, DAI iOS 35.1.0, DAI-32.1.0

2026-07-17 -> 2026-07-21   Hotfix 20 JUL 2026
                           B-33.0.4, DAI-31.0.1, DRC Android 32.0.0,
                           DRC iOS 32.0.0, F-32.0.2, G-7.0.1,
                           Stats 1.0.1, Store 14.0.1
```

The date-named version is the release. The component-named versions sharing its
window are what that release *ships*. Jira cannot express that, so both end up
as flat versions and a person holds the relationship in their head.

**We already model it exactly**: `releases` is the umbrella (name, kind, cycle
start, planned/shipped), `release_artifacts` is one row per component with its
own version string, state and ship date. Nothing in the schema changes.

Some builds ship with no umbrella at all — `Store 15.0.1`, `F-33.0.0`,
`Accounting 7.0.2`. Those are real releases too, of kind `component`. The model
already allows a release with one artifact and no ceremony.

### Cadence, duration and — the number that shapes the view — concurrency

| | |
|---|---|
| Releases per month | 23–57, averaging ~34 |
| Duration, start to ship | median **6 days**, p90 22, max 76 |
| **Open at once, peak** | **28** (12 Feb 2026) |

Twenty-eight overlapping releases is what the timeline must survive. That rules
out a lane per release, and it rules out a naive Gantt: at 34 a month with a
6-day median, bars overlap constantly and most are short.

## 3. The design

A **timeline**: time on the x-axis, releases as bars, packed into as few rows as
will hold them without overlapping.

- **Greedy lane packing.** A release goes in the first lane whose last bar ended
  before this one starts. 28 concurrent releases become ~28 lanes only in the
  worst case; in practice short bars share lanes and it settles far lower. The
  same approach as the workflow diagram's label placement, for the same reason:
  the alternative is a fixed row per item and a screen you scroll forever.
- **A bar is a release, not an artifact.** Artifacts appear inside the bar as
  ticks — one per component, filled once shipped — because "did iOS go out yet"
  is the question a half-shipped release raises, and our model already tracks
  ship state per artifact.
- **Today is a line.** Every timeline that omits it makes the reader count
  columns to place themselves.
- **Colour carries state, not kind.** Planning, in flight, shipped, late. Kind
  (standard / hotfix / component) is the bar's label prefix — a hotfix is
  recognised by its name, and colouring by kind would waste the one channel that
  answers "is anything late".
- **Late is derived, never stored.** `planned_at` in the past with no
  `shipped_at`. A stored flag goes stale the moment a date moves.
- **Scale is a choice, not a guess**: weeks or months. Median duration is six
  days, so a month view compresses most releases to a sliver — it is for seeing
  the year, and the week view is for working.

### What we are deliberately not building

- **Dependencies between releases.** Swanly has them. Nothing in the data shows
  them being used, and an arrow nobody maintains is worse than no arrow.
- **A separate roadmap object.** The timeline is a view of releases. A roadmap
  that is its own record is a second thing to keep true.

## 4. Mock data

Fourteen real release windows are seeded, taken read-only from Jira and kept as
they are — `Release 24 AUG 2026` with its five artifacts, `Hotfix 20 JUL 2026`
with its eight, the lone `Store 15.0.1`. Real names, real dates, real spans.

Mock data that is invented is mock data that agrees with you. These windows have
overlapping bars, a 35-day release beside a same-day hotfix, and releases with
one artifact and with fourteen — which is what the view has to survive.

Seventeen components are derived from the artifact names: A, B, F, G, DAI,
DAI Android, DAI iOS, DRC Android, DRC iOS, Courier Base, Store, Stats,
Accounting, Notification, STORAGE, LOPP Android, LOPP iOS.

## 5. Decision log

| Date | Decision |
|---|---|
| 2026-08-19 | Build the view, not an integration — the data model is ours already |
| 2026-08-19 | A release is an umbrella; component builds are its artifacts |
| 2026-08-19 | Greedy lane packing, because 28 releases run at once |
| 2026-08-19 | State is the bar's colour; kind is its label |
| 2026-08-19 | "Late" derived from planned_at, never stored |
| 2026-08-19 | No release dependencies until something in the data asks for them |
