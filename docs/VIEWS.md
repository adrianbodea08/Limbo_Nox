# Saved views

> **Status:** built and running, 2026-08-22.
>
> `backend/app/nox/views.py` owns it, `frontend/src/components/nox/Views.tsx`
> draws it, and `TrackerPage.tsx` applies one to the board.

---

## 1. The table was always there

`views` has been in the schema since the first migration, with exactly the right
columns — `owner_id`, `shared`, `filter`, `group_by`, `renderer`, `columns`,
`sort`, `wip_limits`, `position`, and a nullable `project_id` for cross-project
ones. It is seeded with a board and a list per project. It is returned in
`/meta`.

**Nothing had ever read it.** The board built its filters on the bar and threw
them away on the way out, so the same three dropdowns were set again every
morning. This is the wiring, plus the two decisions the table left open.

---

## 2. Yours unless you say otherwise

A view belongs to the person who made it. A toggle turns one into a team view
that everybody gets.

That ordering is the decision. If sharing were the default the list would fill
with half-finished filters somebody made once, and a list nobody trusts is a
list nobody opens. Making it deliberate means a shared view is a small
statement: *this one is worth everybody having.*

The rules, all verified against the module rather than assumed:

| | |
|---|---|
| Your private view | only you see it, only you may change it |
| An admin, on your private view | **cannot see or touch it** — a private view is nobody's business, and the refusal reads the same as one that never existed |
| Your shared view | everybody sees it; only you may change it |
| An admin, on a shared view | may tidy it — the same people who can change a project's settings |
| Somebody else's shared view | you may use it, not edit it |

Two smaller rules fall out of the same thinking:

- **`owner_id` never comes from the request body.** Whoever is asking is the
  owner. A client that could name somebody else could put a view in their list.
- **A shared view on a project you cannot see is filtered out**, through the
  same `visible_project_ids` every other read uses. A view's name usually says
  what it is about, so the list would otherwise leak the existence of projects.

---

## 3. A view is the whole arrangement

Not only the filter: Columns or Table or List, the grouping, the sort, and what
to show.

"My view" means *how I like to look at this*, and remembering half of it would
leave the board rearranged under somebody who picked one. Switching to a view
puts the board back exactly as it was left.

### The bar has to be set, not bypassed

A view stores the compiled filter; the board bar is five dropdowns. So applying
one cannot simply send the stored filter — it has to **set the dropdowns**, or
the bar would sit there showing "Anyone" while the board showed one person's
issues.

`barFromFilter` walks the stored filter and puts each condition back where it
came from: `assignee_id` → the people field, `label_id` → labels, and so on.
`project_id` is skipped, because the rail owns which project you are in and a
view must not drag you to another one. Anything the bar cannot express is
ignored rather than guessed at.

---

## 4. "Changed" is a comparison, and it has one trap

The pill carries a dot when the board no longer matches the view whose name it
is showing, and only then does a save button appear. Without the dot the name is
a small lie the moment somebody touches a filter; without the *only then*, a
permanently-visible disabled button teaches people to stop looking at it.

**The trap:** a filter goes to Postgres as `jsonb`, which does not preserve key
order. It is handed `{field, op, value}` and gives back `{op, field, value}`.
Compared as plain JSON, a view read as *changed* the instant it was applied, and
the board offered to save what it had just loaded. `canon()` sorts keys before
stringifying, so the comparison is of what the arrangements say rather than how
they were typed.

---

## 5. Decisions

| Decision | Why |
|---|---|
| Private by default, shareable by choice | A shared-by-default list fills with somebody's half-finished filters and stops being read |
| The whole arrangement, not just the filter | "My view" means how I look at this; remembering half rearranges the board under you |
| `owner_id` from the session, never the body | Otherwise a client can put a view in somebody else's list |
| A private view is invisible to admins too | It is not a record of anything; it is somebody's working state |
| Really deleted, not archived | A view is an arrangement, not a record — there is no history to keep and nothing points at it |
| Compared canonically | `jsonb` reorders keys, and a view that reads as changed the moment it loads is worse than no indicator |
