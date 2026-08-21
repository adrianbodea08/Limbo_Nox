// Accepting an invitation.
//
// The alternative this replaces: an admin creates accounts and tells people
// their passwords. That means one person knows everybody's secret and says it
// out loud, and it is worth avoiding whoever the admin is.
//
// Here the link says who may join; the password is chosen on this screen and
// goes nowhere else. And because an admin already decided when they wrote the
// invitation, there is no approval queue afterwards — you land signed in.

import { useEffect, useState } from "react";
import { api } from "../api";
import type { User } from "../types";
import LogoMark from "./LogoMark";

interface Props {
  token: string;
  onJoined: (token: string, user: User) => void;
}

export function JoinPage({ token, onJoined }: Props) {
  const [invite, setInvite] = useState<
    { email: string; role: string; note: string; becomes: string | null } | null>(null);
  const [checking, setChecking] = useState(true);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The reasons a link fails are different sentences on purpose. "Invalid"
  // tells somebody holding one nothing they can act on; "already used" and
  // "expired" each say exactly what to go back and ask for.
  useEffect(() => {
    let live = true;
    api.checkInvite(token)
      .then((i) => live && setInvite(i))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setChecking(false));
    return () => { live = false; };
  }, [token]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api.acceptInvite(token, username.trim(), password);
      onJoined(r.token, r.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (checking) return <div className="tk-blank tk-blank-full">…</div>;

  if (!invite) {
    return (
      <div className="auth-page">
        <div className="auth-card">
          <div className="auth-brand"><LogoMark /><h1>Nox</h1></div>
          <p className="auth-error">{error}</p>
          <p className="auth-hint">
            Whoever sent you this link can make another one.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">
          <LogoMark />
          <h1>Nox</h1>
        </div>

        <p className="auth-hint">
          You have been invited as <strong>{invite.email}</strong>
          {invite.role === "admin" && ", as an admin"}.
        </p>
        {/* Second person, and by name. Somebody deciding whether this link is
            really for them is answered by "Ana Mihalache", never by an id. */}
        {invite.becomes && (
          <p className="auth-hint">
            You will pick up where <strong>{invite.becomes}</strong> left off —
            that work is already yours.
          </p>
        )}
        {invite.note && <p className="auth-hint">{invite.note}</p>}

        <div className="auth-form">
          <label className="auth-field">
            <span>Username</span>
            <input
              value={username}
              autoFocus
              autoComplete="username"
              placeholder="What people will see"
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              autoComplete="new-password"
              placeholder="At least six characters"
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
        </div>

        {error && <p className="auth-error">{error}</p>}

        <button
          type="submit"
          className="tk-btn tk-btn-primary tk-layer"
          disabled={busy || !username.trim() || password.length < 6}
        >
          {busy ? "Joining…" : "Join"}
        </button>

        {/* Said out loud, because the thing this replaces is somebody being
            handed a password by a colleague. */}
        <p className="auth-hint">
          Nobody else sees this password, including whoever invited you.
        </p>
      </form>
    </div>
  );
}

export default JoinPage;
