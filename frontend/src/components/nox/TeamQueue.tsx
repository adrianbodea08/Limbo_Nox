// A team lead's screen — the backlog, as a table.
//
// The load-bearing screen. If keeping this in order takes more than about half
// a minute a morning it will not be kept, and a stale order is worse than none:
// people go back to guessing, and they have stopped trusting the screen too.
//
// So it is a table, read down a column, with the two things a lead changes —
// who has it and what priority it is — editable in the row itself. No opening
// anything to assign.
//
// The cards on top are the things you would otherwise have to go looking for,
// and each one is a filter: somebody with nothing to do is invisible on a
// board, because absence does not draw a card.
//
// Leads see each other's team read-only. Two teams sharing one plan should be
// able to see what the other is carrying.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { M3MultiSelect } from "../M3MultiSelect";
import { M3Select } from "../M3Select";
import { TopBar, type ShellProps } from "../TopBar";
import { TrackerRail } from "./TrackerRail";
import { TrackerSearch } from "./TrackerSearch";
import { Face, Person } from "./Face";
import { IssueKey } from "./IssueKey";
import { useIssueDialog } from "./useIssueDialog";
import { PRIORITY_COLOUR, ago, trackerApi } from "./model";
import type { QueueIssue, TeamQueueData, TrackerTeam } from "./model";
import { M3Segmented } from "../M3Segmented";
import { X } from "lucide-react";
import { TypeGlyph } from "./TypeGlyph";

// `urgent` is missing on purpose: it is not picked from a dropdown, it is set
// with a reason attached.
const ASSIGNABLE = ["highest", "high", "medium", "low", "lowest"];
const PRIORITY_SORT = ["urgent", "highest", "high", "medium", "low", "lowest"];

// "none" alongside the user ids: unassigned is a real thing to filter to, and
// the first thing a lead looks for.
const UNASSIGNED = "none";

