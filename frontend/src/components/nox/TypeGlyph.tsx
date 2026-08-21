// The mark an issue type wears, and the picker for choosing it.
//
// `issue_types.icon` used to hold a unicode character — ◆ ▣ ▢ ▲ ▼ ● ⬟ ◈ ▫ —
// which is text, and text renders at whatever weight and baseline the font
// decides, shifts when it falls back, and never looks drawn on purpose. It was
// the last place in the product still doing that after the chrome moved to
// Lucide.
//
// Plane solves the same problem with a `logo_props` JSON column holding either
// an emoji or a named icon plus a colour. The named-icon half is right and is
// what this is. The emoji half is deliberately skipped: an emoji is a different
// picture on every operating system, and the one thing a type marker has to do
// is look identical to everyone reading the same board.
//
// The column keeps its type. `icon` is still TEXT; it now holds `lucide:Bug`
// rather than `▲`, and anything that does not parse as `set:Name` still renders
// as the character it always was — so nothing breaks on the way across and a
// project that never updates its types keeps working.

import {
  Anchor, Beaker, BookOpen, Bookmark, Boxes, Bug, CircleDot, CircleHelp, Compass,
  CornerDownRight, Database, FileText, Flag, Flame, Gauge, Globe, Hammer, Heart,
  Layers, Lightbulb, ListTree, Megaphone, Microscope, Milestone, Package,
  Paintbrush, Palette, Plug, Puzzle, RefreshCw, Rocket, Route, Server,
  ShieldAlert, Siren, Smartphone, Sparkles, Split, SquareCheck, Star, Target,
  TestTube, Timer, Trash2, TrendingUp, TriangleAlert, Wrench, Zap,
} from "lucide-react";
import { useState } from "react";

/** The set a type may choose from.
 *
 *  Curated rather than the whole of Lucide — six thousand icons cannot be
 *  imported without abandoning tree-shaking, and a picker with six thousand
 *  entries is a search box, not a decision. These are the ones a tracker's
 *  types are actually about. Adding one is a line here and nothing else. */
export const GLYPHS = {
  Layers, Bookmark, SquareCheck, Bug, TriangleAlert, Siren, Flame, Zap,
  Puzzle, CornerDownRight, ListTree, BookOpen, Rocket, Wrench, ShieldAlert,
  Gauge, Palette, Microscope, CircleHelp, Megaphone, FileText, Beaker,
  Sparkles, CircleDot, Target, Milestone, Hammer, Database, Server, Globe,
  Smartphone, Paintbrush, TestTube, Timer, TrendingUp, Trash2, RefreshCw,
  Plug, Package, Boxes, Lightbulb, Compass, Flag, Star, Heart, Anchor,
  Route, Split,
} as const;

export type GlyphName = keyof typeof GLYPHS;

/** `lucide:Bug` → the component. Anything else → null, and the caller draws
 *  the string as the character it is. */
export function resolve(icon: string): (typeof GLYPHS)[GlyphName] | null {
  if (!icon?.startsWith("lucide:")) return null;
  return GLYPHS[icon.slice(7) as GlyphName] ?? null;
}

/** One type's mark, wherever it appears.
 *
 *  `size` is the icon's, and the box around it stays 16px so a row of labels
 *  lines up whether the mark is drawn or is a leftover character. */
export function TypeGlyph({
  icon, colour, size = 14, title,
}: {
  icon: string;
  colour?: string;
  size?: number;
  title?: string;
}) {
  const Icon = resolve(icon);
  return (
    <span className="tk-type" style={colour ? { color: colour } : undefined} title={title}>
      {Icon ? <Icon size={size} aria-hidden /> : icon}
    </span>
  );
}

/** Choosing one. A grid, not a dropdown — picking a picture is a job the eye
 *  does in one pass and a list of names makes into a reading exercise. */
export function GlyphPicker({
  value, colour, onPick,
}: {
  value: string;
  colour?: string;
  onPick: (icon: string) => void;
}) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const names = (Object.keys(GLYPHS) as GlyphName[])
    .filter((n) => !term || n.toLowerCase().includes(term));

  return (
    <div className="tkg-pick">
      <input
        className="tk-input tkg-pick-search"
        value={query}
        placeholder="Search marks…"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="tkg-pick-grid">
        {names.map((name) => {
          const Icon = GLYPHS[name];
          const on = value === `lucide:${name}`;
          return (
            <button
              key={name}
              type="button"
              className={`tkg-pick-cell tk-layer${on ? " on" : ""}`}
              title={name}
              aria-label={name}
              aria-pressed={on}
              style={on && colour ? { color: colour } : undefined}
              onClick={() => onPick(`lucide:${name}`)}
            >
              <Icon size={18} aria-hidden />
            </button>
          );
        })}
        {!names.length && <p className="tk-dim tkg-pick-none">No mark called “{query}”.</p>}
      </div>
    </div>
  );
}
