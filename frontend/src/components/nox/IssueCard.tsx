// The issue card — the same shape as the My Board one, with the tracker's own
// fields and no sharing (a tracker issue belongs to a project, not to a person).
//
// Two things here are not in the My Board card, and both come from the tracker
// actually having a workflow:
//
//   The status list shows every status in this project's workflow and disables
//   the ones the workflow will not allow from here, with the reason on hover.
//   A greyed row you can ask about beats a dropdown that accepts the click and
//   fails afterwards.
//
//   Custom fields render from the issue's own JSON, so a field added next month
//   appears here without this file learning about it.
//
// Renders as a dialog or as the body of the full page — same component, so the
// two cannot drift apart.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { M3DatePicker } from "../M3DatePicker";
import { M3Select } from "../M3Select";
import { AsksOnIssue } from "./Asks";
import { LabelEditor } from "./Labels";
import { MentionBox } from "./Mentions";
import { Markdown } from "./Markdown";
import { DevelopmentSummary } from "./Development";
import { Person } from "./Face";
import { IssueKey } from "./IssueKey";
import { ChevronDown, X } from "lucide-react";
import { TypeGlyph } from "./TypeGlyph";
import {
  PRIORITIES, PRIORITY_COLOUR, ago, fieldLabel, trackerApi,
  type IssueField, type LinkType, type ParentCandidate, type TrackerIssue,
  type TrackerMeta, type TrackerTransition, type TrackerUser,
} from "./model";

type Mode = "create" | "edit";

interface Props {
  mode: Mode;
  meta: TrackerMeta;
  /** Edit: the issue. Create: which project to start in. */
  issue?: TrackerIssue;
  projectId?: number;
  users: TrackerUser[];
  /** Dialog chrome, or laid out as a page. */
  chrome: "dialog" | "page";
  onClose: () => void;
  onSaved: (issue: TrackerIssue) => void;
  /** Only offered from the dialog. */
}