// The teams' screen. One page with a tab per team plus All, rather than a page
// each: the question a lead has after "what is my team carrying" is almost
// always "what is the other one carrying", and that should be a tab and not a
// journey.
//
// All is read-only for anybody who is not an admin, and deliberately so —
// leads see each other's work but do not reorder it. That rule is enforced per
// row rather than per screen, so a lead's own rows stay editable on the All tab
// while the other team's do not.
export function TeamQueuePage({ shell }: { shell: ShellProps }) {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const tab = (params.get("tab") ?? "all").toUpperCase();
  const [teams, setTeams] = useState<TrackerTeam[]>([]);
  const [data, setData] = useState<TeamQueueData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [urgentFor, setUrgentFor] = useState<QueueIssue | null>(null);
  const issueDialog = useIssueDialog(() => load());

  // Empty means no filter rather than "none of them" — the useful default for
  // a filter bar, and why the fields read "Anyone" and "Any priority".
  const [who, setWho] = useState<string[]>([]);
  const [priority, setPriority] = useState<string[]>([]);
  const [status, setStatus] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [showPool, setShowPool] = useState(false);

  const team = teams.find((t) => t.key === tab);

  useEffect(() => { trackerApi.teams().then(setTeams).catch(() => {}); }, []);

  const load = useCallback(async () => {
    // Wait for the roster: until it arrives a team key cannot be resolved, and
    // asking for "all" in the meantime would flash the wrong tab's data.
    if (!teams.length) return;
    try {
      setData(await trackerApi.teamQueue(team?.id ?? null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [team?.id, teams.length, tab]);

  useEffect(() => { load(); }, [load]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const rows = useMemo(() => {
    if (!data) return [];
    const base = showPool ? [...data.issues, ...data.pool] : data.issues;
    const q = search.trim().toLowerCase();
    const whoSet = new Set(who);
    const prioSet = new Set(priority);
    const statusSet = new Set(status);
    return base.filter((i) => {
      if (whoSet.size) {
        const mine = i.assignee_id === null ? UNASSIGNED : String(i.assignee_id);
        if (!whoSet.has(mine)) return false;
      }
      if (prioSet.size && !prioSet.has(i.priority)) return false;
      if (statusSet.size && !statusSet.has(String(i.status_id))) return false;
      if (q && !`${i.key} ${i.summary}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, who, priority, status, search, showPool]);

  // Only the statuses this team's work is actually sitting in. The global list
  // has twenty-five, and offering a filter that can only ever return nothing is
  // worse than not offering it.
  const statusOptions = useMemo(() => {
    if (!data) return [];
    const seen = new Map<string, { value: string; label: string; colour: string; count: number }>();
    for (const i of [...data.issues, ...data.pool]) {
      const key = String(i.status_id);
      const row = seen.get(key)
        ?? { value: key, label: i.status_name, colour: i.status_colour, count: 0 };
      row.count += 1;
      seen.set(key, row);
    }
    return [...seen.values()].sort((a, b) => b.count - a.count);
  }, [data]);

  // Per row, not per screen. On the All tab a lead sees both teams and may
  // only touch their own — enforcing that with one flag would either lock them
  // out of their own work or let them reorder somebody else's.
  const editable = useMemo(
    () => new Set(data?.editableTeams ?? []), [data?.editableTeams]);
  const canEditRow = useCallback(
    (issue: QueueIssue) => (issue.team_id === null
      // Free-for-all work is pulled *for* a team, and All is not one — so the
      // pool is read-only here and taken from a team's own tab.
      ? !!data?.canTakePool && !!data?.team
      : editable.has(issue.team_id)),
    [editable, data?.canTakePool, data?.team]);
  const readOnly = data ? !data.canEdit : true;
  const stats = data?.stats;

  return (
    <div className="tk-page">
      <TopBar
        title="Team Management"
        user={shell.user}
        isAdmin={shell.isAdmin}
        onBack={() => nav("/")}
        backTitle="Tracker"
        onOpenSettings={shell.onOpenSettings}
        onOpenAdmin={shell.onOpenAdmin}
        onLogout={shell.onLogout}
      >
        <TrackerSearch />
      </TopBar>

      <div className="tk-shell">
        <TrackerRail active="teams" isAdmin={shell.isAdmin} />

        <div className="tkq">
        <header className="tkq-head">
          {/* All first: "what are we carrying between us" is the question
              that had no page at all before. */}
          <M3Segmented
            label="Which team"
            value={tab}
            options={[
              { value: "ALL", label: "All" },
              ...teams.map((t) => ({ value: t.key, label: t.name })),
            ]}
            onChange={(next) =>
              setParams(next === "ALL" ? {} : { tab: next }, { replace: true })}
          />
          {readOnly && <span className="tk-chip tk-chip-quiet">read only</span>}
          {tab === "ALL" && !readOnly && (
            <span className="tk-dim tkq-scope">
              Both teams. You can only change your own team’s rows here.
            </span>
          )}
        </header>

        {error && <div className="tkc-err" onClick={() => setError("")}>{error} <X size={14} aria-hidden /></div>}
        {!data && <p className="tk-dim">Loading…</p>}

        {data && stats && (
          <>
            {/* Each card is also the filter for what it counts — the number is
                only useful if the next click is the list behind it. */}
            <div className="tkq-cards">
              <Stat
                value={stats.byPriority.urgent ?? 0}
                label="urgent"
                tone="err"
                hint="Somebody has been told to stop for these"
                on={priority.length === 1 && priority[0] === "urgent"}
                onClick={() => setPriority(
                  priority.length === 1 && priority[0] === "urgent" ? [] : ["urgent"])}
              />
              <Stat
                value={stats.unassigned}
                label={stats.unassigned === 1 ? "task with nobody on it" : "tasks with nobody on it"}
                tone="warn"
                hint="Planned for this team, not given to anyone yet"
                on={who.length === 1 && who[0] === UNASSIGNED}
                onClick={() => setWho(
                  who.length === 1 && who[0] === UNASSIGNED ? [] : [UNASSIGNED])}
              />
              <Stat
                value={stats.idle.length}
                label={stats.idle.length === 1 ? "person with no work" : "people with no work"}
                tone={stats.idle.length ? "warn" : "plain"}
                hint={stats.idle.length
                  ? stats.idle.map((p) => p.display_name).join(", ")
                  : "Everyone has something"}
                faces={stats.idle}
                on={!!stats.idle.length && who.length === stats.idle.length
                    && stats.idle.every((p) => who.includes(String(p.user_id)))}
                onClick={() => setWho(
                  who.length ? [] : stats.idle.map((p) => String(p.user_id)))}
              />
              <Stat
                value={(stats.byPriority.high ?? 0) + (stats.byPriority.highest ?? 0)}
                label="on high or above"
                tone="plain"
                hint="Not counting urgent"
                // "high or above" is two bands, which is exactly what a
                // multiple filter is for.
                on={priority.length === 2 && priority.includes("high")}
                onClick={() => setPriority(
                  priority.length === 2 && priority.includes("high") ? [] : ["highest", "high"])}
              />
              <Stat
                value={stats.parked}
                label={stats.parked === 1 ? "task paused" : "tasks paused"}
                tone="plain"
                hint="Put down for something else and not picked back up"
                on={false}
                onClick={() => setSearch("")}
              />
              <Stat
                value={stats.pool}
                label="free for all"
                tone="plain"
                hint="Planned for no team — either lead can take these"
                on={showPool}
                onClick={() => setShowPool(!showPool)}
              />
            </div>

            <div className="tkq-filters">
              <M3MultiSelect
                values={who}
                width={215}
                placeholder="Anyone"
                noun="people"
                options={[
                  { value: UNASSIGNED, label: "Nobody yet", hint: "unassigned" },
                  ...data.members.map((m) => ({
                    value: String(m.user_id), label: m.display_name, hint: m.craft,
                    avatar: m.avatar, person: true,
                  })),
                  // Somebody outside the team holding this team's work still
                  // needs to be filterable, or their rows cannot be found.
                  ...data.outside.map((m) => ({
                    value: String(m.user_id), label: m.display_name, hint: "outside the team",
                    avatar: m.avatar, person: true,
                  })),
                ]}
                onChange={setWho}
              />
              <M3MultiSelect
                values={priority}
                width={175}
                placeholder="Any priority"
                noun="priorities"
                searchFrom={99}
                options={PRIORITY_SORT.map((p) => ({
                  value: p, label: p, colour: PRIORITY_COLOUR[p],
                }))}
                onChange={setPriority}
              />
              <M3MultiSelect
                values={status}
                width={185}
                placeholder="Any status"
                noun="statuses"
                options={statusOptions.map((o) => ({
                  value: o.value, label: o.label, colour: o.colour,
                  hint: `${o.count} task${o.count === 1 ? "" : "s"}`,
                }))}
                onChange={setStatus}
              />
              <input
                className="tk-search"
                placeholder="Search key or summary…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <label className="tks-req">
                <input type="checkbox" checked={showPool}
                       onChange={(e) => setShowPool(e.target.checked)} />
                include free-for-all
              </label>
              {(who.length > 0 || priority.length > 0 || status.length > 0 || search !== "") && (
                <button type="button" className="tk-link tk-layer"
                        onClick={() => { setWho([]); setPriority([]); setStatus([]); setSearch(""); }}>
                  Clear filters
                </button>
              )}
              <span className="tk-dim tkq-count">
                {rows.length} of {stats.total + (showPool ? stats.pool : 0)}
              </span>
            </div>

            <div className="tk-table-wrap">
              <table className="tk-table tkq-table">
                <thead>
                  <tr>
                    <th style={{ width: 92 }}>Key</th>
                    <th>Task</th>
                    <th style={{ width: 116 }}>Priority</th>
                    <th style={{ width: 176 }}>Assigned to</th>
                    <th style={{ width: 116 }}>Status</th>
                    <th style={{ width: 82 }} title="What the PO asked for">PO plan</th>
                    {tab === "ALL" && <th style={{ width: 92 }}>Team</th>}
                    <th style={{ width: 86 }}>Updated</th>
                    {!readOnly && <th style={{ width: 84 }} />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((issue) => (
                    <Row
                      key={issue.id}
                      issue={issue}
                      team={data.team}
                      teams={teams}
                      showTeam={tab === "ALL"}
                      members={data.members}
                      readOnly={!canEditRow(issue)}
                      busy={busy}
                      onOpen={() => issueDialog.open(issue.key)}
                      onAssign={(userId) =>
                        act(() => trackerApi.assign(issue.id, { assignee_id: userId }))}
                      onPriority={(p) => act(() => trackerApi.assign(issue.id, { priority: p }))}
                      onTake={() => act(() => trackerApi.assign(issue.id, {
                        // On All there is no one team to take it *for*, so the
                        // pool is pulled from a team's own tab.
                        team_id: data.team?.id, set_team: true }))}
                      onUrgent={() => setUrgentFor(issue)}
                    />
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={8} className="tk-empty-row">
                        Nothing matches those filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {data.outside.length > 0 && (
              <p className="tk-dim tkq-note">
                {stats.outside} task{stats.outside === 1 ? "" : "s"} belonging to{" "}
                {data.team ? data.team.name : "a team"} are with people outside it
                ({data.outside.map((p) => p.display_name).join(", ")}) — they are in
                the table above.
              </p>
            )}
          </>
        )}
        </div>
      </div>

      {issueDialog.dialog}

      {urgentFor && (
        <UrgentDialog
          issue={urgentFor}
          onCancel={() => setUrgentFor(null)}
          onConfirm={(reason) => {
            const issue = urgentFor;
            setUrgentFor(null);
            act(() => trackerApi.setUrgent(issue.id, reason, true));
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ pieces --

function Stat({
  value, label, hint, tone, on, onClick, faces,
}: {
  value: number;
  label: string;
  hint: string;
  tone: "err" | "warn" | "plain";
  on: boolean;
  onClick: () => void;
  /** People the number is about — a name is abstract, a face is a person. */
  faces?: { user_id: number; display_name: string; avatar: string }[];
}) {
  return (
    <button
      type="button"
      title={hint}
      className={`tkq-card tkq-card-${tone} tk-layer${on ? " on" : ""}${value ? "" : " tkq-card-zero"}`}
      onClick={onClick}
    >
      <span className="tkq-card-value">{value}</span>
      <span className="tkq-card-label">{label}</span>
      {faces?.length ? (
        <span className="tkq-card-faces">
          {faces.slice(0, 6).map((p) => (
            <Face key={p.user_id} name={p.display_name} avatar={p.avatar} size={22} />
          ))}
          {faces.length > 6 && <span className="tk-dim">+{faces.length - 6}</span>}
        </span>
      ) : (
        <span className="tkq-card-hint">{hint}</span>
      )}
    </button>
  );
}

function Row({
  issue, team, teams, showTeam, members, readOnly, busy, onOpen, onAssign, onPriority,
  onTake, onUrgent,
}: {
  issue: QueueIssue;
  team: TeamQueueData["team"];
  teams: TrackerTeam[];
  showTeam?: boolean;
  members: TeamQueueData["members"];
  readOnly: boolean;
  busy: boolean;
  onOpen: () => void;
  onAssign: (userId: number | null) => void;
  onPriority: (priority: string) => void;
  onTake: () => void;
  onUrgent: () => void;
}) {
  // On a team's own tab, "foreign" means it belongs to nobody yet. On All
  // every row belongs to a team, so nothing is foreign.
  const foreign = !!team && issue.team_id !== team.id;
  const owner = teams.find((t) => t.id === issue.team_id);
  return (
    <tr className={issue.priority === "urgent" ? "tkq-tr-urgent" : undefined}>
      {/* Not .tk-cell-key: that one is a flex container, and a cell which is
          its own flex box drops out of the table's column sizing. */}
      <td className="tkq-td-key">
        <span className="tkq-keyline">
          <TypeGlyph icon={issue.type_icon} colour={issue.type_colour}
                     title={issue.type_name} />
          <IssueKey issueKey={issue.key} className="tkq-key tk-layer" />
        </span>
      </td>
      <td className="tkq-td-task">
        <button type="button" className="tkq-task tk-layer" onClick={onOpen}>
          {issue.summary}
        </button>
        {issue.priority === "urgent" && (
          <span className="tkw-why tkw-why-urgent"
                title={`${issue.urgent_by_name}: ${issue.urgent_reason}`}>
            {issue.urgent_by_name} — {issue.urgent_reason}
          </span>
        )}
        {issue.paused && (
          <span className="tkw-why">
            Paused{issue.paused.for_key ? ` for ${issue.paused.for_key}` : ""}
          </span>
        )}
      </td>
      <td>
        {readOnly || issue.priority === "urgent" ? (
          <span className="tkw-prio" style={{ background: PRIORITY_COLOUR[issue.priority] }}>
            {issue.priority}
          </span>
        ) : (
          <M3Select
            value={issue.priority}
            width={104}
            options={ASSIGNABLE.map((p) => ({ value: p, label: p }))}
            onChange={onPriority}
          />
        )}
      </td>
      <td>
        {foreign ? (
          <button type="button" className="tk-btn tk-layer" disabled={busy} onClick={onTake}>
            Take for {team?.name}
          </button>
        ) : readOnly ? (
          issue.assignee_name
            ? <Person name={issue.assignee_name} avatar={issue.assignee_avatar} />
            : <em className="tk-dim">nobody yet</em>
        ) : (
          <M3Select
            value={issue.assignee_id ? String(issue.assignee_id) : ""}
            width={164}
            placeholder="Nobody yet"
            options={[
              { value: "", label: "Nobody yet" },
              ...members.map((m) => ({
                value: String(m.user_id), label: m.display_name, hint: m.craft,
                avatar: m.avatar, person: true,
              })),
            ]}
            onChange={(v) => onAssign(v ? Number(v) : null)}
          />
        )}
      </td>
      <td>
        <span className="tk-chip" style={{ borderColor: issue.status_colour, color: issue.status_colour }}>
          {issue.status_name}
        </span>
      </td>
      {/* What the PO asked for, kept visible next to what the lead decided —
          the two disagreeing is a conversation, not an error. */}
      <td className="tk-dim">{issue.plan_priority}</td>
      {showTeam && (
        <td>
          {owner ? (
            <span className="tk-chip"
                  style={{ borderColor: owner.colour, color: owner.colour }}>
              {owner.name}
            </span>
          ) : (
            <em className="tk-dim">free</em>
          )}
        </td>
      )}
      <td className="tk-dim tk-num">{ago(issue.updated_at)}</td>
      {!readOnly && (
        <td>
          {issue.priority !== "urgent" && (
            <button type="button" className="tk-btn tk-layer tkq-urgent-btn" disabled={busy}
                    title="Stop-everything urgent — needs a reason" onClick={onUrgent}>
              Urgent
            </button>
          )}
        </td>
      )}
    </tr>
  );
}

/** Urgency needs a name, a time and a reason attached, or everything is urgent
 *  by the end of the quarter. The reason shows on the developer's screen next
 *  to the thing they were told to drop. */
function UrgentDialog({
  issue, onCancel, onConfirm,
}: { issue: QueueIssue; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <div className="tkc-scrim" onClick={onCancel}>
      <div className="tkc tkw-park" onClick={(e) => e.stopPropagation()}>
        <header className="tkc-head">
          <div className="tkc-head-l">
            <div className="tkc-crumb">{issue.key}</div>
            <h2 className="tkc-title">Make this urgent?</h2>
          </div>
        </header>
        <div className="tks-body">
          <p className="tk-dim">
            Urgent means <strong>stop</strong>, not "very important". Whoever has it will be asked
            to park what they are doing, and your name and reason sit on the card.
          </p>
          <input
            className="tkc-input"
            autoFocus
            placeholder="Why does this come before everything else?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && reason.trim() && onConfirm(reason.trim())}
          />
        </div>
        <footer className="tkc-foot">
          <span />
          <div className="tkc-foot-r">
            <button type="button" className="tk-btn tk-layer" onClick={onCancel}>Cancel</button>
            <button type="button" className="tk-btn tk-layer tk-btn-primary"
                    disabled={!reason.trim()}
                    onClick={() => onConfirm(reason.trim())}>
              Make it urgent
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
