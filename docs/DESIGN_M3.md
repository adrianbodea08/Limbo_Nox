# Material 3 in Nox

This is the standard every component in this app is held to. `DESIGN_SYSTEM.md`
at the root is a *portable* copy of our look, written so Claude can recreate it
in an Artifact. **This** file is the rule set we build against.

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

| Role | Size / weight / tracking | Used for |
|---|---|---|
| headline-small | 24 / 400 / 0 | page titles |
| title-medium | 16 / 600 / .15 | section and card titles |
| title-small | 14 / 600 / .1 | dense titles, table headers |
| body-medium | 14 / 400 / .25 | body copy |
| body-small | 12 / 400 / .4 | secondary text |
| label-large | 14 / 600 / .1 | **buttons** |
| label-small | 11 / 600 / .5 | overlines, pills |

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
