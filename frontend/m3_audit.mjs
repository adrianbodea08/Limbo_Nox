// Hold styles.css to docs/DESIGN_M3.md, mechanically.
//
// The doc says a component using the tokens is compliant by construction and
// one that hard-codes 8px visibly is not. This checks which is which, rather
// than trusting anybody's eye over four and a half thousand lines.
//
// Every rule below is one the doc actually states. Nothing here is invented
// taste — where the doc records a deliberate deviation, the deviation passes.

import fs from "node:fs";
import path from "node:path";
import postcss from "postcss";

const SRC = path.resolve(process.argv[2] ?? "frontend/src");
const css = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
const root = postcss.parse(css);

// The shape scale, by value, so a literal that happens to match is still named.
const SHAPE = { 4: "xs", 8: "s", 12: "m", 16: "l", 28: "xl" };
// The type scale from DESIGN_M3.md section 1.
const TYPE = new Set([11, 12, 14, 16, 22, 24, 28, 32, 36, 45, 57]);

const findings = { radius: [], shadow: [], easing: [], type: [], colour: [], hit: [], ghost: [] };
// Wrappers around a checkbox or radio, collected on the way past and checked
// afterwards: each one has to give the small box a 40px target to sit in.
const wrappersToCheck = new Set();
const where = (d) => `${d.parent.selector?.replace(/\s+/g, " ").slice(0, 64)} { ${d.prop}: ${d.value} }`;

