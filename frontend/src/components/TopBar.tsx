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
import { Menu } from "lucide-react";
import { NotificationBell } from "./nox/Notifications";
import { useNavDrawer } from "./nox/navdrawer";

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
  children,
  rightExtra,
  onOpenAdmin,
  onOpenSettings,
  onLogout,
}: TopBarProps) {
  // At every width now. Below 840 it shows and hides a sheet; above it, it
  // collapses the navigation to its icons and back — two readings of one flag,
  // which is why there is one button rather than two.
  const drawer = useNavDrawer();

  const brand = (
    <span className="brand">
      <span className="brand-logo"><LogoMark /></span>
      <span className="brand-text">{title}</span>
    </span>
  );

  return (
    <header className="topbar">
      <button
        type="button"
        className="topbar-menu tk-layer"
        aria-label={drawer.open ? "Collapse the navigation" : "Expand the navigation"}
        aria-expanded={drawer.open}
        onClick={drawer.toggle}
      >
        <Menu size={20} aria-hidden />
      </button>

      {brand}

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
