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

export function useNavDrawer() {
  return useContext(Ctx);
}

export function NavDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { pathname, search } = useLocation();
  // Whatever had the keyboard when the sheet went up. Somebody who opened it
  // from the menu button and then dismissed it should be back on that button,
  // not at the top of the document with their place lost.
  const cameFrom = useRef<HTMLElement | null>(null);

  const close = useCallback(() => setOpen(false), []);
  const toggle = useCallback(() => {
    setOpen((v) => {
      if (!v) cameFrom.current = document.activeElement as HTMLElement | null;
      return !v;
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
  useEffect(() => { setOpen(false); }, [pathname, search]);

  // Escape closes it, the same key that closes every other layer in the app.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Nothing underneath should scroll while a sheet is over it — on a phone that
  // is the difference between dismissing the drawer and losing your place.
  useEffect(() => {
    if (!open) return;
    const was = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = was; };
  }, [open]);

  const value = useMemo(() => ({ open, toggle, close }), [open, toggle, close]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
