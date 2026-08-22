// One developer's screen: what to work on, in order.
//
// There is no filter bar and no board here. The screen answers one question —
// what do I do next — and everything on it is either the answer or the reason
// for the answer.
//
// Four bands, and their order is the whole design:
//
//   Urgent      stop. Somebody put their name to this.
//   In progress what is already open. Several is fine — three tasks with an
//               assistant each is a normal day now.
//   Next        the queue, in (priority, your own order). Position 1 is it.
//   Paused      what was put down, and what took over.
//   Done        what was finished lately — not for reporting, for the person,
//               who otherwise ends every week looking at a screen that shows
//               only what is left.
//
// Columns or a list, and it is a real choice rather than a preference: columns
// show the shape of a day at a glance, a list gives the queue room to be read
// in order. Urgent is not one of the columns either way — it is an interrupt,
// so it stays across the top where it cannot be scrolled past.
//
// A developer can reorder inside one of their own priority bands and nowhere
// else. Enough to plan a day; not enough to argue with the lead.

import { Fragment, useCallback, useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { TopBar, type ShellProps } from "../TopBar";
import { TrackerSearch } from "./TrackerSearch";
import { Face } from "./Face";
import { useIssueDialog } from "./useIssueDialog";
import { DropSlot, useBandReorder } from "./useBandReorder";
import { TrackerRail } from "./TrackerRail";
import { ago, trackerApi } from "./model";
import type { MyWorkData, QueueIssue, TrackerUser } from "./model";
import { M3Segmented } from "../M3Segmented";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { CardFace } from "./CardFace";
import { AsksBand } from "./Asks";

export function MyWorkPage({ shell }: { shell: ShellProps }) {
  const nav = useNavigate();
  // ?user=<id> shows somebody else's screen. A lead asking "what does this
  // look like from where you sit" is a fair question, and answering it with
  // the developer's own screen rather than a report is the honest answer.
  const [params, setParams] = useSearchParams();
  const viewing = params.get("user") ? Number(params.get("user")) : null;
  const layout = params.get("view") === "list" ? "list" : "columns";

  function setLayout(next: "columns" | "list") {
    const p = new URLSearchParams(params);
    next === "columns" ? p.delete("view") : p.set("view", next);
    setParams(p, { replace: true });
  }
  const [data, setData] = useState<MyWorkData | null>(null);
  // Only so answering an ask can complete a name. Once, and a failure is
  // silent: the answer box still works, it just stops suggesting.
  const [people, setPeople] = useState<TrackerUser[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [parking, setParking] = useState<QueueIssue | null>(null);
  const issueDialog = useIssueDialog(() => load());

  const load = useCallback(async () => {
    try {
      setData(await trackerApi.myWork(viewing ?? undefined));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [viewing]);


  useEffect(() => {

    trackerApi.users().then(setPeople).catch(() => {});

  }, []);

  useEffect(() => { load(); }, [load]);

  async function act(fn: () => Promise<MyWorkData>) {
    setBusy(true);
    setError("");
    try {
      setData(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // One way in, whether the order came from a drag or from the arrow buttons.
  // The ids are only what this column was showing; the server merges them into
  // the full band, which it is the only one that can see — a priority can span
  // columns here, and finished work drops off this screen after a fortnight.
  function reorder(priority: string, issueIds: number[]) {
    act(() => trackerApi.reorderMyBand(viewing ?? shell.user.id, priority, issueIds));
  }

  // The same rule as the board, from the same place.
  const band = useBandReorder<QueueIssue>({
    onReorder: (_listKey, priority, issueIds) => reorder(priority, issueIds),
    enabled: !busy,
  });

  // Reordering is only ever within one band, so the move is always between
  // neighbours that share a priority — there is no way to express "above the
  // highest" and therefore no way to try.
  function move(list: QueueIssue[], index: number, by: number) {
    const target = index + by;
    if (target < 0 || target >= list.length) return;
    if (list[index].priority !== list[target].priority) return;
    const ids = list.filter((i) => i.priority === list[index].priority).map((i) => i.id);
    const from = ids.indexOf(list[index].id);
    const to = ids.indexOf(list[target].id);
    [ids[from], ids[to]] = [ids[to], ids[from]];
    reorder(list[index].priority, ids);
  }

  const urgent = data?.urgent ?? [];
  const running = data?.inProgress ?? [];
  const empty = !!data
    && !urgent.length && !running.length && !data.next.length
    && !data.paused.length && !data.done.length;

  return (
    <div className="tk-page">
      <TopBar
        title="My work"
        user={shell.user}
        isAdmin={shell.isAdmin}
        onOpenSettings={shell.onOpenSettings}
        onOpenAdmin={shell.onOpenAdmin}
        onLogout={shell.onLogout}
      >
        <TrackerSearch />
      </TopBar>

      <div className="tk-shell">
        <TrackerRail active="my-work" isAdmin={shell.isAdmin} />

        <div className="tkw">
        {error && <div className="tkc-err" onClick={() => setError("")}>{error} <X size={14} aria-hidden /></div>}
        {!data && <p className="tk-dim">Loading…</p>}

        {data && (
          <>
            <header className="tkw-head">
              <div className="tkw-who">
                <Face name={data.who ?? shell.user.nickname ?? shell.user.username}
                      avatar={data.avatar} size={44} />
                <div>
                <h1>{viewing ? `${data.who ?? "Their"} work` : "My work"}</h1>
                <p className="tk-dim">
                  {data.team
                    ? <>On <strong style={{ color: data.team.colour }}>{data.team.name}</strong></>
                    : "Not on a team yet"}
                  {data.leads && <> · you lead {data.leads.name}</>}
                </p>
                </div>
              </div>
              <div className="tkw-head-r">
                <M3Segmented
                  label="How to show your work"
                  value={layout}
                  options={[
                    { value: "columns", label: "Columns" },
                    { value: "list", label: "List" },
                  ] as const}
                  onChange={setLayout}
                />
                {data.leads && (
                  <button type="button" className="tk-btn tk-layer"
                          onClick={() => nav(`/teams?tab=${data.leads!.key}`)}>
                    {data.leads.name}'s queue →
                  </button>
                )}
              </div>
            </header>

            {/* An empty screen is the right answer when there is no work, and
                a dead end when you are trying to look at the design. Admins get
                a way to put some demo work on themselves. */}
            {empty && shell.isAdmin && (
              <div className="tkw-seed">
                <p>
                  Nothing is assigned to you. Put a slice of the demo work on this account to
                  see how the screen reads — an urgent one, a couple in progress, and one parked.
                </p>
                <button type="button" className="tk-btn tk-layer tk-btn-primary" disabled={busy}
                        onClick={() => act(() => trackerApi.giveMeWork())}>
                  Give me some work
                </button>
              </div>
            )}

            {/* Urgent is not a band with a heading, it is an interruption. It
                gets the loudest thing on the page or it does not work. */}
            {urgent.length > 0 && (
              <section className="tkw-urgent">
                <div className="tkw-urgent-head">
                  <span className="tkw-siren">!</span>
                  <div>
                    <h2>{urgent.length === 1 ? "Stop — this first" : `Stop — ${urgent.length} urgent`}</h2>
                    <p>Everything else waits until this is done.</p>
                  </div>
                </div>
                <div className="tkw-urgent-row">
                  {urgent.map((issue) => (
                    <article key={issue.id} className="tkw-card">
                      <CardFace
                        issue={issue}
                        status
                        onOpen={() => issueDialog.open(issue.key)}
                      />
                      <div className="tkw-why tkw-why-urgent">
                        {issue.urgent_by_name && <strong>{issue.urgent_by_name}</strong>}
                        {" "}{issue.urgent_reason}
                        {issue.urgent_at && <span className="tk-dim"> · {ago(issue.urgent_at)}</span>}
                      </div>
                      {running.length > 0 && (
                        <button type="button" className="tk-btn tk-layer" disabled={busy}
                                onClick={() => setParking(issue)}>
                          Pause what I was doing ({running.length})
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              </section>
            )}

            <div className={layout === "columns" ? "tkw-cols" : "tkw-stack"}>
              {/* What other people need from you, before anything you had
                  planned for yourself — somebody is held up until you answer,
                  and that outranks your own queue. */}
              <AsksBand
                asks={data.asks ?? []}
                me={shell.user.id}
                users={people}
                onOpen={(key) => issueDialog.open(key)}
                onChanged={load}
              />

              <Band
                layout={layout}
                band={band}
                title="In progress"
                hint={running.length > 3
                  ? "A lot at once — finishing one beats starting another."
                  : "What you have open."}
                issues={running}
                empty="Nothing started."
                onOpen={(i) => issueDialog.open(i.key)}
                action={(issue) => (
                  <button type="button" className="tk-btn tk-layer" disabled={busy}
                          onClick={() => act(() => trackerApi.pauseIssue(issue.id, {}))}>
                    Pause
                  </button>
                )}
              />



              <Band
                layout={layout}
                band={band}
                title="Next"
                hint="In order. The top one is what to start."
                issues={data.next}
                empty="Nothing queued — ask your lead."
                numbered
                onOpen={(i) => issueDialog.open(i.key)}
                action={(issue, index) => {
                  const list = data.next;
                  const up = index > 0 && list[index - 1].priority === issue.priority;
                  const down = index < list.length - 1 && list[index + 1].priority === issue.priority;
                  return (
                    <span className="tkw-order">
                      <button type="button" className="tks-mini tk-layer" disabled={busy || !up}
                              title={up ? "Do this one sooner" : "Already first in its priority"}
                              onClick={() => move(list, index, -1)}><ChevronUp size={16} aria-hidden /></button>
                      <button type="button" className="tks-mini tk-layer" disabled={busy || !down}
                              title={down ? "Do this one later" : "Already last in its priority"}
                              onClick={() => move(list, index, 1)}><ChevronDown size={16} aria-hidden /></button>
                    </span>
                  );
                }}
              />

              {/* Paused keeps its column even when empty, so the four do not
                  reflow underneath you the moment something is picked back up. */}
              <Band
                layout={layout}
                band={band}
                title="Paused"
                hint="Put down for something else."
                issues={data.paused}
                empty="Nothing paused."
                hideWhenEmpty={layout === "list"}
                onOpen={(i) => issueDialog.open(i.key)}
                action={(issue) => (
                  <button type="button" className="tk-btn tk-layer tk-btn-primary" disabled={busy}
                          onClick={() => act(() => trackerApi.resumeIssue(issue.id))}>
                    Pick back up
                  </button>
                )}
              />

              <Band
                layout={layout}
                title="Done"
                hint="Finished in the last two weeks."
                issues={data.done}
                empty="Nothing finished yet."
                hideWhenEmpty={layout === "list"}
                onOpen={(i) => issueDialog.open(i.key)}
              />
            </div>
          </>
        )}
        </div>
      </div>

      {issueDialog.dialog}

      {parking && data && (
        <ParkDialog
          urgent={parking}
          running={running}
          onCancel={() => setParking(null)}
          onDone={async (ids) => {
            setParking(null);
            await act(async () => {
              for (const id of ids) await trackerApi.pauseIssue(id, { for_issue_id: parking.id });
              return trackerApi.myWork();
            });
          }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ pieces --

/** The ranking sentence, when it is still worth printing.
 *
 *  `why` was written for a card that showed neither the status nor the
 *  priority, so it says them itself: an in-progress item's reason *is* its
 *  status name, and an ordinary one's is "High priority". The card carries
 *  both as bands now, and a card that says "In Review" twice is a card
 *  somebody has to read twice to find out it said nothing.
 *
 *  The branches that survive are the ones that tell you something the bands
 *  cannot: what is blocking it, what it was put down for, that it is broken in
 *  production, that it is finished. */
function stillWorthSaying(issue: QueueIssue): string | undefined {
  const why = (issue.why ?? "").trim();
  if (!why) return undefined;
  const status = (issue.status_name ?? "").trim();
  const saysTheStatus = why === status || why === `In ${status}`;
  const saysThePriority = why.toLowerCase() === `${issue.priority} priority`;
  // The urgent band prints the reason underneath, in full and in red.
  const saysItIsUrgent = why.startsWith("Urgent");
  return saysTheStatus || saysThePriority || saysItIsUrgent ? undefined : why;
}

function Band({
  layout, band, title, hint, issues, empty, numbered, hideWhenEmpty, onOpen, action,
}: {
  layout: "columns" | "list";
  /** Drag-to-reorder, shared with every other ranked list in the tracker. */
  band?: ReturnType<typeof useBandReorder<QueueIssue>>;
  title: string;
  hint: string;
  issues: QueueIssue[];
  empty: string;
  numbered?: boolean;
  hideWhenEmpty?: boolean;
  onOpen: (i: QueueIssue) => void;
  action?: (i: QueueIssue, index: number) => React.ReactNode;
}) {
  if (hideWhenEmpty && issues.length === 0) return null;
  const column = layout === "columns";
  return (
    <section
      className={column ? "tkw-band tkw-band-col" : "tkw-band"}
      onDragOver={(e) => { if (band?.dragging) e.preventDefault(); }}
      onDrop={(e) => { e.preventDefault(); band?.drop(title, issues); band?.end(); }}
    >
      <header>
        <h2>{title}</h2>
        {column ? <span className="tk-col-count">{issues.length}</span>
                : <span className="tk-dim">{hint}</span>}
      </header>
      {column && <p className="tk-dim tkw-band-hint">{hint}</p>}
      {issues.length === 0 && empty && <p className="tk-dim tkw-empty">{empty}</p>}
      {issues.map((issue, index) => (
        <Fragment key={issue.id}>
          <DropSlot slot={band?.slotAt(title, index) ?? null} />
          <article
            className={`${column ? "tkw-card tkw-card-col" : "tkw-card"}${
              band?.dragging?.id === issue.id ? " tk-card-dragging" : ""}`}
            {...(band?.rowProps(issue, title, issues, index) ?? {})}
          >
            {numbered && <span className="tkw-num">{index + 1}</span>}
            <CardFace
              issue={issue}
              status
              note={stillWorthSaying(issue)}
              onOpen={() => onOpen(issue)}
            />
            {action?.(issue, index)}
          </article>
        </Fragment>
      ))}
      <DropSlot slot={band?.slotAt(title, issues.length) ?? null} />
    </section>
  );
}


/** Which of the running tasks actually stop.
 *
 *  Everything is ticked, because that is the usual answer — but it is a person
 *  pressing the button, not the system deciding. Pausing automatically would
 *  make the interruption figure measure a flag flip instead of somebody
 *  genuinely putting something down. */
function ParkDialog({
  urgent, running, onCancel, onDone,
}: {
  urgent: QueueIssue;
  running: QueueIssue[];
  onCancel: () => void;
  onDone: (ids: number[]) => void;
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set(running.map((r) => r.id)));

  return (
    <div className="tkc-scrim" onClick={onCancel}>
      <div className="tkc tkw-park" onClick={(e) => e.stopPropagation()}>
        <header className="tkc-head">
          <div className="tkc-head-l">
            <div className="tkc-crumb">TAKING {urgent.key}</div>
            <h2 className="tkc-title">What are you putting down?</h2>
          </div>
        </header>
        <div className="tks-body">
          <p className="tk-dim">
            Paused work is timed, so we can see what interruptions actually cost. Untick anything
            that genuinely keeps going.
          </p>
          {running.map((issue) => (
            <label key={issue.id} className="tks-radio tk-layer">
              <input
                type="checkbox"
                checked={picked.has(issue.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  e.target.checked ? next.add(issue.id) : next.delete(issue.id);
                  setPicked(next);
                }}
              />
              <span>
                <strong>{issue.key}</strong> — {issue.summary}
              </span>
            </label>
          ))}
        </div>
        <footer className="tkc-foot">
          <span />
          <div className="tkc-foot-r">
            <button type="button" className="tk-btn tk-layer" onClick={onCancel}>Cancel</button>
            <button type="button" className="tk-btn tk-layer tk-btn-primary"
                    onClick={() => onDone([...picked])}>
              Pause {picked.size} and start {urgent.key}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}


