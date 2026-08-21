# Material 3 in Nox

This is the standard every component in this app is held to, and since
2026-08-21 it is **checked rather than trusted**: `frontend/m3_audit.mjs` reads
`styles.css` and reports every rule that breaks one of the sections below.

```bash
cd frontend && node m3_audit.mjs src
```

It printed 223 findings the first time it ran. It prints 0 now, and a pull
request that makes it print anything is a pull request that changed the design
system without saying so.

Material 3 is not a colour palette. Most of what makes an interface read as M3
is in four things that are easy to skip: **state layers**, the **shape scale**,
**elevation as a token**, and **motion with the right easing**. A component with
our colours and none of those looks like our old UI, not like M3.

Everything here is expressed as CSS custom properties in `styles.css`, so a
component that uses the tokens is compliant by construction and a component that
hard-codes `8px` is visibly not.

---

## 1. Tokens

### Shape scale

M3 has one shape scale and components pick from it. Never invent a radius.

| Token | Value | Used by |
|---|---|---|
| `--m3-shape-xs` | `4px` | menu containers, checkbox |
| `--m3-shape-s` | `8px` | chips, small surfaces |
| `--m3-shape-m` | `12px` | **cards**, text fields, the default |
| `--m3-shape-l` | `16px` | large surfaces, popovers |
| `--m3-shape-xl` | `28px` | **dialogs**, bottom sheets |
| `--m3-shape-full` | `999px` | **buttons**, pills, switches, nav indicators |

The two most common mistakes, both of which we had: a card at 8px (should be 12)
and a dialog at 12px (should be 28).

### State layers

**The single most M3 thing in the spec.** An interactive surface gets a
translucent layer of its own content colour on top of its container, not a
different background colour and not only a border change.

| State | Opacity |
|---|---|
| hover | `8%` |
| focus | `10%` |
| pressed | `10%` |
| dragged | `16%` |

Implemented as a `::after` pseudo-element so the layer sits above the container
and below the content, which is where the spec puts it:

```css
.thing { position: relative; isolation: isolate; }
.thing::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit;
  background: currentColor; opacity: 0; pointer-events: none;
  transition: opacity var(--m3-dur-short) var(--m3-ease-standard);
}
.thing:hover::after  { opacity: var(--m3-state-hover); }
.thing:active::after { opacity: var(--m3-state-press); }
```

`currentColor` matters: the layer then tints correctly on an accent button and
on a plain one without a second rule.

### Elevation

Five levels, as tokens. A card is level 1 at rest and level 2 on hover; a menu
or dialog is level 3. Never write a bespoke `box-shadow`.

`--m3-elev-1` … `--m3-elev-5`.

### Motion

| Token | Value | For |
|---|---|---|
| `--m3-ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` | most things |
| `--m3-ease-decel` | `cubic-bezier(0, 0, 0, 1)` | entering the screen |
| `--m3-ease-accel` | `cubic-bezier(0.3, 0, 1, 1)` | leaving it |
| `--m3-dur-short` | `150ms` | state layers, small fades |
| `--m3-dur-medium` | `250ms` | expanding, morphing |
| `--m3-dur-long` | `400ms` | large surfaces |

Linear easing is the giveaway that something was not designed. Every transition
takes an easing token.

### Type scale

M3 names type by **role**, not by size, and that is the whole point: a rule
asking for `title-medium` still means the right thing when the scale is retuned,
and a rule asking for `13.5px` never did.

| Token | Size | Role | Used for |
|---|---|---|---|
| `--m3-font-headline-large` | 32 | headline-large | the largest number on a stat card |
| `--m3-font-headline-medium` | 28 | headline-medium | stat values |
| `--m3-font-headline-small` | 24 | headline-small | **page titles** |
| `--m3-font-title-large` | 22 | title-large | section headings |
| `--m3-font-title-medium` | 16 | title-medium, body-large | card titles, lead copy |
| `--m3-font-body-medium` | 14 | body-medium, label-large, title-small | body copy, **button labels**, table headers |
| `--m3-font-label-medium` | 12 | label-medium, body-small | secondary text |
| `--m3-font-label-small` | 11 | label-small | overlines, pills, badges |

