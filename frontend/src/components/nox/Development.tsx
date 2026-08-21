// What git has done about an issue.
//
// Two pieces. In the issue's side column, a **summary** — "1 pull request" and
// the state that matters — because that is the question asked ninety times out
// of a hundred and it should not cost a click. Behind it, a **dialog** with the
// detail: a tab per kind, grouped by repository, a row per branch, commit,
// pull request or build.
//
// The split is the point. A side column has room for one line; a pull request
// has an author, a branch, a state, a build result and a time. Trying to fit
// the second into the first is how a panel becomes unreadable, and hiding the
// first behind the second is how nobody finds it.
//
// Each tab gets its own columns rather than one shared table. A commit has no
// status and a build has no reviewer; one set of columns wide enough for
// everything is mostly empty cells, and an empty cell reads as missing data
// rather than as a question that does not apply.

import { useEffect, useState } from "react";
import { ago } from "./model";
import type { GitRef } from "./model";
import { Check, Clock, X } from "lucide-react";

type Kind = "pr" | "branch" | "commit" | "build";

/** Ranked worst-news-first, so one badge can stand for several pull requests
 *  without hiding the one that needs attention. */
const STATE_RANK: Record<string, number> = { closed: 0, merged: 1, draft: 2, open: 3 };

function when(r: GitRef): number {
  return new Date(r.merged_at || r.opened_at || 0).getTime() || 0;
}

function headline(refs: GitRef[]): { label: string; state: string } | null {
  const count = (n: number, one: string, many: string) =>
    n === 1 ? `1 ${one}` : `${n} ${many}`;

  const prs = refs.filter((r) => r.kind === "pr");
  if (prs.length) {
    const worst = prs.reduce((a, b) =>
      (STATE_RANK[b.state] ?? -1) > (STATE_RANK[a.state] ?? -1) ? b : a);
    return { label: count(prs.length, "pull request", "pull requests"), state: worst.state };
  }
  // No pull request yet: say how far along the work is anyway, because "a
  // branch exists" is the difference between not started and started.
  const branches = refs.filter((r) => r.kind === "branch");
  if (branches.length) {
    return { label: count(branches.length, "branch", "branches"), state: branches[0].state };
  }
  const commits = refs.filter((r) => r.kind === "commit");
  if (commits.length) return { label: count(commits.length, "commit", "commits"), state: "" };
  const builds = refs.filter((r) => r.kind === "build");
  if (builds.length) return { label: count(builds.length, "build", "builds"), state: "" };
  return null;
}

/** The side-column line. Says the one thing, opens the rest. */
export function DevelopmentSummary({ refs, issueKey }: { refs: GitRef[]; issueKey: string }) {
  const [open, setOpen] = useState(false);
  const head = headline(refs);
  if (!head) return null;

  // A red pipeline earns a mark out here. It is the one thing behind the click
  // that changes what somebody does next, and it should not need the click.
  const failing = refs.some((r) => r.checks === "failing" || r.state === "failure");

  return (
    <>
      <button type="button" className="tkd-summary tk-layer" onClick={() => setOpen(true)}>
        <svg width="16" height="16" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
          <path d="M280-80q-33 0-56.5-23.5T200-160v-486q-35-12-57.5-43T120-760q0-50 35-85t85-35q50 0 85 35t35 85q0 40-22.5 71T280-646v406h280v-86q-35-12-57.5-43T480-440q0-50 35-85t85-35q50 0 85 35t35 85q0 40-22.5 71T640-326v86q0 33-23.5 56.5T560-160H280Zm0-680q-17 0-28.5 11.5T240-720q0 17 11.5 28.5T280-680q17 0 28.5-11.5T320-720q0-17-11.5-28.5T280-760Zm320 360q-17 0-28.5 11.5T560-440q0 17 11.5 28.5T600-400q17 0 28.5-11.5T640-440q0-17-11.5-28.5T600-480Z" />
        </svg>
        <span className="tkd-summary-label">{head.label}</span>
        {failing && <span className="tkd-checks tkd-c-failing" title="A build is failing"><X size={16} aria-hidden /></span>}
        {head.state && <span className={`tkd-state tkd-s-${head.state}`}>{head.state}</span>}
      </button>

      {open && (
        <DevelopmentDialog refs={refs} issueKey={issueKey} onClose={() => setOpen(false)} />
      )}
    </>
  );
}

// In the order the work happens: a branch, then commits on it, then the pull
// request, then what CI made of it.
const TABS: { id: Kind; label: string }[] = [
  { id: "branch", label: "Branches" },
  { id: "commit", label: "Commits" },
  { id: "pr", label: "Pull requests" },
  { id: "build", label: "Builds" },
];

interface Column {
  head: string;
  width?: number;
  cell: (r: GitRef) => React.ReactNode;
}

function link(r: GitRef, text: React.ReactNode, className: string) {
  // A ref with no URL came from a payload that carried none. A dead anchor for
  // it would look identical to a live one.
  if (!r.url) return <span className={className}>{text}</span>;
  return (
    <a className={className} href={r.url} target="_blank" rel="noopener noreferrer">
      {text}
    </a>
  );
}

