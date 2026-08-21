import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Face } from "./nox/Face";

export interface M3Option {
  value: string;
  label: string;
  /** Dimmer second line under the label. */
  hint?: string;
  /** A person's picture, when the option is a person. */
  avatar?: string | null;
  /** Draw a face even with no picture, from the label's initials. */
  person?: boolean;
}

interface Props {
  value: string;
  options: M3Option[];
  onChange: (value: string) => void;
  /** Leading icon, drawn like the month picker's calendar. */
  icon?: ReactNode;
  placeholder?: string;
  width?: number;
}

// A Material-3 dropdown built to match MonthPicker: the same outlined field,
// the same portal-and-backdrop menu. The native <select> was the odd one out on
// this bar — it drew the platform arrow hard against its own border.
export function M3Select({ value, options, onChange, icon, placeholder = "Select…", width = 260 }: Props) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width });
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = options.find((o) => o.value === value);

  function toggle() {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      const w = Math.max(r.width, width);
      // Flip left if the menu would run off the right edge.
      const left = r.left + w > window.innerWidth - 8 ? Math.max(8, r.right - w) : r.left;
      setPos({ top: r.bottom + 8, left, width: w });
    }
    setOpen((o) => !o);
  }

  return (
    <div className="m3sel">
      <button
        ref={btnRef}
        type="button"
        className="m3sel-field"
        style={{ width }}
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {icon && <span className="m3sel-lead">{icon}</span>}
        {current?.person && (
          <span className="m3sel-lead"><Face name={current.label} avatar={current.avatar} size={20} /></span>
        )}
        <span className="m3sel-label">{current?.label ?? placeholder}</span>
        <svg className="m3sel-caret" width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
          <path d="M480-360 280-560h400L480-360Z" />
        </svg>
      </button>

      {open &&
        createPortal(
          <>
            <div className="m3sel-backdrop" onClick={() => setOpen(false)} />
            <div
              className="m3sel-pop"
              role="listbox"
              style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}
            >
              {options.map((o) => (
                <button
                  type="button"
                  key={o.value}
                  role="option"
                  aria-selected={o.value === value}
                  className={`m3sel-item ${o.value === value ? "sel" : ""}`}
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                >
                  {o.person && (
                    <span className="m3sel-item-face">
                      <Face name={o.label} avatar={o.avatar} size={22} />
                    </span>
                  )}
                  <span className="m3sel-item-text">
                    <span className="m3sel-item-label">{o.label}</span>
                    {o.hint && <span className="m3sel-item-hint">{o.hint}</span>}
                  </span>
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </div>
  );
}