Before this was enforced the stylesheet used **twenty** distinct sizes, including
9px, 10.5px, 12.5px and 13.5px. Half-pixel type is not a design decision; it is
what happens when each rule is nudged until it looks right on its own. All 208
declarations now name a token, and `font-size` with a literal px is a finding.

Ties round **up**. 13px sits exactly between label-medium and body-medium and was
body copy in all forty-four rules that used it — rounding down would have shrunk
most of the app's text and demoted it to a label role. Legibility breaks the tie,
not arithmetic.

### Focus

Every interactive element shows a visible focus ring on keyboard focus:
`outline: 3px solid var(--accent); outline-offset: 2px`, via `:focus-visible`
so a mouse click does not draw it. This is an accessibility requirement, not a
style choice.

---

## 2. Components

**Button** — `--m3-shape-full`, height `--m3-control-h`, `0 24px` padding
(`0 16px` with a leading icon), label-large, state layer. Filled uses `--accent`
with `--m3-on-accent` text; outlined uses a `--border-strong` ring on
transparent; text has neither.

**Card** — `--m3-shape-m`, `--m3-elev-1`, `--bg-card`, `1px` hairline border.
Interactive cards get a state layer and go to `--m3-elev-2` on hover.

**Chip** — height 32px, `--m3-shape-s`, label-small, outlined by default.

**Text field** — filled: `--bg-col`, `--m3-shape-m`, accent border on focus.
Height matches `--m3-control-h` so fields and buttons line up on one bar.

**Menu / popover** — `--m3-shape-l`, `--m3-elev-3`, items at `--m3-shape-s`
with state layers.

**Dialog** — `--m3-shape-xl`, `--m3-elev-3`, scrim `rgba(0,0,0,.45)`, actions
bottom-right.

**Switch** — 52×32 track at `--m3-shape-full`, 24px handle, handle slides on
`--m3-dur-medium` with the standard easing. Selected fills with `--accent`.

**Date picker** — `M3DatePicker`, never `<input type="date">`. The native
control paints the operating system's calendar: a different shape, different
colours and a different week start on every machine, and it is the only control
in the app that ignores the theme. Day cells are `--m3-shape-full`, the grid is
always six weeks so it does not change height as you page through months, and
weeks start on Monday.

**Checkbox** — 18px box, `--m3-shape-xs`, inside a 40px hit area.

**Navigation rail item** — full-round indicator pill behind the label; the
indicator is the selected state, not a background colour change on the row.

**Progress** — track `--bg-col`, fill `--accent` (or `--ok` at 100%), both
`--m3-shape-full`.

**Segmented button** — `M3Segmented`. One outlined container at
`--m3-shape-full`, segments divided by a 1px hairline, the selected one filled
with `--accent-soft` and carrying a **check icon**. Two signals for the selected
state, not one, so it still reads when the fill is subtle and for anybody who
cannot separate the two colours.

Six places were choosing between mutually exclusive views with a row of separate
outlined pills whose selected state was a background one shade off the container.
On a card the difference was invisible: the settings page showed three identical
pills and no way to tell which theme was on. All six are this component now —
Timeline/List, Weeks/Months, All/Rocket/Sparta, Light/Dark/Midnight,
Columns/List, Diagram/Grid.

It is **not** tabs. Tabs change what a region contains and sit at its top edge;
a segmented button sets a value and can sit anywhere. Project settings has tabs;
the theme picker has a segmented button.

**Dropdown** — `M3Select`, never a native `<select>`. The same reason the date
picker rule exists: a native control paints the operating system's widget, which
is a different shape and a different colour on every machine, and it is the only
thing in the app that ignores the theme. The accounts page had two, and one of
them clipped its own text and silently displayed the wrong value.

---

## 3. Deviations, and why

