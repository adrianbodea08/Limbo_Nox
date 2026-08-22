// The tracker — projects, boards, issues.
//
// Everything on this page is driven by the tracker's own Postgres database,
// which is deliberately optional: on live there is no connection yet, and the
// page says so plainly instead of erroring. That is what lets the whole thing
// ship before devops has provisioned anything.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { morph } from "../../morph";
import { M3MultiSelect } from "../M3MultiSelect";
import { TopBar, type ShellProps } from "../TopBar";
import { TrackerSearch } from "./TrackerSearch";
import { ColumnsBoard, ListBoard, TableBoard, type Renderer } from "./BoardViews";
import { readTagStyle } from "./CardFace";
import { IssueCard } from "./IssueCard";
import { Automations } from "./Automations";
import { GitSettings } from "./GitSettings";
import { Insights } from "./Insights";
import { Releases } from "./Releases";
import { TrackerRail } from "./TrackerRail";
import { M3Segmented } from "../M3Segmented";
import { ViewBar } from "./Views";
import {
  PRIORITY_COLOUR, trackerApi,
  type BoardColumn, type FilterNode, type BoardData, type TrackerIssue,
  type TrackerMeta, type TrackerStatusInfo, type TrackerUser, type Label,
  type SavedView,
} from "./model";

/** Put a saved filter back on the bar.
 *
 *  The other direction — bar to filter — is the `filter` memo below. This one
 *  has to exist because a view stores the compiled filter, and the bar is five
 *  dropdowns: picking a view has to *set* those dropdowns, not just send a
 *  filter the bar then disagrees with. Anything the bar cannot express is
 *  ignored rather than guessed at. */
function barFromFilter(node: FilterNode | null) {
  const bar = {
    who: [] as string[], tester: [] as string[],
    priority: [] as string[], kinds: [] as string[], tags: [] as string[],
  };
  const walk = (n: FilterNode | null) => {
    if (!n) return;
    if ("all" in n) { n.all.forEach(walk); return; }
    // An `any` group is how "somebody, or nobody" is written — the same shape
    // the memo below produces for people.
    if ("any" in n) { n.any.forEach(walk); return; }
    const value = Array.isArray(n.value) ? n.value.map(String) : [];
    switch (n.field) {
      case "assignee_id":
        bar.who.push(...(n.op === "is_empty" ? [UNASSIGNED] : value)); break;
      case "tester_id":
        bar.tester.push(...(n.op === "is_empty" ? [UNASSIGNED] : value)); break;
      case "priority": bar.priority.push(...value); break;
      case "issue_type_id": bar.kinds.push(...value); break;
      case "label_id": bar.tags.push(...value); break;
      default: break; // project_id is set by the rail, not by the view
    }
  };
  walk(node);
  return bar;
}

/** JSON with the keys in a settled order.
 *
 *  A filter goes to Postgres as `jsonb`, which does not keep key order — it is
 *  handed `{field, op, value}` and gives back `{op, field, value}`. Comparing
 *  the two as plain JSON made a view read as *changed* the instant it was
 *  applied, so the board offered to save what it had just loaded. Comparing
 *  arrangements means comparing what they say, not how they were typed. */
function canon(value: unknown): string {
  return JSON.stringify(value, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(
          ([a], [b]) => a.localeCompare(b)))
      : v);
}

interface Props {
  shell: ShellProps;
}

/* The label experiment's own switch — see the note in BoardViews.tsx. Here
 * rather than in the URL bar because comparing three of these means flipping
 * between them twenty times, and typing a query parameter twenty times is not
 * comparing them, it is remembering how to. Goes when one of them wins. */
const TAG_STYLES = [
  { value: "in" as const, label: "In" },
  { value: "out" as const, label: "Out" },
  { value: "bar" as const, label: "Bar" },
];

const RENDERERS: { id: Renderer; label: string; hint: string }[] = [
  { id: "columns", label: "Columns", hint: "A column per status — the working board" },
  { id: "table", label: "Table", hint: "One dense row per issue, sortable" },
  { id: "list", label: "List", hint: "Grouped and stacked, for reading alongside the detail" },
];

// The five a lead sets, plus the one that overrides them.
const PRIORITIES = ["urgent", "highest", "high", "medium", "low", "lowest"];

// A real thing to filter to, and usually the first thing anyone looks for.
const UNASSIGNED = "none";

