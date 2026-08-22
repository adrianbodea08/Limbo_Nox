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

  const running = data?.inProgress ?? [];
  // What is in front of everything else, wherever it happens to sit. The
  // moment somebody escalates, the rest of what is open is not what to be on
  // — and waiting for the pause to be *recorded* would mean saying so only
  // after the person had already started the urgent one, which is after the
  // only decision that mattered.
  const urgentKey = [...running, ...(data?.next ?? [])]
    .find((i) => i.priority === "urgent")?.key ?? null;
  const empty = !!data
    && !running.length && !data.next.length && !data.done.length;

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
                supersededBy={urgentKey}
                onOpen={(i) => issueDialog.open(i.key)}
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

/** What the layer over a card says, if anything.
 *
 *  Two ways to not be the thing you should be on, and the urgent one wins:
 *  being got in front of by an escalation is the more useful thing to know,
 *  and something can easily be both.
 */
function veilFor(issue: QueueIssue, supersededBy?: string | null): string | undefined {
  if (issue.priority === "urgent") return undefined;
  if (supersededBy) return `${supersededBy} comes first`;
  if (!issue.paused) return undefined;
  return issue.paused.for_key
    ? `Paused until ${issue.paused.for_key} is done`
    : "Paused";
}

function Band({
  layout, band, title, hint, issues, empty, numbered, hideWhenEmpty, onOpen, action,
  supersededBy,
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
  /** The key of an urgent issue that is in front of everything here.
   *
   *  It veils the lane the moment something is escalated, rather than waiting
   *  for somebody to start the urgent one — which is the only moment a pause
   *  gets *recorded*, and far too late to be told. Nothing here knows whether
   *  you are five minutes from finishing, so nothing here stops you: the card
   *  underneath still opens, still moves, still finishes. */
  supersededBy?: string | null;
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
              issue.priority === "urgent" ? " tkw-card-urgent" : ""}${
              band?.dragging?.id === issue.id ? " tk-card-dragging" : ""}`}
            {...(band?.rowProps(issue, title, issues, index) ?? {})}
          >
            {numbered && <span className="tkw-num">{index + 1}</span>}
            <CardFace
              issue={issue}
              status
              note={stillWorthSaying(issue)}
              veil={veilFor(issue, supersededBy)}
              onOpen={() => onOpen(issue)}
            />
            {/* Why somebody stopped the queue, attached to the card it is
                about rather than announced above the whole screen. Under it,
                not on it: the card is what the work *is*, and this is what
                happened to it. */}
            {issue.priority === "urgent" && issue.urgent_reason && (
              <div className="tkw-urgent-note">
                <span className="tkw-urgent-word">Urgent</span>
                {issue.urgent_by_name && <strong>{issue.urgent_by_name}</strong>}
                <span>{issue.urgent_reason}</span>
                {issue.urgent_at && <span className="tk-dim">· {ago(issue.urgent_at)}</span>}
              </div>
            )}
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


