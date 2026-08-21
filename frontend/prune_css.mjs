// Remove the stylesheet rules nothing in Nox can reach.
//
// Two earlier passes at this were both too lenient, in different ways, and both
// ways are recorded here because they are easy to fall into again:
//
//   1. Asking "does the class name appear anywhere in the source" is a substring
//      test, and a substring test keeps `.btn` alive because `tk-btn` contains
//      it. Whole swathes of the app Nox was extracted from survived that way.
//
//   2. Tokenising every string literal is better, but this app puts sentences in
//      strings — "Priority first, then the hand-set rank" — and every word of one
//      becomes a class name. `.card`, `.column` and `.tag` all survived on the
//      strength of English prose.
//
// So class names are taken only from the places a class name can appear: the
// value of a `className=` or `class=`, and the arguments of `classList.add`.
// A rule is judged by the *base* class of each compound in its selector, because
// `.bill-badge.ready` is a bill-badge that happens to be ready — if nothing
// renders a bill-badge the rule is dead however many things are ready.
//
// Bias is still towards keeping. A class assembled at runtime (`tkd-s-${state}`)
// keeps its whole family, a selector with no class is kept, and @keyframes are
// left alone. Deleting a live rule is a visual bug a person has to find; keeping
// a dead one costs bytes.

import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";

const SRC = path.resolve(process.argv[2] ?? "src");
const CSS = path.join(SRC, "styles.css");
const APPLY = process.argv.includes("--apply");

// --- what the source actually says ------------------------------------------
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.(tsx?|html)$/.test(e.name) ? [p] : [];
  });
}
const sources = [...walk(SRC), path.join(SRC, "..", "index.html")]
  .filter((p) => fs.existsSync(p) && !p.endsWith("styles.css"));
const haystack = sources.map((p) => fs.readFileSync(p, "utf8")).join("\n");