root.walkDecls((decl) => {
  const { prop, value } = decl;
  const inKeyframes = decl.parent?.parent?.type === "atrule"
    && /keyframes/.test(decl.parent.parent.name);
  if (inKeyframes) return;
  // The token definitions themselves are allowed to hold literals.
  if (decl.parent.selector === ":root" || /^\[data-theme/.test(decl.parent.selector || "")) return;

  // 1. Radius must come from the shape scale.
  // The active-tab indicator is 3dp tall with a 3dp rounded top — the spec's own
  // number, and not a container, so the shape scale does not apply to it.
  const TAB_INDICATOR = "3px 3px 0 0";
  if (/^border(-[a-z]+)*-radius$/.test(prop) && !value.includes("--m3-shape")
      && value.trim() !== TAB_INDICATOR) {
    const px = [...value.matchAll(/(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    const bad = px.filter((n) => n > 0);
    if (bad.length && !value.includes("inherit") && !value.includes("%")) {
      findings.radius.push(`${where(decl)}${bad.every((n) => SHAPE[n]) ? "   -> --m3-shape-" + SHAPE[bad[0]] : ""}`);
    }
  }

  // 2. Shadow must come from an elevation token.
  if (prop === "box-shadow" && value !== "none" && !value.includes("--m3-elev")
      && !value.includes("inset")) {
    findings.shadow.push(where(decl));
  }

  // 3. Every transition names an easing token.
  if ((prop === "transition" || prop === "animation") && value !== "none") {
    if (!value.includes("--m3-ease") && !/steps\(/.test(value)) {
      findings.easing.push(where(decl));
    }
    if (!value.includes("--m3-dur") && /\d+m?s/.test(value)) {
      findings.easing.push(`${where(decl)}   (duration not a token)`);
    }
  }

  // 4. Font sizes name a type token.
  //
  // Checking only that the *value* is on the scale let `font-size: 11px` pass,
  // which is on the scale and still a literal — it cannot be retuned and it
  // does not say which role it is. The doc says the rule is the token; this is
  // now the rule the doc says.
  if (prop === "font-size" && !value.includes("--m3-font")) {
    const n = Number((value.match(/^(\d+(?:\.\d+)?)px$/) || [])[1]);
    if (n) findings.type.push(`${where(decl)}${TYPE.has(n) ? "   (on the scale, but not a token)" : ""}`);
  }

  // 5. Colours come from variables, so all three themes follow.
  if (/^(color|background|background-color|border-color|fill|stroke)$/.test(prop)) {
    const literal = value.match(/#[0-9a-f]{3,8}\b|\brgba?\([^)]*\)/i);
    if (literal && !value.includes("var(") && !/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,/.test(value)
        && value !== "transparent") {
      findings.colour.push(where(decl));
    }
  }

  // 6. Hit areas: buttons and text fields at least 40px.
  //
  // Deliberately not every control. M3 sizes a checkbox at 18dp, a switch track
  // at 32dp and a chip at 32dp, and the 40dp+ touch target for those comes from
  // the label or row wrapping them — flagging the box itself is flagging the
  // spec. Wrappers are checked below instead. Pseudo-elements are decoration
  // inside a control that has already been judged.
  if ((prop === "height" || prop === "min-height") && /^\d+px$/.test(value)) {
    const n = Number(value.replace("px", ""));
    const sel = decl.parent.selector || "";
    // A square control 24px or under is a checkbox, a radio or a switch handle
    // whatever the selector calls it — a text field is never square. Structural,
    // so it does not depend on the selector spelling out the input type.
    const square = (() => {
      let w = 0;
      decl.parent.walkDecls("width", (d) => {
        const px = Number((d.value.match(/^(\d+)px$/) || [])[1] || 0);
        if (px) w = px;
      });
      return w && w === n && n <= 24;
    })();
    const isBox = square
      || /input\[type="?(checkbox|radio)"?\]|::(before|after)|\.tk-chip/.test(sel);
    // Word-bounded on purpose. A bare /select/ also matches
    // `.ProseMirror-selectednode`, and a bare /input/ matches anything ending
    // in "input" — the same substring trap that once had prune_css keeping
    // `.btn` alive because `.tk-btn` contained it.
    const interactive =
      /\bbutton\b|\.tk-btn\b|\.tk-tab\b|\.tk-x\b|\binput\b|\bselect\b|\btextarea\b|\[role="button"\]/i
        .test(sel);
    if (interactive && !isBox && n < 40) {
      findings.hit.push(`${where(decl)}   (interactive, under 40px)`);
    }
  }

  // 6b. Anything wrapping a checkbox or radio has to be the touch target.
  if (/input\[type="?(checkbox|radio)"?\]/.test(decl.parent.selector || "")
      && (prop === "width" || prop === "height")) {
    // The wrapper is the token immediately *before* the checkbox, not the
    // first token of the selector. Taking the first blamed `.tk-md` — a whole
    // prose block, which was never going to be a 40px target — for a checkbox
    // nested four levels inside it.
    const parts = (decl.parent.selector || "").split(/\s+|\s*>\s*/).filter(Boolean);
    const at = parts.findIndex((p) => /input\[type="?(checkbox|radio)"?\]/.test(p));
    const wrapper = at > 0 ? parts[at - 1] : "";
    if (wrapper.startsWith(".")) wrappersToCheck.add(wrapper);
  }
});

// The second pass: every collected wrapper needs a height or min-height of 40+.
for (const wrapper of wrappersToCheck) {
  let floor = 0;
  root.walkRules((rule) => {
    if (rule.selector.trim() !== wrapper) return;
    rule.walkDecls(/^(min-)?height$/, (d) => {
      const n = Number((d.value.match(/^(\d+)px$/) || [])[1] || 0);
      if (n > floor) floor = n;
    });
  });
  if (floor < 40) {
    findings.hit.push(`${wrapper} { no 40px touch target around its checkbox }`);
  }
}

// A token that is used but never defined. Every other check here asks "did you
// reach for a token?" and answers yes for `var(--m3-font-title-small)` — which
// does not exist, silently falls back to whatever the browser felt like, and
// looks compliant in every report. Asking the second question costs one pass.
{
  const defined = new Set();
  root.walkDecls((d) => { if (d.prop.startsWith("--")) defined.add(d.prop); });
  root.walkDecls((d) => {
    for (const m of d.value.matchAll(/var\(\s*(--[\w-]+)\s*(,|\))/g)) {
      // Only ours: a bare `var(--x)` with no fallback and no definition is a
      // hole. One with a fallback is a deliberate choice and left alone.
      if (!m[1].startsWith("--m3-") && !m[1].startsWith("--tk-")) continue;
      if (m[2] === ",") continue;
      if (!defined.has(m[1])) findings.ghost.push(`${where(d)}  — ${m[1]} is never defined`);
    }
  });
}

const titles = {
  radius: "Radius not from the shape scale",
  shadow: "Shadow not from an elevation token",
  easing: "Transition without a motion token",
  type: "Font size off the type scale",
  colour: "Hard-coded colour (themes cannot follow it)",
  hit: "Hit area under the minimum",
  ghost: "Token used but never defined",
};

let total = 0;
for (const [key, list] of Object.entries(findings)) {
  const seen = [...new Set(list)];
  total += seen.length;
  console.log(`\n### ${titles[key]} — ${seen.length}`);
  seen.slice(0, 40).forEach((l) => console.log("  " + l));
  if (seen.length > 40) console.log(`  … and ${seen.length - 40} more`);
}
console.log(`\nTOTAL: ${total}`);
