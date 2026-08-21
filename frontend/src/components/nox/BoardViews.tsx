// The three ways to look at the same issues.
//
// A view here is a filter plus a renderer, so "which board" is a rendering
// choice rather than a different page. Columns for working a queue, Table for
// scanning many at once, List for reading one while keeping your place.

import { Fragment, useState } from "react";
import type { CSSProperties, DragEvent } from "react";
import { DropSlot, useBandReorder } from "./useBandReorder";
import { Face as PersonFace } from "./Face";
import { IssueKey } from "./IssueKey";
import {
  PRIORITY_COLOUR, ago, parentColour,
  type BoardColumn, type BoardData, type TrackerIssue, type TrackerStatus,
} from "./model";

export type Renderer = "columns" | "table" | "list";

function Face({ issue, size = 22 }: { issue: TrackerIssue; size?: number }) {
  return (
    <PersonFace name={issue.assignee_name} avatar={issue.assignee_avatar} size={size}
                title={issue.assignee_name ? `${issue.assignee_name} — assignee` : "Unassigned"} />
  );
}

/** The first line of a description, with the title taken back out.
 *
 *  Descriptions open by restating the summary, which is already the biggest
 *  thing on the card — so a preview that includes it wastes both its lines
 *  saying the same thing twice. */
function preview(issue: TrackerIssue): string {
  const body = (issue.description ?? "").trim();
  if (!body) return "";
  const summary = issue.summary.trim().replace(/[.\s]+$/, "");
  const withoutTitle = body.startsWith(summary)
    ? body.slice(summary.length).replace(/^[.\s]+/, "")
    : body;
  return withoutTitle.replace(/\s+/g, " ").trim();
}

/** The row along the bottom of a card: what is true about this issue that you
 *  would otherwise have to open it to find out.
 *
 *  The row is always there, even when it is empty, because a card that changes
 *  height as work happens to it breaks the grid. Blocked comes first and in the
 *  error colour — it is the one that changes what you do next. A pull request
 *  belongs here too once git integration lands; the space is already its.
 */
function Badges({ issue }: { issue: TrackerIssue }) {
  const blocked = issue.blocked_by ?? 0;
  const many = (n: number, one: string, rest = `${one}s`) => `${n} ${n === 1 ? one : rest}`;
  return (
    <div className="tk-card-foot">
      {blocked > 0 && (
        <span className="tk-badge tk-badge-stop"
              title={`Blocked by ${many(blocked, "unfinished issue")}`}>
          <svg width="13" height="13" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
            <path d="M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q54 0 104-17.5t92-50.5L228-676q-33 42-50.5 92T160-480q0 134 93 227t227 93Zm252-124q33-42 50.5-92T800-480q0-134-93-227t-227-93q-54 0-104 17.5T284-732l448 448Z" />
          </svg>
          {blocked > 1 && blocked}
        </span>
      )}
      {/* The reserved slot in the footer, now filled. A failing build outranks
          everything else here for the same reason blocked does: it is the one
          that changes what somebody does next. */}
      {!!issue.git_summary?.prs && (
        <span
          className={`tk-badge${issue.git_summary.checks === "failing" ? " tk-badge-stop" : ""}${
            issue.git_summary.state === "merged" ? " tk-badge-done" : ""}`}
          title={`${many(issue.git_summary.prs, "pull request")}`
            + ` · ${issue.git_summary.state || "open"}`
            + (issue.git_summary.checks !== "none"
              ? ` · checks ${issue.git_summary.checks}` : "")}
        >
          <svg width="13" height="13" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
            <path d="M280-80q-33 0-56.5-23.5T200-160v-486q-35-12-57.5-43T120-760q0-50 35-85t85-35q50 0 85 35t35 85q0 40-22.5 71T280-646v406h280v-86q-35-12-57.5-43T480-440q0-50 35-85t85-35q50 0 85 35t35 85q0 40-22.5 71T640-326v86q0 33-23.5 56.5T560-160H280Zm-40-600q17 0 28.5-11.5T280-800q0-17-11.5-28.5T240-840q-17 0-28.5 11.5T200-800q0 17 11.5 28.5T240-760Zm360 360q17 0 28.5-11.5T640-440q0-17-11.5-28.5T600-480q-17 0-28.5 11.5T560-440q0 17 11.5 28.5T600-400Z" />
          </svg>
          {issue.git_summary.prs > 1 && issue.git_summary.prs}
        </span>
      )}
      {!!issue.child_count && (
        <span className="tk-badge" title={many(issue.child_count!, "child issue")}>
          <svg width="13" height="13" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
            <path d="M200-80q-33 0-56.5-23.5T120-160v-160q0-33 23.5-56.5T200-400h40v-80q0-33 23.5-56.5T320-560h120v-80h-40q-33 0-56.5-23.5T320-720v-160q0-33 23.5-56.5T400-960h160q33 0 56.5 23.5T640-880v160q0 33-23.5 56.5T560-640h-40v80h120q33 0 56.5 23.5T720-480v80h40q33 0 56.5 23.5T840-320v160q0 33-23.5 56.5T760-80H600q-33 0-56.5-23.5T520-160v-160q0-33 23.5-56.5T600-400h40v-80H320v80h40q33 0 56.5 23.5T440-320v160q0 33-23.5 56.5T360-80H200Z" />
          </svg>
          {issue.child_count}
        </span>
      )}
      {!!issue.link_count && (
        <span className="tk-badge" title={many(issue.link_count!, "linked issue")}>
          <svg width="13" height="13" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
            <path d="M440-280H280q-83 0-141.5-58.5T80-480q0-83 58.5-141.5T280-680h160v80H280q-50 0-85 35t-35 85q0 50 35 85t85 35h160v80ZM320-440v-80h320v80H320Zm200 160v-80h160q50 0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83 0 141.5 58.5T880-480q0 83-58.5 141.5T680-280H520Z" />
          </svg>
          {issue.link_count}
        </span>
      )}
      {!!issue.comment_count && (
        <span className="tk-badge" title={many(issue.comment_count!, "comment")}>
          <svg width="13" height="13" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
            <path d="M240-400h320v-80H240v80Zm0-120h480v-80H240v80Zm0-120h480v-80H240v80ZM80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Z" />
          </svg>
          {issue.comment_count}
        </span>
      )}
    </div>
  );
}

