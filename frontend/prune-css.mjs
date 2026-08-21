// Remove the stylesheet rules Nox can never use.
//
// styles.css came from the app Nox was extracted from, which had five features
// Nox does not: dev stats, timesheets, My Board, a product importer, Jira
// dashboards. Their rules came with it.
//
// The rule for deciding: a class is "in use" if its name appears anywhere in
// Nox's source. That over-keeps — a class mentioned only in a comment survives
// — and over-keeping is the correct bias. Deleting a rule that turns out to be
// live is a visual bug found by a person; keeping a dead one costs bytes.
//
// A rule is kept when *any* class in its selector is in use, when the selector
// has no class at all (element, :root, *, a keyframe step), or when it sits
// inside @keyframes. Whole at-rules that end up empty are dropped with it.

import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";

const SRC = path.resolve(process.argv[2] ?? "frontend/src");
const CSS = path.join(SRC, "styles.css");
const APPLY = process.argv.includes("--apply");

// --- everything Nox's source says ------------------------------------------
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

// Class names built at runtime: `tkq-card-${tone}` means every tkq-card-* stays.
const prefixes = [...haystack.matchAll(/([A-Za-z][A-Za-z0-9_-]*-)\$\{/g)].map((m) => m[1]);

const seen = new Map();
function inUse(cls) {
  if (seen.has(cls)) return seen.get(cls);
  const hit = haystack.includes(cls) || prefixes.some((p) => cls.startsWith(p));
  seen.set(cls, hit);
  return hit;
}

// --- decide, rule by rule ---------------------------------------------------
const css = fs.readFileSync(CSS, "utf8");
const root = postcss.parse(css);

let kept = 0, dropped = 0;
const casualties = [];

root.walkRules((rule) => {
  // Keyframe steps ("from", "50%") are not selectors we can judge.
  if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;

  const classes = [...rule.selector.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]);
  if (classes.length === 0) { kept++; return; }
  if (classes.some(inUse)) { kept++; return; }

  dropped++;
  if (casualties.length < 2000) casualties.push(rule.selector.replace(/\s+/g, " ").slice(0, 80));
  rule.remove();
});

// An @media or @supports left holding nothing is noise.
let emptied = 0;
root.walkAtRules((at) => {
  if (at.nodes && at.nodes.length === 0) { emptied++; at.remove(); }
});

// Unused @keyframes go too — nothing references them once their rules are gone.
const animationsUsed = new Set();
root.walkDecls(/^(animation|animation-name)$/, (decl) => {
  decl.value.split(/[,\s]+/).forEach((v) => animationsUsed.add(v.trim()));
});
let framesDropped = 0;
root.walkAtRules(/keyframes/, (at) => {
  if (!animationsUsed.has(at.params) && !haystack.includes(at.params)) {
    framesDropped++;
    at.remove();
  }
});

const out = root.toString();
const before = css.split("\n").length;
const after = out.split("\n").length;

console.log(`source files scanned      : ${sources.length}`);
console.log(`dynamic class prefixes    : ${[...new Set(prefixes)].join(", ") || "none"}`);
console.log(`rules kept                : ${kept}`);
console.log(`rules removed             : ${dropped}`);
console.log(`empty at-rules removed    : ${emptied}`);
console.log(`unused @keyframes removed : ${framesDropped}`);
console.log(`lines ${before} -> ${after}  (${Math.round((1 - after / before) * 100)}% smaller)`);
console.log(`bytes ${css.length} -> ${out.length}`);

if (APPLY) {
  fs.writeFileSync(CSS, out);
  console.log("\nwritten.");
} else {
  fs.writeFileSync("pruned-sample.txt", casualties.join("\n"));
  console.log("\nfirst 30 selectors that would go:");
  console.log(casualties.slice(0, 30).map((s) => "  " + s).join("\n"));
}
