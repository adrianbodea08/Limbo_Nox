// Project settings — admin only, on its own page.
//
// A page rather than a dialog because none of this is a quick decision: the
// flow grid for AI First Development is seventeen columns wide, and the field
// library is a list somebody reads rather than glances at. A dialog would have
// meant scrolling a 92vh box on every one of them.
//
// Five things live here because they are the five that differ per board: the
// columns, the moves between them, who can see it, which types it offers with
// which fields, and the fields themselves.
//
// Every change posts and gets the whole settings object back rather than
// patching a local copy. These changes interact — removing a column drops its
// transitions with it — and a client that patched its own copy would drift out
// of step with the database within about three clicks.
//
// The refusals matter as much as the changes: a column with issues in it will
// not be removed, a type still in use will not be dropped, and a restricted
// project cannot be left with nobody on the list. Each says what it refused on.

import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { M3Select } from "../M3Select";
import { TopBar, type ShellProps } from "../TopBar";
import { TrackerRail } from "./TrackerRail";
import { TrackerSearch } from "./TrackerSearch";
import { FlowDiagram } from "./FlowDiagram";
import { trackerApi } from "./model";
import type { FieldDefinition, ProjectSettingsData, TrackerUser } from "./model";
import { M3Segmented } from "../M3Segmented";
import { X } from "lucide-react";
import { GlyphPicker, TypeGlyph } from "./TypeGlyph";

type Tab = "columns" | "flow" | "access" | "types" | "fields";

const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "columns", label: "Columns", hint: "Which statuses this board shows, and in what order" },
  { id: "flow", label: "Flow", hint: "Which moves the workflow allows" },
  { id: "access", label: "Who can see it", hint: "Everyone, or named tags and people" },
  { id: "types", label: "Issue types", hint: "The types this board offers, and the fields each asks for" },
  { id: "fields", label: "Fields", hint: "Every field that exists, where it is used, and whether anyone fills it in" },
];


