# The text editor

> **Status:** built and running. WYSIWYG since 2026-08-22.
>
> `RichText.tsx` is the editor, `Composer.tsx` is the lazy boundary in front of
> it, `Markdown.tsx` renders the read-only places (comments, asks, board cards).
> Section 7 is the comparison that chose Tiptap.

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

## 3. Write and Read are two documents

The tabs are back, and they are **not** editor-and-preview — the editor already
renders what you type, so a preview would show the same thing twice. They are
two versions of the same field that stop being identical the moment somebody
types without saving:

| | |
|---|---|
| **Read** | what the team can see. Straight from the server, always. |
| **Write** | what *you* have written, saved or not. |

**An unsaved edit is kept.** Type, click away, close the tab, come back
tomorrow — Write still has it, and the issue opens on Write because that is the
whole point of having kept it. Read never moves until you save. Once you save,
the two agree and there is nothing left to keep.

**Clicking the text starts writing**, the way a document does. Three details
make that help rather than annoy:

- A link inside the text is a link. The handler bails when the click landed on
  an `<a>`, so an issue key or a runbook URL opens instead of switching modes.
- The caret lands in the box, but the page does not move. Tiptap's own
  `autofocus` scrolls the caret into view, which on a long description means
  clicking the first paragraph and being thrown to the last one.
- Only *asking* to write takes the caret. An issue that opens on Write because
  a draft was waiting leaves focus alone — you arrived to read it, not to type.

The read side is a `div` with `role="button"`, not a `button`: there are links
and issue keys inside it, and nesting those in a button is both invalid and
unusable from a keyboard.

Nobody else sees it. Not in their Read, not in their Write, not on the board
card, not in search.

### Where the draft lives

`drafts.ts`, in `localStorage`, keyed by person **and** issue.

That is the requirement rather than a shortcut: a draft must not reach another
account, and **text that never leaves the browser cannot**. There is no endpoint
to get wrong, no row to accidentally join, nothing to redact. Verified by
looking: with a draft open, `issues`, `comments` and `events` all contain zero
rows matching it.

Keyed by person too, because two accounts do share a browser sometimes, and one
reading the other's unsaved words would be the same failure by a shorter route.

The cost is real and worth saying plainly: **a draft does not follow you to
another computer.** If it should, that is a `drafts` table and an endpoint, and
the privacy rule stops being structural and starts being something the server
has to remember to enforce on every query.

Two housekeeping rules so this cannot grow forever: drafts expire after 30 days,
and past 50 of them the oldest goes. Failing to save silently is worse than
dropping text nobody has touched in a month.

### "There is a draft" is derived, never stored

It means exactly *what I have differs from what is saved*. A second copy of that
fact would eventually disagree with the first, and the disagreement would be
invisible — a dot claiming unsaved work that is not there, or worse, no dot over
work that is.

### Typing is the formatting

Everything below happens as you type, and the toolbar does the same things to
the same document:

