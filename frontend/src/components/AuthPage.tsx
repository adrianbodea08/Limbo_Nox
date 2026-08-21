// Signing in, and asking to.
//
// Registration is a request an admin approves. An issue tracker anybody can
// sign themselves into is not a tracker — it is a wiki with tickets — so the
// register form says so plainly rather than letting somebody discover it when
// their new password does not work.
//
// The exception is the very first account, because somebody has to be able to
// approve the second. That one is approved on the spot and made admin, and the
// form says that too.

import { useEffect, useState } from "react";
import { api } from "../api";
import type { User } from "../types";
import LogoMark from "./LogoMark";

interface Props {
  onAuthenticated: (token: string, user: User) => void;
}

export function AuthPage({ onAuthenticated }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");
  const [busy, setBusy] = useState(false);
  const [first, setFirst] = useState<boolean | null>(null);

  useEffect(() => {
    api.setupStatus()
      .then((s) => {
        setFirst(s.needsFirstAccount);
        // Nobody has an account yet: there is nothing to log into, so open on
        // the form that can actually get somebody in.
        if (s.needsFirstAccount) setMode("register");
      })
      .catch(() => setFirst(false));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setInfo("");
    setBusy(true);
    try {
      if (mode === "login") {
        const res = await api.login(username.trim(), password);
        onAuthenticated(res.token, res.user);
        return;
      }
      const res = await api.register(username.trim(), email.trim(), password);
      if (res.token && res.user) {
        onAuthenticated(res.token, res.user);
        return;
      }
      setInfo(res.message ?? "Registration submitted.");
      setMode("login");
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <LogoMark size={34} />
          <div>
            <h1>Nox</h1>
            <span className="tk-dim">by Limbo</span>
          </div>
        </div>

        {first && (
          <p className="auth-hint auth-first">
            Nobody has an account yet. The first one is approved straight away
            and becomes the admin — everyone after it needs approving.
          </p>
        )}

        <div className="auth-tabs">
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={mode === m ? "active" : undefined}
              onClick={() => { setMode(m); setError(""); setInfo(""); }}
            >
              {m === "login" ? "Sign in" : first ? "Create the first account" : "Request access"}
            </button>
          ))}
        </div>

        <div className="auth-form">
        <label className="auth-field">
          <span>Username</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)}
                 autoComplete="username" required />
        </label>

        {mode === "register" && (
          <label className="auth-field">
            <span>Email</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
                   autoComplete="email" required />
          </label>
        )}

        <label className="auth-field">
          <span>Password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                 autoComplete={mode === "login" ? "current-password" : "new-password"}
                 minLength={mode === "register" ? 6 : undefined} required />
        </label>
        </div>

        {error && <p className="auth-error">{error}</p>}
        {info && <p className="auth-info">{info}</p>}

        <button type="submit" className="tk-btn tk-layer tk-btn-primary auth-submit"
                disabled={busy}>
          {busy ? "…" : mode === "login" ? "Sign in"
            : first ? "Create it" : "Request access"}
        </button>

        {mode === "register" && !first && (
          <p className="auth-hint">
            An admin approves new accounts. You will not be able to sign in
            until one does.
          </p>
        )}
      </form>
    </div>
  );
}

export default AuthPage;