const AUTHOR: Column = {
  head: "Author", width: 132,
  cell: (r) => <span className="tk-dim">{r.author || "—"}</span>,
};
const STATUS: Column = {
  head: "Status", width: 110,
  cell: (r) => (r.state
    ? <span className={`tkd-state tkd-s-${r.state}`}>{r.state}</span>
    : <span className="tk-dim">—</span>),
};
const UPDATED: Column = {
  head: "Updated", width: 104,
  // ago("") reads "Invalid Date"; a ref we only know the name of has no time.
  cell: (r) => (
    <span className="tk-dim tk-num">
      {when(r) ? ago(new Date(when(r)).toISOString()) : "—"}
    </span>
  ),
};
const BRANCH: Column = {
  head: "Branch", width: 220,
  cell: (r) => (r.branch
    ? <span className="tkd-branch">{r.branch}</span>
    : <span className="tk-dim">—</span>),
};

const COLUMNS: Record<Kind, Column[]> = {
  pr: [
    AUTHOR,
    { head: "ID", width: 68, cell: (r) => link(r, `#${r.ref}`, "tkd-id") },
    {
      head: "Summary",
      cell: (r) => (
        <>
          {link(r, r.title || r.ref, "tkd-title")}
          {r.branch && <span className="tkd-branch">{r.branch}</span>}
        </>
      ),
    },
    STATUS,
    {
      // Its own column, not folded into status: a merged pull request with a
      // red build is a real thing.
      head: "Checks", width: 68,
      cell: (r) => (r.checks !== "none"
        ? (
          <span className={`tkd-checks tkd-c-${r.checks}`} title={`Checks ${r.checks}`}>
            {r.checks === "passing" ? <Check size={16} aria-hidden />
              : r.checks === "failing" ? <X size={16} aria-hidden />
              : <Clock size={16} aria-hidden />}
          </span>
        )
        : <span className="tk-dim">—</span>),
    },
    UPDATED,
  ],
  branch: [
    { ...AUTHOR, head: "Last commit by" },
    { head: "Branch", cell: (r) => link(r, r.ref, "tkd-title tkd-mono") },
    {
      // "Exists" is not news — every branch exists. How far past the default
      // branch it has run is the thing worth a column.
      head: "Against the default branch", width: 190,
      cell: (r) => (r.title ? <span>{r.title}</span> : <span className="tk-dim">—</span>),
    },
    STATUS,
    UPDATED,
  ],
  commit: [
    AUTHOR,
    { head: "Commit", width: 96, cell: (r) => link(r, r.ref.slice(0, 7), "tkd-id") },
    { head: "Message", cell: (r) => link(r, r.title || r.ref.slice(0, 7), "tkd-title") },
    BRANCH,
    { ...UPDATED, head: "Committed" },
  ],
  build: [
    { ...AUTHOR, head: "Triggered by" },
    { head: "Workflow", cell: (r) => link(r, r.title || r.ref, "tkd-title") },
    BRANCH,
    STATUS,
    UPDATED,
  ],
};

/** The detail, grouped the way somebody reads it: by repository first, because
 *  "which repo was that in" is the question that comes before any other. */
function DevelopmentDialog({
  refs, issueKey, onClose,
}: {
  refs: GitRef[];
  issueKey: string;
  onClose: () => void;
}) {
  // Open on whichever tab has something. A dialog that opens empty when the
  // answer is one tab across is a dialog that looks broken.
  const first = TABS.find((t) => refs.some((r) => r.kind === t.id))?.id ?? "pr";
  const [tab, setTab] = useState<Kind>(first);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);

  const shown = refs.filter((r) => r.kind === tab).sort((a, b) => when(b) - when(a));
  const repos = [...new Set(shown.map((r) => r.repo))].sort();
  const columns = COLUMNS[tab];

  return (
    <div className="tkc-scrim tkd-scrim" onClick={onClose}>
      <div className="tkd" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <header className="tkd-head">
          <h2>Development {issueKey}</h2>
          <button type="button" className="tk-x tk-layer" onClick={onClose} aria-label="Close"><X size={16} aria-hidden /></button>
        </header>

        <div className="tkd-tabs">
          {TABS.map((t) => {
            const n = refs.filter((r) => r.kind === t.id).length;
            return (
              <button
                key={t.id}
                type="button"
                className={`tkd-tab tk-layer${tab === t.id ? " on" : ""}`}
                disabled={!n}
                onClick={() => setTab(t.id)}
              >
                {t.label}
                {!!n && <span className="tkd-tab-n">{n}</span>}
              </button>
            );
          })}
        </div>

        <div className="tkd-body">
          {repos.map((repo) => (
            <section key={repo} className="tkd-repo">
              <header className="tkd-repo-head">
                <span className="tkd-repo-name">{repo}</span>
                <span className="tk-dim">(GitHub)</span>
              </header>

              <div className="tkd-scroll">
                <table className="tk-table tkd-table">
                  <thead>
                    <tr>
                      {columns.map((c) => (
                        <th key={c.head} style={c.width ? { width: c.width } : undefined}>
                          {c.head}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.filter((r) => r.repo === repo).map((r) => (
                      <tr key={r.id}>
                        {columns.map((c) => <td key={c.head}>{c.cell(r)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          {!shown.length && <p className="tk-dim tkd-none">Nothing here yet.</p>}
        </div>

        {/* Where the link came from. A match on a branch name is the one most
            likely to be wrong, and this is the only place that says which. */}
        <footer className="tkd-foot">
          <span className="tk-dim">
            Linked by the issue key in{" "}
            {[...new Set(refs.map((r) => r.found_in).filter(Boolean))].join(", ") || "the title"}.
          </span>
        </footer>
      </div>
    </div>
  );
}
