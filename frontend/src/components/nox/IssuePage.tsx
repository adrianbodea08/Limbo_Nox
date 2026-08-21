// One issue, on its own page at /tracker/issue/CD-12.
//
// The same card the board opens in a dialog, given the whole window and a URL
// worth pasting into a message. Deliberately the same component: an issue that
// looks one way in a dialog and another on its page is two things to keep in
// step, and they always drift.

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { TopBar, type ShellProps } from "../TopBar";
import { TrackerSearch } from "./TrackerSearch";
import { IssueCard } from "./IssueCard";
import { TrackerRail } from "./TrackerRail";
import { trackerApi, type TrackerIssue, type TrackerMeta, type TrackerUser } from "./model";

export function IssuePage({ shell }: { shell: ShellProps }) {
  const { issueKey = "" } = useParams();
  const nav = useNavigate();
  const [meta, setMeta] = useState<TrackerMeta | null>(null);
  const [users, setUsers] = useState<TrackerUser[]>([]);
  const [issue, setIssue] = useState<TrackerIssue | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      trackerApi.meta(),
      trackerApi.users(),
      trackerApi.issue(issueKey.toUpperCase()),
    ])
      .then(([m, u, i]) => {
        if (!live) return;
        setMeta(m);
        setUsers(u);
        setIssue(i);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [issueKey]);

  const back = () =>
    nav(issue ? `/?project=${issue.project_key}` : "/");

  return (
    <div className="tk-page">
      <TopBar
        title={issueKey.toUpperCase()}
        user={shell.user}
        isAdmin={shell.isAdmin}
        onBack={back}
        backTitle="Tracker"
        onOpenSettings={shell.onOpenSettings}
        onOpenAdmin={shell.onOpenAdmin}
        onLogout={shell.onLogout}
      >
        <TrackerSearch />
      </TopBar>
      {loading && <div className="tk-blank">Loading…</div>}
      {!loading && error && (
        <div className="tk-blank tk-blank-card">
          <h2>Cannot show {issueKey.toUpperCase()}</h2>
          <p>{error}</p>
          <button type="button" className="tk-btn tk-layer" onClick={back}>
            Back to the tracker
          </button>
        </div>
      )}
      {!loading && !error && issue && meta && (
        // The rail stays, as it does on My work: a page without it reads as
        // somewhere you have left the tracker rather than somewhere inside it.
        <div className="tk-shell">
          <TrackerRail
            active={`project:${issue.project_key}`}
            isAdmin={shell.isAdmin}
          />
          <div className="tkc-page-wrap">
            <IssueCard
              mode="edit"
              chrome="page"
              meta={meta}
              issue={issue}
              users={users}
              onClose={back}
              onSaved={setIssue}
            />
          </div>
        </div>
      )}
    </div>
  );
}
