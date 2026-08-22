// The three ways to look at the same issues.
//
// A view here is a filter plus a renderer, so "which board" is a rendering
// choice rather than a different page. Columns for working a queue, Table for
// scanning many at once, List for reading one while keeping your place.

import { Fragment, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { DragEvent } from "react";
import { DropSlot, useBandReorder } from "./useBandReorder";
import { Face as PersonFace } from "./Face";
import { IssueKey } from "./IssueKey";
import { TypeGlyph } from "./TypeGlyph";
import { CardFace, Priority, readTagStyle, type TagStyle } from "./CardFace";
import {
  ago,
  type BoardColumn, type BoardData, type TrackerIssue, type TrackerStatus,
} from "./model";

export type Renderer = "columns" | "table" | "list";

function Face({ issue, size = 22 }: { issue: TrackerIssue; size?: number }) {
  return (
    <PersonFace name={issue.assignee_name} avatar={issue.assignee_avatar} size={size}
                title={issue.assignee_name ? `${issue.assignee_name} — assignee` : "Unassigned"} />
  );
}



function TypeIcon({ issue }: { issue: TrackerIssue }) {
  return (
    <TypeGlyph icon={issue.type_icon} colour={issue.type_colour} title={issue.type_name} />
  );
}



// ------------------------------------------------------------------ columns --

/* ---- an experiment, on `?tags=` -------------------------------------------
 * Three answers to "where do a card's labels go", switchable so they can be
 * compared on a real board rather than argued about. The losers come out once
 * one is picked; this is not meant to ship as a choice. The treatments
 * themselves live with the card — see CardFace.
 */
function useTagStyle(): TagStyle {
  const [params] = useSearchParams();
  return readTagStyle(params.get("tags"));
}

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
  const tagStyle = useTagStyle();
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
    <div className={`tk-cols tk-tags-${tagStyle}`}>
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
                <CardFace
                  issue={issue}
                  onOpen={() => onOpen(issue)}
                  selected={selectedId === issue.id}
                  dragging={dragging?.id === issue.id}
                  tagStyle={tagStyle}
                  wrapper={{
                    ...band.rowProps(issue, String(col.key), col.issues, index),
                    onDragStart: (e: DragEvent) => start(issue, String(col.key), e),
                    onDragEnd: end,
                  }}
                />
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
                <span className="tk-keyline">
                  <TypeIcon issue={issue} />
                  <IssueKey issueKey={issue.key} />
                </span>
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
