// Who is signed in, and the few things they can do about it.

import { useEffect, useRef, useState } from "react";
import type { User } from "../types";

interface Props {
  user: User;
  isAdmin?: boolean;
  onOpenAdmin?: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}

export function AccountMenu({ user, isAdmin, onOpenAdmin, onOpenSettings, onLogout }: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  // Close on a click anywhere else and on Escape — a menu that only closes by
  // clicking the thing that opened it is a menu people click twice.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  const name = user.nickname || user.username;
  const initials = name.slice(0, 2).toUpperCase();

  return (
    <div className="acct" ref={wrap}>
      <button
        type="button"
        className="acct-btn tk-layer"
        onClick={() => setOpen(!open)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {user.avatar
          ? <img className="acct-face" src={user.avatar} alt="" />
          : <span className="acct-face acct-initials">{initials}</span>}
        <span className="acct-name">{name}</span>
      </button>

      {open && (
        <div className="acct-menu" role="menu">
          <div className="acct-who">
            <strong>{name}</strong>
            <span className="tk-dim">{user.email}</span>
            {isAdmin && <span className="tk-chip tk-chip-quiet">admin</span>}
          </div>
          <div className="acct-div" />
          <button type="button" className="acct-row tk-layer"
                  onClick={() => { setOpen(false); onOpenSettings(); }}>
            Settings
          </button>
          {isAdmin && onOpenAdmin && (
            <button type="button" className="acct-row tk-layer"
                    onClick={() => { setOpen(false); onOpenAdmin(); }}>
              Accounts
            </button>
          )}
          <div className="acct-div" />
          <button type="button" className="acct-row tk-layer"
                  onClick={() => { setOpen(false); onLogout(); }}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