export function IssueCard({
  mode, meta, issue, projectId, users, chrome, onClose, onSaved,
}: Props) {
  const project = meta.projects.find(
    (p) => p.id === (issue?.project_id ?? projectId),
  ) ?? meta.projects[0];

  const [typeId, setTypeId] = useState<number>(
    issue?.issue_type_id ?? meta.issueTypes.find((t) => t.key === "task")?.id ?? meta.issueTypes[0].id,
  );
  const [summary, setSummary] = useState(issue?.summary ?? "");
  const [description, setDescription] = useState(issue?.description ?? "");
  // Reading an issue happens far more often than editing one, so a description
  // that has something in it opens rendered. An empty one opens ready to type,
  // because there is nothing to read.
  const [writing, setWriting] = useState(!(issue?.description ?? "").trim());
  const [priority, setPriority] = useState(issue?.priority ?? "medium");
  const [assignee, setAssignee] = useState<number | null>(issue?.assignee_id ?? null);
  const [tester, setTester] = useState<number | null>(issue?.tester_id ?? null);
  const [custom, setCustom] = useState<Record<string, unknown>>(issue?.custom ?? {});

  const [full, setFull] = useState<TrackerIssue | undefined>(issue);
  const [moves, setMoves] = useState<TrackerTransition[]>([]);
  const [comment, setComment] = useState("");
  // Comments first: it is the one people come to add to, and the history is
  // there when they want to know why something happened.
  const [talk, setTalk] = useState<"comments" | "activity">("comments");
  const [linkTypes, setLinkTypes] = useState<LinkType[]>([]);
  // Clipboard writes are silent, so the button says so itself for a moment.
  const [copied, setCopied] = useState<"link" | "key" | null>(null);

  function copy(what: "link" | "key", text: string) {
    navigator.clipboard?.writeText(text);
    setCopied(what);
    window.setTimeout(() => setCopied((c) => (c === what ? null : c)), 1600);
  }

  useEffect(() => {
    trackerApi.linkTypes().then(setLinkTypes).catch(() => {});
  }, []);
  const [menu, setMenu] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (mode !== "edit" || !issue) return;
    let live = true;
    Promise.all([trackerApi.issue(issue.key), trackerApi.transitions(issue.id)])
      .then(([detail, transitions]) => {
        if (!live) return;
        setFull(detail);
        setMoves(transitions);
        setCustom(detail.custom ?? {});
      })
      .catch((e) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [mode, issue?.id, issue?.key]);

  async function refresh() {
    if (!issue) return;
    const [detail, transitions] = await Promise.all([
      trackerApi.issue(issue.key),
      trackerApi.transitions(issue.id),
    ]);
    setFull(detail);
    setMoves(transitions);
    onSaved(detail);
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      if (mode === "edit") await refresh();
    } catch (e) {
      // A refused transition is a sentence, so show it as one.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // Markdown helpers, same as the My Board card — people already know them.
  function md(before: string, after = before, line = false) {
    const ta = bodyRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e, value } = ta;
    let next: string;
    if (line) {
      const ls = value.lastIndexOf("\n", s - 1) + 1;
      const block = value.slice(ls, e) || before.trim();
      next = value.slice(0, ls) + block.split("\n").map((l) => before + l).join("\n") + value.slice(e);
    } else {
      next = value.slice(0, s) + before + value.slice(s, e) + after + value.slice(e);
    }
    setDescription(next);
    requestAnimationFrame(() => ta.focus());
  }

  async function save() {
    if (!summary.trim()) return;
    await run(async () => {
      if (mode === "create") {
        const created = await trackerApi.create({
          project_id: project.id,
          issue_type_id: typeId,
          summary: summary.trim(),
          description,
          priority,
          assignee_id: assignee,
          tester_id: tester,
          custom,
        });
        onSaved(created);
        onClose();
      } else if (issue) {
        await trackerApi.update(issue.id, {
          summary: summary.trim(),
          description,
          priority,
          assignee_id: assignee,
          tester_id: tester,
          issue_type_id: typeId,
          custom,
        });
      }
    });
  }

  const type = meta.issueTypes.find((t) => t.id === typeId);
  // Whether any type sits above this one. Asked of the types rather than
  // hard-coded against "epic", so a new level added later needs no change here.
  const canHaveParent = !!type && meta.issueTypes.some(
    (t) => t.hierarchy_level > type.hierarchy_level);
  const types = meta.issueTypes; // project types come from meta; all are offered
  const dirty =
    mode === "create" ||
    (full &&
      (summary.trim() !== full.summary ||
        description !== (full.description ?? "") ||
        priority !== full.priority ||
        assignee !== full.assignee_id ||
        tester !== (full.tester_id ?? null) ||
        typeId !== full.issue_type_id ||
        JSON.stringify(custom) !== JSON.stringify(full.custom ?? {})));

  const body = (
    <>
      {error && (
        <div className="tkc-err" onClick={() => setError("")}>
          {error} <X size={14} aria-hidden />
        </div>
      )}

      <div className="tkc-body">
        <div className="tkc-main">
          <Field label="Summary">
            <input
              className="tkc-input"
              value={summary}
              autoFocus={mode === "create"}
              placeholder="What needs doing?"
              onChange={(e) => setSummary(e.target.value)}
            />
          </Field>

          <Field label="Description">
            <div className="tkc-desc">
              <div className="tkc-toolbar">
                {/* Write and Read, not Edit and Preview: "preview" suggests a
                    lesser version of the real thing, and the rendered side is
                    the real thing — it is what everybody else will see. */}
                <div className="tkc-modes" role="tablist" aria-label="Description">
                  <button type="button" role="tab" aria-selected={writing}
                          className={`tkc-mode tk-layer${writing ? " on" : ""}`}
                          onClick={() => setWriting(true)}>Write</button>
                  <button type="button" role="tab" aria-selected={!writing}
                          className={`tkc-mode tk-layer${!writing ? " on" : ""}`}
                          onClick={() => setWriting(false)}>Read</button>
                </div>
                {writing && (
                  <>
                    <span className="tkc-tb-div" />
                    <button type="button" className="tkc-tb tk-layer" title="Heading" onClick={() => md("## ", "", true)}>H</button>
                    <button type="button" className="tkc-tb tk-layer" title="Bold" onClick={() => md("**")}><b>B</b></button>
                    <button type="button" className="tkc-tb tk-layer" title="Italic" onClick={() => md("*")}><i>I</i></button>
                    <button type="button" className="tkc-tb tk-layer" title="Strikethrough" onClick={() => md("~~")}><s>S</s></button>
                    <span className="tkc-tb-div" />
                    <button type="button" className="tkc-tb tk-layer" title="Bullet list" onClick={() => md("- ", "", true)}>•</button>
                    <button type="button" className="tkc-tb tk-layer" title="Numbered list" onClick={() => md("1. ", "", true)}>1.</button>
                    <button type="button" className="tkc-tb tk-layer" title="Checklist" onClick={() => md("- [ ] ", "", true)}>&#9744;</button>
                    <span className="tkc-tb-div" />
                    <button type="button" className="tkc-tb tk-layer" title="Link" onClick={() => md("[", "](url)")}>&#128279;</button>
                    <button type="button" className="tkc-tb tk-layer" title="Quote" onClick={() => md("> ", "", true)}>&rdquo;</button>
                    <button type="button" className="tkc-tb tk-layer" title="Code" onClick={() => md("`")}>&lt;/&gt;</button>
                  </>
                )}
              </div>
              {writing ? (
                <MentionBox
                  ref={bodyRef}
                  className="tkc-ta"
                  people={users}
                  value={description}
                  placeholder="Describe the work, acceptance criteria, links…"
                  onChange={setDescription}
                />
              ) : (
                // Clicking the text puts you in it, the way a document does.
                // Not a button: this has links and issue keys inside it, and
                // nesting those in a button is both invalid and unusable.
                <div
                  className="tkc-read"
                  role="button"
                  tabIndex={0}
                  title="Click to write"
                  onClick={(e) => {
                    // A link inside the text is a link, not a way in.
                    if ((e.target as HTMLElement).closest("a")) return;
                    setWriting(true);
                    requestAnimationFrame(() => bodyRef.current?.focus());
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setWriting(true);
                      requestAnimationFrame(() => bodyRef.current?.focus());
                    }
                  }}
                >
                  {description.trim()
                    ? <Markdown text={description} people={users} />
                    : <p className="tk-dim">Describe the work, acceptance criteria, links…</p>}
                </div>
              )}
            </div>
          </Field>

          {mode === "edit" && full && (
            <>
              {/* What is standing in front of this. Loud, because "why can I
                  not start" is the question it answers, and an issue that
                  looks ready and is not wastes somebody's morning. */}
              {!!full.blockers?.length && (
                <div className="tkl-blocked">
                  <strong>Blocked</strong> by{" "}
                  {full.blockers.map((b, i) => (
                    <span key={b.id}>
                      {i > 0 && ", "}
                      <IssueKey issueKey={b.key} /> ({b.status_name})
                    </span>
                  ))}
                </div>
              )}

              {/* The words this team invented for itself. Sits with the
                  issue's own facts rather than in the sidebar of dropdowns:
                  a label is something somebody typed, not something somebody
                  configured. */}
              <Field label="Labels">
                <LabelEditor
                  issueId={full.id}
                  labels={full.labels ?? []}
                  onChanged={(next) => {
                    // Locally at once so the chips answer the click, and up to
                    // the board so the card behind the dialog agrees.
                    const next_issue = { ...full, labels: next };
                    setFull(next_issue);
                    onSaved(next_issue);
                  }}
                />
              </Field>

              {/* Who is waiting on whom. Sits with the issue's facts and above
                  Links, because an open ask is the reason the thing is not
                  moving — which is not a remark. Only in edit mode: there is
                  nothing to ask about an issue that does not exist yet. */}
              {mode === "edit" && full && (
                <Field
                  label={`Asks${
                    (full.asks ?? []).filter((a) => a.state === "open").length
                      ? ` (${(full.asks ?? []).filter((a) => a.state === "open").length} open)`
                      : ""}`}
                >
                  <AsksOnIssue
                    issueId={full.id}
                    asks={full.asks ?? []}
                    users={users}
                    me={meta.me ?? -1}
                    onChanged={refresh}
                  />
                </Field>
              )}

              <Field label={`Links${full.links?.length ? ` (${full.links.length})` : ""}`}>
                <Links
                  issue={full}
                  linkTypes={linkTypes}
                  busy={busy}
                  onAdd={(kind, key) => run(() => trackerApi.addLink(full.id, kind, key))}
                  onRemove={(id) => run(() => trackerApi.removeLink(full.id, id))}
                />
              </Field>

              {!!full.children?.length && (
                <Field label={`Child issues (${full.children.length})`}>
                  <div className="tkl-list">
                    {full.children.map((child) => (
                      <div key={child.id} className="tkl-row">
                        <TypeGlyph icon={child.type_icon} colour={child.type_colour} />
                        <IssueKey issueKey={child.key} />
                        <span className="tkl-sum">{child.summary}</span>
                        <span className="tk-chip"
                              style={{ borderColor: child.status_colour, color: child.status_colour }}>
                          {child.status_name}
                        </span>
                      </div>
                    ))}
                  </div>
                </Field>
              )}
            </>
          )}

          {/* Comments and activity share one panel rather than stacking.
              They answer the same question — what has happened here — and two
              scrolling lists one above the other means the second is only ever
              found by accident. */}
          {mode === "edit" && full && (
            <div className="tkc-talk">
              <nav className="tks-tabs tkc-talk-tabs">
                {([
                  ["comments", `Comments${full.comments?.length ? ` (${full.comments.length})` : ""}`],
                  ["activity", `Activity${full.activity?.length ? ` (${full.activity.length})` : ""}`],
                ] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={`tks-tab tk-layer${talk === id ? " on" : ""}`}
                    onClick={() => setTalk(id)}
                  >
                    {label}
                  </button>
                ))}
              </nav>

              {talk === "comments" ? (
                <div className="tkc-comments">
                  {(full.comments ?? []).map((c) => (
                    <article key={c.id} className="tk-comment">
                      <header>
                        <Person size={20} name={c.author_name ?? "Someone"} avatar={c.author_avatar} />
                        <span className="tk-dim">{ago(c.created_at)}</span>
                      </header>
                      <Markdown text={c.body} people={users} />
                    </article>
                  ))}
                  {!(full.comments ?? []).length && <p className="tk-dim">No comments yet.</p>}
                  <div className="tk-comment-new">
                    <MentionBox
                      rows={2}
                      people={users}
                      placeholder="Add a comment…"
                      value={comment}
                      onChange={setComment}
                    />
                    <button
                      type="button"
                      className="tk-btn tk-layer"
                      disabled={busy || !comment.trim()}
                      onClick={() =>
                        run(async () => {
                          await trackerApi.comment(full.id, comment.trim());
                          setComment("");
                        })
                      }
                    >
                      Comment
                    </button>
                  </div>
                </div>
              ) : (
                <div className="tkc-activity">
                  {(full.activity ?? []).map((ev) => (
                    <div key={ev.batchId} className="tk-event">
                      <span className="tk-event-who">
                        <Person size={18} name={ev.actorName ?? ev.actorKind} avatar={ev.actorAvatar} />
                      </span>
                      <span className="tk-event-what">
                        {ev.kind === "created" && "created this issue"}
                        {ev.kind === "commented" && "commented"}
                        {ev.kind === "release_added" && "put this on a release"}
                        {ev.kind === "release_removed" && "took this off a release"}
                        {ev.kind === "paused" && "paused this"}
                        {ev.kind === "resumed" && "picked this back up"}
                        {ev.kind === "field_changed" &&
                          ev.changes.map((c, i) => (
                            <span key={c.field}>
                              {i > 0 && ", "}
                              changed <strong>{fieldLabel(c.field, meta.fields)}</strong>
                              {` ${readValue(c.field, c.to, meta, users)}`}
                            </span>
                          ))}
                      </span>
                      <span className="tk-dim tk-event-when">{ago(ev.at)}</span>
                    </div>
                  ))}
                  {!(full.activity ?? []).length && <p className="tk-dim">Nothing yet.</p>}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="tkc-side">
          <Field label="Status">
            {/* Only where it can actually go. The whole workflow with most of it
                greyed out was honest but noisy — seventeen rows to find the
                three you may pick. The refusal still exists on the server, and
                the diagram in project settings is where the full shape lives. */}
            <Picker
              open={menu === "status"}
              disabled={mode !== "edit" || busy || moves.length === 0}
              onToggle={() => setMenu(menu === "status" ? null : "status")}
              onClose={() => setMenu(null)}
              button={
                <>
                  <span className="tk-dot" style={{ background: full?.status_colour }} />
                  {full?.status_name ?? "—"}
                </>
              }
              note={
                moves.length === 0 && mode === "edit"
                  ? `Nothing follows ${full?.status_name} in this workflow.`
                  : undefined
              }
              items={moves.map((m) => ({
                id: String(m.to_status_id),
                selected: false,
                text: m.to_name,
                node: (
                  <>
                    <span className="tk-dot" style={{ background: m.to_colour }} />
                    {m.to_name}
                    {/* Only a name somebody wrote. The generated ones are the
                        arrow plus the target, which the row already says. */}
                    {!m.name.endsWith(m.to_name) && (
                      <span className="tkc-move-name">{m.name}</span>
                    )}
                  </>
                ),
                onPick: () => {
                  setMenu(null);
                  if (full) run(() => trackerApi.transition(full.id, m.to_status_id));
                },
              }))}
            />
          </Field>

          <Field label="Priority">
            <Picker
              open={menu === "priority"}
              onToggle={() => setMenu(menu === "priority" ? null : "priority")}
              onClose={() => setMenu(null)}
              button={
                <>
                  <span className="tk-prio" style={{ background: PRIORITY_COLOUR[priority], marginLeft: 0 }} />
                  {priority.replace(/^./, (c) => c.toUpperCase())}
                </>
              }
              items={PRIORITIES.map((p) => ({
                id: p,
                selected: p === priority,
                node: (
                  <>
                    <span className="tk-prio" style={{ background: PRIORITY_COLOUR[p], marginLeft: 0 }} />
                    {p.replace(/^./, (c) => c.toUpperCase())}
                  </>
                ),
                onPick: () => { setPriority(p); setMenu(null); },
              }))}
            />
          </Field>

          <Field label="Assignee">
            <Picker
              open={menu === "assignee"}
              onToggle={() => setMenu(menu === "assignee" ? null : "assignee")}
              onClose={() => setMenu(null)}
              button={
                assignee
                  ? <Person name={users.find((u) => u.id === assignee)?.display_name}
                            avatar={users.find((u) => u.id === assignee)?.avatar} />
                  : <span className="tk-dim">Unassigned</span>
              }
              items={[
                { id: "none", selected: assignee === null, text: "unassigned nobody",
                  node: <span className="tk-dim">Unassigned</span>,
                  onPick: () => { setAssignee(null); setMenu(null); } },
                ...users.map((u) => ({
                  id: String(u.id),
                  selected: u.id === assignee,
                  text: u.display_name,
                  node: <Person name={u.display_name} avatar={u.avatar} />,
                  onPick: () => { setAssignee(u.id); setMenu(null); },
                })),
              ]}
            />
          </Field>

          {/* Under the assignee, and on every type: who checks it is as much a
              part of a piece of work as who does it. Deliberately a separate
              person — the one who wrote it is the worst one to verify it. */}
          <Field label="Tester">
            <Picker
              open={menu === "tester"}
              onToggle={() => setMenu(menu === "tester" ? null : "tester")}
              onClose={() => setMenu(null)}
              button={
                tester
                  ? <Person name={users.find((u) => u.id === tester)?.display_name}
                            avatar={users.find((u) => u.id === tester)?.avatar} />
                  : <span className="tk-dim">No tester</span>
              }
              note={tester && tester === assignee
                ? "Same person as the assignee — nobody is checking this but its author."
                : undefined}
              items={[
                { id: "none", selected: tester === null, text: "no tester nobody",
                  node: <span className="tk-dim">No tester</span>,
                  onPick: () => { setTester(null); setMenu(null); } },
                ...users.map((u) => ({
                  id: String(u.id),
                  selected: u.id === tester,
                  text: `${u.display_name} ${u.craft ?? ""}`,
                  node: (
                    <>
                      <Person name={u.display_name} avatar={u.avatar} />
                      {u.craft === "qa" && <span className="tk-chip tk-chip-quiet">QA</span>}
                    </>
                  ),
                  onPick: () => { setTester(u.id); setMenu(null); },
                })),
              ]}
            />
          </Field>

          {/* What git is doing about it. Only when there is something — an
              empty box on every issue teaches nothing, and most issues have no
              branch until somebody starts. */}
          {!!full?.git?.length && (
            <Field label="Development">
              <DevelopmentSummary refs={full.git} issueKey={full.key} />
            </Field>
          )}

          {/* The fields this project asks for on this type — decided in project
              settings, not invented here. Fields are global and shared, so a
              new one made up on an issue would land on every board that uses
              the same key with no thought about what it means. */}
          {!!(full?.fields ?? []).length && (
            <Field label="Fields">
              <div className="tkc-custom">
                {(full?.fields ?? []).map((f) => (
                  <CustomField
                    key={f.key}
                    field={f}
                    value={custom[f.key]}
                    users={users}
                    openMenu={menu}
                    onMenu={setMenu}
                    onChange={(v) => setCustom({ ...custom, [f.key]: v })}
                  />
                ))}
              </div>
            </Field>
          )}

          {mode === "edit" && full && (
            <>
              <Field label="Releases">
                {full.releases?.length ? (
                  <div className="tkc-releases">
                    {full.releases.map((r) => (
                      <span key={r.id} className={`tk-state tk-state-${r.state}`} title={r.state.replace("_", " ")}>
                        {r.name}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="tk-dim">Not on a release.</span>
                )}
              </Field>

              {/* Hierarchy is a tree and links are a graph. Keeping the two
                  apart is why an epic can contain a story without also
                  "relating to" it.

                  Nothing sits above the top of that tree, so an epic has no
                  parent to offer and the field is not shown at all — a field
                  that can never be filled is worse than a missing one. The
                  server refuses the same arrangement; this stops it being
                  offered in the first place. It does still appear on an issue
                  that somehow has a parent already, because otherwise there
                  would be no way to take it back out. */}
              {(canHaveParent || full.parent) && (
                <Field label="Parent">
                  <Parent issue={full} busy={busy} onSet={(key) =>
                    run(() => trackerApi.setParent(full.id, key))} />
                </Field>
              )}

              <Field label="Details">
                <dl className="tkc-meta">
                  <dt>Project</dt><dd>{full.project_key}</dd>
                  <dt>Reporter</dt>
                  <dd>
                    {full.reporter_id
                      ? <Person size={20}
                                name={users.find((u) => u.id === full.reporter_id)?.display_name}
                                avatar={users.find((u) => u.id === full.reporter_id)?.avatar} />
                      : "—"}
                  </dd>
                  <dt>Created</dt><dd>{new Date(full.created_at).toLocaleDateString()}</dd>
                  <dt>Updated</dt><dd>{ago(full.updated_at)}</dd>
                  {full.resolved_at && (<><dt>Resolved</dt><dd>{new Date(full.resolved_at).toLocaleDateString()}</dd></>)}
                </dl>
              </Field>
            </>
          )}
        </div>
      </div>
    </>
  );

  const footer = (
    <footer className="tkc-foot">
      <div className="tkc-foot-l" />
      <div className="tkc-foot-r">
        <button type="button" className="tk-btn tk-layer" onClick={onClose}>
          {chrome === "page" ? "Back" : "Close"}
        </button>
        <button
          type="button"
          className="tk-btn tk-layer tk-btn-primary"
          disabled={busy || !summary.trim() || !dirty}
          onClick={save}
        >
          {busy ? "Saving…" : mode === "create" ? "Create" : "Save"}
        </button>
      </div>
    </footer>
  );

  // Vertical, and in the top corner: the same three dots, where a card's own
  // actions belong rather than beside Save.
  const kebab = full && (
    <div className="tkc-kebab-wrap">
      <button
        type="button"
        className="tkc-more tk-layer"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={menu === "kebab"}
        onClick={() => setMenu(menu === "kebab" ? null : "kebab")}
      >
        <svg width="20" height="20" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
          <path d="M480-160q-33 0-56.5-23.5T400-240q0-33 23.5-56.5T480-320q33 0 56.5 23.5T560-240q0 33-23.5 56.5T480-160Zm0-240q-33 0-56.5-23.5T400-480q0-33 23.5-56.5T480-560q33 0 56.5 23.5T560-480q0 33-23.5 56.5T480-400Zm0-240q-33 0-56.5-23.5T400-720q0-33 23.5-56.5T480-800q33 0 56.5 23.5T560-720q0 33-23.5 56.5T480-640Z" />
        </svg>
      </button>
      {menu === "kebab" && (
        <>
          <div className="tkc-pop-back" onClick={() => setMenu(null)} />
          <div className="tkc-kebab tkc-kebab-down" role="menu">
            {/* Archive, not delete: events point at this issue and a deleted
                one leaves a history nobody can read. */}
            <button
              type="button"
              className="tkc-kebab-row tkc-danger tk-layer"
              onClick={() =>
                run(async () => {
                  await trackerApi.archiveIssue(full.id);
                  setMenu(null);
                  onClose();
                })
              }
            >
              Archive
            </button>
          </div>
        </>
      )}
    </div>
  );

  // What kind of thing this is, in the header rather than as the first field
  // of the form. It is identity, not data: you read it to know what you are
  // looking at, the same way you read the key — and it took a full-width field
  // to say one word. Still editable, by clicking it.
  const typePicker = (
    <Picker
      variant="chip"
      searchFrom={99}
      open={menu === "type"}
      onToggle={() => setMenu(menu === "type" ? null : "type")}
      onClose={() => setMenu(null)}
      button={
        <>
          <TypeGlyph icon={type?.icon ?? ""} colour={type?.colour} />
          <span className="tkc-type-name">{type?.name}</span>
        </>
      }
      items={types.map((t) => ({
        id: String(t.id),
        selected: t.id === typeId,
        text: t.name,
        node: (
          <>
            <TypeGlyph icon={t.icon} colour={t.colour} />
            {t.name}
          </>
        ),
        onPick: () => { setTypeId(t.id); setMenu(null); },
      }))}
    />
  );

  const head = (
    <header className="tkc-head">
      <div className="tkc-head-l">
        <div className="tkc-crumb">
          {project?.name?.toUpperCase()}
          {full ? ` · ${full.status_name.toUpperCase()}` : ""}
        </div>
        <div className="tkc-titlerow">
          {typePicker}
          <h2 className="tkc-title">
            {mode === "create" ? "Create issue"
              : chrome === "dialog"
                // In the dialog the key is the way to the full page; on the page
                // it is just the title and linking it to itself is noise.
                ? <IssueKey issueKey={(full?.key ?? issue?.key) as string} className="tkc-key"
                            title={`Open ${full?.key ?? issue?.key} as a full page`} />
                : <span className="tkc-key">{full?.key ?? issue?.key}</span>}
          </h2>

          {/* Right next to the thing they act on. Copying a link to an issue is
              how it gets into a chat message, and hunting for it in a menu is
              friction on the most common thing anybody does with a key. */}
          {mode === "edit" && (full?.key ?? issue?.key) && (
            <span className="tkc-keybar">
              <IconButton
                label={copied === "link" ? "Link copied" : "Copy link"}
                done={copied === "link"}
                onClick={() => copy("link", `${location.origin}/issue/${full?.key ?? issue?.key}`)}
              >
                <path d="M440-280H280q-83 0-141.5-58.5T80-480q0-83 58.5-141.5T280-680h160v80H280q-50 0-85 35t-35 85q0 50 35 85t85 35h160v80ZM320-440v-80h320v80H320Zm200 160v-80h160q50 0 85-35t35-85q0-50-35-85t-85-35H520v-80h160q83 0 141.5 58.5T880-480q0 83-58.5 141.5T680-280H520Z" />
              </IconButton>
              <IconButton
                label={copied === "key" ? "Key copied" : "Copy key"}
                done={copied === "key"}
                onClick={() => copy("key", (full?.key ?? issue?.key) as string)}
              >
                <path d="M360-240q-33 0-56.5-23.5T280-320v-480q0-33 23.5-56.5T360-880h360q33 0 56.5 23.5T800-800v480q0 33-23.5 56.5T720-240H360Zm0-80h360v-480H360v480ZM200-80q-33 0-56.5-23.5T120-160v-560h80v560h440v80H200Zm160-240v-480 480Z" />
              </IconButton>
            </span>
          )}
        </div>
      </div>
      {/* The menu lives here now, where the close button was. Closing is
          still a click on the scrim, Escape, or the button in the footer —
          three ways, none of which needed a fourth in the corner. */}
      {mode === "edit" && full && kebab}
    </header>
  );

  if (chrome === "page") {
    return (
      <div className="tkc tkc-as-page">
        {head}
        {body}
        {footer}
      </div>
    );
  }

  return (
    <div className="tkc-scrim" onClick={onClose}>
      <div className="tkc" onClick={(e) => e.stopPropagation()}>
        {head}
        {body}
        {footer}
      </div>
    </div>
  );
}

/** What a changed value should read as.
 *
 *  The event log stores everything as text, which is what makes one column hold
 *  every field type — but it means an assignee change is the string "21" until
 *  somebody turns it back into a person. Nobody can read an id.
 */
function readValue(
  field: string,
  to: string | null,
  meta: TrackerMeta,
  users: TrackerUser[],
): string {
  if (to === null || to === "") return "to nothing";
  if (field === "status_id") {
    return `to ${meta.statuses.find((s) => String(s.id) === to)?.name ?? to}`;
  }
  if (field === "issue_type_id") {
    return `to ${meta.issueTypes.find((t) => String(t.id) === to)?.name ?? to}`;
  }
  if (field === "assignee_id" || field === "reporter_id" || field === "tester_id") {
    return `to ${users.find((u) => String(u.id) === to)?.display_name ?? "someone else"}`;
  }
  if (field === "team_id") return "to another team";
  // Long text — a rewritten description — says that it changed rather than
  // pasting a paragraph into a one-line history entry.
  return to.length < 40 ? `to “${to}”` : "";
}

// ------------------------------------------------------------------ pieces --

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="tkc-field">
      <label className="tkc-label">{label}</label>
      {children}
    </div>
  );
}



function Picker({
  open, onToggle, onClose, button, items, searchFrom = 8, disabled, note,
  variant = "field",
}: {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  button: React.ReactNode;
  /** `text` is what the search matches on — the node is markup. */
  items: {
    id: string;
    selected: boolean;
    node: React.ReactNode;
    text?: string;
    onPick: () => void;
  }[];
  /** Below this many options a search box is more clutter than help. */
  searchFrom?: number;
  disabled?: boolean;
  /** Shown under the list — why there is nothing else to choose, usually. */
  note?: string;
  /** "chip" is the compact form for a header, where the value is identity
   *  rather than a form field. Same menu, same behaviour — only the trigger
   *  differs, so the two cannot drift apart. */
  variant?: "field" | "chip";
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [box, setBox] = useState<Placement | null>(null);
  const showSearch = items.length >= searchFrom;

  useEffect(() => {
    if (open && showSearch) searchRef.current?.focus();
    if (!open) setQuery("");
  }, [open, showSearch]);

  // Measured before paint, so the menu never appears in the wrong place first.
  useLayoutEffect(() => {
    if (!open) { setBox(null); return; }
    const place = () => btnRef.current && setBox(placeMenu(btnRef.current, variant));
    place();
    // The dialog behind this scrolls, and so does the page. Following the
    // trigger beats the alternatives: a menu left behind looks broken, and
    // closing on any scroll fights a trackpad.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, variant]);

  const shown = query.trim()
    ? items.filter((it) => (it.text ?? "").toLowerCase().includes(query.trim().toLowerCase()))
    : items;

  return (
    <div className={`tkc-dd-wrap${variant === "chip" ? " tkc-dd-wrap-chip" : ""}`}>
      <button
        ref={btnRef}
        type="button"
        className={`tkc-dd tk-layer${variant === "chip" ? " tkc-dd-chip" : ""}`}
        onClick={onToggle}
        disabled={disabled}
        title={variant === "chip" ? "Change the issue type" : undefined}
      >
        <span className="tkc-dd-val">{button}</span>
        <span className="tkc-dd-caret"><ChevronDown size={16} aria-hidden /></span>
      </button>
      {open && box && createPortal(
        <>
          <div className="tkc-pop-back" onClick={onClose} />
          <div className="tkc-menu" style={box.style}>
            {showSearch && (
              <div className="tkc-menu-search">
                <input
                  ref={searchRef}
                  value={query}
                  placeholder="Search…"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") onClose();
                    // Enter takes the only remaining match, which is what
                    // typing three letters and pressing enter should do.
                    if (e.key === "Enter" && shown.length === 1) shown[0].onPick();
                  }}
                />
              </div>
            )}
            <div className="tkc-menu-list">
              {shown.map((it) => (
                <button
                  key={it.id}
                  type="button"
                  className={`tkc-menu-row tk-layer${it.selected ? " sel" : ""}`}
                  aria-current={it.selected || undefined}
                  onClick={it.onPick}
                >
                  <span className="tkc-menu-node">{it.node}</span>
                </button>
              ))}
              {shown.length === 0 && <p className="tkc-menu-none">Nothing matches “{query}”.</p>}
            </div>
            {note && <p className="tkc-menu-note">{note}</p>}
          </div>
        </>,
        document.body,
      )}
    </div>
  );
}

interface Placement { style: React.CSSProperties }

/** Where the menu goes, in viewport coordinates.
 *
 *  Below the trigger when there is room, above it when there is not — and the
 *  height it is allowed is whatever is actually left, so a menu near an edge
 *  scrolls internally instead of running off the screen. */
function placeMenu(trigger: HTMLElement, variant: "field" | "chip"): Placement {
  const EDGE = 8;   // never touch the viewport edge
  const GAP = 6;    // the same gap the absolute version used
  const TALLEST = 320;

  const r = trigger.getBoundingClientRect();
  const below = window.innerHeight - r.bottom - EDGE - GAP;
  const above = r.top - EDGE - GAP;
  // Flip only when below is genuinely cramped *and* above is roomier. A menu
  // that flips for the sake of twenty more pixels is a menu that jumps around.
  const flip = below < 200 && above > below;

  const width = variant === "chip" ? Math.max(r.width, 200) : r.width;
  const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - width - EDGE));

  return {
    style: {
      position: "fixed",
      left,
      width: variant === "chip" ? undefined : width,
      minWidth: variant === "chip" ? width : undefined,
      maxWidth: variant === "chip" ? 320 : undefined,
      ...(flip
        ? { bottom: window.innerHeight - r.top + GAP }
        : { top: r.bottom + GAP }),
      maxHeight: Math.min(TALLEST, Math.max(120, flip ? above : below)),
    },
  };
}

/** Branches and pull requests on an issue.
 *
 *  Pull requests first and branches after: a PR is the thing with a state
 *  somebody needs to read, and a branch with no PR only says "started". */

/** A small square icon button that confirms itself after it is pressed. */
function IconButton({
  label, done, onClick, children,
}: {
  label: string;
  done: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={`tkc-iconbtn tk-layer${done ? " done" : ""}`}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {done ? (
        <svg width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
          <path d="M382-240 154-468l57-57 171 171 367-367 57 57-424 424Z" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
          {children}
        </svg>
      )}
    </button>
  );
}

/** The links on an issue, and a way to add one.
 *
 *  Grouped by phrase so "is blocked by" reads as one thing with two issues
 *  under it rather than the same words twice. */
function Links({
  issue, linkTypes, busy, onAdd, onRemove,
}: {
  issue: TrackerIssue;
  linkTypes: LinkType[];
  busy: boolean;
  onAdd: (kind: string, key: string) => void;
  onRemove: (id: number) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState("blocks");
  const [key, setKey] = useState("");

  const groups = new Map<string, typeof issue.links>();
  for (const link of issue.links ?? []) {
    groups.set(link.phrase, [...(groups.get(link.phrase) ?? []), link]);
  }

  return (
    <div className="tkl">
      {[...groups.entries()].map(([phrase, list]) => (
        <div key={phrase} className="tkl-group">
          <span className="tkl-phrase">{phrase}</span>
          <div className="tkl-list">
            {(list ?? []).map((link) => (
              <div key={link.id} className="tkl-row">
                <TypeGlyph icon={link.issue.type_icon} colour={link.issue.type_colour} />
                <IssueKey issueKey={link.issue.key} />
                <span className="tkl-sum">{link.issue.summary}</span>
                <span className="tk-chip"
                      style={{ borderColor: link.issue.status_colour, color: link.issue.status_colour }}>
                  {link.issue.status_name}
                </span>
                <button type="button" className="tks-mini tks-danger tk-layer"
                        disabled={busy} title="Remove this link"
                        onClick={() => onRemove(link.id)}><X size={16} aria-hidden /></button>
              </div>
            ))}
          </div>
        </div>
      ))}
      {!(issue.links ?? []).length && !adding && (
        <p className="tk-dim">Nothing linked.</p>
      )}

      {adding ? (
        <div className="tkl-add">
          <M3Select
            value={kind}
            width={170}
            options={linkTypes.map((t) => ({ value: t.kind, label: t.outward }))}
            onChange={setKind}
          />
          <input
            className="tkc-input tkc-input-sm"
            autoFocus
            placeholder="Issue key, e.g. CD-12"
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !key.trim()) return;
              onAdd(kind, key.trim());
              setKey(""); setAdding(false);
            }}
          />
          <button type="button" className="tk-btn tk-layer" onClick={() => setAdding(false)}>
            Cancel
          </button>
          <button type="button" className="tk-btn tk-layer tk-btn-primary"
                  disabled={!key.trim() || busy}
                  onClick={() => { onAdd(kind, key.trim()); setKey(""); setAdding(false); }}>
            Link
          </button>
        </div>
      ) : (
        <button type="button" className="tk-link tk-layer" onClick={() => setAdding(true)}>
          + link an issue
        </button>
      )}
    </div>
  );
}

