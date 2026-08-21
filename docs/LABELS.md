# Labels

> **Status:** built and running, 2026-08-21.
>
> `backend/app/nox/labels.py` owns it, `frontend/src/components/nox/Labels.tsx`
> draws it. Schema in `schema.py`, migration `c5d1e9b408aa`. The filter lives in
> `query.py` beside every other one.

---

## 1. The axis nothing else covers

Every issue already answers a lot of questions. Type says what kind of work it
is. Status says where it has got to. Component says which part of the system.
Parent says what it belongs to. Priority says how much it matters. Assignee says
whose it is.

None of them can say **flaky**. Or **needs-design**, or **good-first-issue**, or
**blocked-on-vendor**, or **regression-from-4.2**.

Those are words a team invents for itself, usually about one situation, often
only useful for a month. That is precisely why they cannot be another configured
taxonomy: by the time somebody has opened project settings, added a field,
chosen a widget and picked its options, the situation has moved on and the word
has gone into the summary instead — where nothing can filter on it.

So: a free list, global, made by using it.

---

## 2. Made by using them

**There is no create-a-label screen.** You type a word on an issue and the label
exists. If somebody typed it before, you get theirs.

The alternative is an admin curating the list before anybody may tag anything,
and the outcome of that is reliably the same: eleven labels nobody uses, and the
actual words people needed still living in issue summaries.

```
POST /issues/{id}/labels  {"name": "Needs Design"}
```

That call creates `needs-design` if it is new, attaches it, and returns the
issue's labels. One request. No setup step.

### Folding

`Needs Design`, `needs design`, `needs-design` and `NEEDS-DESIGN` are **one
label**.

```python
SHAPE = re.compile(r"[^a-z0-9]+")
key = SHAPE.sub("-", name.strip().lower()).strip("-")
```

The fold happens on the way *in*, not loosely on the way out, so the unique
constraint on `key` does the work and there is exactly one row however it was
typed. The `name` keeps whatever casing the first person used; the `key` is what
"the same label" means.

Deliberately narrow — letters, digits and hyphens. A label with a space in it is
two labels somebody will type differently next time.

### Colours

Handed out by position from a nine-colour palette, so the first nine labels are
all visibly different without anybody choosing. Changeable afterwards by an
admin (`PATCH /labels/{id}`). The point is that nobody is asked to pick a colour
before they are allowed to tag anything.

Not the status palette. A label is not a state and should not borrow the colours
that mean one.

### The key never changes

`PATCH /labels/{id}` renames and recolours. It cannot change the `key`, because
the key is what "the same label" means — letting it move would silently split
every issue already wearing it.

### Archiving is a suggestion, not a deletion

Archived labels drop out of the list and the pickers. Using one again
un-archives it: somebody typing the word is the only vote that counts.

---

## 3. Global, like statuses

A label that means one thing on QA Board and something else on Classic Dev makes
every cross-project filter a guess. Same reasoning as statuses, fields and issue
types, which are all global here for the same reason.

---

## 4. Filtering

`label_id` compiles to an **EXISTS**, not a join:

```python
wearing = select(issue_labels.c.issue_id).where(issue_labels.c.issue_id == issues.c.id)
```

A join would multiply an issue by the number of labels it wears, and every count
on the board — column totals, "3 of 12" — would be wrong for exactly the issues
that use the feature most. All five operators are supported:

| Op | Means |
|---|---|
| `in` / `eq` | wearing any of these |
| `not_in` / `ne` | wearing none of these |
| `is_empty` | wearing nothing |
| `is_not_empty` | wearing something |

Picking two on the board bar means "wearing either", the same as every other
multi-select there.

---

## 5. Where they show

**On a board card** — between the summary and the description, same left edge.
They qualify what the thing *is*, so they read with the title rather than with
the counts in the footer. Three at most, then `+N`; never a silent trim.

Deliberately quieter than the priority pill on the same card. Priority is a
state somebody assigned; a label is a word somebody typed.

**On the issue** — a chip row you can type into. Enter adds, Backspace on an
empty box takes the last one off, `×` removes one, and the suggestion list
offers what already exists (commonest first) before offering to make a new one.
Focus stays in the box after every change, because adding one label is usually
adding two.

**On the board bar** — last in the run of filters, after Any type. It is the
only axis on that bar that is not configured: it appears once somebody has
invented a word, and a filter that is sometimes absent should not shuffle the
four that are always there.

---

## 6. What they are not

Labelling is written to the **activity feed**, like every other change, and
**not** to notifications. Somebody tagging an issue is not somebody waiting on
you, and the notification trigger list stays four long — see
[ASKS.md](ASKS.md) section 5 for the test anything new has to pass.

---

## 7. Decisions

| Decision | Why |
|---|---|
| Created by use, not by an admin | A curated list is out of date before the word is needed |
| Global, not per project | A per-project label makes every cross-project filter a guess |
| Fold on the way in | One row per word however it was typed; the DB constraint does the work |
| `key` immutable | It is what "the same label" means; moving it splits the issues wearing it |
| Colour by position | Nobody picks a colour before they may tag anything |
| Archive, don't delete | Using it again is the only vote that counts |
| EXISTS, not JOIN | A join multiplies rows and every count on the board goes wrong |
| Activity feed, not notifications | A tag is not somebody waiting on you |
