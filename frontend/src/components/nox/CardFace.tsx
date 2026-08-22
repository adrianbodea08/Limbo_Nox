// An issue, as a card. The only one.
//
// There were two. The board drew the one everything below is about — three
// colour bands along the top edge, the summary, labels on the foot, a row of
// facts along the bottom — and My work drew its own: a glyph, the key, a status
// chip, a priority pill, a title and a sentence. Same object, two faces, and
// the two drifted every time either was touched. A person moving between the
// board and their own work was reading the same issue twice in two languages.
//
// **What is different between the places is passed in, not rebuilt.** My work
// ranks its cards and has to say why, so `note` takes the place the board's
// description preview sits in — the same slot, because on My work there is no
// description to preview and on the board there is no reason to give. My work
// is not a column per status, so it asks for `status`; the board never does,
// because on a board the column *is* the status and printing it on every card
// says the same thing forty times.
//
// The wrapper stays with the caller: dragging belongs to the board, and the
// Pause button and the urgent reason belong to My work. What is shared is the
// face.

import type { CSSProperties, ReactNode } from "react";
import { Face as PersonFace } from "./Face";
import { LabelChips } from "./Labels";
import { plain } from "./Markdown";
import { TypeGlyph } from "./TypeGlyph";
import { IssueKey } from "./IssueKey";
import { PRIORITY_COLOUR, parentColour } from "./model";
import type { CardIssue } from "./model";
export type { CardIssue } from "./model";


/* Where a card's labels go — see the note in styles.css.
 *
 * The class goes on the *card* rather than on the board, because the card is
 * drawn on more than one screen and My work has no board around it: scoped to
 * the board, every card outside it silently fell back to the touch layout and
 * drew its labels as a row of chips through the middle of itself.
 *
 * `out` additionally needs the class on an ancestor of the column, because
 * what it turns off is the column's clipping. The board puts it there too. */
export type TagStyle = "in" | "out" | "bar";
export const TAG_SLOTS: Record<TagStyle, number> = { in: 3, out: 3, bar: 5 };

export function readTagStyle(asked: string | null): TagStyle {
  return asked === "in" || asked === "out" ? asked : "bar";
}

const many = (n: number, one: string, rest = `${one}s`) => `${n} ${n === 1 ? one : rest}`;

/** The first line of a description, with the title taken back out.
 *
 *  Descriptions open by restating the summary, which is already the biggest
 *  thing on the card — so a preview that includes it wastes both its lines
 *  saying the same thing twice. */
function preview(issue: CardIssue): string {
  const body = (issue.description ?? "").trim();
  if (!body) return "";
  const summary = issue.summary.trim().replace(/[.\s]+$/, "");
  const withoutTitle = body.startsWith(summary)
    ? body.slice(summary.length).replace(/^[.\s]+/, "")
    : body;
  // One line with no room to render anything, so the markup comes off rather
  // than showing as asterisks and hyphens.
  return plain(withoutTitle);
}

/** The type and the key, as one band across the card's top-left corner.
 *
 *  On a row — a table or a list — the glyph in line with the key is right,
 *  because a row is read left to right. A column of cards is scanned, and what
 *  a scan finds is a block of colour in a place that never moves.
 *
 *  The band does not take clicks; the key inside it does, and takes them back.
 *  A band that swallowed the pointer would lose the one affordance on a card
 *  that opens an issue in its own window. */
function TypeBand({ issue }: { issue: CardIssue }) {
  return (
    <span
      className="tk-card-corner"
      // A custom property rather than `background` directly: the band's ink is
      // worked out from its colour, and a stylesheet cannot read an inline
      // background to do that.
      style={{ "--band": issue.type_colour } as CSSProperties}
      title={issue.type_name}
    >
      <TypeGlyph icon={issue.type_icon} size={13} />
      <IssueKey issueKey={issue.key} className="tk-key tk-corner-key" />
    </span>
  );
}

/** Priority, said rather than hinted.
 *
 *  It was a coloured dot, which needs a legend nobody has — six priorities and
 *  six shades, told apart only by somebody who already knows the order. The
 *  word is the thing a board is actually scanned for. */
export function Priority({ value }: { value: string }) {
  const colour = PRIORITY_COLOUR[value] ?? PRIORITY_COLOUR.medium;
  return (
    <span
      className={`tk-card-prio tk-prio-${value}`}
      title={`Priority: ${value}`}
      style={{ "--prio": colour } as CSSProperties}
    >
      {value}
    </span>
  );
}

/** The row along the bottom: what is true about this issue that you would
 *  otherwise have to open it to find out.
 *
 *  Always there, even when empty, because a card that changes height as work
 *  happens to it breaks the grid. Blocked comes first and in the error colour
 *  — it is the one that changes what you do next. */
