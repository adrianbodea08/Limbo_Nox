// Your own account: what you are called, and your password.
//
// Small deliberately. Everything about how Nox *works* — projects, workflows,
// fields, git — is configured where it applies, not in a settings page that
// becomes the place everything nobody could categorise ends up.

import { useEffect, useState } from "react";
import { api } from "../api";
import { trackerApi } from "./nox/model";
import type { NotificationPrefs } from "./nox/model";
import { TopBar, type ShellProps } from "./TopBar";
import { TrackerRail } from "./nox/TrackerRail";
import { THEMES, applyTheme, getTheme, setTheme, type ThemeId } from "../theme";
import { M3Segmented } from "./M3Segmented";

export function SettingsPage({ shell }: { shell: ShellProps }) {
  const [nickname, setNickname] = useState(shell.user.nickname || "");
  const [avatar, setAvatar] = useState(shell.user.avatar || "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [theme, setThemeState] = useState<ThemeId>(getTheme());
  const [prefs, setPrefs] = useState<NotificationPrefs>({});

  useEffect(() => {
    trackerApi.notificationPrefs().then(setPrefs).catch(() => {});
  }, []);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function act(what: () => Promise<unknown>, said: string) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await what();
      setNote(said);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tk-page">
      <TopBar
        title="Settings"
        user={shell.user}
        isAdmin={shell.isAdmin}
        onBack={() => history.back()}
        backTitle="Back"
        onOpenAdmin={shell.onOpenAdmin}
        onOpenSettings={shell.onOpenSettings}
        onLogout={shell.onLogout}
      />

      <div className="tk-shell">
        <TrackerRail isAdmin={shell.isAdmin} />

        <div className="tk-canvas tks-main">
        <header className="tk-page-head">
          <h1>Settings</h1>
          <p className="tk-dim">
            Your own account. How Nox works is set where it applies.
          </p>
        </header>

        {error && <p className="tk-error">{error}</p>}
        {note && <p className="tk-dim">{note}</p>}

        <section className="tkgs-card">
          <h3>You</h3>
          <label className="auth-field">
            <span>Display name</span>
            <input className="tk-input" value={nickname}
                   onChange={(e) => setNickname(e.target.value)} />
          </label>
          <label className="auth-field">
            <span>Avatar URL</span>
            <input className="tk-input" value={avatar}
                   onChange={(e) => setAvatar(e.target.value)} />
          </label>
          <button type="button" className="tk-btn tk-layer" disabled={busy}
                  onClick={() => act(
                    () => fetch(`/api/auth/profile?nickname=${encodeURIComponent(nickname)}`
                                + `&avatar=${encodeURIComponent(avatar)}`,
                                { method: "PUT",
                                  headers: { Authorization: `Bearer ${localStorage.getItem("nox_token")}` } }),
                    "Saved.")}>
            Save
          </button>
        </section>

        <section className="tkgs-card">
          <h3>Appearance</h3>
          <M3Segmented
            label="Theme"
            value={theme}
            options={THEMES.map((t) => ({ value: t.id, label: t.label }))}
            onChange={(next) => { setTheme(next); applyTheme(next); setThemeState(next); }}
          />
        </section>

        <section className="tkgs-card">
          <h3>Notifications</h3>
          <p className="tk-dim tkn-why">
            Four things, and that is the whole list — everything here is either
            somebody waiting on you or somebody answering you. Turn one off and
            it stops reaching you entirely.
          </p>
          <div className="tkn-prefs">
            {Object.entries(prefs).map(([kind, p]) => (
              <label key={kind} className="tkn-pref">
                <span className="tk-toggle">
                  <input
                    type="checkbox"
                    checked={p.on}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setPrefs((was) => ({ ...was, [kind]: { ...p, on } }));
                      trackerApi.setNotificationPref(kind, on).then(setPrefs)
                        .catch(() => setPrefs((was) => ({ ...was, [kind]: { ...p, on: !on } })));
                    }}
                  />
                </span>
                <span className="tkn-pref-label">{p.label}</span>
              </label>
            ))}
            {!Object.keys(prefs).length && <p className="tk-dim">Loading…</p>}
          </div>
        </section>

        <section className="tkgs-card">
          <h3>Password</h3>
          <label className="auth-field">
            <span>Current</span>
            <input className="tk-input" type="password" value={current}
                   onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label className="auth-field">
            <span>New — at least six characters</span>
            <input className="tk-input" type="password" value={next}
                   onChange={(e) => setNext(e.target.value)} minLength={6} />
          </label>
          <button type="button" className="tk-btn tk-layer"
                  disabled={busy || !current || next.length < 6}
                  onClick={() => act(async () => {
                    await api.changePassword(current, next);
                    setCurrent(""); setNext("");
                  }, "Password changed.")}>
            Change it
          </button>
        </section>
        </div>
      </div>
    </div>
  );
}
