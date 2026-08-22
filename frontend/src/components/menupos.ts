// Where a menu goes, once, for every menu in the app.
//
// Six components opened a panel next to something and each worked out the
// position itself. They agreed on the easy half — flip left when the menu
// would run off the right edge — and disagreed on everything else: two of them
// (the issue card's, the date picker's) also flipped *upwards* and capped the
// height to the room actually available, and four did not. A menu opened from
// a control near the bottom of a phone screen therefore ran off the bottom of
// the window, and because these are `position: fixed`, nothing could scroll to
// reach it. The saved-views menu, which had no vertical handling at all, is the
// one people met first: it hangs off a bar that is halfway down the page.
//
// This is the issue card's version, which was the one that had thought about
// it, made general and moved out. It is deliberately a plain function over a
// DOMRect and `window` rather than a hook: it is called in an event handler at
// the moment of opening, which is the only moment the answer is known.

import type { CSSProperties } from "react";

/** Never let a menu touch the edge of the window. */
const EDGE = 8;

export interface MenuOptions {
  /** How wide. A number is that many pixels; "trigger" matches the control it
   *  hangs from. Either way the window wins — a 460px search menu on a 375px
   *  phone is 359px. */
  width?: number | "trigger";
  /** A floor, applied after `width`. For menus that must stay readable even
   *  when the control they belong to is a small chip. */
  minWidth?: number;
  /** A ceiling. Giving one makes the menu *elastic*: it is emitted as a
   *  min-width and a max-width rather than a width, so the content picks
   *  somewhere between the two. Without one the menu is exactly `width`. */
  maxWidth?: number;
  /** The tallest it may be with all the room in the world. */
  tallest?: number;
  /** Between the trigger and the menu. */
  gap?: number;
}

/** Positions for a `position: fixed` menu, as a style object to spread.
 *
 *  Anchored by `top` when it opens downwards and by `bottom` when it opens up,
 *  so a menu that grows — a list that finishes loading, a filter being typed
 *  into — grows away from its trigger rather than walking over it. */
export function placeMenu(trigger: Element, options: MenuOptions = {}): CSSProperties {
  const { width = "trigger", minWidth, maxWidth, tallest = 320, gap = 6 } = options;
  const r = trigger.getBoundingClientRect();

  const room = window.innerWidth - EDGE * 2;
  let w = width === "trigger" ? r.width : width;
  if (minWidth !== undefined) w = Math.max(w, minWidth);
  w = Math.min(w, room);

  // An elastic menu can end up anywhere between its two bounds, so the edge is
  // worked out from the widest it could be. Guessing with the minimum would
  // leave a menu that grew into the content hanging off the screen.
  const widest = maxWidth === undefined ? w : Math.min(maxWidth, room);
  // Prefer the trigger's left edge; hang off its right when that would
  // overflow; and never let either answer push the menu off the other side.
  const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - widest - EDGE));

  const below = window.innerHeight - r.bottom - EDGE - gap;
  const above = r.top - EDGE - gap;
  // Flip only when below is genuinely cramped *and* above is roomier. A menu
  // that flips for the sake of twenty more pixels is a menu that jumps around.
  const flip = below < 200 && above > below;

  return {
    position: "fixed",
    left,
    ...(maxWidth === undefined
      ? { width: w }
      : { minWidth: w, maxWidth: widest }),
    ...(flip
      ? { bottom: window.innerHeight - r.top + gap }
      : { top: r.bottom + gap }),
    // Whatever is actually left, so a menu near an edge scrolls inside itself
    // instead of running off the screen. The floor stops it collapsing to a
    // sliver in a very short window — better a menu that overhangs slightly
    // than one with two visible rows.
    maxHeight: Math.min(tallest, Math.max(120, flip ? above : below)),
  };
}