/** The page: resolves the project from the URL and owns the data. */
export function ProjectSettingsPage({ shell }: { shell: ShellProps }) {
  const { projectKey = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const [projectId, setProjectId] = useState<number | null>(null);
  const [users, setUsers] = useState<TrackerUser[]>([]);
  const [error, setError] = useState("");

  const tab = (TABS.find((t) => t.id === params.get("tab"))?.id ?? "columns") as Tab;

  useEffect(() => {
    Promise.all([trackerApi.meta(), trackerApi.users()])
      .then(([meta, u]) => {
        setUsers(u);
        const found = meta.projects.find((p) => p.key === projectKey.toUpperCase());
        if (!found) setError(`No project ${projectKey.toUpperCase()}`);
        else setProjectId(found.id);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [projectKey]);

  const back = () => nav(`/?project=${projectKey.toUpperCase()}`);

  return (
    <div className="tk-page">
      <TopBar
        title={`${projectKey.toUpperCase()} settings`}
        user={shell.user}
        isAdmin={shell.isAdmin}
        onOpenSettings={shell.onOpenSettings}
        onOpenAdmin={shell.onOpenAdmin}
        onLogout={shell.onLogout}
      >
        <TrackerSearch />
      </TopBar>

      {/* The rail stays, here as everywhere: settings are somewhere inside the
          tracker, not somewhere you have left it for. */}
      <div className="tk-shell">
        <TrackerRail
          active={`project:${projectKey.toUpperCase()}`}
          isAdmin={shell.isAdmin}
        />

        <div className="tks-main">
          {error && (
            <div className="tk-blank tk-blank-card">
              <h2>Cannot open settings</h2>
              <p>{error}</p>
              <button type="button" className="tk-btn tk-layer" onClick={back}>
                Back to the tracker
              </button>
            </div>
          )}
          {!error && projectId === null && <div className="tk-blank">Loading…</div>}
          {!error && projectId !== null && (
            <ProjectSettings
              projectId={projectId}
              users={users}
              tab={tab}
              onTab={(t) => {
                const next = new URLSearchParams(params);
                next.set("tab", t);
                setParams(next, { replace: true });
              }}
              onChanged={() => {}}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function ProjectSettings({
  projectId,
  users,
  tab,
  onTab,
  onChanged,
}: {
  projectId: number;
  users: TrackerUser[];
  tab: Tab;
  onTab: (t: Tab) => void;
  onChanged: () => void;
}) {
  const [data, setData] = useState<ProjectSettingsData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    trackerApi.projectSettings(projectId).then(setData).catch((e) => setError(String(e)));
  }, [projectId]);

  async function act(fn: () => Promise<ProjectSettingsData>) {
    setBusy(true);
    setError("");
    try {
      setData(await fn());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tks-page">
      <header className="tks-page-head">
        <div>
          <div className="tkc-crumb">PROJECT SETTINGS</div>
          <h1 className="tks-page-title">{data?.project.name ?? "…"}</h1>
          {data && <p className="tk-dim">{data.project.description}</p>}
        </div>
        <span className="tk-dim">Changes save as you make them.</span>
      </header>

      <nav className="tks-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            // The strip scrolls on a narrow window, so the tab you are on can
            // be off the end of it — arriving on Fields from a link showed
            // four other tabs and no indicator at all. `inline` only: `block`
            // would scroll the page as well and take the heading with it.
            ref={tab === t.id ? (el) => el?.scrollIntoView({ inline: "nearest", block: "nearest" }) : undefined}
            type="button"
            title={t.hint}
            className={`tks-tab tk-layer${tab === t.id ? " on" : ""}`}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {error && <div className="tkc-err" onClick={() => setError("")}>{error} <X size={14} aria-hidden /></div>}

      <div className="tks-body">
        {!data && <p className="tk-dim">Loading…</p>}
        {data && tab === "columns" && <Columns data={data} busy={busy} act={act} />}
        {data && tab === "flow" && <Flow data={data} busy={busy} act={act} />}
        {data && tab === "access" && <Access data={data} users={users} busy={busy} act={act} />}
        {data && tab === "types" && <Types data={data} busy={busy} act={act} />}
        {data && tab === "fields" && <Fields onChanged={() => act(() => trackerApi.projectSettings(projectId))} />}
      </div>
    </div>
  );
}

type Act = (fn: () => Promise<ProjectSettingsData>) => Promise<void>;

// ------------------------------------------------------------------ columns --

function Columns({ data, busy, act }: { data: ProjectSettingsData; busy: boolean; act: Act }) {
  // Local while dragging, saved on drop. A drag is a whole rearrangement —
  // columns and statuses land together — so the write is one atomic layout
  // rather than a dozen little ones racing each other.
  const [columns, setColumns] = useState<DraftColumn[]>([]);
  const [hidden, setHidden] = useState<DraftStatus[]>([]);
  const [dragging, setDragging] = useState<{ status: DraftStatus; from: string } | null>(null);
  const [dragCol, setDragCol] = useState<number | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    setColumns(data.workflow.board.columns.map((c) => ({ ...c, statuses: [...c.statuses] })));
    setHidden([...data.workflow.board.hidden]);
  }, [data]);

  function save(next: DraftColumn[]) {
    setColumns(next);
    act(() => trackerApi.setBoard(data.project.id,
      next.map((c) => ({ name: c.name, status_ids: c.statuses.map((s) => s.id) }))));
  }

  /** Move a status into a column, or out to hidden. */
  function drop(target: string) {
    if (!dragging) return;
    const { status, from } = dragging;
    setDragging(null);
    setOver(null);
    if (from === target) return;

    const next = columns.map((c) => ({
      ...c,
      statuses: c.statuses.filter((s) => s.id !== status.id),
    }));
    if (target === "hidden") {
      setHidden([...hidden.filter((s) => s.id !== status.id), status]);
      save(next);
      return;
    }
    const column = next.find((c) => String(c.id) === target);
    if (!column) return;
    column.statuses.push(status);
    setHidden(hidden.filter((s) => s.id !== status.id));
    save(next);
  }

  /** Reorder columns by dragging one onto another. */
  function dropColumn(targetId: number) {
    if (dragCol === null || dragCol === targetId) return setDragCol(null);
    const next = [...columns];
    const from = next.findIndex((c) => c.id === dragCol);
    const to = next.findIndex((c) => c.id === targetId);
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setDragCol(null);
    save(next);
  }

  const total = columns.reduce((n, c) => n + c.issue_count, 0);
  const hiddenCount = hidden.reduce((n, s) => n + s.issue_count, 0);

  return (
    <div className="tks-pane tks-pane-wide">
      <p className="tk-dim">
        A column holds one status or several. Drag a status between columns, drag a column by its
        name to reorder, and drop anything into <strong>Hidden</strong> to keep it off the board.
        Changes apply to everyone.
      </p>

      <div className="tkb">
        {/* Hidden first, and always present: the pile is only meaningful if
            there is somewhere obvious to drag to. */}
        <section
          className={`tkb-col tkb-hidden${over === "hidden" ? " tkb-over" : ""}`}
          onDragOver={(e) => { if (dragging) { e.preventDefault(); setOver("hidden"); } }}
          onDragLeave={() => setOver((o) => (o === "hidden" ? null : o))}
          onDrop={(e) => { e.preventDefault(); drop("hidden"); }}
        >
          <header>
            <span className="tkb-col-name">Hidden statuses</span>
            {hiddenCount > 0 && <span className="tk-col-count">{hiddenCount}</span>}
          </header>
          <p className="tk-dim tkb-note">Issues in these statuses are not on the board.</p>
          {hidden.map((st) => (
            <StatusChip key={st.id} status={st} busy={busy}
                        onDragStart={() => setDragging({ status: st, from: "hidden" })}
                        onDragEnd={() => setDragging(null)} />
          ))}
          {hidden.length === 0 && <p className="tkb-empty">Nothing hidden.</p>}
        </section>

        {columns.map((column) => (
          <section
            key={column.id}
            className={`tkb-col${over === String(column.id) ? " tkb-over" : ""}${dragCol === column.id ? " tkb-dragging" : ""}`}
            onDragOver={(e) => {
              if (dragging || dragCol !== null) { e.preventDefault(); setOver(String(column.id)); }
            }}
            onDragLeave={() => setOver((o) => (o === String(column.id) ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging) drop(String(column.id));
              else dropColumn(column.id);
            }}
          >
            <header
              draggable={!busy && renaming !== column.id}
              onDragStart={() => setDragCol(column.id)}
              onDragEnd={() => { setDragCol(null); setOver(null); }}
              title="Drag to reorder this column"
            >
              <span className="tks-grip" aria-hidden>⠿</span>
              {renaming === column.id ? (
                <input
                  className="tkc-input tkc-input-sm"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={() => {
                    setRenaming(null);
                    if (name.trim() && name !== column.name) {
                      save(columns.map((c) => c.id === column.id ? { ...c, name: name.trim() } : c));
                    }
                  }}
                  onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                />
              ) : (
                <button type="button" className="tkb-col-name tk-layer"
                        title="Rename this column"
                        onClick={() => { setRenaming(column.id); setName(column.name); }}>
                  {column.name}
                </button>
              )}
              {column.issue_count > 0 && <span className="tk-col-count">{column.issue_count}</span>}
              <button
                type="button"
                className="tks-mini tks-danger tk-layer"
                disabled={busy || columns.length === 1}
                title={columns.length === 1
                  ? "A board needs at least one column"
                  : "Remove the column — its statuses become hidden"}
                onClick={() => {
                  setHidden([...hidden, ...column.statuses]);
                  save(columns.filter((c) => c.id !== column.id));
                }}
              ><X size={16} aria-hidden /></button>
            </header>

            {column.statuses.map((st) => (
              <StatusChip key={st.id} status={st} busy={busy}
                          onDragStart={() => setDragging({ status: st, from: String(column.id) })}
                          onDragEnd={() => setDragging(null)} />
            ))}
            {column.statuses.length === 0 && (
              <p className="tkb-empty">No status — this column will always be empty.</p>
            )}
          </section>
        ))}

        <button
          type="button"
          className="tkb-add tk-layer"
          disabled={busy}
          onClick={() => save([...columns, { id: -Date.now(), name: "New column",
                                             position: columns.length, statuses: [], issue_count: 0 }])}
        >
          + Add column
        </button>
      </div>

      <p className="tk-dim">
        {total} issue{total === 1 ? "" : "s"} on the board
        {hiddenCount > 0 && `, ${hiddenCount} hidden`}. Statuses come from the workflow — add one
        on the Flow tab first if it is not here.
      </p>
    </div>
  );
}

type DraftStatus = ProjectSettingsData["workflow"]["board"]["hidden"][number];
type DraftColumn = ProjectSettingsData["workflow"]["board"]["columns"][number];

function StatusChip({
  status, busy, onDragStart, onDragEnd,
}: {
  status: DraftStatus;
  busy: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      className="tkb-status"
      draggable={!busy}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; onDragStart(); }}
      onDragEnd={onDragEnd}
      title={`${status.name} — drag to another column`}
    >
      <span className="tk-dot" style={{ background: status.colour }} />
      <span className="tkb-status-name">{status.name}</span>
      <span className="tk-chip tk-chip-quiet">{status.category.replace("_", " ")}</span>
      {status.issue_count > 0 && <span className="tk-dim tk-num">{status.issue_count}</span>}
    </div>
  );
}

// --------------------------------------------------------------------- flow --

function Flow({ data, busy, act }: { data: ProjectSettingsData; busy: boolean; act: Act }) {
  // Two views of one thing. The diagram is what people open a workflow to
  // understand; the grid is what they want when changing twenty moves at once.
  const [view, setView] = useState<"diagram" | "grid">("diagram");

  return (
    <div className="tks-pane tks-pane-wide">
      <div className="tkf-switch">
        <M3Segmented
          label="How to show the workflow"
          value={view}
          options={[
            { value: "diagram", label: "Diagram" },
            { value: "grid", label: "Grid" },
          ] as const}
          onChange={setView}
        />
        <span className="tk-dim">
          {view === "diagram"
            ? "Click a status for its settings. Drag to rearrange."
            : "Every move at once — rows are where an issue is, columns where it may go."}
        </span>
        <NewStatus data={data} busy={busy} act={act} />
      </div>
      {view === "diagram" ? <FlowDiagram data={data} busy={busy} act={act} /> : <FlowGrid data={data} busy={busy} act={act} />}
    </div>
  );
}

function NewStatus({ data, busy, act }: { data: ProjectSettingsData; busy: boolean; act: Act }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("in_progress");

  if (!open) {
    return (
      <button type="button" className="tk-btn tk-layer" onClick={() => setOpen(true)}>
        Add status
      </button>
    );
  }
  return (
    <span className="tkf-row">
      <input className="tkc-input tkc-input-sm" autoFocus placeholder="Status name"
             value={name} onChange={(e) => setName(e.target.value)} />
      <M3Select
        value={category}
        width={160}
        options={[
          { value: "todo", label: "To do" },
          { value: "in_progress", label: "In progress" },
          { value: "done", label: "Done" },
        ]}
        onChange={setCategory}
      />
      <button type="button" className="tk-btn tk-layer" onClick={() => setOpen(false)}>Cancel</button>
      <button
        type="button"
        className="tk-btn tk-layer tk-btn-primary"
        disabled={!name.trim() || busy}
        onClick={() => act(async () => {
          const next = await trackerApi.createStatus(data.project.id, {
            name: name.trim(),
            category,
            colour: { todo: "#8b949e", in_progress: "#5b8cff", done: "#3fb950" }[category] ?? "#8b949e",
          });
          setName("");
          setOpen(false);
          return next;
        })}
      >
        Create
      </button>
    </span>
  );
}

function FlowGrid({ data, busy, act }: { data: ProjectSettingsData; busy: boolean; act: Act }) {
  const cols = data.workflow.columns;
  const allowed = new Set(
    data.workflow.transitions.map((t) => `${t.from_status_id}>${t.to_status_id}`),
  );
  const inferred = new Set(
    data.workflow.transitions
      .filter((t) => (t.conditions as { inferred?: boolean } | null)?.inferred)
      .map((t) => `${t.from_status_id}>${t.to_status_id}`),
  );

  return (
    <>
      <div className="tks-grid-wrap">
        <table className="tks-grid">
          <thead>
            <tr>
              <th />
              {cols.map((c) => (
                <th key={c.id} title={c.name}>
                  <span className="tks-vert">{c.name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cols.map((from) => (
              <tr key={from.id}>
                <th scope="row">
                  <span className="tk-dot" style={{ background: from.colour }} />
                  {from.name}
                </th>
                {cols.map((to) => {
                  const key = `${from.id}>${to.id}`;
                  const same = from.id === to.id;
                  const on = allowed.has(key);
                  return (
                    <td key={to.id} className={same ? "tks-same" : undefined}>
                      {!same && (
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={busy}
                          title={
                            inferred.has(key)
                              ? "Inferred when the workflow was captured — no issue was in this status to sample"
                              : `${from.name} → ${to.name}`
                          }
                          className={inferred.has(key) ? "tks-inferred" : undefined}
                          onChange={(e) =>
                            act(() => trackerApi.setTransition(
                              data.project.id, from.id, to.id, e.target.checked))
                          }
                        />
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="tk-dim">
        A dotted box was inferred rather than read from Jira — nothing was sitting in that
        status when the workflow was captured.
      </p>
    </>
  );
}

// ------------------------------------------------------------------- access --

function Access({
  data, users, busy, act,
}: { data: ProjectSettingsData; users: TrackerUser[]; busy: boolean; act: Act }) {
  const [entries, setEntries] = useState(data.access.map((a) => ({ kind: a.kind, value: a.value })));
  const [visibility, setVisibility] = useState(data.project.visibility);
  const [addKind, setAddKind] = useState("tag");
  const [addValue, setAddValue] = useState("");

  useEffect(() => {
    setEntries(data.access.map((a) => ({ kind: a.kind, value: a.value })));
    setVisibility(data.project.visibility);
  }, [data]);

  const KNOWN_TAGS = ["management", "dev_stats", "qa_stats", "time_management", "sales", "tracker"];

  function save(nextVisibility: string, nextEntries: { kind: string; value: string }[]) {
    act(() => trackerApi.setAccess(data.project.id, nextVisibility, nextEntries));
  }

  return (
    <div className="tks-pane">
      <div className="tks-choice">
        {[
          { id: "everyone", label: "Everyone with tracker access", hint: "The default, and the right answer for most boards" },
          { id: "restricted", label: "Only these tags and people", hint: "Hidden from everyone else — including from search and links" },
        ].map((o) => (
          <label key={o.id} className={`tks-radio tk-layer${visibility === o.id ? " on" : ""}`}>
            <input
              type="radio"
              name="visibility"
              checked={visibility === o.id}
              disabled={busy}
              onChange={() => {
                setVisibility(o.id);
                if (o.id === "everyone" || entries.length) save(o.id, entries);
              }}
            />
            <span>
              <strong>{o.label}</strong>
              <span className="tk-dim"> — {o.hint}</span>
            </span>
          </label>
        ))}
      </div>

      {visibility === "restricted" && (
        <>
          <div className="tks-chips">
            {entries.map((e, i) => (
              <span key={`${e.kind}:${e.value}`} className="tk-chip tk-chip-quiet">
                {e.kind === "tag" ? "#" : ""}
                {e.kind === "user"
                  ? users.find((u) => String(u.id) === e.value)?.display_name ?? e.value
                  : e.value}
                <button
                  type="button"
                  className="tks-chip-x"
                  disabled={busy}
                  onClick={() => {
                    const next = entries.filter((_, j) => j !== i);
                    setEntries(next);
                    if (next.length) save("restricted", next);
                  }}
                ><X size={16} aria-hidden /></button>
              </span>
            ))}
            {entries.length === 0 && (
              <span className="tk-dim">
                Nobody yet — add at least one before this takes effect.
              </span>
            )}
          </div>

          <div className="tks-add">
            <M3Select
              value={addKind}
              width={130}
              options={[{ value: "tag", label: "Tag" }, { value: "user", label: "Person" }]}
              onChange={(v) => { setAddKind(v); setAddValue(""); }}
            />
            <M3Select
              value={addValue}
              width={240}
              placeholder={addKind === "tag" ? "Pick a tag…" : "Pick a person…"}
              options={
                addKind === "tag"
                  ? KNOWN_TAGS.map((t) => ({ value: t, label: t }))
                  : users.map((u) => ({ value: String(u.id), label: u.display_name }))
              }
              onChange={setAddValue}
            />
            <button
              type="button"
              className="tk-btn tk-layer"
              disabled={!addValue || busy}
              onClick={() => {
                const next = [...entries, { kind: addKind, value: addValue }];
                setEntries(next);
                setAddValue("");
                save("restricted", next);
              }}
            >
              Add
            </button>
          </div>
          <p className="tk-dim">
            Admins always see every board. Restriction applies to the board, its issues and
            its links — an issue in a hidden project answers "not found" rather than
            confirming it exists.
          </p>
        </>
      )}
    </div>
  );
}

// -------------------------------------------------------------------- types --

function Types({ data, busy, act }: { data: ProjectSettingsData; busy: boolean; act: Act }) {
  const [open, setOpen] = useState<number | null>(data.types[0]?.id ?? null);
  const [marking, setMarking] = useState<number | null>(null);
  const [addType, setAddType] = useState("");
  const [addField, setAddField] = useState("");
  const [newField, setNewField] = useState(false);

  const onBoard = new Set(data.types.map((t) => t.id));
  const spareTypes = data.allTypes.filter((t) => !onBoard.has(t.id));
  const current = data.types.find((t) => t.id === open);
  const used = new Set(current?.fields.map((f) => f.id));
  const spareFields = data.allFields.filter((f) => !used.has(f.id));

  function setFields(typeId: number, fields: { field_id: number; required: boolean }[]) {
    act(() => trackerApi.setTypeFields(data.project.id, typeId, fields));
  }

  return (
    <div className="tks-pane tks-two">
      <div>
        <h4 className="tks-h">Issue types</h4>
        <ol className="tks-list">
          {data.types.map((t) => (
            <li
              key={t.id}
              className={`tks-row tks-pick tk-layer${open === t.id ? " on" : ""}`}
              onClick={() => setOpen(t.id)}
            >
              <button
                type="button"
                className="tks-mark tk-layer"
                title={`Change how ${t.name} is marked`}
                aria-label={`Change how ${t.name} is marked`}
                onClick={(e) => { e.stopPropagation(); setMarking(t.id); }}
              >
                <TypeGlyph icon={t.icon} colour={t.colour} size={16} />
              </button>
              <span className="tks-row-name">{t.name}</span>
              <span className="tk-dim">{t.fields.length} field{t.fields.length === 1 ? "" : "s"}</span>
              <button
                type="button"
                className="tks-mini tks-danger tk-layer"
                disabled={busy}
                title="Stop offering this type on this board"
                onClick={(e) => {
                  e.stopPropagation();
                  act(() => trackerApi.setTypes(
                    data.project.id, data.types.filter((x) => x.id !== t.id).map((x) => x.id)));
                }}
              ><X size={16} aria-hidden /></button>
            </li>
          ))}
        </ol>
        {marking != null && (() => {
          const t = data.types.find((x) => x.id === marking);
          if (!t) return null;
          return (
            <div className="tkc-scrim" onClick={() => setMarking(null)}>
              <div className="tkd tks-mark-dialog" onClick={(e) => e.stopPropagation()}
                   role="dialog" aria-modal="true">
                <header className="tkd-head">
                  <h2>How {t.name} is marked</h2>
                  <button type="button" className="tk-x tk-layer"
                          onClick={() => setMarking(null)} aria-label="Close">
                    <X size={16} aria-hidden />
                  </button>
                </header>
                <div className="tkd-body">
                  <p className="tk-dim tks-mark-note">
                    Types are shared by every board, the same as statuses — a Bug has
                    to mean a Bug everywhere or no cross-project number means
                    anything. This changes {t.name} on all of them.
                  </p>

                  <div className="tkc-field">
                    <span className="tkc-label">Colour</span>
                    <span className="tkf-colours">
                      {["#8b949e", "#5b8cff", "#a371f7", "#d29922", "#3fb950",
                        "#2dd4bf", "#f0883e", "#f85149", "#6e7681"].map((c) => (
                        <button
                          key={c}
                          type="button"
                          className={`tkf-swatch${t.colour === c ? " on" : ""}`}
                          style={{ background: c }}
                          title={c}
                          onClick={() => act(() =>
                            trackerApi.patchType(data.project.id, t.id, { colour: c }))}
                        />
                      ))}
                    </span>
                  </div>

                  <div className="tkc-field">
                    <span className="tkc-label">Mark</span>
                    <GlyphPicker
                      value={t.icon}
                      colour={t.colour}
                      onPick={(icon) => act(() =>
                        trackerApi.patchType(data.project.id, t.id, { icon }))}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })()}

        {spareTypes.length > 0 && (
          <div className="tks-add">
            <M3Select
              value={addType}
              width={200}
              placeholder="Add a type…"
              options={spareTypes.map((t) => ({ value: String(t.id), label: t.name }))}
              onChange={setAddType}
            />
            <button
              type="button"
              className="tk-btn tk-layer"
              disabled={!addType || busy}
              onClick={() => act(async () => {
                const next = await trackerApi.setTypes(
                  data.project.id, [...data.types.map((t) => t.id), Number(addType)]);
                setAddType("");
                return next;
              })}
            >
              Add
            </button>
          </div>
        )}
      </div>

      <div>
        <h4 className="tks-h">
          Fields on {current?.name ?? "…"}
        </h4>
        {!current && <p className="tk-dim">Pick a type.</p>}
        {current && (
          <>
            <ol className="tks-list">
              {current.fields.map((f) => (
                <li key={f.id} className="tks-row">
                  <span className="tks-row-name">{f.name}</span>
                  <span className="tk-chip tk-chip-quiet">{f.kind}</span>
                  <label className="tks-req">
                    <input
                      type="checkbox"
                      checked={f.required}
                      disabled={busy}
                      onChange={(e) =>
                        setFields(current.id, current.fields.map((x) => ({
                          field_id: x.id,
                          required: x.id === f.id ? e.target.checked : x.required,
                        })))
                      }
                    />
                    required
                  </label>
                  <button
                    type="button"
                    className="tks-mini tks-danger tk-layer"
                    disabled={busy}
                    onClick={() =>
                      setFields(current.id, current.fields
                        .filter((x) => x.id !== f.id)
                        .map((x) => ({ field_id: x.id, required: x.required })))
                    }
                  ><X size={16} aria-hidden /></button>
                </li>
              ))}
              {current.fields.length === 0 && <p className="tk-dim">No fields on this type.</p>}
            </ol>

            <div className="tks-add">
              <M3Select
                value={addField}
                width={220}
                placeholder="Add a field…"
                options={spareFields.map((f) => ({ value: String(f.id), label: f.name, hint: f.kind }))}
                onChange={setAddField}
              />
              <button
                type="button"
                className="tk-btn tk-layer"
                disabled={!addField || busy}
                onClick={() => {
                  setFields(current.id, [
                    ...current.fields.map((x) => ({ field_id: x.id, required: x.required })),
                    { field_id: Number(addField), required: false },
                  ]);
                  setAddField("");
                }}
              >
                Add
              </button>
              <button type="button" className="tk-link tk-layer" onClick={() => setNewField(true)}>
                + define a new field
              </button>
            </div>
            <p className="tk-dim">
              Fields are global: defining one here makes it available to every board, which is
              what stops the same idea becoming four fields with four ids.
            </p>
          </>
        )}
      </div>

      {newField && (
        <NewField
          onCancel={() => setNewField(false)}
          onCreated={() => {
            setNewField(false);
            act(() => trackerApi.projectSettings(data.project.id));
          }}
        />
      )}
    </div>
  );
}

// Every field that exists, not only the ones on this board.
//
// Fields are global, so "which fields do we have" is a real question with one
// answer, and this is where it lives. The two numbers per row are the point:
// where a field is asked for, and how many issues actually carry a value. A
// field asked for on five types with nothing filled in is the shape of the rot
// that made Jira's create form unusable, and it is visible here rather than
// suspected.
function Fields({ onChanged }: { onChanged: () => void }) {
  const [fields, setFields] = useState<FieldDefinition[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState({ name: "", description: "", reason: "" });
  const [showRetired, setShowRetired] = useState(false);

  async function reload() {
    try {
      setFields(await trackerApi.fields());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => { reload(); }, []);

  async function guard(fn: () => Promise<unknown>) {
    setError("");
    try {
      await fn();
      await reload();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!fields) return <p className="tk-dim">Loading…</p>;
  const live = fields.filter((f) => !f.archived_at);
  const retired = fields.filter((f) => f.archived_at);
  const shown = showRetired ? fields : live;

  return (
    <div className="tks-pane">
      <div className="tks-add">
        <p className="tk-dim" style={{ flex: 1 }}>
          {live.length} field{live.length === 1 ? "" : "s"} across every board. Defining one
          here makes it available everywhere — that is what stops the same idea becoming four
          fields with four ids.
        </p>
        {retired.length > 0 && (
          <label className="tks-req">
            <input type="checkbox" checked={showRetired}
                   onChange={(e) => setShowRetired(e.target.checked)} />
            show {retired.length} retired
          </label>
        )}
        <button type="button" className="tk-btn tk-layer tk-btn-primary"
                onClick={() => setCreating(true)}>
          New field
        </button>
      </div>
      {error && <div className="tkc-err" onClick={() => setError("")}>{error} <X size={14} aria-hidden /></div>}

      <div className="tks-fields">
        {shown.map((f) => {
          const boards = [...new Set(f.usage.map((u) => u.project_key))];
          const unused = f.usage.length > 0 && f.filled === 0;
          return (
            <article key={f.id} className={`tks-field${f.archived_at ? " tks-field-off" : ""}`}>
              <div className="tks-field-top">
                <span className="tks-field-name">{f.name}</span>
                <code className="tks-field-key">{f.key}</code>
                <span className="tk-chip tk-chip-quiet">{f.kind}</span>
                {f.archived_at && <span className="tk-chip tk-chip-quiet">retired</span>}
                <span className="tks-field-actions">
                  <button type="button" className="tks-mini tk-layer" title="Rename"
                          onClick={() => {
                            setEditing(f.id);
                            setDraft({ name: f.name, description: f.description, reason: f.reason });
                          }}>
                    ✎
                  </button>
                  <button
                    type="button"
                    className="tks-mini tk-layer"
                    title={f.archived_at
                      ? "Bring this field back"
                      : f.usage.length
                        ? `Still asked for on ${f.usage.length} type(s) — take it off those first`
                        : "Retire this field"}
                    onClick={() => guard(() => trackerApi.archiveField(f.id, !f.archived_at))}
                  >
                    {f.archived_at ? "↺" : "⌫"}
                  </button>
                </span>
              </div>

              {editing === f.id ? (
                <div className="tks-field-edit">
                  <input className="tkc-input tkc-input-sm" value={draft.name}
                         placeholder="Name"
                         onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                  <input className="tkc-input tkc-input-sm" value={draft.reason}
                         placeholder="Why it exists"
                         onChange={(e) => setDraft({ ...draft, reason: e.target.value })} />
                  <button type="button" className="tk-btn tk-layer"
                          onClick={() => setEditing(null)}>Cancel</button>
                  <button type="button" className="tk-btn tk-layer tk-btn-primary"
                          onClick={() => guard(async () => {
                            await trackerApi.patchField(f.id, draft);
                            setEditing(null);
                          })}>
                    Save
                  </button>
                  {/* The key is not editable: issues store it and filters are
                      written against it, so changing it would orphan every
                      value already saved. */}
                  <span className="tk-dim">the key stays {f.key} — values are stored under it</span>
                </div>
              ) : (
                <>
                  {f.reason && <p className="tks-field-why">{f.reason}</p>}
                  {!!f.options?.length && (
                    <div className="tks-chips">
                      {(f.options as string[]).map((o) => (
                        <span key={o} className="tk-chip tk-chip-quiet">{o}</span>
                      ))}
                    </div>
                  )}
                  <div className="tks-field-foot">
                    <span className={unused ? "tks-warn" : "tk-dim"}>
                      {f.filled} issue{f.filled === 1 ? "" : "s"} have a value
                      {unused && " — asked for, never filled in"}
                    </span>
                    <span className="tk-dim">
                      {f.usage.length
                        ? `on ${f.usage.length} type${f.usage.length === 1 ? "" : "s"} (${boards.join(", ")})`
                        : "not on any board"}
                    </span>
                  </div>
                  {f.usage.length > 0 && (
                    <div className="tks-chips">
                      {f.usage.map((u) => (
                        <span key={`${u.project_id}-${u.type_id}`} className="tk-chip tk-chip-quiet">
                          {u.project_key} · {u.type_name}
                          {u.required && <strong> ·  required</strong>}
                        </span>
                      ))}
                    </div>
                  )}
                </>
              )}
            </article>
          );
        })}
      </div>

      {creating && (
        <NewField onCancel={() => setCreating(false)}
                  onCreated={() => { setCreating(false); reload(); onChanged(); }} />
      )}
    </div>
  );
}


function NewField({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState("text");
  const [options, setOptions] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");

  const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

  return (
    <div className="tkc-scrim" onClick={onCancel}>
      <div className="tkc tks-newfield" onClick={(e) => e.stopPropagation()}>
        <header className="tkc-head">
          <div className="tkc-head-l">
            <div className="tkc-crumb">NEW FIELD</div>
            <h2 className="tkc-title">Define a field</h2>
          </div>
        </header>
        {error && <div className="tkc-err">{error}</div>}
        <div className="tks-body">
          <label className="tkc-field">
            <span className="tkc-label">Name</span>
            <input className="tkc-input" autoFocus value={name}
                   onChange={(e) => setName(e.target.value)} placeholder="Root cause" />
            {key && <span className="tk-dim">key: {key} — permanent once created</span>}
          </label>
          <label className="tkc-field">
            <span className="tkc-label">Kind</span>
            <M3Select
              value={kind}
              width={220}
              options={["text", "number", "select", "multiselect", "date", "user", "checkbox"]
                .map((k) => ({ value: k, label: k }))}
              onChange={setKind}
            />
          </label>
          {(kind === "select" || kind === "multiselect") && (
            <label className="tkc-field">
              <span className="tkc-label">Options</span>
              <input className="tkc-input" value={options} placeholder="low, medium, high"
                     onChange={(e) => setOptions(e.target.value)} />
            </label>
          )}
          <label className="tkc-field">
            <span className="tkc-label">Why it exists</span>
            <input className="tkc-input" value={reason} placeholder="Who asked for it, and what reads it"
                   onChange={(e) => setReason(e.target.value)} />
            {/* Recorded on the field itself: a tracker's field list rots when
                nobody remembers why half of them are there. */}
          </label>
        </div>
        <footer className="tkc-foot">
          <span />
          <div className="tkc-foot-r">
            <button type="button" className="tk-btn tk-layer" onClick={onCancel}>Cancel</button>
            <button
              type="button"
              className="tk-btn tk-layer tk-btn-primary"
              disabled={!key}
              onClick={async () => {
                try {
                  await trackerApi.createField({
                    key, name: name.trim(), kind, reason,
                    options: options.split(",").map((o) => o.trim()).filter(Boolean),
                  });
                  onCreated();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Create
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
