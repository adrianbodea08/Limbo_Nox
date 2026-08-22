// Whether the navigation is showing, on a screen too narrow to keep it open.
//
// Above 840px the rail is simply there and none of this does anything: `open`
// is ignored, the button that toggles it is not displayed, and the scrim never
// renders. Below it the same rail becomes a sheet over the page, because 248px
// of navigation out of 375 leaves 127 for the work — which is not a layout, it
// is a rail with a margin.
//
// **A context rather than a prop.** The button lives in the top bar and the
// drawer is the rail, and the two are siblings under seven different pages
// (the board, my work, teams, an issue, project settings, settings, accounts).
// Threading a boolean and a setter through all seven would have been fourteen
// props to say one thing, and every page added later would have to remember.
//
// It closes itself on navigation. A drawer that stays open over the page you
// just asked for is a drawer you have to dismiss twice.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";

interface NavDrawer {
  open: boolean;
  toggle: () => void;
  close: () => void;
}

// Defaults that do nothing, so a component rendered outside the provider — a
// test, a screen not yet wired up — behaves like the wide layout rather than
// throwing.
const Ctx = createContext<NavDrawer>({ open: false, toggle: () => {}, close: () => {} });

/** Whether a media query holds, and keeps holding. */
function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}

export function useNavDrawer() {
  return useContext(Ctx);
}

/** Below this the navigation is a sheet over the page; above it, part of it.
 *  M3's own boundary, and the same one the stylesheet uses. */
const MODAL = "(max-width: 839px)";
const REMEMBER = "nox-nav-open";

export function NavDrawerProvider({ children }: { children: ReactNode }) {
  // Two different things wear the same flag, which is the point rather than a
  // compromise: closed is *icons only* where there is room for a rail, and
  // *gone* where there is not. Open is the same drawer either way.
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(REMEMBER);
      return saved === null ? true : saved === "1";
    } catch { return true; }
  });
  const { pathname, search } = useLocation();
  const modal = useMedia(MODAL);
  // Whatever had the keyboard when the sheet went up. Somebody who opened it
  // from the menu button and then dismissed it should be back on that button,
  // not at the top of the document with their place lost.
  const cameFrom = useRef<HTMLElement | null>(null);

  const remember = (v: boolean) => {
    try { localStorage.setItem(REMEMBER, v ? "1" : "0"); } catch { /* private mode */ }
    return v;
  };
  const close = useCallback(() => setOpen(() => remember(false)), []);
  const toggle = useCallback(() => {
    setOpen((v) => {
      if (!v) cameFrom.current = document.activeElement as HTMLElement | null;
      return remember(!v);
    });
  }, []);

  useEffect(() => {
    if (open || !cameFrom.current) return;
    // Only if it is still on the page: picking a destination unmounts the
    // whole screen, and the right answer then is wherever the new page starts.
    if (cameFrom.current.isConnected) cameFrom.current.focus();
    cameFrom.current = null;
  }, [open]);

  // Both parts of the address: the rooms are paths (/my-work, /teams) but the
  // board's sections are query parameters (?section=releases), so watching the
  // path alone would leave the drawer open over four of the seven destinations.
  //
  // Only while it is a sheet. Where the drawer is part of the page, closing it
  // on every navigation would collapse the navigation each time somebody used
  // it — which is a preference they set, not a state to be reset.
  useEffect(() => { if (modal) setOpen(false); }, [pathname, search, modal]);

  // Crossing the boundary is not a decision, so it must not overwrite one.
  // Narrowing puts the sheet away without saving that; widening again asks
  // what was set the last time somebody actually chose. Without the second
  // half, resizing a window down and back up quietly collapsed a navigation
  // that had been left open on purpose.
  useEffect(() => {
    if (modal) return;
    try {
      const saved = localStorage.getItem(REMEMBER);
      setOpen(saved === null ? true : saved === "1");
    } catch { setOpen(true); }
  }, [modal]);

  // Escape closes it, the same key that closes every other layer in the app —
  // and only while it is one. Escape should not collapse a rail.
  useEffect(() => {
    if (!open || !modal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, modal]);

  // Nothing underneath should scroll while a sheet is over it — on a phone that
  // is the difference between dismissing the drawer and losing your place.
  useEffect(() => {
    if (!open || !modal) return;
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = was; };
  }, [open, modal]);

  const value = useMemo(() => ({ open, toggle, close }), [open, toggle, close]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
