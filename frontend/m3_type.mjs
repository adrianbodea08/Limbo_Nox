// Put the type scale on the tokens, and every font size onto the scale.
//
// DESIGN_M3.md has had a type-scale table since it was written, and nothing
// enforced it: twenty distinct sizes were in use, including 9px, 10.5px, 12.5px
// and 13.5px. Half-pixel type is not a design decision, it is what happens when
// each rule is nudged until it looks right on its own.
//
// M3's scale in the range this app uses is 11 / 12 / 14 / 16 / 22 / 24 / 28.
// Everything snaps to the nearest step, except where the nearest step would
// flatten a hierarchy — an h2 at 18 sitting under an h1 at 26 has to land on 22
// and 24, not both on 16 and 24.

import fs from "node:fs";

const CSS = "src/styles.css";
let css = fs.readFileSync(CSS, "utf8");

// The role each step is, so the token says what it is for and not how big it is.
const ROLE = {
  11: "label-small", 12: "label-medium", 14: "body-medium",
  16: "title-medium", 22: "title-large", 24: "headline-small",
  28: "headline-medium", 32: "headline-large",
};

// Selectors that need a step other than the nearest one, and why.
const BY_SELECTOR = {
  ".tkw-urgent-head h2": 22,   // a section heading under a 24px page title
  ".tkt-head h2": 22,          // same
  ".m3mp-nav": 24,             // a glyph in a nav button: icon size, not text size
  // Page titles are headline-small, which the doc has said since it was
  // written. 26px is a tie between 24 and 28 and arithmetic should not be the
  // one deciding what a page title is.
  ".tks-page-title": 24,
  ".tkw-head h1": 24,
  // A stat number, not a heading. Headline-medium so the biggest thing on the
  // page is still the page's own title.
  ".tkq-card-value": 28,
};

// Ties round up. 13px is exactly between label-medium and body-medium, and it
// is body text in every one of the forty-four rules that use it — rounding it
// down would shrink most of the app's copy and demote it to a label role.
// Legibility is the tie-breaker, not arithmetic.
function nearest(n) {
  const steps = Object.keys(ROLE).map(Number).sort((a, b) => a - b);
  return steps.reduce((a, b) => (Math.abs(b - n) <= Math.abs(a - n) ? b : a));
}

// Rewrite declaration by declaration so the selector is in hand for the
// exceptions above.
let changed = 0;
const counts = new Map();

css = css.replace(
  /([^{}]+)\{([^{}]*)\}/g,
  (whole, selector, body) => {
    const sel = selector.trim().replace(/\s+/g, " ");
    const next = body.replace(/font-size:\s*([0-9.]+)px/g, (decl, raw) => {
      const n = Number(raw);
      const want = BY_SELECTOR[sel] ?? nearest(n);
      changed++;
      counts.set(`${n} -> ${want}`, (counts.get(`${n} -> ${want}`) ?? 0) + 1);
      return `font-size: var(--m3-font-${ROLE[want]})`;
    });
    return `${selector}{${next}}`;
  });

// The tokens themselves, next to the rest of the M3 block.
const anchor = `  /* Text on an accent fill. A named role rather than #fff scattered about. */`;
const tokens = `  /* Type scale. M3 names its type by role, not by size, and that is the point:
     a rule asking for \`title-medium\` keeps meaning the right thing when the
     scale is retuned, and a rule asking for 13.5px never did. Line height and
     tracking ride along on the .m3-* classes below for anything new. */
  --m3-font-label-small: 11px;
  --m3-font-label-medium: 12px;
  --m3-font-body-medium: 14px;      /* also label-large and title-small */
  --m3-font-title-medium: 16px;     /* also body-large */
  --m3-font-title-large: 22px;
  --m3-font-headline-small: 24px;
  --m3-font-headline-medium: 28px;
  --m3-font-headline-large: 32px;

${anchor}`;

// The *definition*, not the name: by the time this runs the name is on every
// rule the pass above rewrote, and checking for it skipped the insert entirely.
if (!css.includes("--m3-font-label-small:")) {
  css = css.replace(anchor, tokens);
}

fs.writeFileSync(CSS, css);
console.log(`font-size declarations rewritten: ${changed}\n`);
[...counts.entries()].sort().forEach(([k, v]) => console.log(`  ${k.padEnd(12)} x${v}`));