const STRING = /(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;

const tokens = new Set();
function harvest(text) {
  for (const lit of text.matchAll(STRING)) {
    for (const word of lit[2].split(/[^A-Za-z0-9_-]+/)) if (word) tokens.add(word);
  }
}

for (const m of haystack.matchAll(/\bclass(?:Name)?\s*=\s*/g)) {
  const rest = haystack.slice(m.index + m[0].length);
  if (rest[0] === "{") {
    // Balanced braces, so a nested `${}` or a ternary comes along whole.
    let depth = 0, end = 0;
    for (; end < rest.length; end++) {
      if (rest[end] === "{") depth++;
      else if (rest[end] === "}" && --depth === 0) { end++; break; }
    }
    harvest(rest.slice(0, end));
  } else if (/["'`]/.test(rest[0])) {
    const lit = rest.match(new RegExp("^" + STRING.source));
    if (lit) harvest(lit[0]);
  }
}
// A few classes are handed to a helper rather than written on an element.
for (const m of haystack.matchAll(/classList\.(?:add|remove|toggle)\(([^)]*)\)/g)) {
  harvest(m[1]);
}

// Classes also travel as arguments — `link(r, text, "tkd-id")` ends up on an
// element two lines later, and no `className=` scan will ever see it. So take a
// second, wider pass over every string, but only trust the *hyphenated* tokens
// from it. Every class in this app is namespaced (`tk-`, `tkc-`, `m3sel-`), and
// a hyphen is what separates them from the English that also lives in strings:
// "column" and "card" are prose, "tkd-title" is not.
const hyphenated = new Set();
for (const lit of haystack.matchAll(STRING)) {
  for (const word of lit[2].split(/[^A-Za-z0-9_-]+/)) {
    if (word.includes("-")) hyphenated.add(word);
  }
}

// Class names finished at runtime keep their whole family:
//   `tkd-s-${state}`      -> prefix tkd-s-
//   "tk-badge-" + tone    -> prefix tk-badge-
const prefixes = new Set([
  ...[...haystack.matchAll(/([A-Za-z][A-Za-z0-9_-]*-)\$\{/g)].map((m) => m[1]),
  ...[...haystack.matchAll(/["'`]([A-Za-z][A-Za-z0-9_-]*-)["'`]\s*\+/g)].map((m) => m[1]),
]);

const decided = new Map();
function inUse(cls) {
  if (decided.has(cls)) return decided.get(cls);
  const hit = tokens.has(cls)
    || (cls.includes("-") && hyphenated.has(cls))
    || [...prefixes].some((p) => cls.startsWith(p) && cls !== p);
  decided.set(cls, hit);
  return hit;
}

function selectorIsLive(selector) {
  return selector.split(",").some((part) => {
    const bases = part
      // `:not(.x)` and `:is(.x)` qualify the compound they hang off; their
      // contents are not what the rule is *about*.
      .replace(/::?[a-z-]+\([^)]*\)/gi, "")
      .split(/[\s>+~]+/)
      .filter(Boolean)
      .map((c) => (c.match(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/) || [])[1])
      .filter(Boolean);
    if (!bases.length) return true;          // element-only selector: not ours to judge
    return bases.every(inUse);
  });
}

// --- decide, rule by rule ----------------------------------------------------
const css = fs.readFileSync(CSS, "utf8");
const root = postcss.parse(css);

let kept = 0, dropped = 0;
const casualties = [];

root.walkRules((rule) => {
  if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
  if (!/\./.test(rule.selector)) { kept++; return; }
  if (selectorIsLive(rule.selector)) { kept++; return; }

  dropped++;
  casualties.push(rule.selector.replace(/\s+/g, " ").slice(0, 90));
  rule.remove();
});

// `::view-transition-old(name)` targets a name something has to declare with
// `view-transition-name`. Two of these point at pages that never came across.
const vtNames = new Set();
root.walkDecls("view-transition-name", (d) => vtNames.add(d.value.trim()));
for (const m of haystack.matchAll(/view-transition-name["'`:\s]+([A-Za-z][\w-]*)/g)) {
  vtNames.add(m[1]);
}
root.walkRules((rule) => {
  const named = [...rule.selector.matchAll(/::view-transition-[a-z]+\(([^)]+)\)/g)]
    .map((m) => m[1].trim());
  if (named.length && !named.some((n) => vtNames.has(n) || n === "*")) {
    dropped++;
    casualties.push(rule.selector.replace(/\s+/g, " ").slice(0, 90));
    rule.remove();
  }
});

// An @media or @supports left holding nothing is noise.
let emptied = 0;
root.walkAtRules((at) => {
  if (at.nodes && at.nodes.length === 0) { emptied++; at.remove(); }
});

// Unused @keyframes go too — nothing references them once their rules are gone.
const animations = new Set();
root.walkDecls(/^(animation|animation-name)$/, (decl) => {
  decl.value.split(/[,\s]+/).forEach((v) => animations.add(v.trim()));
});
let frames = 0;
root.walkAtRules(/keyframes/, (at) => {
  if (!animations.has(at.params)) { frames++; at.remove(); }
});

const out = root.toString();
const before = css.split("\n").length;
const after = out.split("\n").length;

console.log(`source files scanned      : ${sources.length}`);
console.log(`class tokens in source    : ${tokens.size}`);
console.log(`runtime prefixes          : ${[...prefixes].join(", ") || "none"}`);
console.log(`rules kept                : ${kept}`);
console.log(`rules removed             : ${dropped}`);
console.log(`empty at-rules removed    : ${emptied}`);
console.log(`unused @keyframes removed : ${frames}`);
console.log(`lines ${before} -> ${after}  (${Math.round((1 - after / before) * 100)}% smaller)`);

if (APPLY) {
  fs.writeFileSync(CSS, out);
  console.log("\nwritten.");
} else {
  fs.writeFileSync("prune-report.txt", casualties.join("\n"));
  console.log(`\nfull list in prune-report.txt (${casualties.length} rules)`);
}
