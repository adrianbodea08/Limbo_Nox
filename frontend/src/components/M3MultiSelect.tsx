import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Face } from "./nox/Face";
import { placeMenu } from "./menupos";
import type { CSSProperties, ReactNode } from "react";

export interface M3MultiOption {
  value: string;
  label: string;
  /** Dimmer second line under the label. */
  hint?: string;
  /** A dot before the label — status colour, team colour. */
  colour?: string;
  /** A person's picture, when the option is a person. */
  avatar?: string | null;
  /** Draw a face even with no picture, from the label's initials. */
  person?: boolean;
}

interface Props {
  values: string[];
  options: M3MultiOption[];
  onChange: (values: string[]) => void;
  /** Shown when nothing is picked, which means "no filter". */
  placeholder?: string;
  /** What the field says once several are picked: "3 people". */
  noun?: string;
  icon?: ReactNode;
  width?: number;
  /** Below this many options the search box is more clutter than help. */
  searchFrom?: number;
}

// A multiple-choice M3 field with a search box, built to match M3Select — same
// outlined field, same portal-and-backdrop menu, same metrics — so the two sit
// side by side on a filter bar without a step between them.
//
// Nothing picked means no filter rather than "none of them". That is the useful
// default for a filter bar and the opposite of what a form control would do, so
// the field says "Anyone" rather than sitting empty.
export function M3MultiSelect({
  values, options, onChange, placeholder = "Any", noun = "selected",
  icon, width = 220, searchFrom = 7,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<CSSProperties>({});
  const btnRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const picked = useMemo(() => new Set(values), [values]);
  const showSearch = options.length >= searchFrom;

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      o.label.toLowerCase().includes(q) || (o.hint ?? "").toLowerCase().includes(q));
  }, [options, query]);

  useEffect(() => {
    if (open && showSearch) searchRef.current?.focus();
    if (!open) setQuery("");
  }, [open, showSearch]);

  function toggleOpen() {
    // Worked out at the moment of opening, which is the only moment the answer
    // is known — see menupos.ts for why this is not four lines here any more.
    if (!open && btnRef.current) {
      setPos(placeMenu(btnRef.current, { width, minWidth: width, tallest: 340, gap: 8 }));
    }
    setOpen((o) => !o);
  }

  function pick(value: string) {
    const next = new Set(picked);
    next.has(value) ? next.delete(value) : next.add(value);
    // Order follows the option list, not click order — a filter that reorders
    // itself as you tick things is disorienting to read back.
    onChange(options.filter((o) => next.has(o.value)).map((o) => o.value));
  }

  const label =
    values.length === 0 ? placeholder
      : values.length === 1
        ? options.find((o) => o.value === values[0])?.label ?? placeholder
        : `${values.length} ${noun}`;

  return (
    <div className="m3sel">
      <button
        ref={btnRef}
        type="button"
        className={`m3sel-field${values.length ? " m3ms-on" : ""}`}
        style={{ "--m3sel-w": `${width}px` } as CSSProperties}
        onClick={toggleOpen}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {icon && <span className="m3sel-lead">{icon}</span>}
        {values.length === 1 && options.find((o) => o.value === values[0])?.person && (
          <span className="m3sel-lead">
            <Face name={options.find((o) => o.value === values[0])!.label}
                  avatar={options.find((o) => o.value === values[0])!.avatar} size={20} />
          </span>
        )}
        <span className="m3sel-label">{label}</span>
        {values.length > 1 && <span className="m3ms-count">{values.length}</span>}
        <svg className="m3sel-caret" width="18" height="18" viewBox="0 -960 960 960"
             fill="currentColor" aria-hidden="true">
          <path d="M480-360 280-560h400L480-360Z" />
        </svg>
      </button>

      {open &&
        createPortal(
          <>
            <div className="m3sel-backdrop" onClick={() => setOpen(false)} />
            <div
              className="m3sel-pop m3ms-pop"
              role="listbox"
              aria-multiselectable="true"
              style={pos}
            >
              {showSearch && (
                <div className="m3ms-search">
                  <input
                    ref={searchRef}
                    value={query}
                    placeholder="Search…"
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setOpen(false);
                      // Enter takes the only remaining match, which is what
                      // typing three letters and pressing enter should do.
                      if (e.key === "Enter" && shown.length === 1) pick(shown[0].value);
                    }}
                  />
                </div>
              )}

              <div className="m3ms-list">
                {shown.map((o) => (
                  <button
                    type="button"
                    key={o.value}
                    role="option"
                    aria-selected={picked.has(o.value)}
                    className={`m3sel-item m3ms-item ${picked.has(o.value) ? "sel" : ""}`}
                    onClick={() => pick(o.value)}
                  >
                    <span className={`m3ms-box${picked.has(o.value) ? " on" : ""}`} aria-hidden="true" />
                    {o.person && <Face name={o.label} avatar={o.avatar} size={22} />}
                    {o.colour && <span className="m3ms-dot" style={{ background: o.colour }} />}
                    <span className="m3ms-text">
                      <span className="m3sel-item-label">{o.label}</span>
                      {o.hint && <span className="m3sel-item-hint">{o.hint}</span>}
                    </span>
                  </button>
                ))}
                {shown.length === 0 && <p className="m3ms-none">Nothing matches “{query}”.</p>}
              </div>

              <div className="m3ms-foot">
                <button type="button" className="m3ms-clear" disabled={!values.length}
                        onClick={() => onChange([])}>
                  Clear
                </button>
                <button type="button" className="m3ms-done" onClick={() => setOpen(false)}>
                  Done
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
