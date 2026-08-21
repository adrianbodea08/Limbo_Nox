import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

const POP_W = 312;
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

interface Props {
  /** "YYYY-MM-DD", or "" for no date. */
  value: string;
  onChange: (date: string) => void;
  placeholder?: string;
  /** Inclusive bounds, "YYYY-MM-DD". */
  min?: string;
  max?: string;
  width?: number;
  /** Offer a Clear button — a date that can be unset needs a way to unset it. */
  clearable?: boolean;
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// A Material-3 date picker, to replace <input type="date">.
//
// The native control paints the operating system's calendar: a different shape,
// a different set of colours and a different week start on every machine, in
// the middle of a dialog built to one design. It is also the only control in
// the app that ignores the theme.
//
// Metrics follow MonthPicker and M3Select, because these sit next to each other
// on the same rows. Weeks start on Monday.
export function M3DatePicker({
  value, onChange, placeholder = "Pick a date", min, max, width = 200, clearable = true,
}: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  const selected = value ? new Date(`${value}T00:00:00`) : null;
  const [cursor, setCursor] = useState(() => selected ?? new Date());
  const today = iso(new Date());

  const label = selected
    ? selected.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
    : placeholder;

  // Six weeks from the Monday on or before the 1st, so the grid never changes
  // height between months — a calendar that grows a row as you page through it
  // pushes everything under it about.
  const grid = useMemo(() => {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = new Date(first);
    const weekday = (first.getDay() + 6) % 7; // Monday = 0
    start.setDate(first.getDate() - weekday);
    return Array.from({ length: 42 }, (_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [cursor]);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      let left = r.left;
      if (left + POP_W > window.innerWidth - 8) left = Math.max(8, r.right - POP_W);
      // Flip above when there is no room below.
      const top = r.bottom + 8 + 360 > window.innerHeight ? Math.max(8, r.top - 368) : r.bottom + 8;
      setPos({ top, left });
      setCursor(selected ?? new Date());
    }
    setOpen((o) => !o);
  }

  function blocked(d: string): boolean {
    return (!!min && d < min) || (!!max && d > max);
  }

  function pick(d: Date) {
    const s = iso(d);
    if (blocked(s)) return;
    onChange(s);
    setOpen(false);
  }

  return (
    <div className="m3mp m3dp">
      <button ref={btnRef} type="button" className="m3mp-field" style={{ width }}
              onClick={toggle} aria-haspopup="dialog" aria-expanded={open}>
        <svg className="m3mp-cal" width="18" height="18" viewBox="0 -960 960 960"
             fill="currentColor" aria-hidden="true">
          <path d="M200-80q-33 0-56.5-23.5T120-160v-560q0-33 23.5-56.5T200-800h40v-40q0-17 11.5-28.5T280-880q17 0 28.5 11.5T320-840v40h320v-40q0-17 11.5-28.5T680-880q17 0 28.5 11.5T720-840v40h40q33 0 56.5 23.5T840-720v560q0 33-23.5 56.5T760-80H200Zm0-80h560v-400H200v400Zm0-480h560v-80H200v80Z" />
        </svg>
        <span className={`m3mp-label${value ? "" : " m3dp-empty"}`}>{label}</span>
        <svg className="m3mp-caret" width="18" height="18" viewBox="0 -960 960 960"
             fill="currentColor" aria-hidden="true">
          <path d="M480-360 280-560h400L480-360Z" />
        </svg>
      </button>

      {open &&
        createPortal(
          <>
            <div className="m3mp-backdrop" onClick={() => setOpen(false)} />
            <div
              className="m3mp-pop m3dp-pop"
              role="dialog"
              aria-label="Choose a date"
              style={{ position: "fixed", top: pos.top, left: pos.left, width: POP_W }}
              onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
            >
              <div className="m3mp-yearnav">
                <button type="button" className="m3mp-nav" aria-label="Previous month"
                        onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1))}>
                  ‹
                </button>
                <span className="m3mp-year">
                  {cursor.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}
                </span>
                <button type="button" className="m3mp-nav" aria-label="Next month"
                        onClick={() => setCursor(new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1))}>
                  ›
                </button>
              </div>

              <div className="m3dp-weekdays">
                {WEEKDAYS.map((d) => <span key={d}>{d}</span>)}
              </div>

              <div className="m3dp-grid">
                {grid.map((d) => {
                  const s = iso(d);
                  const outside = d.getMonth() !== cursor.getMonth();
                  const off = blocked(s);
                  return (
                    <button
                      key={s}
                      type="button"
                      disabled={off}
                      aria-current={s === today ? "date" : undefined}
                      aria-selected={s === value}
                      className={`m3dp-day${s === value ? " sel" : ""}${outside ? " out" : ""}${s === today ? " today" : ""}`}
                      onClick={() => pick(d)}
                    >
                      {d.getDate()}
                    </button>
                  );
                })}
              </div>

              <div className="m3dp-foot">
                {clearable && (
                  <button type="button" className="m3dp-action" disabled={!value}
                          onClick={() => { onChange(""); setOpen(false); }}>
                    Clear
                  </button>
                )}
                <button type="button" className="m3dp-action m3dp-today"
                        disabled={blocked(today)}
                        onClick={() => { onChange(today); setOpen(false); }}>
                  Today
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