function Badges({ issue, status }: { issue: CardIssue; status?: boolean }) {
  const blocked = issue.blocked_by ?? 0;
  return (
    <div className="tk-card-foot">
      {/* Where a screen has no column per status, the status is a fact about
          the issue like the rest of these. Where it has one, it is the column
          heading and does not belong here too. */}
      {status && issue.status_name && (
        <span className="tk-chip tk-card-status"
              style={{ borderColor: issue.status_colour, color: issue.status_colour }}>
          {issue.status_name}
        </span>
      )}
      {blocked > 0 && (
        <span className="tk-badge tk-badge-stop"
              title={`Blocked by ${many(blocked, "unfinished issue")}`}>
          <svg width="13" height="13" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
            <path d="M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q54 0 104-17.5t92-50.5L228-676q-33 42-50.5 92T160-480q0 134 93 227t227 93Zm252-124q33-42 50.5-92T800-480q0-134-93-227t-227-93q-54 0-104 17.5T284-732l448 448Z" />
          </svg>
          {blocked > 1 && blocked}
        </span>
      )}
      {/* A failing build outranks everything else here for the same reason
          blocked does: it is the one that changes what somebody does next. */}
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
        <span className="tk-badge" title={many(issue.child_count, "child issue")}>
          <svg width="13" height="13" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
            <path d="M200-80q-33 0-56.5-23.5T120-160v-160q0-33 23.5-56.5T200-400h40v-80q0-33 23.5-56.5T320-560h120v-80h-40q-33 0-56.5-23.5T320-720v-160q0-33 23.5-56.5T400-960h160q33 0 56.5 23.5T640-880v160q0 33-23.5 56.5T560-640h-40v80h120q33 0 56.5 23.5T720-480v80h40q33 0 56.5 23.5T840-320v160q0 33-23.5 56.5T760-80H600q-33 0-56.5-23.5T520-160v-160q0-33 23.5-56.5T600-400h40v-80H320v80h40q33 0 56.5 23.5T440-320v160q0 33-23.5 56.5T360-80H200Z" />
          </svg>
          {issue.child_count}
        </span>
      )}
      {!!issue.link_count && (
        <span className="tk-badge" title={many(issue.link_count, "linked issue")}>
          <svg width="13" height="13" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
            <path d="M440-280H280q-83 0-141.5-58.5T80-480q0-83 58.5-141.5T280-680h160v80H280q-50 0-85 35t-35 85q0 50 35 85t85 35h160v80ZM320-440v-80h320v80H320Zm200 160v-80h160q50 0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83 0 141.5 58.5T880-480q0 83-58.5 141.5T680-280H520Z" />
          </svg>
          {issue.link_count}
        </span>
      )}
      {!!issue.comment_count && (
        <span className="tk-badge" title={many(issue.comment_count, "comment")}>
          <svg width="13" height="13" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
            <path d="M240-400h320v-80H240v80Zm0-120h480v-80H240v80Zm0-120h480v-80H240v80ZM80-80v-720q0-33 23.5-56.5T160-880h640q33 0 56.5 23.5T880-800v480q0 33-23.5 56.5T800-240H240L80-80Z" />
          </svg>
          {issue.comment_count}
        </span>
      )}
      {/* Last, and pushed to the far end. Who owns a card is a fact about it
          rather than part of its identity line. A shade smaller than it was in
          the key row: beside 13px count badges, 22 was the loudest thing. */}
      <span className="tk-card-face">
        <PersonFace
          name={issue.assignee_name}
          avatar={issue.assignee_avatar}
          size={20}
          title={issue.assignee_name ? `${issue.assignee_name} — assignee` : "Unassigned"}
        />
      </span>
    </div>
  );
}

export interface CardFaceProps {
  issue: CardIssue;
  onOpen: () => void;
  /** Drawn where the description preview goes. My work's reason for ranking a
   *  card sits here, because a ranked list nobody understands is a ranked list
   *  nobody follows — and there is no description on that screen to lose. */
  note?: string;
  /** Show the status. For screens that are not a column per status. */
  status?: boolean;
  /** Where the labels go, and how many of them fit. */
  tagStyle?: TagStyle;
  selected?: boolean;
  dragging?: boolean;
  /** Whatever the caller needs on the article: drag handlers, ordering. */
  wrapper?: Record<string, unknown>;
  /** Extra classes on the card itself. */
  className?: string;
  /** Anything the screen wants inside the card, after the badges. */
  children?: ReactNode;
}

export function CardFace({
  issue, onOpen, note, status, tagStyle = "bar",
  selected, dragging, wrapper, className = "", children,
}: CardFaceProps) {
  const under = note ?? preview(issue);
  return (
    <article
      className={`tk-card tk-layer tk-tags-${tagStyle}${selected ? " tk-card-on" : ""}${
        dragging ? " tk-card-dragging" : ""}${className ? ` ${className}` : ""}`}
      // A card is a thing you open, so it says so and answers the keyboard.
      // It was a bare `<article onClick>` on the board — reachable only through
      // the key inside it — and a `<button>` on My work, which is invalid: that
      // key is an anchor, and an anchor inside a button is interactive content
      // inside a control. `role="button"` on the article is neither problem.
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); }
      }}
      {...wrapper}
    >
      <div className="tk-card-top">
        <TypeBand issue={issue} />
        {/* What this is part of, alongside what it is called. It gives up its
            width first — the type and the priority either side of it are fixed
            points a board is read by. */}
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
      </div>
      <p className="tk-card-sum">{issue.summary}</p>
      <LabelChips labels={issue.labels ?? []} slots={TAG_SLOTS[tagStyle]} className="tk-card-tags" />
      {under && <p className="tk-card-desc">{under}</p>}
      <Badges issue={issue} status={status} />
      {children}
    </article>
  );
}
