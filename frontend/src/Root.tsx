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
import { ApiError, api, getAuthToken, setAuthToken, setUnauthorizedHandler } from "./api";
import { AuthPage } from "./components/AuthPage";
import { AccountsPage } from "./components/AccountsPage";
import { SettingsPage } from "./components/SettingsPage";
import { TrackerPage } from "./components/nox/TrackerPage";
import { IssuePage } from "./components/nox/IssuePage";
import { MyWorkPage } from "./components/nox/MyWork";
import { ProjectSettingsPage } from "./components/nox/ProjectSettings";
import { TeamQueuePage } from "./components/nox/TeamQueue";
import { NavDrawerProvider } from "./components/nox/navdrawer";
import type { ShellProps } from "./components/TopBar";
import type { User } from "./types";

export default function Root() {
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);
  // Reachable, as far as we know. Only the boot check sets this — once the app
  // is up, a dropped request is the individual page's problem, not the shell's.
  const [offline, setOffline] = useState(false);
  // Bumped by the Try now button to run the check again.
  const [tryAgain, setTryAgain] = useState(0);
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
  //
  // **Only the server rejecting it settles anything.** A failure to reach the
  // server at all is not a verdict on the session, and treating it as one is
  // how a good token gets discarded: `docker compose up -d --build` recreates
  // the api container, a reload lands in that window, /api/auth/me never
  // completes, and somebody is signed out of a session with 29 days left. The
  // API log had no 401 in it, because there was nothing to say no.
  //
  // So the two are kept apart, the same way the 401 handler above already does
  // it: 401 clears, anything else waits and asks again.
  useEffect(() => {
    if (!getAuthToken()) { setChecking(false); return; }
    let alive = true;
    let timer = 0;

    // Quick at first, because a container restart is over in seconds; slow
    // afterwards, so a server that is properly down is not hammered while
    // somebody stares at the offline card.
    const WAITS = [400, 1200, 3000];

    async function ask(attempt = 0) {
      try {
        const who = await api.me();
        if (!alive) return;
        setUser(who);
        setOffline(false);
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 401) {
          // The one case that means what it says.
          setAuthToken(null);
          setUser(null);
          setOffline(false);
        } else {
          // Keep the token. It is still perfectly good; we simply cannot ask.
          // The card waits for the second failure: a container restart is often
          // over inside the first retry, and flashing "Nox is not answering" at
          // somebody for 400ms is alarming about nothing. Until then this stays
          // in the loading state it was already in.
          if (attempt > 0) {
            setOffline(true);
            setChecking(false);
          }
          timer = window.setTimeout(
            () => ask(attempt + 1),
            WAITS[Math.min(attempt, WAITS.length - 1)],
          );
          return;
        }
      }
      if (alive) setChecking(false);
    }

    ask();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [tryAgain]);

  if (checking) return <div className="tk-blank">…</div>;

  // Signed in as far as we know, but the server is not answering. Saying so is
  // the whole point: the alternative is a sign-in page, which tells somebody
  // their session ended when it did not, and invites them to fix it by typing a
  // password that was never the problem.
  if (offline && !user) {
    return (
      <div className="tk-blank tk-blank-full">
        <div className="tk-blank-card">
          <h2>Nox is not answering</h2>
          <p>
            You are still signed in — the server cannot be reached just now,
            which usually means it is restarting.
          </p>
        </div>
        <p className="tk-dim">Trying again on its own.</p>
        <button
          type="button"
          className="tk-btn tk-layer tk-btn-primary"
          onClick={() => { setChecking(true); setTryAgain((n) => n + 1); }}
        >
          Try now
        </button>
      </div>
    );
  }

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
    // Whether the navigation is showing, on a window too narrow to keep it
    // open. Here rather than inside a page because the button that opens it is
    // in the top bar and the thing it opens is the rail, and every page renders
    // both.
    <NavDrawerProvider>
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
    </NavDrawerProvider>
  );
}

/** /tracker/issue/CD-1 → /issue/CD-1. */
function LegacyIssue() {
  const key = location.pathname.split("/").pop() ?? "";
  return <Navigate to={`/issue/${key}`} replace />;
}
