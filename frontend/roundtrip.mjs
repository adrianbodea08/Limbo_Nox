// Does a description survive being opened in the editor and saved again?
//
// This is the check that matters most for the editor, because the failure it
// catches is silent and permanent: somebody opens an issue to read it, presses
// Save without typing a word, and the stored text comes back subtly different.
// Do that a few times across a team and the descriptions rot.
//
// `MarkdownManager` is pure data — no DOM — so this runs in Node, as part of
// the build rather than as something to remember to click through.
//
//    node roundtrip.mjs      (must print 0 changed)

import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";

// The same set RichText builds with. If they drift, this stops testing the
// thing that ships.
const mgr = new MarkdownManager({
  extensions: [
    StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
    TaskList,
    TaskItem.configure({ nested: true }),
  ],
});

// The same repair RichText applies on the way out. Markdown is not HTML, and
// the serializer escapes `&`, `<` and `>` in prose — see the long note in
// RichText.tsx for why undoing that is the faithful reading of the document.
const ENTITY = /&(amp|lt|gt|quot|#39);/g;
const CHAR = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
function unescapeProse(md) {
  return md
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 ? part : part.replace(ENTITY, (_, e) => CHAR[e])))
    .join("");
}

const CASES = {
  heading: "# One\n\n## Two\n\n### Three",
  "bold, italic, strike, code": "A **bold** and *italic* and ~~gone~~ and `code`.",
  bullets: "- one\n- two\n- three",
  numbers: "1. one\n2. two\n3. three",
  "nested list": "- one\n  - inner\n- two",
  checklist: "- [x] done\n- [ ] not done",
  quote: "> Somebody said this.",
  fence: "```sql\nSELECT 1;\n```",
  rule: "before\n\n---\n\nafter",
  link: "See [the runbook](https://example.com/x).",
  "link with a query": "[link](https://x.com/a?b=1&c=2)",
  mention: "Ping @Ana Mihalache about it.",
  "issue key": "Blocked by CD-11 and CD-9.",
  // The four that caught the escaping bug. Prose is not HTML.
  "arrow in stored text": "queued -> running -> done",
  ampersand: "salt & pepper",
  "angle brackets": "if x < y and y > z",
  "html sample in a fence": "```\n<b>a &amp; b</b>\n```",
  "html sample in a span": "use `&amp;` for an ampersand",
  mixed: "### Acceptance\n\n- [x] empty basket\n- [ ] 200 lines\n\n> ships behind a flag",
};

let changed = 0;
for (const [name, md] of Object.entries(CASES)) {
  let out;
  try {
    out = unescapeProse(mgr.serialize(mgr.parse(md))).trim();
  } catch (e) {
    out = `THREW: ${e.message}`;
  }
  const same = out === md.trim();
  if (!same) {
    changed += 1;
    console.log(`CHANGED  ${name}`);
    console.log(`   was: ${JSON.stringify(md.trim())}`);
    console.log(`   now: ${JSON.stringify(out)}`);
  } else {
    console.log(`   ok    ${name}`);
  }
}

const total = Object.keys(CASES).length;
console.log(`\n${total - changed}/${total} unchanged.  CHANGED: ${changed}`);
process.exit(changed ? 1 : 0);
