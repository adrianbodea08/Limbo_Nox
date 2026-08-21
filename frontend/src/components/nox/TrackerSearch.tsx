// One search box, in the header, on every tracker page.
//
// Global on purpose. A search that only looks at the board you happen to be
// standing on is a search you have to be in the right place to use, and the
// times you need it most are the times you do not know where the thing is.
//
// It matches summary, description and comments. Comments are the ones that make
// the difference: half of what anybody remembers about an issue — the error
// string, the customer's name, "the one where staging fell over" — was said
// underneath it rather than in its title. So each result says where it matched
// and shows that line, because a result whose title looks unrelated otherwise
// reads as a bug in the search.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { trackerApi, type SearchHit } from "./model";
import { X } from "lucide-react";

const DEBOUNCE_MS = 180;

export function TrackerSearch() {
  const nav = useNavigate();
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 420 });
  const fieldRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ready = term.trim().length >= 2;

  function place() {
    const r = fieldRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, 460);
    // Flip left rather than run off the edge — the field sits mid-header and
    // the menu is wider than it.
    const left = r.left + width > window.innerWidth - 12
      ? Math.max(12, r.right - width) : r.left;
    setPos({ top: r.bottom + 8, left, width });
  }

  // Debounced: typing "checkout" should be one request, not eight.
  useEffect(() => {
    if (!ready) { setHits([]); setBusy(false); return; }
    setBusy(true);
    const timer = window.setTimeout(async () => {
      try {
        const found = await trackerApi.searchEverything(term);
        setHits(found);
        setCursor(0);
        place();
      } catch {
        setHits([]);
      } finally {
        setBusy(false);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, ready]);

  // "/" from anywhere lands here, the way it does in every tool people already
  // use — but not while they are typing into something else.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const typing = !!target?.closest("input, textarea, [contenteditable=true]");
      const hotkey = e.key === "/" || (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey));
      if (!hotkey || (typing && e.key === "/")) return;
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = useCallback((hit: SearchHit) => {
    setOpen(false);
    setTerm("");
    nav(`/issue/${hit.key}`);
  }, [nav]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); return; }
    if (!open || !hits.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => (c + 1) % hits.length); }
    if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => (c - 1 + hits.length) % hits.length); }
    if (e.key === "Enter") { e.preventDefault(); go(hits[cursor]); }
  }

  const showing = open && ready;

  return (
    <div className="tkf-wrap" ref={fieldRef}>
      {/* M3 search bar: full-round, leading icon, filled surface. */}
      <div className={`tkf-bar${showing ? " tkf-bar-open" : ""}`}>
        <svg className="tkf-icon" width="20" height="20" viewBox="0 -960 960 960"
             fill="currentColor" aria-hidden="true">
          <path d="M784-120 532-372q-30 24-69 38t-83 14q-109 0-184.5-75.5T120-580q0-109 75.5-184.5T380-840q109 0 184.5 75.5T640-580q0 44-14 83t-38 69l252 252-56 56ZM380-420q67 0 113.5-46.5T540-580q0-67-46.5-113.5T380-740q-67 0-113.5 46.5T220-580q0 67 46.5 113.5T380-420Z" />
        </svg>
        <input
          ref={inputRef}
          className="tkf-input"
          type="search"
          value={term}
          placeholder="Search everything…"
          aria-label="Search every issue, description and comment"
          onChange={(e) => { setTerm(e.target.value); setOpen(true); place(); }}
          onFocus={() => { setOpen(true); place(); }}
          onKeyDown={onKeyDown}
        />
        {term && (
          <button type="button" className="tkf-clear" title="Clear"
                  onClick={() => { setTerm(""); inputRef.current?.focus(); }}><X size={16} aria-hidden /></button>
        )}
      </div>

      {showing && createPortal(
        <>
          <div className="m3sel-backdrop" onClick={() => setOpen(false)} />
          <div className="tkf-pop" role="listbox"
               style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}>
            {busy && !hits.length && <p className="tkf-note">Searching…</p>}
            {!busy && !hits.length && (
              <p className="tkf-note">Nothing matches “{term.trim()}”.</p>
            )}

            {hits.map((hit, i) => (
              <button
                key={hit.id}
                type="button"
                role="option"
                aria-selected={i === cursor}
                className={`tkf-hit${i === cursor ? " on" : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => go(hit)}
              >
                <span className="tkf-hit-top">
                  <span className="tk-type" style={{ color: hit.type_colour }}>{hit.type_icon}</span>
                  <span className="tkf-hit-key">{hit.key}</span>
                  <span className="tkf-hit-sum">{hit.summary}</span>
                  <span className="tk-chip"
                        style={{ borderColor: hit.status_colour, color: hit.status_colour }}>
                    {hit.status_name}
                  </span>
                </span>
                {hit.matched && (
                  <span className="tkf-hit-why">
                    <span className="tkf-hit-where">in {hit.matched.where}</span>
                    <span className="tkf-hit-text">{hit.matched.text}</span>
                  </span>
                )}
              </button>
            ))}

            {hits.length > 0 && (
              <p className="tkf-foot">
                Summary, description and comments · ↑↓ to move, ↵ to open
              </p>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}
