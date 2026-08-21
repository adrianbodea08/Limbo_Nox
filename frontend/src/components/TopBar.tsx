// Nox's header, on every page.
//
// Written for Nox rather than carried over. The app this was extracted from put
// an application switcher in this corner, because it was five products behind
// one login. Nox is one product, so the corner is the logo, whatever the page
// wants in the middle — the search box, usually — and the account.

import type { ReactNode } from "react";
import type { User } from "../types";
import { AccountMenu } from "./AccountMenu";
import LogoMark from "./LogoMark";
import { ArrowLeft } from "lucide-react";
import { NotificationBell } from "./nox/Notifications";

/** What every page needs from the shell. Passed down from Root so a page never
 *  reaches for global state to find out who is signed in. */
export interface ShellProps {
  user: User;
  isAdmin: boolean;
  onOpenAdmin: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}

export interface TopBarProps {
  title: string;
  user: User;
  isAdmin?: boolean;
  /** Clicking the logo goes back here — set on pages that are inside another. */
  onBack?: () => void;
  backTitle?: string;
  /** The centre slot: search, tabs, whatever the page needs. */
  children?: ReactNode;
  /** Extra controls immediately left of the account menu. */
  rightExtra?: ReactNode;
  onOpenAdmin?: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
}

export function TopBar({
  title,
  user,
  isAdmin = false,
  onBack,
  backTitle,
  children,
  rightExtra,
  onOpenAdmin,
  onOpenSettings,
  onLogout,
}: TopBarProps) {
  const brand = (
    <span className="brand">
      <span className="brand-logo"><LogoMark /></span>
      <span className="brand-text">{title}</span>
    </span>
  );

  return (
    <header className="topbar">
      {onBack ? (
        <button className="brand-back" onClick={onBack} title={backTitle ?? "Back"}>
          <span className="brand-back-arrow"><ArrowLeft size={18} aria-hidden /></span>
          {brand}
        </button>
      ) : (
        brand
      )}

      {children}

      <div className="topbar-right">
        {rightExtra}
        <NotificationBell />
        <AccountMenu
          user={user}
          isAdmin={isAdmin}
          onOpenAdmin={onOpenAdmin}
          onOpenSettings={onOpenSettings}
          onLogout={onLogout}
        />
      </div>
    </header>
  );
}
