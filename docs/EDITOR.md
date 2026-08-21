# The text editor

> **Status:** built and running, 2026-08-21.
>
> `frontend/src/components/nox/Markdown.tsx` renders it,
> `IssueCard.tsx` holds the Write/Read pair and the toolbar,
> `Mentions.tsx` completes the `@names` inside it (see [ASKS.md](ASKS.md) §5).

---

## 1. The bug this fixes

There has been a Markdown toolbar over the description since the day the issue
card was built. **Nothing in this product had ever rendered what it wrote.**

Every description and every comment was read as raw syntax — asterisks, hyphens
and backticks in the middle of sentences. That is worse than having shipped no
toolbar at all, because the toolbar actively encouraged people to *add* the
noise. Somebody clicked **B**, got `**like this**`, and every reader after them
saw the asterisks.

So the feature here is not "add Markdown". Markdown was already being stored.
The feature is showing it.

---

## 2. Rendered to elements, never to HTML

There is no `dangerouslySetInnerHTML` in this renderer and no sanitiser to keep
correct.

An issue description is text other people wrote, and the safest way to render
text other people wrote is to never let it become markup in the first place. The
parser produces React elements directly, so `<script>`, `<img onerror>` and
`<b>` in a description come out as the characters somebody typed. There is no
path from the text to the DOM as markup, so there is nothing to escape and no
escaping bug to have.

The one place a value from the text reaches an attribute is a link's `href`, and
`safeHref` decides that one by scheme: `http:`, `https:`, `mailto:` and
site-relative paths get an anchor. Anything else — `javascript:`, `data:` —
**gets no anchor at all** and renders as inert text.

Verified against a description containing all four:

| Written | Rendered |
|---|---|
| `[x](javascript:alert(1))` | text, no anchor |
| `[x](data:text/html,<script>…)` | text, no anchor |
| `<img src=x onerror=alert(1)>` | those characters |
| `[x](https://example.com/ok)` | an anchor |

---

## 3. Write and Read

Two tabs on the toolbar, not "Edit" and "Preview".

*Preview* suggests a lesser version of the real thing. The rendered side **is**
the real thing — it is what everybody else will see — so it gets the name that
says so.

**A description that has something in it opens on Read.** Reading an issue
happens far more often than editing one, and a description that is only ever a
raw textarea is a description nobody ever sees rendered. An empty one opens on
Write, because there is nothing to read.

**Clicking the text puts you in it**, the way a document does. Two details make
that work rather than annoy:

- A link inside the text is a link. The handler bails when the click landed on
  an `<a>`, so an issue key or a runbook URL opens instead of switching modes.
- Read and Write have the same metrics, so switching does not move the panel
  underneath or shift what is below it.

It is a `div` with `role="button"`, not a `button` — there are links and issue
keys inside it, and nesting those in a button is both invalid and unusable with
a keyboard.

---

## 4. What it renders

Everything the toolbar writes, plus what people paste out of other trackers:

headings, **bold**, *italic*, ~~strikethrough~~, `inline code`, fenced code
blocks, bullet lists, numbered lists, blockquotes, horizontal rules, links, and
checklists.

Plus the two things this product knows about that Markdown does not:

- **Issue keys** — `CD-11` becomes a real link, the same `IssueKey` used
  everywhere else, so middle-click and copy-address work.
- **`@names`** — become a chip, but *only when they resolve to a person*, by the
  same rule the server uses in `notify.find_mentions`. A name spelled almost
  right stays plain text. That is the point: what looks like it reached somebody
  is exactly what reached somebody.

### Decisions inside the renderer

| Decision | Why |
|---|---|
| Two heading levels, not six | A description sits in a dialog under the issue's own summary. But `###` is what people actually type for their only heading, so it has to look like one — `#`/`##` are level one, `###`/`####` level two. |
| A newline is a line break | Strict Markdown wants two trailing spaces. Nobody types two trailing spaces, and every tracker people came from broke the line. |
| Checklists are not clickable | Ticking a box is an edit, and an edit that happens without the Save button is a different feature with its own decisions. |
| Bare URLs keep their parens | A Wikipedia address ends in one. Sentence punctuation is trimmed off the end instead, and a closing paren counts as the URL's only when the URL opened it. |
| `plain()` for one-line places | A board card has one line and no room to render anything, so the markup comes off rather than showing as asterisks. |

---

## 5. Two bugs worth remembering

**A shared `/g/` regex cannot be used by a function that recurses.** The inline
scanner walks one combined expression and calls itself for the inside of `**…**`.
With `exec` in a loop, the inner call reset `lastIndex` underneath the outer one,
which then re-matched the same position forever — the page hung on the first
description containing bold text. `matchAll` iterates a clone, so the recursion
cannot reach the iteration.

**A flex container turns loose text into flex items.** A checklist row is a flex
box so the tick hangs beside the text. Every bare text node and inline tag inside
it became its own flex item, which laid `The \`price_list_legacy\` table is
dropped` out in columns instead of wrapping it. The row's text is one element
now.

Both were found by looking at the thing, not by any check — `tsc`, the M3 audit
and the CSS pruner all passed while the page was hanging.

---

## 6. Where it is used

| Place | Treatment |
|---|---|
| Issue description | Write/Read, full toolbar |
| Comments | Rendered |
| Asks — question and answer | Rendered |
| Board card, table row | `plain()`, one line, markup stripped |
| Release notes | Plain box — notifications are keyed by issue, so a mention there could not reach anybody |
