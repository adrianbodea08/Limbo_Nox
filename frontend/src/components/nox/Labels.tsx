// Labels — the axis nothing else covers.
//
// Type says what kind of work it is, status where it has got to, component
// which part of the system, parent what it belongs to. None of them can say
// "flaky", "needs-design" or "good-first-issue".
//
// **Made by using them.** There is no create screen: you type a word and it
// exists, and if somebody typed it before you get theirs. An admin curating the
// list before anybody may tag anything is how a tag system ends up with eleven
// labels nobody uses and the actual words living in the summary.

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { trackerApi } from "./model";
import type { Label } from "./model";

/** Read-only, for a board card or a row.
 *
 *  `className` replaces the wrapper's, rather than adding to it, because the
 *  board card wants a different *layout* for these — a strip down its edge
 *  rather than a row in its flow — and inheriting `.tk-labels`' flex row would
 *  mean overriding half of it back. The chips inside are the same either way. */
export function LabelChips({
  labels, slots, className = "tk-labels",
}: {
  labels: Label[];
  /** The most chips to draw, **counting the `+N`**. Three slots and four
   *  labels is two labels and a `+2`, not three and a `+1` — the caller is
   *  bounding how much room this takes, and a `+N` takes exactly as much room
   *  as a label does. `max` used to mean "labels before the +N", which made
   *  the total one more than whatever was asked for. */
  slots?: number;
  className?: string;
}) {
  if (!labels?.length) return null;
  const over = slots !== undefined && labels.length > slots;
  const shown = over ? labels.slice(0, slots - 1) : labels;
  const hidden = labels.length - shown.length;
  return (
    <span className={className}>
      {shown.map((l) => (
        <span key={l.id} className="tk-label" title={l.name}
              style={{ "--label": l.colour } as React.CSSProperties}>
          {l.name}
        </span>
      ))}
      {/* Never a silent trim — the card says there are more. */}
      {hidden > 0 && <span className="tk-label tk-label-more">+{hidden}</span>}
    </span>
  );
}

/** On the issue: the chips, each removable, and a box to type a new one. */
export function LabelEditor({
  issueId, labels, onChanged,
}: {
  issueId: number;
  labels: Label[];
  onChanged: (next: Label[]) => void;
}) {
  const [typing, setTyping] = useState("");
  const [all, setAll] = useState<Label[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const typer = useRef<HTMLInputElement>(null);

  useEffect(() => {
    trackerApi.labels().then(setAll).catch(() => {});
  }, [labels.length]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const worn = new Set(labels.map((l) => l.id));
  const term = typing.trim().toLowerCase();
  // Commonest first, which is how the list arrives — the ranking that means
  // something for a box people type into.
  const suggestions = all
    .filter((l) => !worn.has(l.id) && (!term || l.key.includes(term) || l.name.toLowerCase().includes(term)))
    .slice(0, 8);
  // Only offer to make one when nothing already matches what was typed.
  const isNew = term && !all.some((l) => l.key === term.replace(/[^a-z0-9]+/g, "-"));

  async function act(what: () => Promise<Label[]>) {
    setBusy(true);
    setError("");
    try {
      onChanged(await what());
      setTyping("");
      setOpen(false);
      // Adding one label is usually adding two. The change re-renders the
      // issue around this field, which drops focus to the body — put it back,
      // or the second label means reaching for the mouse again.
      requestAnimationFrame(() => typer.current?.focus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tk-label-edit" ref={box}>
      <div className="tk-labels">
        {labels.map((l) => (
          <span key={l.id} className="tk-label tk-label-on"
                style={{ "--label": l.colour } as React.CSSProperties}>
            {l.name}
            <button
              type="button"
              className="tk-label-x"
              disabled={busy}
              title={`Take ${l.name} off`}
              aria-label={`Take ${l.name} off`}
              onClick={() => act(() => trackerApi.removeLabel(issueId, l.id))}
            >
              <X size={12} aria-hidden />
            </button>
          </span>
        ))}

        <input
          ref={typer}
          className="tk-label-input"
          value={typing}
          placeholder={labels.length ? "Add…" : "Add a label…"}
          disabled={busy}
          onFocus={() => setOpen(true)}
          onChange={(e) => { setTyping(e.target.value); setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && term) {
              e.preventDefault();
              act(() => trackerApi.addLabel(issueId, typing.trim()));
            }
            if (e.key === "Escape") { setOpen(false); setTyping(""); }
            // Backspace on an empty box takes the last one off, which is what
            // every other chip input in the world does.
            if (e.key === "Backspace" && !typing && labels.length) {
              act(() => trackerApi.removeLabel(issueId, labels[labels.length - 1].id));
            }
          }}
        />
      </div>

      {error && <p className="tk-error tk-label-err">{error}</p>}

      {open && (suggestions.length > 0 || isNew) && (
        <div className="tk-label-pop">
          {suggestions.map((l) => (
            <button key={l.id} type="button" className="tk-label-opt tk-layer"
                    onClick={() => act(() => trackerApi.addLabel(issueId, l.name))}>
              <span className="tk-label-dot" style={{ background: l.colour }} />
              <span className="tk-label-opt-name">{l.name}</span>
              <span className="tk-dim">{l.count}</span>
            </button>
          ))}
          {isNew && (
            <button type="button" className="tk-label-opt tk-layer tk-label-new"
                    onClick={() => act(() => trackerApi.addLabel(issueId, typing.trim()))}>
              Make <strong>{typing.trim()}</strong>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default LabelEditor;
