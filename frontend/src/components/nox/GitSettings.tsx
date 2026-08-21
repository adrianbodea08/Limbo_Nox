// Connecting GitHub: one button, no tokens.
//
// The version this replaces asked for a personal access token. That works and
// is wrong for a product: it authenticates as a person, so it dies the day they
// rotate it or leave, and covering ninety-odd repositories means a list
// somebody maintains by hand.
//
// A GitHub App is one authorisation by an org owner. GitHub then delivers
// events for every repository — including ones created next month — and hands
// us short-lived tokens scoped to what the app declares. Nobody types a secret.
//
// Unregistered is a state, not an error. With no app set up this page explains
// what to do rather than showing a red box, the same way the tracker handles
// having no database.

import { useCallback, useEffect, useState } from "react";
import { ago, trackerApi } from "./model";
import type { GitStatus } from "./model";

export function GitSettings({ isAdmin }: { isAdmin: boolean }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [synced, setSynced] = useState("");
  const [manualId, setManualId] = useState("");

  const load = useCallback(async () => {
    try {
      setStatus(await trackerApi.gitStatus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Coming back from GitHub: the install redirects here with the id it created.
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const installation = params.get("installation_id");
    if (!installation) return;
    (async () => {
      setBusy(true);
      try {
        await trackerApi.gitConnected(Number(installation));
        // Take it out of the URL so a refresh does not try to connect twice.
        params.delete("installation_id");
        params.delete("setup_action");
        history.replaceState({}, "", `${location.pathname}?${params}`);
        await load();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  }, [load]);

  async function act(what: () => Promise<unknown>, note = "") {
    setBusy(true);
    setError("");
    try {
      const result = await what();
      if (note) {
        const r = result as { pull_requests?: number; links?: number };
        setSynced(`${r.pull_requests ?? 0} pull requests read, ${r.links ?? 0} linked.`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <p className="tk-dim">Loading…</p>;

  return (
    <div className="tkgs">
      <div className="tk-rel-head">
        <h2>Git</h2>
        {status.configured && isAdmin && (
          <button type="button" className="tk-btn tk-layer" disabled={busy}
                  onClick={() => act(() => trackerApi.gitSync(), "sync")}>
            {busy ? "Syncing…" : "Sync now"}
          </button>
        )}
      </div>

      {error && <p className="tk-error">{error}</p>}
      {synced && <p className="tk-dim">{synced}</p>}

      {/* Nothing registered yet: say what to do, in order, rather than failing. */}
      {!status.configured && (
        <div className="tk-blank-card tkgs-setup">
          <h3>No GitHub App yet</h3>
          <p>{status.message}</p>
          <ol className="tkgs-steps">
            <li>
              Register a GitHub App on the organisation — <em>Settings →
              Developer settings → GitHub Apps → New GitHub App</em>.
            </li>
            <li>
              Permissions: <strong>Contents: read</strong>,{" "}
              <strong>Pull requests: read</strong>,{" "}
              <strong>Checks: read</strong>. Nothing needs write access; this
              only ever reads.
            </li>
            <li>
              Subscribe to <code>pull_request</code>, <code>create</code> and{" "}
              <code>check_suite</code>.
            </li>
            <li>
              Point its webhook at <code>{location.origin}/api/nox/git/webhook</code>{" "}
              and set a webhook secret.
            </li>
            <li>
              Give this server <code>TRACKER_GITHUB_APP_ID</code>,{" "}
              <code>TRACKER_GITHUB_APP_SLUG</code>,{" "}
              <code>TRACKER_GITHUB_APP_KEY</code> (the .pem) and{" "}
              <code>TRACKER_GIT_WEBHOOK_SECRET</code>.
            </li>
          </ol>
          <p className="tk-dim">
            Then this page grows a Connect button, and an org owner presses it once.
          </p>
        </div>
      )}

      {status.configured && (
        <>
          {/* The secret is what stands between the webhook and the internet, so
              its absence is worth saying out loud rather than discovering when
              deliveries silently fail. */}
          {!status.webhookSecretSet && (
            <p className="tk-error">
              No webhook secret is set, so the webhook refuses every delivery.
              Set <code>TRACKER_GIT_WEBHOOK_SECRET</code> to the same value as
              the app’s.
            </p>
          )}

          {status.installations.length === 0 ? (
            <div className="tk-blank-card tkgs-setup">
              <h3>Not connected to an organisation yet</h3>
              <p>
                One click, and GitHub asks which repositories to allow. Choose
                <strong> all repositories</strong> and a repo created next month
                is covered without anybody remembering.
              </p>
              {isAdmin && status.installUrl && (
                <a className="tk-btn tk-layer tk-btn-primary" href={status.installUrl}>
                  Connect GitHub organisation
                </a>
              )}
              {!isAdmin && <p className="tk-dim">An admin needs to connect it.</p>}

              {/* The install normally redirects back here with the id. It only
                  does that if the app has a setup URL, and GitHub will not take
                  one pointing at localhost — so on a laptop the redirect never
                  happens. The id is on GitHub at
                  Settings → Applications → the app, in the address bar. */}
              {isAdmin && (
                <div className="tkgs-manual">
                  <p className="tk-dim">
                    Landed back on GitHub instead? Its address ends in the
                    installation id — paste it here.
                  </p>
                  <div className="tkgs-manual-row">
                    <input
                      className="tk-input"
                      inputMode="numeric"
                      placeholder="e.g. 12345678"
                      value={manualId}
                      onChange={(e) => setManualId(e.target.value.replace(/\D/g, ""))}
                    />
                    <button
                      type="button"
                      className="tk-btn tk-layer"
                      disabled={busy || !manualId}
                      onClick={() => act(async () => {
                        const r = await trackerApi.gitConnected(Number(manualId));
                        setManualId("");
                        return r;
                      })}
                    >
                      Connect
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="tkgs-list">
              {status.installations.map((i) => (
                <div key={i.installation_id} className="tkgs-card">
                  <div className="tkgs-card-top">
                    <span className="tkgs-org">{i.account_login}</span>
                    <span className="tk-chip tk-chip-quiet">{i.account_type}</span>
                    {i.suspended && <span className="tk-chip tk-state-late">suspended</span>}
                    <span className={`tk-chip${i.repo_selection === "all" ? "" : " tk-chip-quiet"}`}>
                      {i.repo_selection === "all" ? "all repositories" : "selected repositories"}
                    </span>
                  </div>
                  <dl className="tkc-meta">
                    <dt>Connected</dt><dd>{ago(i.connected_at)}</dd>
                    <dt>Last sync</dt>
                    <dd>{i.last_sync_at ? `${ago(i.last_sync_at)} — ${i.last_sync}` : "not yet"}</dd>
                  </dl>
                  {/* "selected" is the setting that quietly leaves a new repo
                      out, so it gets said rather than left to be discovered. */}
                  {i.repo_selection !== "all" && (
                    <p className="tk-dim">
                      Only the chosen repositories are covered — a new one will
                      need adding on GitHub.
                    </p>
                  )}
                  {isAdmin && (
                    <button
                      type="button"
                      className="tk-btn tk-layer"
                      disabled={busy}
                      onClick={() => act(() => trackerApi.gitDisconnect(i.installation_id))}
                    >
                      Disconnect
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