M3 is a system to apply, not a spec to obey when obeying it makes the product
worse. Each of these is deliberate and stays documented:

| Deviation | M3 says | We do | Why |
|---|---|---|---|
| Control height | 40px buttons, 56px fields | both `42px` via `--m3-control-h` | The app already ran at 42px everywhere. A bar where a button is 40 and a field 42 shifts everything below it by 2px on every swap — which is exactly the morph bug we spent two rounds fixing. Uniform beats nominal. |
| Menu radius | 4px (extra-small) | `--m3-shape-l` (16px) | Our menus are floating popovers with heavy elevation, not attached dropdowns. 4px on a level-3 surface reads as a mistake. |
| Colour roles | full tonal palette (primary / on-primary / surface-container-*) | our semantic tokens (`--accent`, `--bg-card`, …) | Three themes already ship against these names. Renaming them all is a large diff with no visible benefit; the *structure* of the roles is what M3 is actually asking for, and we have it. |
| Density | default | one step tighter throughout | The board is deliberately information-dense. M3 defines density levels for this. |
| Table controls | 40dp small buttons | `--m3-control-h-dense` (32px) | M3's own extra-small button size. A 42px control inside a 52px table row forces the row to grow; extra-small is the size the spec provides for exactly this. |
| Board status label | chip, 32dp | 22px, `pointer-events: none` | It is a label, not a chip — read, never clicked. At chip height it would be the loudest thing on a card whose point is the summary. |
| Tab indicator radius | shape scale | `3px 3px 0 0` | The spec's own number for the active indicator. The shape scale is for containers; a 3dp bar is not one. |

Anything not on this list is not a deviation — it is a bug.

---

## 4. Checklist for a new component

1. Radius comes from the shape scale.
2. Interactive surfaces have a state layer, not just a border change.
3. Shadow comes from an elevation token, or there is no shadow.
4. Every transition names an easing and a duration token.
5. `:focus-visible` draws a ring.
6. Hit areas are at least 40px; rows in a list at least 48px.
7. Colours come from variables, so all three themes follow.
8. Text sizes come from the type scale.
9. A view change morphs the section (see `morph.ts`) rather than reloading the
   page — M3's container transform, and a standing rule in this app.
10. Every page has the left rail. A page without it reads as somewhere you have
    left the product rather than somewhere inside it — Accounts and Settings
    both shipped without one and both felt like a different application.
11. `node m3_audit.mjs src` prints nothing.

---

## 5. What the auditor checks, and what it deliberately does not

| Checked | Rule |
|---|---|
| Radius | comes from `--m3-shape-*` (or is the tab indicator) |
| Shadow | comes from `--m3-elev-*` |
| Motion | every transition names a `--m3-ease-*` **and** a `--m3-dur-*` |
| Type | every `font-size` names a `--m3-font-*` |
| Colour | no literal hex or rgb outside the theme blocks, so all three themes follow |
| Hit areas | buttons and text fields ≥ 40px; anything wrapping a checkbox or radio ≥ 40px |

It does **not** flag a checkbox at 18dp, a switch track at 32dp or a chip at
32dp, because those are the spec's own numbers and the touch target comes from
the label or row around them — which is the thing it checks instead. A square
control 24px or under is treated as one of these structurally, rather than by
trusting the selector to spell out the input type.

A checker that cries wolf about the spec's own numbers is worse than no checker,
because the next person turns it off rather than reading it.

`frontend/prune_css.mjs` is the other half: it removes rules nothing can reach.
Two earlier versions of it were too lenient in ways worth remembering — matching
class names as substrings kept `.btn` alive because `tk-btn` contains it, and
tokenising every string literal kept `.card`, `.column` and `.tag` alive on the
strength of English prose in user-facing sentences. It now reads class names
only from `className=` positions plus hyphenated tokens from any string (classes
travel as function arguments too), and judges a rule by the **base** class of
each compound — `.bill-badge.ready` is a bill-badge that happens to be ready.