function TypeIcon({ issue }: { issue: TrackerIssue }) {
  return (
    <span className="tk-type" style={{ color: issue.type_colour }} title={issue.type_name}>
      {issue.type_icon}
    </span>
  );
}

function Priority({ value }: { value: string }) {
  return (
    <span
      className="tk-prio"
      title={`Priority: ${value}`}
      style={{ background: PRIORITY_COLOUR[value] ?? PRIORITY_COLOUR.medium }}
    />
  );
}

// ------------------------------------------------------------------ columns --

interface ColumnsProps {
  board: BoardData;
  selectedId: number | null;
  onOpen: (issue: TrackerIssue) => void;
  /** Returns the statuses this issue may legally reach. */
  allowedFor: (issue: TrackerIssue) => Promise<Set<number>>;
  onMove: (issue: TrackerIssue, statusId: number) => void;
  /** The new order of one priority band of one column. */
  onReorder: (column: BoardColumn, priority: string, issueIds: number[]) => void;
}

export function ColumnsBoard({
  board, selectedId, onOpen, allowedFor, onMove, onReorder,
}: ColumnsProps) {
  // While a card is in the air we know exactly where it is allowed to land, so
  // the board says so. Jira lets you drop anywhere and explains afterwards;
  // showing the rule during the drag is the point of having strict transitions.
  const [allowed, setAllowed] = useState<Set<number> | null>(null);
  const [over, setOver] = useState<string | null>(null);

  // Reordering inside a column is the shared rule, unchanged from anywhere
  // else it applies. What is particular to a board — dragging *between*
  // columns, which is a transition and not a reorder — stays here.
  const band = useBandReorder<TrackerIssue>({
    onReorder: (colKey, priority, issueIds) => {
      const col = board.columns.find((c) => String(c.key) === colKey);
      if (col) onReorder(col, priority, issueIds);
    },
  });
  const dragging = band.dragging;

  async function start(issue: TrackerIssue, colKey: string, ev: DragEvent) {
    band.start(issue, colKey, ev);
    setAllowed(await allowedFor(issue));
  }

  function end() {
    band.end();
    setAllowed(null);
    setOver(null);
  }

  /** Which status a drop on this column would move the card to, or null if
   *  none of them is a legal move.
   *
   *  It has to come from the column's own statuses. A column *key* is the board
   *  column's id, which lives in a different space from status ids — testing
   *  one against the other is how a drag ends up transitioning an issue to
   *  whichever status happened to share a number with the column.
   *
   *  A column can hold several statuses, so "which one" is a real question: the
   *  answer is the first of them the issue may actually reach, which for the
   *  ordinary one-status column is simply that status.
   */
  function targetStatus(col: BoardColumn): number | null {
    if (!dragging || !allowed) return null;
    const ids = (col.statuses ?? []).map((s) => s.id);
    if (ids.includes(dragging.status_id)) return dragging.status_id;
    const legal = ids.filter((id) => allowed.has(id));
    return legal.length ? legal[0] : null;
  }

  return (
    <div className="tk-cols">
      {board.columns.map((col) => {
        const dropping = dragging !== null && board.groupBy === "status";
        const landing = dropping ? targetStatus(col) : null;
        const ok = landing !== null;
        return (
          <section
            key={String(col.key)}
            className={`tk-col${dropping ? (ok ? " tk-can-drop" : " tk-no-drop") : ""}${
              over === String(col.key) && ok ? " tk-over" : ""
            }`}
            onDragOver={(e) => {
              if (!ok) return;
              e.preventDefault();
              setOver(String(col.key));
            }}
            onDragLeave={() => setOver((c) => (c === String(col.key) ? null : c))}
            onDrop={(e) => {
              e.preventDefault();
              // Inside its own column a drop is a reorder; across columns it is
              // a transition. Never both.
              if (!band.drop(String(col.key), col.issues) && landing !== null && dragging
                  && dragging.status_id !== landing) {
                onMove(dragging, landing);
              }
              end();
            }}
          >
            <header className="tk-col-head">
              <span className="tk-dot" style={{ background: col.colour || "var(--text-faint)" }} />
              <span className="tk-col-name">{col.name}</span>
              <span className="tk-col-count">{col.issues.length}</span>
            </header>
            <div className="tk-col-body">
              {col.issues.map((issue, index) => (
                <Fragment key={issue.id}>
                  <DropSlot slot={band.slotAt(String(col.key), index)} />
                <article
                  className={`tk-card tk-layer${selectedId === issue.id ? " tk-card-on" : ""}${
                    dragging?.id === issue.id ? " tk-card-dragging" : ""
                  }`}
                  {...band.rowProps(issue, String(col.key), col.issues, index)}
                  onDragStart={(e) => start(issue, String(col.key), e)}
                  onDragEnd={end}
                  onClick={() => onOpen(issue)}
                >
                  <div className="tk-card-top">
                    <TypeIcon issue={issue} />
                    <IssueKey issueKey={issue.key} />
                    {/* What this is part of, alongside what it is called. It
                        gives up its width first — the priority and the face
                        after it are fixed points a board is read by. */}
                    {issue.parent_key && (
                      <span
                        className="tk-card-parent"
                        title={`Part of ${issue.parent_key} — ${issue.parent_summary}`}
                        style={{ "--pill": parentColour(issue.parent_key) } as CSSProperties}
                      >
                        {issue.parent_summary || issue.parent_key}
                      </span>
                    )}
                    <Priority value={issue.priority} />
                    <Face issue={issue} />
                  </div>
                  <p className="tk-card-sum">{issue.summary}</p>
                  {preview(issue) && <p className="tk-card-desc">{preview(issue)}</p>}
                  <Badges issue={issue} />
                </article>
                </Fragment>
              ))}
              <DropSlot slot={band.slotAt(String(col.key), col.issues.length)} />
              {col.issues.length === 0 && <p className="tk-col-empty">Nothing here</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

// -------------------------------------------------------------------- table --

interface TableProps {
  issues: TrackerIssue[];
  selectedId: number | null;
  onOpen: (issue: TrackerIssue) => void;
  sortBy: string;
  sortDir: "asc" | "desc";
  onSort: (field: string) => void;
}

const TABLE_COLUMNS: { field: string; label: string; sortable: boolean }[] = [
  { field: "key", label: "Key", sortable: true },
  { field: "summary", label: "Summary", sortable: true },
  { field: "status_id", label: "Status", sortable: true },
  { field: "priority", label: "Priority", sortable: true },
  { field: "assignee_id", label: "Assignee", sortable: true },
  { field: "tester_id", label: "Tester", sortable: true },
  { field: "updated_at", label: "Updated", sortable: true },
];

export function TableBoard({ issues, selectedId, onOpen, sortBy, sortDir, onSort }: TableProps) {
  return (
    <div className="tk-table-wrap">
      <table className="tk-table">
        <thead>
          <tr>
            {TABLE_COLUMNS.map((c) => (
              <th
                key={c.field}
                className={c.sortable ? "tk-sortable" : undefined}
                onClick={c.sortable ? () => onSort(c.field) : undefined}
              >
                {c.label}
                {sortBy === c.field && <span className="tk-sort">{sortDir === "asc" ? "▲" : "▼"}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {issues.map((issue) => (
            <tr
              key={issue.id}
              className={selectedId === issue.id ? "tk-row-on" : undefined}
              onClick={() => onOpen(issue)}
            >
              <td className="tk-cell-key">
                <TypeIcon issue={issue} />
                <IssueKey issueKey={issue.key} />
              </td>
              <td className="tk-cell-sum">{issue.summary}</td>
              <td>
                <span className="tk-chip" style={{ borderColor: issue.status_colour, color: issue.status_colour }}>
                  {issue.status_name}
                </span>
              </td>
              <td>
                <span className="tk-prio-row">
                  <Priority value={issue.priority} />
                  {issue.priority}
                </span>
              </td>
              <td>
                <span className="tk-assignee">
                  <Face issue={issue} size={20} />
                  {issue.assignee_name ?? <em className="tk-dim">Unassigned</em>}
                </span>
              </td>
              <td>
                <span className="tk-assignee">
                  {issue.tester_id ? (
                    <>
                      <PersonFace name={issue.tester_name} avatar={issue.tester_avatar} size={20} />
                      {issue.tester_name}
                    </>
                  ) : (
                    <em className="tk-dim">No tester</em>
                  )}
                </span>
              </td>
              <td className="tk-dim tk-num">{ago(issue.updated_at)}</td>
            </tr>
          ))}
          {issues.length === 0 && (
            <tr>
              <td colSpan={TABLE_COLUMNS.length} className="tk-empty-row">
                No issues match this view.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// --------------------------------------------------------------------- list --

interface ListProps {
  issues: TrackerIssue[];
  statuses: TrackerStatus[];
  selectedId: number | null;
  onOpen: (issue: TrackerIssue) => void;
}

export function ListBoard({ issues, statuses, selectedId, onOpen }: ListProps) {
  // Grouped by status here too, but stacked rather than side by side — the
  // reading layout, for when the detail panel is the thing you are looking at.
  const order = new Map(statuses.map((s, i) => [s.id, i]));
  const groups = new Map<number, TrackerIssue[]>();
  for (const issue of issues) {
    const list = groups.get(issue.status_id) ?? [];
    list.push(issue);
    groups.set(issue.status_id, list);
  }
  const sorted = [...groups.entries()].sort(
    (a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99),
  );

  return (
    <div className="tk-list">
      {sorted.map(([statusId, group]) => {
        const status = statuses.find((s) => s.id === statusId);
        return (
          <section key={statusId} className="tk-list-group">
            <header className="tk-list-head">
              <span className="tk-dot" style={{ background: status?.colour || "var(--text-faint)" }} />
              {status?.name ?? "Unknown"}
              <span className="tk-col-count">{group.length}</span>
            </header>
            {group.map((issue) => (
              <button
                key={issue.id}
                type="button"
                className={`tk-list-row tk-layer${selectedId === issue.id ? " tk-list-on" : ""}`}
                onClick={() => onOpen(issue)}
              >
                <TypeIcon issue={issue} />
                <IssueKey issueKey={issue.key} />
                <span className="tk-list-sum">{issue.summary}</span>
                <Priority value={issue.priority} />
                <Face issue={issue} size={20} />
              </button>
            ))}
          </section>
        );
      })}
      {issues.length === 0 && <p className="tk-col-empty">No issues match this view.</p>}
    </div>
  );
}
