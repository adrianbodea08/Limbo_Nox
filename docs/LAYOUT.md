# Narrow windows

> **Built 2026-08-22.** Nox works from 320px up. This is what changes, where,
> and why those widths — plus four bugs the pass turned up that were not about
> width at all.

Everything in Nox was designed at about 1400px, because that is where it was
ever looked at. It was not that the small end was bad; it was that nobody had
decided what it should be. At 375px the navigation took two thirds of the
screen and the board's control bar was drawn straight over it.

---

## 1. Two breakpoints, and they are the spec's

| | Under 600px | 600–839px | 840px and up |
|---|---|---|---|
| Material 3 calls it | compact | medium | expanded |
| Navigation | a sheet you open | a sheet you open | a column, always there |
| Filters, forms, two-column bodies | one column, controls fill the width | as they were | as they were |

Those are **M3's own window size classes**, not a pair somebody picked. It
means the layout changes where the design system says a layout changes, and the
answer to *"why 840?"* is a citation rather than a preference — the same
argument that made [DESIGN_M3.md](DESIGN_M3.md) worth writing a script for.

**Why a modal drawer at both compact and medium**, rather than M3's icon rail
at medium: the rail has seven destinations plus a list of projects. M3's
navigation bar tops out at five, and at rail width the labels have to sit under
the icons, where "Automations" does not fit across seventy-six pixels — which
is the same reason `TrackerRail.tsx` is a drawer and not a rail at full size
either.

The four breakpoints that were already here (640, 900, 1100, 1500) are left
alone. Each was written for one grid that stops fitting at one width, each was
measured against real content, and moving them to round numbers would be
tidying at the cost of the thing they were tuned for.

---

## 2. The navigation, as a sheet

Under 840px the rail becomes a sheet over the page: `position: fixed`,
translated off the left, with a scrim. A menu button appears in the top bar.

**State lives in a context** (`components/nox/navdrawer.tsx`), not in props.
The button is in the top bar and the drawer is the rail, and those two are
siblings under seven different pages. Threading a boolean and a setter through
all seven would have been fourteen props to say one thing, and every page added
later would have had to remember.

It closes on navigation — watching **both** the path and the query string,
because the rooms are paths (`/my-work`) and the board's sections are
parameters (`?section=releases`); watching the path alone would leave it open
over four of the seven destinations.

**Focus goes in and comes back.** Opening a sheet and leaving the keyboard
behind it is the same as not opening it: the next Tab reaches something the
reader cannot see. Focus lands on the drawer itself rather than its first item,
so a screen reader announces what appeared before reading the list, and on
close it returns to whatever opened it — if that is still on the page, since
picking a destination unmounts the whole screen.

Not done: a focus **trap**. Tab from the last item reaches the page behind the
scrim. Escape, the scrim and picking anything all close it, so this is a flaw
rather than a dead end.

---

## 3. What compact actually changes

- **The top bar keeps to two rows.** It is a wrapping flex row and the search
  box already takes a line of its own below 900px. What was left still could
  not fit "Team Management", the bell and the account, so the account wrapped
  to a *third* row — 150px of an 812px screen spent before any of the page. The
  page title now ellipsises and the account's name is dropped beside its face.
- **Filters go to a two-column grid.** They were right-aligned to sit against
  the New issue button at the end of a wide bar; wrapped, they became a
  staircase, each a different distance from the left because each is a
  different width. Two columns rather than one because five stacked filters is
  five rows of chrome before any work is visible.
- **Page headings wrap.** Every one is "who or what this is" on the left and a
  control on the right, held apart by `space-between` — which at 375px squeezed
  "My work" into a column two letters wide.
- **The issue dialog becomes a full-screen sheet.** With 24px of scrim either
  side it had 327px to work in.
- **Tab strips scroll instead of wrapping.** A tab strip that wraps is not a
  strip: "Who can see it" broke onto three lines inside its own tab while
  "Fields" was cut off the end with nothing to say it was there. The active tab
  scrolls itself into view, so arriving from a link does not show four other
  tabs and no indicator.