export function TrackerPage({ shell }: Props) {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<TrackerStatusInfo | null>(null);
  const [meta, setMeta] = useState<TrackerMeta | null>(null);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [issues, setIssues] = useState<TrackerIssue[]>([]);
  const [selected, setSelected] = useState<TrackerIssue | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  // Empty means no filter rather than "none of them" — the useful default for
  // a filter bar, and why the fields read "Anyone" and "Any priority".
  const [who, setWho] = useState<string[]>([]);
  const [tester, setTester] = useState<string[]>([]);
  const [priority, setPriority] = useState<string[]>([]);
  const [kinds, setKinds] = useState<string[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [views, setViews] = useState<SavedView[]>([]);
  const [viewId, setViewId] = useState<number | null>(null);
  const [savingView, setSavingView] = useState(false);
  const [labels, setLabels] = useState<Label[]>([]);
  const [sortBy, setSortBy] = useState("updated_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [users, setUsers] = useState<TrackerUser[]>([]);

  const projectKey = params.get("project") ?? "";
  // Releases are their own section rather than a project, because a release
  // spans projects by construction.
  const sectionParam = params.get("section");
  const section =
    sectionParam === "releases" || sectionParam === "automations"
    || sectionParam === "git" || sectionParam === "insights"
      ? sectionParam : "issues";
  const releaseId = params.get("release") ? Number(params.get("release")) : null;
  const renderer = (params.get("view") as Renderer) || "columns";
  // Which of the three label treatments the board is drawing. The board reads
  // this from the URL itself; this copy is only so the switch can show which
  // one is on.
  const tagStyle = readTagStyle(params.get("tags"));
  // Not a control any more: a project's board columns decide what the columns
  // are, which is a better answer than a dropdown. The parameter is still read
  // so older links keep working.
  const groupBy = params.get("group") ?? "status";

  const project = meta?.projects.find((p) => p.key === projectKey) ?? null;

  function setParam(patch: Record<string, string | null>) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  }

  // ------------------------------------------------------------- first load --


  // The words this team has invented for itself, commonest first.

  useEffect(() => {

    trackerApi.labels().then(setLabels).catch(() => {});

  }, []);

  // Re-asked per project: a view pinned to one project is not offered on
  // another, and the server is the only thing that knows which are shared.
  const loadViews = useCallback(() => {
    if (!project) return;
    trackerApi.views(project.id).then(setViews).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);
  useEffect(() => { loadViews(); }, [loadViews]);

  useEffect(() => {
    (async () => {
      try {
        const st = await trackerApi.status();
        setStatus(st);
        if (!st.connected) return;
        setMeta(await trackerApi.meta());
        setUsers(await trackerApi.users());
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Land on the first project rather than an empty page.
  useEffect(() => {
    if (meta && !projectKey && meta.projects.length) setParam({ project: meta.projects[0].key });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  // ----------------------------------------------------------------- issues --

  // The same roster feeds the assignee and tester filters.
  const people = useMemo(() => users.map((u) => ({
    value: String(u.id), label: u.display_name,
    hint: u.craft ?? undefined, avatar: u.avatar, person: true,
  })), [users]);

  const filter = useMemo<FilterNode | null>(() => {
    const conditions: FilterNode[] = [];
    if (project) conditions.push({ field: "project_id", op: "eq", value: project.id });

    // "Nobody yet" is not an id, so it becomes its own condition rather than a
    // value in the list — otherwise picking it alongside two people would
    // quietly drop them.
    for (const [field, picked] of [
      ["assignee_id", who], ["tester_id", tester],
    ] as [string, string[]][]) {
      if (!picked.length) continue;
      const ids = picked.filter((v) => v !== UNASSIGNED).map(Number);
      const parts: FilterNode[] = [];
      if (ids.length) parts.push({ field, op: "in", value: ids });
      if (picked.includes(UNASSIGNED)) parts.push({ field, op: "is_empty" });
      conditions.push(parts.length === 1 ? parts[0] : { any: parts });
    }
    if (priority.length) conditions.push({ field: "priority", op: "in", value: priority });
    if (kinds.length) {
      conditions.push({ field: "issue_type_id", op: "in", value: kinds.map(Number) });
    }
    // Labels are many-per-issue, so this compiles to an EXISTS rather than a
    // column comparison. Picking two means "wearing either", the same as every
    // other multi-select on this bar.
    if (tags.length) {
      conditions.push({ field: "label_id", op: "in", value: tags.map(Number) });
    }
    return conditions.length ? { all: conditions } : null;
  }, [project, who, tester, priority, kinds, tags]);

  const filterCount = who.length + tester.length + priority.length + kinds.length + tags.length;

  // ------------------------------------------------------------------ views --

  const current = views.find((v) => v.id === viewId) ?? null;

  /** The board exactly as it stands, in the shape a view is stored in. */
  function arrangement() {
    return {
      filter, renderer, group_by: groupBy,
      sort: [{ field: sortBy, dir: sortDir }],
    };
  }

  // Compared as JSON rather than field by field: a view is one arrangement, and
  // "has anything about it changed" is the only question worth asking. With no
  // view picked, any filter at all counts as something worth offering to keep.
  const changed = current
    ? canon(arrangement()) !== canon({
        filter: current.filter, renderer: current.renderer,
        group_by: current.group_by, sort: current.sort,
      })
    : filterCount > 0;

  function applyView(v: SavedView | null) {
    setViewId(v?.id ?? null);
    if (!v) { clearFilters(); return; }
    const bar = barFromFilter(v.filter);
    setWho(bar.who);
    setTester(bar.tester);
    setPriority(bar.priority);
    setKinds(bar.kinds);
    setTags(bar.tags);
    setSortBy(v.sort?.[0]?.field ?? "updated_at");
    setSortDir(v.sort?.[0]?.dir ?? "desc");
    setParam({ view: v.renderer, group: v.group_by });
  }

  async function onView(fn: () => Promise<unknown>) {
    setSavingView(true);
    try {
      await fn();
      loadViews();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingView(false);
    }
  }

  function clearFilters() {
    setWho([]); setTester([]); setPriority([]); setKinds([]); setTags([]);
  }

  const load = useCallback(async () => {
    if (!status?.connected || !meta || section !== "issues") return;
    setError("");
    try {
      if (renderer === "columns") {
        // project_id is sent separately from the filter: it decides which
        // workflow's statuses become columns, which is a different question
        // from which issues are shown.
        setBoard(await trackerApi.board({
          filter, group_by: groupBy, limit: 500, project_id: project?.id ?? null,
        }));
      } else {
        const res = await trackerApi.search({
          filter,
          sort: [{ field: sortBy, dir: sortDir }],
          limit: 500,
        });
        setIssues(res.issues);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [status?.connected, meta, section, renderer, filter, groupBy, sortBy, sortDir, project?.id]);

  // Filters reset per project by construction — the people and types on one
  // board are not the ones on the next, so carrying a filter across boards
  // would show an empty board with no visible reason.
  useEffect(() => {
    clearFilters();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  useEffect(() => {
    load();
  }, [load]);

  // A deep link to a specific issue opens it.
  useEffect(() => {
    const key = params.get("issue");
    if (!key || !status?.connected) return;
    if (selected?.key === key) return;
    trackerApi.issue(key).then(setSelected).catch(() => setParam({ issue: null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.get("issue"), status?.connected]);

  const allowedFor = useCallback(async (issue: TrackerIssue) => {
    try {
      const moves = await trackerApi.transitions(issue.id);
      return new Set(moves.map((m) => m.to_status_id));
    } catch {
      return new Set<number>();
    }
  }, []);

  // A board is always in priority order, so a drag can only change where a
  // card sits among its equals. The server checks that too — it refuses any
  // list that is not a rearrangement of exactly one band — so a client that
  // got this wrong could not push a medium above a high anyway.
  async function reorder(column: BoardColumn, priority: string, issueIds: number[]) {
    if (!project) return;
    try {
      await trackerApi.reorderBoard({
        project_id: project.id,
        status_ids: (column.statuses ?? []).map((s) => s.id),
        priority,
        issue_ids: issueIds,
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function move(issue: TrackerIssue, statusId: number) {
    try {
      await trackerApi.transition(issue.id, statusId);
      await load();
      if (selected?.id === issue.id) setSelected(await trackerApi.issue(issue.key));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // Opening the card is deliberately *not* a morph.
  //
  // A morph is for a surface that exists on both sides and changes shape. A
  // dialog has no counterpart to morph from — it simply arrives — and it
  // already carries its own entrance: the scrim fades and the card scales up.
  // Running a view transition over the top adds a second animation on the same
  // element, and for its duration the page is a stack of snapshots whose order
  // is decided by the transition rather than by z-index. That is what put the
  // card behind the board for a moment.
  //
  // Closing is the opposite case: React unmounts the dialog immediately, so
  // there is no CSS animation left to play and the transition is the only
  // thing that can fade it out. There it earns its keep — and `.tkc-scrim`
  // carries a view-transition-name so the outgoing card is its own layer,
  // above the board, rather than part of the root snapshot underneath it.
  function open(issue: TrackerIssue) {
    setSelected(issue);
    setParam({ issue: issue.key });
  }

  function close() {
    morph(() => {
      setSelected(null);
      setParam({ issue: null });
    });
  }

  // ------------------------------------------------------------------ chrome --

  const top = (
    <TopBar
      title="Nox"
      user={shell.user}
        isAdmin={shell.isAdmin}
      onOpenSettings={shell.onOpenSettings}
      onOpenAdmin={shell.onOpenAdmin}
      onLogout={shell.onLogout}
    >
      <TrackerSearch />
    </TopBar>
  );

  if (loading) {
    return (
      <div className="tk-page">
        {top}
        <div className="tk-blank">Loading…</div>
      </div>
    );
  }

  // Not connected is a state, not a failure — say what is true and stop.
  if (!status?.connected) {
    return (
      <div className="tk-page">
        {top}
        <div className="tk-blank tk-blank-card">
          <h2>Not connected yet</h2>
          <p>
            {status?.configured
              ? "The tracker has a database configured but cannot reach it right now."
              : "The tracker runs on its own database, which has not been set up on this environment yet."}
          </p>
          {status?.error && <pre className="tk-blank-detail">{status.error}</pre>}
          <p className="tk-dim">
            Everything else in this app is unaffected — it reads from the existing database, which
            this does not touch.
          </p>
        </div>
      </div>
    );
  }

  if (meta && meta.projects.length === 0) {
    return (
      <div className="tk-page">
        {top}
        <div className="tk-blank tk-blank-card">
          <h2>Nothing here yet</h2>
          <p>The database is connected but empty. Creating the starting statuses, issue types and projects is safe to repeat.</p>
          {shell.isAdmin ? (
            <button
              type="button"
              className="tk-btn tk-layer tk-btn-primary"
              onClick={async () => {
                await trackerApi.setup();
                setMeta(await trackerApi.meta());
              }}
            >
              Set the tracker up
            </button>
          ) : (
            <p className="tk-dim">An admin needs to run the first-time setup.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="tk-page">
      {top}
      <div className="tk-shell">
        <TrackerRail
          active={section !== "issues" ? section
            : projectKey ? `project:${projectKey}` : "projects"}
          isAdmin={shell.isAdmin}
          projects={meta?.projects}
          onProject={(key) =>
            morph(() => setParam({ project: key, section: null, release: null, issue: null }))}
        />

        <main className="tk-main">
          {section !== "issues" && meta ? (
            <div className="tk-canvas">
              {section === "releases" ? (
                <Releases
                  selectedId={releaseId}
                  onSelect={(id) =>
                    morph(() => setParam({ release: id === null ? null : String(id) }))
                  }
                />
              ) : section === "git" ? (
                <GitSettings isAdmin={shell.isAdmin} />
              ) : section === "insights" ? (
                <Insights projects={meta.projects} />
              ) : (
                <Automations meta={meta} />
              )}
            </div>
          ) : (
          <>
          <div className="tk-bar">
            <div className="tk-bar-left">
              <h1 className="tk-title">{project?.name ?? "All issues"}</h1>
              {/* The view sits with the project, not among the filters: it is
                  what you are looking at, and the filters are how you got
                  there. Picking one sets all of them. */}
              <ViewBar
                views={views}
                current={current}
                changed={changed}
                busy={savingView}
                onPick={(v) => morph(() => applyView(v))}
                onCreate={(name) => onView(async () => {
                  const made = await trackerApi.createView({
                    name, project_id: project?.id ?? null, ...arrangement(),
                  });
                  setViewId(made.id);
                })}
                onUpdate={(v) => onView(() => trackerApi.patchView(v.id, arrangement()))}
                onRename={(v, name) => onView(() => trackerApi.patchView(v.id, { name }))}
                onShare={(v, shared) => onView(() => trackerApi.patchView(v.id, { shared }))}
                onDelete={(v) => onView(async () => {
                  await trackerApi.deleteView(v.id);
                  if (viewId === v.id) setViewId(null);
                })}
              />
              {project?.description && <span className="tk-dim">{project.description}</span>}
            </div>
            <div className="tk-bar-right">
              {/* How to show it, beside what to show. This lived in the left
                  column until the column went; a view control belongs on the
                  view's own bar anyway. */}
              <M3Segmented
                label="How to show the board"
                value={renderer}
                options={RENDERERS.map((r) => ({ value: r.id, label: r.label }))}
                onChange={(next) => morph(() => setParam({ view: next }))}
              />
              {/* Only on the board: labels are drawn on cards, and the table
                  and the list do not have any. Temporary — it comes out with
                  the two treatments that lose. */}
              {renderer === "columns" && (
                <span className="tk-try" title="Where a card's labels go — an experiment">
                  <span className="tk-try-tag">Labels</span>
                  <M3Segmented
                    label="Where a card's labels go"
                    value={tagStyle}
                    options={TAG_STYLES}
                    onChange={(next) => morph(() => setParam({ tags: next }))}
                  />
                </span>
              )}
              <M3MultiSelect
                values={who}
                width={190}
                placeholder="Anyone"
                noun="people"
                options={[
                  { value: UNASSIGNED, label: "Nobody yet", hint: "unassigned" },
                  ...people,
                ]}
                onChange={setWho}
              />
              <M3MultiSelect
                values={tester}
                width={190}
                placeholder="Any tester"
                noun="testers"
                options={[
                  { value: UNASSIGNED, label: "No tester", hint: "nobody checking it" },
                  ...people,
                ]}
                onChange={setTester}
              />
              <M3MultiSelect
                values={priority}
                width={165}
                placeholder="Any priority"
                noun="priorities"
                searchFrom={99}
                options={PRIORITIES.map((p) => ({
                  value: p, label: p, colour: PRIORITY_COLOUR[p],
                }))}
                onChange={setPriority}
              />
              <M3MultiSelect
                values={kinds}
                width={160}
                placeholder="Any type"
                noun="types"
                searchFrom={99}
                options={(meta?.issueTypes ?? []).map((t) => ({
                  value: String(t.id), label: t.name, colour: t.colour,
                }))}
                onChange={setKinds}
              />
              {/* Last on the bar, because it is the only axis that is not
                  configured — it appears once somebody has invented a word,
                  and a filter that is sometimes absent should not shuffle the
                  four that are always there. */}
              {!!labels.length && (
                <M3MultiSelect
                  values={tags}
                  width={190}
                  placeholder="Any label"
                  noun="labels"
                  options={labels.map((l) => ({
                    value: String(l.id), label: l.name, colour: l.colour,
                  }))}
                  onChange={setTags}
                />
              )}
              {filterCount > 0 && (
                <button
                  type="button"
                  className="tk-link tk-layer"
                  title="Show everything again"
                  onClick={() => morph(clearFilters)}
                >
                  Clear {filterCount}
                </button>
              )}
              <button type="button" className="tk-btn tk-layer tk-btn-primary"
                      onClick={() => setCreating(true)}>
                New issue
              </button>
            </div>
          </div>

          {error && <p className="tk-error">{error}</p>}

          <div className="tk-content">
            <div className="tk-canvas">
              {renderer === "columns" && board && (
                <ColumnsBoard
                  board={board}
                  selectedId={selected?.id ?? null}
                  onOpen={open}
                  allowedFor={allowedFor}
                  onMove={move}
                  onReorder={reorder}
                />
              )}
              {renderer === "table" && (
                <TableBoard
                  issues={issues}
                  selectedId={selected?.id ?? null}
                  onOpen={open}
                  sortBy={sortBy}
                  sortDir={sortDir}
                  onSort={(f) => {
                    if (f === sortBy) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
                    else {
                      setSortBy(f);
                      setSortDir("asc");
                    }
                  }}
                />
              )}
              {renderer === "list" && (
                <ListBoard
                  issues={issues}
                  statuses={meta?.statuses ?? []}
                  selectedId={selected?.id ?? null}
                  onOpen={open}
                />
              )}
            </div>

          </div>
          </>
          )}
        </main>
      </div>

      {/* The card, over the board — the same shape as the My Board one.
          Never both at once: they share one view-transition name, and two
          elements claiming the same name cancels the transition outright. */}
      {selected && !creating && meta && (
        <IssueCard
          key={selected.key}
          mode="edit"
          chrome="dialog"
          meta={meta}
          issue={selected}
          users={users}
          onClose={close}
          onSaved={(issue) => {
            setSelected(issue);
            load();
          }}
        />
      )}

      {creating && meta && project && (
        <IssueCard
          mode="create"
          chrome="dialog"
          meta={meta}
          projectId={project.id}
          users={users}
          onClose={() => setCreating(false)}
          onSaved={(issue) => {
            setCreating(false);
            load();
            open(issue);
          }}
        />
      )}
    </div>
  );
}
