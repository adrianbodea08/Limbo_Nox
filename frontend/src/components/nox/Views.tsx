// Saved views — the board bar, kept.
//
// The filters on this bar were built fresh every morning and thrown away every
// evening. The `views` table has been in the schema since the first migration,
// seeded and returned in `/meta`, and nothing had ever read it. This is that
// wiring, plus the one decision the table left open: a view is **yours** until
// you say otherwise.
//
// A view is the whole arrangement — Columns or Table or List, the grouping, the
// sort, and what to show. "My view" means how I like to look at this, and
// remembering half of it would leave the board rearranged under somebody who
// picked one.

import { Check, ChevronDown, Pencil, Plus, Share2, Trash2, Users } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { placeMenu } from "../menupos";
import { createPortal } from "react-dom";
import type { SavedView } from "./model";

interface Props {
  views: SavedView[];
  /** Which one the board is currently showing, if any. */
  current: SavedView | null;
  /** Whether the board has drifted from it — or from nothing, if none is
   *  picked and filters are set. */
  changed: boolean;
  busy?: boolean;
  onPick: (view: SavedView | null) => void;
  onCreate: (name: string) => void;
  onUpdate: (view: SavedView) => void;
  onRename: (view: SavedView, name: string) => void;
  onShare: (view: SavedView, shared: boolean) => void;
  onDelete: (view: SavedView) => void;
}

export function ViewBar({
  views, current, changed, busy, onPick, onCreate, onUpdate, onRename, onShare, onDelete,
}: Props) {
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [at, setAt] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".tkv-menu, .tkv-trigger")) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  /** Width has to match the stylesheet's `min-width`, because the menu is
   *  measured before it exists. */
  const MENU_W = 300;

  function show() {
    // This flipped sideways and not upwards, which was fine on the desk and
    // not on a phone: the bar it hangs from is a third of the way down a
    // 812px screen, and a list of a dozen views ran straight off the bottom
    // of a window that cannot be scrolled to reach it.
    // Both bounds, matching the stylesheet, so the menu stays elastic.
    if (trigger.current) setAt(placeMenu(trigger.current, { width: MENU_W, maxWidth: 380 }));
    setOpen((o) => !o);
  }

  const mine = views.filter((v) => v.mine);
  const theirs = views.filter((v) => !v.mine);

  function make() {
    const wanted = name.trim();
    if (!wanted) return;
    onCreate(wanted);
    setName("");
    setNaming(false);
    setOpen(false);
  }

  return (
    <div className="tkv">
      <button
        ref={trigger}
        type="button"
        className="tkv-trigger tk-layer"
        aria-expanded={open}
        onClick={show}
      >
        <span className="tkv-name">{current?.name ?? "All issues"}</span>
        {/* Says the board no longer matches the view whose name is showing.
            Without it the name is a small lie the moment you touch a filter. */}
        {changed && <span className="tkv-changed" title="Not saved">•</span>}
        <ChevronDown size={15} aria-hidden />
      </button>

      {/* Only when there is something to save. A button that is usually
          disabled teaches people to stop looking at it. */}
      {changed && (
        current?.mine ? (
          <button type="button" className="tk-link tk-layer tkv-act" disabled={busy}
                  title={`Save these changes to “${current.name}”`}
                  onClick={() => onUpdate(current)}>
            Save changes
          </button>
        ) : (
          <button type="button" className="tk-link tk-layer tkv-act" disabled={busy}
                  onClick={() => { setNaming(true); show(); }}>
            Save as view
          </button>
        )
      )}

      {open && createPortal(
        <div className="tkv-menu" style={at} role="menu">
          <button type="button" className="tkv-row tk-layer"
                  onClick={() => { onPick(null); setOpen(false); }}>
            <span className="tkv-tick">{!current && <Check size={14} aria-hidden />}</span>
            <span className="tkv-row-name">All issues</span>
            <span className="tk-dim tkv-hint">no filter</span>
          </button>

          {!!mine.length && <p className="tkv-head">Yours</p>}
          {mine.map((v) => (
            <Row key={v.id} view={v} on={current?.id === v.id} busy={busy}
                 onPick={() => { onPick(v); setOpen(false); }}
                 onRename={onRename} onShare={onShare} onDelete={onDelete} />
          ))}

          {!!theirs.length && <p className="tkv-head">The team’s</p>}
          {theirs.map((v) => (
            <Row key={v.id} view={v} on={current?.id === v.id} busy={busy}
                 onPick={() => { onPick(v); setOpen(false); }}
                 onRename={onRename} onShare={onShare} onDelete={onDelete} />
          ))}

          <div className="tkv-foot">
            {naming ? (
              <div className="tkv-naming">
                <input
                  className="tkv-input"
                  autoFocus
                  value={name}
                  placeholder="Name this view…"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); make(); }
                    if (e.key === "Escape") { e.stopPropagation(); setNaming(false); }
                  }}
                />
                <button type="button" className="tk-btn tk-layer tk-btn-primary"
                        disabled={!name.trim() || busy} onClick={make}>
                  Save
                </button>
              </div>
            ) : (
              <button type="button" className="tkv-row tk-layer" onClick={() => setNaming(true)}>
                <span className="tkv-tick"><Plus size={14} aria-hidden /></span>
                <span className="tkv-row-name">Save the board as a view</span>
              </button>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

function Row({
  view, on, busy, onPick, onRename, onShare, onDelete,
}: {
  view: SavedView;
  on: boolean;
  busy?: boolean;
  onPick: () => void;
  onRename: (v: SavedView, name: string) => void;
  onShare: (v: SavedView, shared: boolean) => void;
  onDelete: (v: SavedView) => void;
}) {
  return (
    <div className={`tkv-line${on ? " on" : ""}`}>
      <button type="button" className="tkv-row tk-layer" onClick={onPick}>
        <span className="tkv-tick">{on && <Check size={14} aria-hidden />}</span>
        <span className="tkv-row-name">{view.name}</span>
        {/* Whose it is, when it is not yours. A shared view behaving oddly is
            somebody's opinion, and knowing whose is how you go and ask. */}
        {!view.mine && view.owner_name && (
          <span className="tk-dim tkv-hint">{view.owner_name}</span>
        )}
        {view.mine && view.shared && (
          <Users size={13} aria-hidden className="tkv-shared" />
        )}
      </button>

      {/* Only your own can be changed from here. Somebody else's shared view is
          theirs to edit, and an admin who needs to tidy one can do it where the
          rest of the admin lives. */}
      {view.mine && (
        <span className="tkv-tools">
          <button type="button" className="tkv-tool tk-layer" disabled={busy}
                  title={view.shared ? "Make it private again" : "Share with the team"}
                  aria-label={view.shared ? "Make it private again" : "Share with the team"}
                  onClick={() => onShare(view, !view.shared)}>
            <Share2 size={14} aria-hidden />
          </button>
          <button type="button" className="tkv-tool tk-layer" disabled={busy}
                  title="Rename" aria-label="Rename"
                  onClick={() => {
                    const next = window.prompt("Name this view", view.name);
                    if (next && next.trim() && next.trim() !== view.name) {
                      onRename(view, next.trim());
                    }
                  }}>
            <Pencil size={14} aria-hidden />
          </button>
          <button type="button" className="tkv-tool tk-layer tkv-drop" disabled={busy}
                  title="Delete" aria-label="Delete"
                  onClick={() => onDelete(view)}>
            <Trash2 size={14} aria-hidden />
          </button>
        </span>
      )}
    </div>
  );
}

export default ViewBar;
