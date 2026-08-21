// @-mentions, with Tab to complete.
//
// Naming somebody is the one thing people type that has to be *exactly* right:
// `notify.find_mentions` matches the text against real display names, so
// "@Ana" reaches Ana and "@ana m" reaches nobody. Asking a person to spell a
// colleague's name correctly from memory, in a box with no feedback, is asking
// them to fail quietly — the notification simply never arrives, and nobody
// finds out until the thing they were waiting on did not happen.
//
// So the box completes it. Type `@`, keep typing, press Tab. The name that goes
// in is the one the server will match, because it came from the same list.

import { createPortal } from "react-dom";
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState,
} from "react";
import type { TextareaHTMLAttributes } from "react";
import { Face } from "./Face";
import type { TrackerUser } from "./model";

/** `@` at a word boundary, then a name — one space allowed, because these are
 *  people's real two-word names and `notify.MENTION` matches two words too. */
const AT = /(?:^|[\s(\[{,;:"'])@([\p{L}\p{N}'.-]*(?:[ ][\p{L}\p{N}'.-]*)?)$/u;

/** Enough to choose from, few enough to read without scrolling. */
const MOST = 6;

interface Spot {
  /** Where the `@` is, so completing replaces the whole fragment. */
  from: number;
  query: string;
}

function spotAt(value: string, caret: number): Spot | null {
  const found = AT.exec(value.slice(0, caret));
  if (!found) return null;
  return { query: found[1], from: caret - found[1].length - 1 };
}

// Every property that changes where a glyph lands. Miss one and the popover
// sits a few pixels off — which reads as a bug even though the completion
// itself is right.
const MIRRORED = [
  "box-sizing", "width", "padding-top", "padding-right", "padding-bottom",
  "padding-left", "border-top-width", "border-right-width",
  "border-bottom-width", "border-left-width", "font-family", "font-size",
  "font-weight", "font-style", "font-variant", "letter-spacing", "line-height",
  "text-transform", "text-indent", "word-spacing", "tab-size",
];

/** Where the caret is on screen.
 *
 *  A textarea will not tell you, so the text is laid out a second time in a
 *  hidden div built from the same metrics and the marker's position is read off
 *  that. The usual trick, and the only one that works. */
function caretPoint(ta: HTMLTextAreaElement) {
  const style = window.getComputedStyle(ta);
  const mirror = document.createElement("div");
  for (const p of MIRRORED) mirror.style.setProperty(p, style.getPropertyValue(p));
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.textContent = ta.value.slice(0, ta.selectionStart);
  const mark = document.createElement("span");
  // Something with height, or an empty span measures as a zero-height box.
  mark.textContent = ta.value.slice(ta.selectionStart) || ".";
  mirror.appendChild(mark);
  document.body.appendChild(mirror);
  const box = ta.getBoundingClientRect();
  const point = {
    left: box.left + mark.offsetLeft - ta.scrollLeft,
    top: box.top + mark.offsetTop - ta.scrollTop,
    line: parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4,
  };
  document.body.removeChild(mirror);
  return point;
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> & {
  value: string;
  onChange: (value: string) => void;
  /** Who can be named. Usually the workspace; inactive people are dropped. */
  people: TrackerUser[];
};

/** A textarea that completes `@names`. Everything else passes through, so it
 *  drops in wherever a plain one was. */
export const MentionBox = forwardRef<HTMLTextAreaElement, Props>(function MentionBox(
  { value, onChange, people, onKeyDown, onBlur, ...rest }, outer,
) {
  const ta = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(outer, () => ta.current as HTMLTextAreaElement, []);

  const [spot, setSpot] = useState<Spot | null>(null);
  // What the last look found, readable without making `look` depend on it —
  // it is called from a document-level listener that must not be re-bound on
  // every keystroke.
  const seen = useRef<Spot | null>(null);
  const [at, setAt] = useState({ left: 0, top: 0, line: 18 });
  const [pick, setPick] = useState(0);

  const matches = useMemo(() => {
    if (!spot) return [];
    const q = spot.query.trim().toLowerCase();
    const ranked: { who: TrackerUser; rank: number }[] = [];
    for (const who of people) {
      if (who.active === false) continue;
      const name = (who.display_name || "").toLowerCase();
      if (!q) { ranked.push({ who, rank: 0 }); continue; }
      // Whole name first, then any word of it, then anywhere. Somebody typing
      // "mi" means Mihalache far more often than they mean Du-mi-tru.
      if (name.startsWith(q)) ranked.push({ who, rank: 0 });
      else if (name.split(" ").some((w) => w.startsWith(q))) ranked.push({ who, rank: 1 });
      else if (name.includes(q)) ranked.push({ who, rank: 2 });
    }
    ranked.sort((a, b) => a.rank - b.rank
      || a.who.display_name.localeCompare(b.who.display_name));
    return ranked.slice(0, MOST).map((r) => r.who);
  }, [spot, people]);

  const open = !!spot && matches.length > 0;

  const look = useCallback(() => {
    const box = ta.current;
    if (!box) return;
    const next = spotAt(box.value, box.selectionStart ?? 0);
    const was = seen.current;
    if (!next) {
      seen.current = null;
      setSpot(null);
      return;
    }
    // Same fragment as last time means the same list, so leave the highlight
    // where the arrow keys put it — and skip re-measuring the caret, which is
    // a DOM write and a read on every keystroke otherwise.
    if (was && was.from === next.from && was.query === next.query) return;
    seen.current = next;
    setSpot(next);
    setAt(caretPoint(box));
    setPick(0);
  }, []);

  // The caret moves for reasons other than typing — arrows, clicks, undo — and
  // the list has to agree with where it actually is.
  useEffect(() => {
    const box = ta.current;
    if (!box) return;
    const owner = box.ownerDocument;
    const onlyMine = () => { if (owner.activeElement === box) look(); };
    owner.addEventListener("selectionchange", onlyMine);
    return () => owner.removeEventListener("selectionchange", onlyMine);
  }, [look]);

  function complete(who: TrackerUser) {
    const box = ta.current;
    if (!box || !spot) return;
    const caret = box.selectionStart ?? 0;
    const head = value.slice(0, spot.from);
    const tail = value.slice(caret);
    // A trailing space, unless there already is one — you are almost never
    // finished after a name, and a second space is the sort of thing people
    // delete by hand every single time.
    const gap = tail.startsWith(" ") ? "" : " ";
    onChange(head + "@" + who.display_name + gap + tail);
    const land = head.length + 1 + who.display_name.length + gap.length;
    seen.current = null;
    setSpot(null);
    requestAnimationFrame(() => {
      box.focus();
      box.setSelectionRange(land, land);
    });
  }

  return (
    <>
      <textarea
        {...rest}
        ref={ta}
        value={value}
        // Announced as a combobox, so a screen reader is told there is a list
        // here rather than having text silently completed under it.
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        aria-controls={open ? "tk-mention-list" : undefined}
        onChange={(e) => onChange(e.target.value)}
        onClick={look}
        onKeyUp={look}
        onBlur={(e) => { seen.current = null; setSpot(null); onBlur?.(e); }}
        onKeyDown={(e) => {
          if (open) {
            // Only while the list is up. Tab has a job in every other state and
            // taking it away is worse than having no completion at all.
            if (e.key === "Tab" || e.key === "Enter") {
              e.preventDefault();
              complete(matches[pick]);
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setPick((i) =>
                (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
              return;
            }
            if (e.key === "Escape") {
              // Dismiss the list, keep the dialog. Escape here means "not
              // that", not "throw away what I was writing".
              e.preventDefault();
              e.stopPropagation();
              seen.current = null;
              setSpot(null);
              return;
            }
          }
          onKeyDown?.(e);
        }}
      />

      {/* Portalled: these boxes live inside scrolling dialogs, and a popover
          that scrolls away from its own caret is worse than none. */}
      {open && createPortal(
        <ul
          id="tk-mention-list"
          className="tk-mention"
          role="listbox"
          style={{
            left: Math.min(at.left, window.innerWidth - 250),
            top: at.top + at.line + 4,
          }}
        >
          {matches.map((who, i) => (
            <li key={who.id} role="option" aria-selected={i === pick}>
              <button
                type="button"
                className={`tk-mention-opt tk-layer${i === pick ? " on" : ""}`}
                // mousedown, not click: the textarea blurs on mousedown and the
                // list would be gone before a click ever landed.
                onMouseDown={(e) => { e.preventDefault(); complete(who); }}
                onMouseEnter={() => setPick(i)}
              >
                <Face size={22} name={who.display_name} avatar={who.avatar} />
                <span className="tk-mention-name">{who.display_name}</span>
                {who.craft && <span className="tk-dim tk-mention-craft">{who.craft}</span>}
              </button>
            </li>
          ))}
          <li className="tk-mention-hint tk-dim">Tab to insert</li>
        </ul>,
        document.body,
      )}
    </>
  );
});

export default MentionBox;