| You type | You get |
|---|---|
| `# ` `## ` `### ` | headings |
| `- ` `* ` | a bullet list |
| `1. ` | a numbered list |
| `[] ` | a checklist |
| `> ` | a quote |
| ` ``` ` | a code block |
| `---` | a divider, full width of the panel |
| `**x**` `*x*` `~~x~~` `` `x` `` | bold, italic, strike, code |
| `->` `<-` `--` `...` `(c)` | → ← — … © *(and 18 more)* |

The last row is `@tiptap/extension-typography`, and it is the reason the
arrow example in the original request works without anything custom.

### Pasting is the same thing

Paste a page of Markdown from a wiki and it arrives formatted, by the same
parser that reads the stored value.

It is guarded, because parsing *every* paste as Markdown turns `5 * 3 * 2 = 30`
into italics: a paste is parsed as Markdown only when it carries a construct
that only Markdown has — a heading, a list, a fence, a rule, a table, or an
inline pair like `**x**`. Everything else pastes as text. **Ctrl/Cmd+Shift+V
always pastes as text**, which is the escape hatch for the times the guess is
wrong. And when the clipboard carries real HTML, that wins: the source
application already said what it meant.

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

## 5. Three bugs worth remembering

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

**A class name that already meant something else.** The Write/Read tabs were
called `.tkc-side` — which is the dialog's right-hand column. A 30px tab
button's metrics were silently applying to the whole sidebar. Renamed
`.tkc-mode`.

All three were found by looking at the thing, not by any check — `tsc`, the M3
audit and the CSS pruner all passed while the page was hanging.

---

## 6. Where it is used

| Place | Treatment |
|---|---|
| Issue description | Write / Read, `Composer`, full toolbar, draft kept |
| Comments — composing | `Composer`, compact toolbar |
| Comments — reading | `Markdown.tsx` |
| Asks — asking and answering | `Composer`, compact toolbar |
| Asks — reading | `Markdown.tsx` |
| Board card, table row | `plain()`, one line, markup stripped |
| Release notes | Plain box — notifications are keyed by issue, so a mention there could not reach anybody |


---

## 7. Why Tiptap

The brief was explicit: *"if I copy paste a markdown it works, if I write it
there I can do the same"* — and *"how does Plane do it?"*

Plane uses **Tiptap** (`@tiptap/core` + `starter-kit` + `tiptap-markdown` +
Yjs). Worth knowing before copying them: the `tiptap-markdown` they depend on is
**no longer maintained** — its author now points people at Tiptap's own official
`@tiptap/markdown`, which landed in 3.7.0. So we use the official one and are
slightly ahead of the thing we were asked to match.

### Scored

Weights come from the brief, not from a generic editor shootout. Storage format
and typing rules carry the most because that is what was asked for.

| Weight | Criterion | **Tiptap** | Milkdown | Lexical | Plate | BlockNote | Hand-rolled |
|---|---|---|---|---|---|---|---|
| 20 | Markdown is the stored format, both ways | 8 | **10** | 7 | 7 | 2 | **10** |
| 20 | Typing rules (`1. `, `---`, `# `, `**`, `->`) | **10** | 8 | 8 | 8 | 9 | 7 |
| 12 | Paste Markdown → formatted | 9 | 9 | 7 | 8 | 8 | 6 |
| 12 | Headless — M3 keeps every pixel | **10** | 9 | **10** | 6 | 4 | **10** |
| 12 | Health and momentum | **10** | 6 | **10** | 7 | 7 | 4 |
| 8 | Licence | 9 | **10** | **10** | **10** | 6 | — |
| 8 | Fits what Nox already has | **10** | 7 | 6 | 5 | 4 | 9 |
| 8 | Cost to carry | 6 | 7 | 6 | 5 | 7 | 2 |
| | **Total** | **90.8** | 84.0 | 80.0 | 71.2 | 58.4 | 74.8 |

### What decided it

- **`->` → `→` is a shipped feature.** `@tiptap/extension-typography` does the
  exact example in the request plus 22 more substitutions. Nothing else has it
  built in.
- **BlockNote is out on the requirement, not on taste.** Its export function is
  named `blocksToMarkdownLossy()` and its documentation tells you not to use
  Markdown as your storage format. Nox stores Markdown and full-text-searches
  it.
- **Milkdown is the purest fit and the biggest risk.** Markdown genuinely *is*
  its document model (remark). But 321K weekly downloads and 4 releases in 90
  days, against Tiptap's 14.7M and 17.
- **Hand-rolling loses on cost, not on principle.** The moment you transform
  text programmatically the browser's native undo stack breaks, which means
  writing your own undo, selection mapping and paste sanitising. That is
  rebuilding a small ProseMirror.

Measured, not recalled — from the npm registry on 2026-08-22:

| Package | Version | Licence | Weekly downloads | Releases / 90 days |
|---|---|---|---|---|
| `@tiptap/core` | 3.30.2 | MIT | 14,668,394 | 17 |
| `lexical` | 0.49.0 | MIT | 4,109,604 | 68 |
| `slate` | 0.126.2 | MIT | 2,544,538 | 7 |
| `@blocknote/core` | 0.54.0 | **MPL-2.0** | 437,675 | 8 |
| `@milkdown/core` | 7.22.1 | MIT | 320,907 | 4 |
| `quill` | — | BSD | 6,872,746 | last published Jan 2025 |

### The caveat

`@tiptap/markdown` is marked **early release**, with known gaps around tables
and comments. Neither is in the toolbar or in this database. If it turns out to
lose something on round-trip, the fallback is a serialiser of our own against
the same ProseMirror schema — not a change of editor.

### What it costs

The editor is behind a lazy import (`Composer.tsx`), so nothing that does not
write a word pays for it:

| | before | after |
|---|---|---|
| Main bundle | 122.89 kB gzip | **121.11 kB gzip** |
| Editor chunk | — | 155.51 kB gzip, on first dialog |

The main bundle got *smaller*, because the textarea-with-completion it replaced
was deleted. 56 packages were added; `npm audit` reports 0 vulnerabilities.
