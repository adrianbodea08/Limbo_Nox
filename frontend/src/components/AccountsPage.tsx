// Who can get in, and who decides.
//
// Registration is a request; this is where it gets answered. Approving is the
// whole point of the page, so it is one click on the row rather than a form —
// and an admin cannot lock themselves out, because a tracker with nobody who
// can approve anybody is a tracker nobody new can ever join.

import { Fragment, useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { M3Select } from "./M3Select";
import { TopBar, type ShellProps } from "./TopBar";
import { TrackerRail } from "./nox/TrackerRail";
import type { User } from "../types";
import type { AuditEntry } from "../api";
import { ago, trackerApi, type ProjectAccess } from "./nox/model";

const STATUSES = ["approved", "pending", "suspended", "banned"] as const;
const ROLES = ["member", "admin"] as const;

const asOptions = (values: readonly string[]) =>
  values.map((v) => ({ value: v, label: v }));

export function AccountsPage({ shell }: { shell: ShellProps }) {
  const [users, setUsers] = useState<User[]>([]);
  const [openFor, setOpenFor] = useState<number | null>(null);
  const [log, setLog] = useState<AuditEntry[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [seen, setSeen] = useState<ProjectAccess[]>([]);
  const [error, setError] = useState("");
  const [, setBusy] = useState(false);

  const load = useCallback(() => {
    api.users().then(setUsers).catch((e) => setError(String(e.message ?? e)));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (!showLog) return;
    api.audit(50).then(setLog).catch(() => setLog([]));
  }, [showLog, users]);

  useEffect(() => {
    if (openFor == null) { setSeen([]); return; }
    trackerApi.seenBy(openFor).then(setSeen).catch(() => setSeen([]));
  }, [openFor]);

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

        {/* Every permission that has changed, and who changed it. The
            tracker records every ticket move and recorded none of this until
            2026-08-22 — which is the wrong way round, because "who gave
            themselves admin" is the question somebody asks under pressure. */}
        <section className="tk-audit">
          <button type="button" className="tk-audit-toggle tk-layer"
                  onClick={() => setShowLog((v) => !v)}>
            {showLog ? "Hide" : "Show"} what admins have changed
          </button>
          {showLog && (
            <ol className="tk-audit-list">
              {log.map((e) => (
                <li key={e.id} className="tk-audit-row">
                  <span className="tk-audit-who">{e.actor}</span>
                  <span className="tk-audit-what">{e.what}</span>
                  {e.subject && <span className="tk-audit-subject">{e.subject}</span>}
                  {/* The before as well as the after. "changed a role" is not
                      an answer; "member to admin" is. */}
                  {e.was && e.now && (
                    <span className="tk-dim tk-audit-move">{e.was} → {e.now}</span>
                  )}
                  {!e.was && e.now && <span className="tk-dim tk-audit-move">{e.now}</span>}
                  <span className="tk-dim tk-audit-when">{ago(e.at)}</span>
                </li>
              ))}
              {!log.length && (
                <li className="tk-dim">Nothing has been changed yet.</li>
              )}
            </ol>
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
                <th style={{ width: 130 }}>Can see</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const self = u.id === shell.user.id;
                return (
                  <Fragment key={u.id}>
                  <tr>
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
                    <td>
                      {/* The other half of what an admin does after approving
                          somebody. Project settings answers "who can see this
                          project"; this answers "what can this person see",
                          which is the question you have when you are looking
                          at a person. */}
                      <button type="button" className="tk-link tk-layer"
                              onClick={() => setOpenFor(openFor === u.id ? null : u.id)}>
                        {/* Not "Projects" — the rail already has one of
                            those, and two controls with the same word on one
                            screen make somebody read both to find out which
                            is which. */}
                        {openFor === u.id ? "Hide" : "Change"}
                      </button>
                    </td>
                  </tr>
                  {openFor === u.id && (
                    <tr className="tk-acc-open">
                      <td colSpan={5}>
                        <div className="tk-acc-projects">
                          {seen.map((p) => (
                            <label key={p.id}
                                   className={`tk-acc-project tk-layer${p.can_see ? " on" : ""}`}
                                   title={p.open_to_all
                                     ? "This project is open to everyone"
                                     : p.via_tag
                                       ? `Reached through the ${p.via_tag} tag`
                                       : "Named on this project"}>
                              <input
                                type="checkbox"
                                checked={p.can_see}
                                /* Nothing to decide when the project is open to
                                   everybody, or when a tag already lets them
                                   in — unticking would not take the access
                                   away, and a control that lies is worse than
                                   one that is absent. */
                                disabled={p.open_to_all || !!p.via_tag}
                                onChange={(e) => act(async () => {
                                  setSeen(await trackerApi.namePersonOn(
                                    u.id, p.id, e.target.checked));
                                })}
                              />
                              <span className="tk-acc-key">{p.key}</span>
                              <span className="tk-acc-name">{p.name}</span>
                              {p.open_to_all && <span className="tk-dim">everyone</span>}
                              {p.via_tag && <span className="tk-dim">via {p.via_tag}</span>}
                            </label>
                          ))}
                          {!seen.length && <span className="tk-dim">No projects yet.</span>}
                        </div>
                      </td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
              {users.length === 0 && (
                <tr><td colSpan={5} className="tk-empty-row">Nobody yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        </div>
      </div>
    </div>
  );
}