**The board is still columns**, and columns on a 375px screen are one column at
a time — which is what it does, by scrolling sideways, exactly as it does on a
desk. The list and table layouts are the ones that suit a phone, and they are
two taps away on the same bar.

---

## 4. Four things that were not about width

Each was found by looking at a narrow window and none of them was a narrow
window problem.

### The shell was never the height of the window

`.tk-page` said `min-height: 100vh` from the first commit. A minimum grows, so
the page was as tall as its tallest board and the browser scrolled the whole
thing — top bar, navigation and all.

Which means **every `overflow: auto` beneath it had never once fired**. Not one
of them could: none of their ancestors had a height to be bigger than.
`.tks-main` still carries the comment "panes that sit beside the rail and own
their own scrolling", and it never did. It is `height: 100dvh` now, and `dvh`
rather than `vh` because on a phone `100vh` is the window with the browser's
chrome *hidden* — a `vh` shell is always a chrome's worth too tall.

This exposed one real regression, which is the point of a change like this
being made deliberately: the issue **page** (not the dialog) set `flex: 1` and
`overflow: visible` on the same element, which means "be exactly the height
left over, and then draw past it anyway". The description spilled over the Back
and Save buttons. It was invisible while nothing was ever bounded.

### Six components each decided where to put a menu

They agreed on the easy half — flip left when the menu would run off the right
edge — and disagreed on the rest. Two (the issue card's, the date picker's)
also flipped **upwards** and capped the height to the room available; four did
not. So a dropdown opened from a control near the bottom of a phone ran off the
bottom of the window, and because these are `position: fixed`, nothing could
scroll to reach it. The saved-views menu, which had no vertical handling at
all, is the one people met first: it hangs off a bar a third of the way down.

The issue card's version — the one that had thought about it — is now
`components/menupos.ts`, and all six use it.

### Two features owned the same class

`.tkf-bar` was the workflow diagram's toolbar and the global search box's
field: one `tkf-` for *flow*, one for *find*. The search rule is declared four
hundred lines later, so it won every property both set, and the diagram had
been drawing itself as a 44px search pill with a 999px radius. Its own rule had
never applied. The diagram's is `.tkf-tools` now.

### Tables hid what did not fit

`.tk-table-wrap` used `overflow: hidden` to clip its corners to the border
radius, and it also clipped the columns. On a phone the accounts table lost
Status, Role and every button in the row, with nothing on screen to say they
existed. It scrolls on x and clips on y — the corners stay and the columns come
back.

### …and one that was about width after all

A grid track defaults to a **content** minimum, so `1fr` on its own means "at
least as wide as the widest unbreakable thing in here" — a long word, an image,
a 190px select. That is how a one-column grid ends up wider than its container.
Three places collapsed to `1fr` at a breakpoint and were still overflowing.
They say `minmax(0, 1fr)`, which is what they always meant.

---

## 5. How it was checked

Not by eye. A script walked the DOM at each width and reported anything whose
right edge was past the viewport without a scrollable ancestor, anything
clipped without an ellipsis, and any element handed a fixed height that its
content overflowed. Every screen was then looked at, at 320, 375, 768 and 1400.

The drawer's wiring was proved in two halves, because the browser this was
driven with could not deliver a synthetic click: the button's **live** React
handler was read from the DOM and is the provider's own setter, and forcing the
state open produced the open class, the scrim, `aria-expanded="true"` and a
locked body. Both halves observed, neither assumed.

---

## 6. Known and accepted

- **No focus trap in the drawer** — see §2.
- **A table on a phone is a table on a phone.** It scrolls sideways rather
  than becoming a list of cards. Honest and consistent; not delightful.
- **The workflow diagram is a diagram.** It scrolls in both directions at
  375px. There is no phone-shaped view of a seventeen-status workflow, and
  inventing one for a screen nobody will read it on is not worth the code.
- **Nothing is touch-specific.** No swipe to open the drawer, no pull to
  refresh. Everything is reachable by tap; nothing is reachable *only* by
  gesture, which is the part that matters.
