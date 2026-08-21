// Who can get in, and who decides.
//
// Registration is a request; this is where it gets answered. Approving is the
// whole point of the page, so it is one click on the row rather than a form —
// and an admin cannot lock themselves out, because a tracker with nobody who
// can approve anybody is a tracker nobody new can ever join.

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { M3Select } from "./M3Select";
import { TopBar, type ShellProps } from "./TopBar";
import { TrackerRail } from "./nox/TrackerRail";
import type { User } from "../types";
import type { Invite } from "../api";

const STATUSES = ["approved", "pending", "suspended", "banned"] as const;
const ROLES = ["member", "admin"] as const;

const asOptions = (values: readonly string[]) =>
  values.map((v) => ({ value: v, label: v }));

export function AccountsPage({ shell }: { shell: ShellProps }) {
  const [users, setUsers] = useState<User[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [people, setPeople] = useState<{ id: number; display_name: string; issues: number }[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [claims, setClaims] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [, setBusy] = useState(false);

  const load = useCallback(() => {
    api.users().then(setUsers).catch((e) => setError(String(e.message ?? e)));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    api.invites().then(setInvites).catch(() => {});
    // The seeded people, so "joins as" is a pick from a list rather than an id
    // somebody has to go and look up.
    api.unclaimed().then(setPeople).catch(() => {});
  }, [users]);

  function link(token: string) {
    return `${window.location.origin}/join?token=${token}`;
  }

  async function act(what: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await what();
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const waiting = users.filter((u) => u.status === "pending");

  return (
    <div className="tk-page">
      <TopBar
        title="Accounts"
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

        <div className="tk-canvas">
        <header className="tk-page-head">
          <h1>Accounts</h1>
          <p className="tk-dim">
            Everyone who can sign in, and what they are allowed to do.
          </p>
        </header>

        {error && <p className="tk-error">{error}</p>}

        {/* Inviting somebody, rather than making them an account.
            The difference is the password: this way it is chosen by the person
            it belongs to and nobody else ever knows it. They also arrive
            approved, because saying who may join *is* the approval. */}
        <section className="tk-inv">
          <h2>Invite somebody</h2>
          <div className="tk-inv-form">
            <label className="tk-inv-field">
              <span>Email</span>
              <input
                className="tkc-input"
                value={email}
                placeholder="them@example.com"
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label className="tk-inv-field">
              <span>Role</span>
              <M3Select
                value={role}
                width={150}
                options={[{ value: "member", label: "Member" },
                          { value: "admin", label: "Admin" }]}
                onChange={setRole}
              />
            </label>
            {/* The whole point of Phase 1: the tracker was populated before
                anybody could sign in, so most people joining already have work
                under their name. */}
            {!!people.length && (
              <label className="tk-inv-field tk-inv-wide">
                <span>They are already in here as</span>
                <M3Select
                  value={claims}
                  width={280}
                  placeholder="Somebody new"
                  options={[
                    { value: "", label: "Somebody new" },
                    ...people.map((p) => ({
                      value: String(p.id),
                      label: p.display_name,
                      hint: `${p.issues} ${p.issues === 1 ? "issue" : "issues"} assigned`,
                    })),
                  ]}
                  onChange={setClaims}
                />
              </label>
            )}
            <button
              type="button"
              className="tk-btn tk-btn-primary tk-layer"
              disabled={!email.includes("@")}
              onClick={() => act(async () => {
                const made = await api.invite({
                  email: email.trim(), role,
                  claims: claims ? Number(claims) : null,
                  note: "",
                });
                setEmail("");
                setClaims("");
                setInvites(await api.invites());
                navigator.clipboard?.writeText(link(made.token));
                setCopied(made.token);
              })}
            >
              Make a link
            </button>
          </div>

          {invites.filter((i) => !i.used_at).length > 0 && (
            <ul className="tk-inv-list">
              {invites.filter((i) => !i.used_at).map((i) => (
                <li key={i.token} className="tk-inv-row">
                  <span className="tk-inv-who">
                    {i.email}
                    {i.claims != null && (
                      <span className="tk-dim">
                        {" · as "}
                        {people.find((p) => p.id === i.claims)?.display_name ?? "somebody here"}
                      </span>
                    )}
                  </span>
                  <button type="button" className="tk-link tk-layer"
                          onClick={() => {
                            navigator.clipboard?.writeText(link(i.token));
                            setCopied(i.token);
                            window.setTimeout(
                              () => setCopied((c) => (c === i.token ? null : c)), 1600);
                          }}>
                    {copied === i.token ? "Copied" : "Copy link"}
                  </button>
                  <button type="button" className="tk-link tk-layer"
                          onClick={() => act(async () => {
                            await api.revokeInvite(i.token);
                            setInvites(await api.invites());
                          })}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Anybody waiting comes first. A request nobody sees is a person who
            thinks the tool is broken. */}
        {waiting.length > 0 && (
          <p className="tk-dim">
            {waiting.length} {waiting.length === 1 ? "person is" : "people are"} waiting
            for approval.
          </p>
        )}

        <div className="tk-table-wrap">
          <table className="tk-table">
            <thead>
              <tr>
                <th>Who</th>
                <th style={{ width: 240 }}>Email</th>
                <th style={{ width: 150 }}>Status</th>
                <th style={{ width: 120 }}>Role</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === shell.user.id;
                return (
                  <tr key={u.id}>
                    <td>
                      <strong>{u.nickname || u.username}</strong>
                      {self && <span className="tk-chip tk-chip-quiet">you</span>}
                    </td>
                    <td className="tk-dim">{u.email}</td>
                    <td>
                      {/* The last admin standing must not be able to suspend
                          themselves out of the product, so their own row is
                          shown as text rather than as a control they cannot
                          use — a disabled dropdown invites the click anyway. */}
                      {self ? <span className="tk-dim">{u.status}</span> : (
                        <M3Select
                          value={u.status}
                          options={asOptions(STATUSES)}
                          width={150}
                          onChange={(v) => act(() => api.setUserStatus(u.id, v))}
                        />
                      )}
                    </td>
                    <td>
                      {self ? <span className="tk-dim">{u.role}</span> : (
                        <M3Select
                          value={u.role}
                          options={asOptions(ROLES)}
                          width={130}
                          onChange={(v) => act(() => api.setUserRole(u.id, v))}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
              {users.length === 0 && (
                <tr><td colSpan={4} className="tk-empty-row">Nobody yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        </div>
      </div>
    </div>
  );
}
