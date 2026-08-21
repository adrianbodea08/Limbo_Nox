// Who can get in, and who decides.
//
// Registration is a request; this is where it gets answered. Approving is the
// whole point of the page, so it is one click on the row rather than a form —
// and an admin cannot lock themselves out, because a tracker with nobody who
// can approve anybody is a tracker nobody new can ever join.

import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { TopBar, type ShellProps } from "./TopBar";
import type { User } from "../types";

const STATUSES = ["approved", "pending", "suspended", "banned"] as const;

export function AccountsPage({ shell }: { shell: ShellProps }) {
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.users().then(setUsers).catch((e) => setError(String(e.message ?? e)));
  }, []);
  useEffect(load, [load]);

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

      <div className="tk-canvas">
        {error && <p className="tk-error">{error}</p>}

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
                      <select
                        className="tk-input"
                        value={u.status}
                        // The last admin standing must not be able to suspend
                        // themselves out of the product.
                        disabled={busy || self}
                        onChange={(e) => act(() => api.setUserStatus(u.id, e.target.value))}
                      >
                        {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                    <td>
                      <select
                        className="tk-input"
                        value={u.role}
                        disabled={busy || self}
                        onChange={(e) => act(() => api.setUserRole(u.id, e.target.value))}
                      >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                      </select>
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
  );
}