/** The issue this one sits under. Candidates come from the server, which knows
 *  which types may parent which — so the list cannot offer something that will
 *  be refused. */
function Parent({
  issue, busy, onSet,
}: {
  issue: TrackerIssue;
  busy: boolean;
  onSet: (key: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ParentCandidate[] | null>(null);

  useEffect(() => {
    if (!open || options) return;
    trackerApi.parentCandidates(issue.id).then(setOptions).catch(() => setOptions([]));
  }, [open, options, issue.id]);

  if (issue.parent) {
    return (
      <div className="tkl-row tkl-parent">
        <TypeGlyph icon={issue.parent.type_icon} colour={issue.parent.type_colour} />
        <IssueKey issueKey={issue.parent.key} />
        <span className="tkl-sum">{issue.parent.summary}</span>
        <button type="button" className="tks-mini tks-danger tk-layer" disabled={busy}
                title="Take it out from under this parent" onClick={() => onSet(null)}><X size={16} aria-hidden /></button>
      </div>
    );
  }

  return (
    <Picker
      open={open}
      disabled={busy}
      onToggle={() => setOpen(!open)}
      onClose={() => setOpen(false)}
      button={<span className="tk-dim">No parent</span>}
      note={options && options.length === 0
        ? "Nothing on this board sits above this type."
        : undefined}
      items={(options ?? []).map((c) => ({
        id: String(c.id),
        selected: false,
        text: `${c.key} ${c.summary}`,
        node: (
          <>
            <TypeGlyph icon={c.type_icon} colour={c.type_colour} />
            <span className="tk-key">{c.key}</span>
            <span className="tkl-sum">{c.summary}</span>
          </>
        ),
        onPick: () => { setOpen(false); onSet(c.key); },
      }))}
    />
  );
}

/** One configured field, drawn the way its kind deserves.
 *
 *  A select rendered as a text box is how "hgih" ends up in a database, which
 *  is the whole reason a field carries a kind at all. */
function CustomField({
  field, value, users, openMenu, onMenu, onChange,
}: {
  field: IssueField;
  value: unknown;
  users: TrackerUser[];
  openMenu: string | null;
  onMenu: (m: string | null) => void;
  onChange: (v: unknown) => void;
}) {
  const id = `field:${field.key}`;
  const label = (
    <span className="tk-dim" title={field.description || undefined}>
      {field.name}
      {field.required && <span className="tkc-req" title="Required">*</span>}
      {field.unconfigured && (
        <span className="tkc-stray" title="Has a value here but is no longer asked for on this type">
          retired
        </span>
      )}
    </span>
  );

  if (field.kind === "select" || field.kind === "multiselect") {
    const options = (field.options ?? []) as string[];
    return (
      <label className="tkc-custom-row">
        {label}
        <Picker
          open={openMenu === id}
          onToggle={() => onMenu(openMenu === id ? null : id)}
          onClose={() => onMenu(null)}
          button={value ? <>{String(value)}</> : <span className="tk-dim">—</span>}
          items={[
            { id: "none", selected: !value, text: "none empty",
              node: <span className="tk-dim">Not set</span>,
              onPick: () => { onChange(null); onMenu(null); } },
            ...options.map((o) => ({
              id: o, selected: value === o, text: o, node: <>{o}</>,
              onPick: () => { onChange(o); onMenu(null); },
            })),
          ]}
        />
      </label>
    );
  }

  if (field.kind === "user") {
    const who = users.find((u) => String(u.id) === String(value));
    return (
      <label className="tkc-custom-row">
        {label}
        <Picker
          open={openMenu === id}
          onToggle={() => onMenu(openMenu === id ? null : id)}
          onClose={() => onMenu(null)}
          button={who ? <Person name={who.display_name} avatar={who.avatar} /> : <span className="tk-dim">—</span>}
          items={[
            { id: "none", selected: !value, text: "none nobody",
              node: <span className="tk-dim">Not set</span>,
              onPick: () => { onChange(null); onMenu(null); } },
            ...users.map((u) => ({
              id: String(u.id), selected: String(u.id) === String(value), text: u.display_name,
              node: <Person name={u.display_name} avatar={u.avatar} />,
              onPick: () => { onChange(u.id); onMenu(null); },
            })),
          ]}
        />
      </label>
    );
  }

  if (field.kind === "date") {
    return (
      <label className="tkc-custom-row">
        {label}
        <M3DatePicker value={typeof value === "string" ? value : ""}
                      onChange={(d) => onChange(d || null)} width={150} />
      </label>
    );
  }

  if (field.kind === "checkbox") {
    return (
      <label className="tkc-custom-row tkc-custom-check">
        {label}
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
      </label>
    );
  }

  return (
    <label className="tkc-custom-row">
      {label}
      <input
        className="tkc-input tkc-input-sm"
        type={field.kind === "number" ? "number" : "text"}
        value={value === null || value === undefined ? "" : String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(null);
          onChange(field.kind === "number" && !Number.isNaN(Number(raw)) ? Number(raw) : raw);
        }}
      />
    </label>
  );
}
