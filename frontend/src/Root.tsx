// Nox's shell: who is signed in, and which page they are looking at.
//
// One product, so there is no application switcher and no per-feature gating —
// if you are in, you are in. The only distinction is admin, which decides who
// can approve accounts and change a project's settings.
//
// Nox lives at the root. The app it was extracted from mounted this whole thing
// under /tracker as one of five features; here the board *is* the front page,
// and the old paths redirect so nobody's bookmarks break.

import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, getAuthToken, setAuthToken, setUnauthorizedHandler } from "./api";
import { AuthPage } from "./components/AuthPage";
import { AccountsPage } from "./components/AccountsPage";
import { SettingsPage } from "./components/SettingsPage";
import { TrackerPage } from "./components/nox/TrackerPage";
import { IssuePage } from "./components/nox/IssuePage";
import { MyWorkPage } from "./components/nox/MyWork";
import { ProjectSettingsPage } from "./components/nox/ProjectSettings";
import { TeamQueuePage } from "./components/nox/TeamQueue";
import type { ShellProps } from "./components/TopBar";
import type { User } from "./types";

export default function Root() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  const navigate = useNavigate();

  const signOut = useCallback(() => {
    api.logout().catch(() => {});
    setAuthToken(null);
    setUser(null);
  }, []);

  // One place decides what an expired session means, rather than every call
  // inventing its own answer.
  useEffect(() => { setUnauthorizedHandler(() => { setAuthToken(null); setUser(null); }); }, []);

  // A token in storage is a claim; ask the server whether it still means
  // anything before showing somebody their board.
  useEffect(() => {
    if (!getAuthToken()) { setChecking(false); return; }
    api.me()
      .then(setUser)
      .catch(() => setAuthToken(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <div className="tk-blank">…</div>;

  if (!user) {
    return (
      <AuthPage
        onAuthenticated={(token, who) => { setAuthToken(token); setUser(who); }}
      />
    );
  }

  const shell: ShellProps = {
    user,
    isAdmin: user.role === "admin",
    onOpenAdmin: () => navigate("/accounts"),
    onOpenSettings: () => navigate("/settings"),
    onLogout: signOut,
  };

  return (
    <Routes>
      <Route path="/" element={<TrackerPage shell={shell} />} />
      <Route path="/issue/:issueKey" element={<IssuePage shell={shell} />} />
      <Route path="/my-work" element={<MyWorkPage shell={shell} />} />
      <Route path="/teams" element={<TeamQueuePage shell={shell} />} />
      <Route
        path="/project/:projectKey/settings"
        element={shell.isAdmin
          ? <ProjectSettingsPage shell={shell} />
          : <Navigate to="/" replace />}
      />
      <Route
        path="/accounts"
        element={shell.isAdmin ? <AccountsPage shell={shell} /> : <Navigate to="/" replace />}
      />
      <Route path="/settings" element={<SettingsPage shell={shell} />} />

      {/* The paths this had when it lived inside another app. Kept so links
          people already sent each other still land somewhere. */}
      <Route path="/tracker" element={<Navigate to="/" replace />} />
      <Route path="/tracker/my-work" element={<Navigate to="/my-work" replace />} />
      <Route path="/tracker/teams" element={<Navigate to="/teams" replace />} />
      <Route path="/tracker/issue/:issueKey" element={<LegacyIssue />} />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** /tracker/issue/CD-1 → /issue/CD-1. */
function LegacyIssue() {
  const key = location.pathname.split("/").pop() ?? "";
  return <Navigate to={`/issue/${key}`} replace />;
}
