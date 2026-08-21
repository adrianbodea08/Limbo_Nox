// Releases — what ships, when, and what is in it.
//
// One release spans projects, because a delivery does. The page is built round
// the three questions a release actually gets asked: is the work done, has it
// shipped, and what is left on the runbook before it can.

import { useEffect, useState } from "react";
import { M3DatePicker } from "../M3DatePicker";
import { M3Select } from "../M3Select";
import { Person } from "./Face";
import { IssueKey } from "./IssueKey";
import { ReleaseTimeline } from "./ReleaseTimeline";
import { ago, trackerApi } from "./model";
import { M3Segmented } from "../M3Segmented";
import { ArrowLeft, X } from "lucide-react";
import { TypeGlyph } from "./TypeGlyph";
import type {
  ReleaseDetail, ReleaseSummary, TrackerComponent, UnreleasedIssue,
} from "./model";

interface Props {
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}

export function Releases({ selectedId, onSelect }: Props) {
  const [list, setList] = useState<ReleaseSummary[]>([]);
  const [detail, setDetail] = useState<ReleaseDetail | null>(null);
  const [components, setComponents] = useState<TrackerComponent[]>([]);
  const [creating, setCreating] = useState(false);
  // A timeline answers "what overlaps and what is late"; the list answers
  // "what exists". Different questions, so it is a view switch, not a sort.
  const [view, setView] = useState<"timeline" | "list">("timeline");
  const [error, setError] = useState("");

  async function reload() {
    setList(await trackerApi.releases());
  }

  useEffect(() => {
    reload().catch((e) => setError(String(e)));
    trackerApi.components().then(setComponents).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedId === null) {
      setDetail(null);
      return;
    }
    trackerApi
      .release(selectedId)
      .then(setDetail)
      .catch((e) => {
        // The release in the URL is gone — deleted, or the demo data was
        // regenerated underneath a stale link. Fall back to the list instead of
        // sitting on an error nothing can clear.
        const message = e instanceof Error ? e.message : String(e);
        if (message.toLowerCase().includes("no release")) {
          setDetail(null);
          onSelect(null);
          setError("That release no longer exists.");
        } else {
          setError(message);
        }
      });
  }, [selectedId]);

  function apply(next: ReleaseDetail) {
    setDetail(next);
    reload().catch(() => {});
  }

  async function guard(action: () => Promise<ReleaseDetail>) {
    setError("");
    try {
      apply(await action());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (detail) {
    return (
      <ReleaseDetailView
        release={detail}
        components={components}
        error={error}
        onBack={() => onSelect(null)}
        onAction={guard}
        onComponentsChanged={() => trackerApi.components().then(setComponents)}
      />
    );
  }

  return (
    <div className="tk-releases">
      <div className="tk-rel-head">
        <h2>Releases</h2>
        <M3Segmented
          label="How to show releases"
          value={view}
          options={[
            { value: "timeline", label: "Timeline" },
            { value: "list", label: "List" },
          ] as const}
          onChange={setView}
        />
        <button type="button" className="tk-btn tk-layer tk-btn-primary" onClick={() => setCreating(true)}>
          New release
        </button>
      </div>
      {error && <p className="tk-error">{error}</p>}

      {view === "timeline" && <ReleaseTimeline onOpen={onSelect} />}

      {view === "list" && list.length === 0 && <p className="tk-dim">No releases yet.</p>}
      <div className="tk-rel-list" hidden={view !== "list"}>
        {list.map((r) => {
          const pct = r.counts.total ? Math.round((r.counts.done / r.counts.total) * 100) : 0;
          return (
            <button key={r.id} type="button" className="tk-rel-card tk-layer" onClick={() => onSelect(r.id)}>
              <div className="tk-rel-card-top">
                <span className="tk-rel-name">{r.name}</span>
                <span className={`tk-state tk-state-${r.state}`}>{r.state.replace("_", " ")}</span>
                <span className="tk-chip tk-chip-quiet">{r.kind}</span>
              </div>
              {/* Progress by status category, which is why category is a column
                  on statuses rather than a convention in the status name. */}
              <div className="tk-rel-bar" title={`${r.counts.done} of ${r.counts.total} done`}>
                <span className="tk-rel-bar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="tk-rel-card-foot">
                <span className="tk-dim">
                  {r.counts.done}/{r.counts.total} done
                </span>
                <span className="tk-dim">
                  {r.shipped_at
                    ? `shipped ${ago(r.shipped_at)}`
                    : r.planned_at
                      ? `planned ${new Date(r.planned_at).toLocaleDateString()}`
                      : "no date"}
                </span>
              </div>
            </button>
          );
        })}
      </div>

      {creating && (
        <NewRelease
          onCancel={() => setCreating(false)}
          onCreated={(r) => {
            setCreating(false);
            reload();
            onSelect(r.id);
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ detail --

function ReleaseDetailView({
  release,
  components,
  error,
  onBack,
  onAction,
  onComponentsChanged,
}: {
  release: ReleaseDetail;
  components: TrackerComponent[];
  error: string;
  onBack: () => void;
  onAction: (fn: () => Promise<ReleaseDetail>) => Promise<void>;
  onComponentsChanged: () => void;
}) {
  const [actionTitle, setActionTitle] = useState("");
  const [component, setComponent] = useState("");
  const [version, setVersion] = useState("");
  const [notes, setNotes] = useState(release.notes);
  const [notesOpen, setNotesOpen] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => setNotes(release.notes), [release.id, release.notes]);

  const pct = release.counts.total
    ? Math.round((release.counts.done / release.counts.total) * 100)
    : 0;
  const free = components.filter(
    (c) => !release.artifacts.some((a) => a.component_id === c.id),
  );

  return (
    <div className="tk-releases">
      <div className="tk-rel-head">
        <button type="button" className="tk-btn tk-layer" onClick={onBack}><ArrowLeft size={16} aria-hidden /> Releases</button>
        <h2>{release.name}</h2>
        <span className={`tk-state tk-state-${release.state}`}>
          {release.state.replace("_", " ")}
        </span>
        <span className="tk-chip tk-chip-quiet">{release.kind}</span>
      </div>
      {error && <p className="tk-error">{error}</p>}

      <div className="tk-rel-grid">
        <section className="tk-rel-block">
          <h3>Progress</h3>
          <div className="tk-rel-bar tk-rel-bar-lg">
            <span className="tk-rel-bar-fill" style={{ width: `${pct}%` }} />
          </div>
          <p className="tk-dim">
            {release.counts.done} done · {release.counts.in_progress} in progress ·{" "}
            {release.counts.todo} to do
          </p>
          <table className="tk-mini">
            <tbody>
              {release.byProject.map((p) => (
                <tr key={p.project}>
                  <td className="tk-rail-key">{p.project}</td>
                  <td className="tk-num">
                    {p.done}/{p.total}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="tk-rel-block">
          <h3>Artifacts</h3>
          {/* Each ships on its own date. Mobile ships when Apple says so, and
              that staggering is the thing the old fixVersion tagging faked. */}
          {release.artifacts.length === 0 && <p className="tk-dim">Nothing to ship listed yet.</p>}
          {release.artifacts.map((a) => (
            <div key={a.id} className="tk-artifact">
              <span className="tk-artifact-name">{a.component_name}</span>
              <span className="tk-dim tk-num">{a.version || "—"}</span>
              <button
                type="button"
                className={`tk-ship tk-layer${a.state === "shipped" ? " tk-shipped" : ""}`}
                onClick={() =>
                  onAction(() => trackerApi.shipArtifact(a.id, a.state !== "shipped"))
                }
              >
                {a.state === "shipped" ? `✓ shipped ${a.shipped_at ? ago(a.shipped_at) : ""}` : "Mark shipped"}
              </button>
            </div>
          ))}
          {free.length > 0 && (
            <div className="tk-artifact-add">
              <M3Select
                value={component}
                width={190}
                placeholder="Add component…"
                options={free.map((c) => ({ value: String(c.id), label: c.name, hint: c.repo }))}
                onChange={setComponent}
              />
              <input
                className="tk-search"
                style={{ width: 110 }}
                placeholder="Version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
              />
              <button
                type="button"
                className="tk-btn tk-layer"
                disabled={!component}
                onClick={() =>
                  onAction(async () => {
                    const next = await trackerApi.addArtifact(release.id, Number(component), version);
                    setComponent("");
                    setVersion("");
                    return next;
                  })
                }
              >
                Add
              </button>
            </div>
          )}
          <NewComponent onCreated={onComponentsChanged} />
        </section>

        <section className="tk-rel-block">
          <h3>Runbook</h3>
          {/* An ordered checklist with an owner and a done-at, so "what is left
              before we ship" is a query rather than a conversation. */}
          {release.actions.map((a) => (
            <label key={a.id} className={`tk-runbook${a.done_at ? " tk-runbook-done" : ""}`}>
              <input
                type="checkbox"
                checked={!!a.done_at}
                onChange={() => onAction(() => trackerApi.completeAction(a.id, !a.done_at))}
              />
              <span className="tk-runbook-title">{a.title}</span>
              {a.owner_name && <Person size={20} name={a.owner_name} avatar={null} />}
              <button
                type="button"
                className="tk-x tk-layer"
                onClick={(e) => {
                  e.preventDefault();
                  onAction(() => trackerApi.removeAction(a.id));
                }}
              ><X size={16} aria-hidden /></button>
            </label>
          ))}
          <div className="tk-artifact-add">
            <input
              className="tk-search"
              style={{ flex: 1 }}
              placeholder="Add a step…"
              value={actionTitle}
              onChange={(e) => setActionTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" || !actionTitle.trim()) return;
                onAction(async () => {
                  const next = await trackerApi.addAction(release.id, actionTitle.trim());
                  setActionTitle("");
                  return next;
                });
              }}
            />
          </div>
        </section>
      </div>

      <section className="tk-rel-block">
        <div className="tk-rel-notes-head">
          <h3>Release notes</h3>
          <button
            type="button"
            className="tk-btn tk-layer"
            onClick={async () => {
              const draft = await trackerApi.draftNotes(release.id);
              setNotes(draft);
              setNotesOpen(true);
            }}
          >
            Generate from issues
          </button>
          <button
            type="button"
            className="tk-btn tk-layer tk-btn-primary"
            disabled={notes === release.notes}
            onClick={() => onAction(() => trackerApi.patchRelease(release.id, { notes }))}
          >
            Save
          </button>
        </div>
        {/* Generated, then edited before publishing — the draft is a starting
            point, so saving is always an explicit act. */}
        <textarea
          className="tk-notes"
          rows={notesOpen || notes ? 12 : 4}
          value={notes}
          placeholder="Generate a draft from the issues, then edit it."
          onChange={(e) => setNotes(e.target.value)}
        />
      </section>

      <section className="tk-rel-block">
        <div className="tk-rel-notes-head">
          <h3>
            Issues <span className="tk-col-count">{release.issues.length}</span>
          </h3>
          {/* The pool is issues on no release at all — an issue belonging to
              two releases is a question nobody has answered, and a picker is
              the wrong place for it to first come up. */}
          <button type="button" className="tks-mini tk-layer tkr-add"
                  title="Add issues that are not on a release yet"
                  onClick={() => setAdding(true)}>
            +
          </button>
        </div>
        <div className="tk-table-wrap">
          <table className="tk-table">
            <tbody>
              {release.issues.map((i) => (
                <tr key={i.id}>
                  <td className="tk-cell-key">
                    <span className="tk-keyline">
                      <TypeGlyph icon={i.type_icon} colour={i.type_colour} />
                      <IssueKey issueKey={i.key} />
                    </span>
                  </td>
                  <td className="tk-cell-sum">{i.summary}</td>
                  <td>
                    <span
                      className="tk-chip"
                      style={{ borderColor: i.status_colour, color: i.status_colour }}
                    >
                      {i.status_name}
                    </span>
                  </td>
                  <td className="tk-dim">{i.assignee_name ?? "Unassigned"}</td>
                  <td>
                    <button
                      type="button"
                      className="tk-x tk-layer"
                      title="Take off this release"
                      onClick={() => onAction(() => trackerApi.removeReleaseIssue(release.id, i.id))}
                    ><X size={16} aria-hidden /></button>
                  </td>
                </tr>
              ))}
              {release.issues.length === 0 && (
                <tr>
                  <td className="tk-empty-row">Nothing on this release yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {adding && (
          <AddIssues
            release={release}
            onCancel={() => setAdding(false)}
            onAdded={(ids) => {
              setAdding(false);
              onAction(async () => {
                const r = await trackerApi.addReleaseIssues(release.id, { issue_ids: ids });
                return r.release;
              });
            }}
          />
        )}
      </section>

      <section className="tk-rel-block">
        <h3>History</h3>
        {(release.activity ?? []).map((ev) => (
          <div key={ev.batchId} className="tk-event">
            <span className="tk-event-who">
              <Person size={18} name={ev.actorName ?? ev.actorKind} avatar={ev.actorAvatar} />
            </span>
            <span className="tk-event-what">
              {ev.kind === "created" && "created this release"}
              {ev.kind === "issue_added" && `added ${ev.changes.length} issue(s)`}
              {ev.kind === "issue_removed" && `removed ${ev.changes.length} issue(s)`}
              {ev.kind === "artifact_added" && "added an artifact"}
              {ev.kind === "artifact_shipped" && "shipped an artifact"}
              {ev.kind === "artifact_unshipped" && "un-shipped an artifact"}
              {ev.kind === "action_added" && `added “${ev.payload?.title ?? "a step"}”`}
              {ev.kind === "action_done" && `ticked off “${ev.payload?.title ?? "a step"}”`}
              {ev.kind === "action_reopened" && `reopened “${ev.payload?.title ?? "a step"}”`}
              {ev.kind === "action_removed" && `removed “${ev.payload?.title ?? "a step"}”`}
              {ev.kind === "field_changed" &&
                ev.changes.map((c, i) => (
                  <span key={c.field}>
                    {i > 0 && ", "}
                    changed <strong>{c.field}</strong> to “{c.to}”
                  </span>
                ))}
            </span>
            <span className="tk-dim tk-event-when">{ago(ev.at)}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ dialogs --

/** Pick from the issues that are on no release yet.
 *
 *  Searchable and multiple, because building a release is choosing eight things
 *  out of forty rather than opening a dropdown eight times. */
function AddIssues({
  release, onCancel, onAdded,
}: {
  release: ReleaseDetail;
  onCancel: () => void;
  onAdded: (ids: number[]) => void;
}) {
  const [rows, setRows] = useState<UnreleasedIssue[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    trackerApi.unreleasedIssues(query, release.kind)
      .then((r) => live && setRows(r))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => { live = false; };
  }, [query]);

  function toggle(id: number) {
    const next = new Set(picked);
    next.has(id) ? next.delete(id) : next.add(id);
    setPicked(next);
  }

  return (
    <div className="tkc-scrim" onClick={onCancel}>
      <div className="tkc tkr-pick" onClick={(e) => e.stopPropagation()}>
        <header className="tkc-head">
          <div className="tkc-head-l">
            <div className="tkc-crumb">{release.name.toUpperCase()}</div>
            <h2 className="tkc-title">Add issues</h2>
          </div>
          <button type="button" className="tk-x tk-layer" onClick={onCancel} aria-label="Close"><X size={16} aria-hidden /></button>
        </header>

        <div className="tks-body">
          <input
            className="tkc-input"
            autoFocus
            placeholder="Search key or summary…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <p className="tk-dim">
            Issues not yet on a <strong>{release.kind}</strong> release. An issue can be on one
            release of each kind, so work already lined up for a different kind is still here.
            Open work first.
          </p>
          {error && <div className="tkc-err">{error}</div>}
          {!rows && <p className="tk-dim">Loading…</p>}
          {rows && rows.length === 0 && (
            <p className="tk-dim">
              {query
                ? `Nothing matches “${query}”.`
                : `Everything is already on a ${release.kind} release.`}
            </p>
          )}

          <div className="tkr-pick-list">
            {(rows ?? []).map((i) => (
              <label key={i.id} className={`tkr-pick-row tk-layer${picked.has(i.id) ? " on" : ""}`}>
                <input type="checkbox" checked={picked.has(i.id)} onChange={() => toggle(i.id)} />
                <TypeGlyph icon={i.type_icon} colour={i.type_colour} />
                <IssueKey issueKey={i.key} className="tkq-key" />
                <span className="tkr-pick-sum">{i.summary}</span>
                <span className="tk-chip" style={{ borderColor: i.status_colour, color: i.status_colour }}>
                  {i.status_name}
                </span>
                {i.assignee_name && <Person size={20} name={i.assignee_name} avatar={i.assignee_avatar} />}
              </label>
            ))}
          </div>
        </div>

        <footer className="tkc-foot">
          <span className="tk-dim">{picked.size} selected</span>
          <div className="tkc-foot-r">
            <button type="button" className="tk-btn tk-layer" onClick={onCancel}>Cancel</button>
            <button type="button" className="tk-btn tk-layer tk-btn-primary"
                    disabled={!picked.size}
                    onClick={() => onAdded([...picked])}>
              Add {picked.size || ""} to {release.name}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function NewRelease({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (r: ReleaseSummary) => void;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("standard");
  const [planned, setPlanned] = useState("");
  const [error, setError] = useState("");

  // Not an enum in the database either: we do not know the full set of release
  // kinds yet, and guessing it wrong costs a migration.
  const KINDS = ["standard", "hotfix", "mobile", "infra", "content"];

  return (
    <div className="tk-modal-back" onClick={onCancel}>
      <div className="tk-modal" onClick={(e) => e.stopPropagation()}>
        <h2>New release</h2>
        {error && <p className="tk-error">{error}</p>}
        <input
          className="tk-input"
          autoFocus
          placeholder="Name — B-34, Android 33.1, hotfix 34.0.1"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="tk-modal-row">
          <M3Select
            value={kind}
            width={190}
            options={KINDS.map((k) => ({ value: k, label: k }))}
            onChange={setKind}
          />
          {/* Not <input type="date">: that paints the operating system's
              calendar, which is a different shape and a different set of
              colours on every machine, and the only control here that ignores
              the theme. */}
          <M3DatePicker value={planned} onChange={setPlanned} width={210}
                        placeholder="Planned date" />
        </div>
        <div className="tk-modal-actions">
          <button type="button" className="tk-btn tk-layer" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="tk-btn tk-layer tk-btn-primary"
            disabled={!name.trim()}
            onClick={async () => {
              try {
                onCreated(
                  await trackerApi.createRelease({
                    name: name.trim(),
                    kind,
                    planned_at: planned ? new Date(planned).toISOString() : null,
                  }),
                );
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Create
          </button>
        </div>
      </div>
    </div>
  );
}

function NewComponent({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [repo, setRepo] = useState("");

  if (!open) {
    return (
      <button type="button" className="tk-link tk-layer" onClick={() => setOpen(true)}>
        + new component
      </button>
    );
  }
  return (
    <div className="tk-artifact-add">
      <input className="tk-search" style={{ width: 90 }} placeholder="key"
             value={key} onChange={(e) => setKey(e.target.value)} />
      <input className="tk-search" style={{ width: 130 }} placeholder="Name"
             value={name} onChange={(e) => setName(e.target.value)} />
      <input className="tk-search" style={{ width: 150 }} placeholder="org/repo"
             value={repo} onChange={(e) => setRepo(e.target.value)} />
      <button
        type="button"
        className="tk-btn tk-layer"
        disabled={!key.trim() || !name.trim()}
        onClick={async () => {
          await trackerApi.createComponent({ key: key.trim(), name: name.trim(), repo: repo.trim() });
          setKey("");
          setName("");
          setRepo("");
          setOpen(false);
          onCreated();
        }}
      >
        Add
      </button>
    </div>
  );
}
