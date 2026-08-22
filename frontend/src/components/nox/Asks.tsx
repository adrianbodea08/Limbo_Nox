// Asks — somebody needs a named person to look at something and come back.
//
// See docs/ASKS.md. Three pieces, because an ask is seen from three places:
//
//   * on the **issue**, with its own facts rather than in the discussion — an
//     open ask is the reason the thing is not moving, which is not a remark
//   * on **My work**, as what other people need from you, oldest first
//   * as the **composer** for making one
//
// The four kinds are fixed and each wants a different shape of answer back, so
// the composer names the shape rather than leaving somebody to guess what
// "confirm" is asking for.

import { CircleHelp, Clock, MessageSquare, Presentation, ShieldQuestion } from "lucide-react";
import { useState } from "react";
import { M3Select } from "../M3Select";
import { Person } from "./Face";
import { CardFace } from "./CardFace";
import { plain } from "./Markdown";
import { ago, trackerApi } from "./model";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import type { Ask, AskKind, TrackerUser } from "./model";

const KINDS: {
  id: AskKind; label: string; Icon: typeof CircleHelp; wants: string; hint: string;
}[] = [
  { id: "confirm", label: "Confirm", Icon: ShieldQuestion, wants: "a verdict",
    hint: "Is this really what it looks like?" },
  { id: "explain", label: "Explain", Icon: CircleHelp, wants: "an answer",
    hint: "I do not understand this — can you explain?" },
  { id: "discuss", label: "Discuss", Icon: MessageSquare, wants: "a conversation",
    hint: "Can we talk about this?" },
  { id: "present", label: "Present", Icon: Presentation, wants: "a slot, then a sign-off",
    hint: "This is done — can we show you?" },
];

const kindOf = (k: AskKind) => KINDS.find((x) => x.id === k) ?? KINDS[0];

/** How long it has been waiting. The part that does the work — an ask nobody
 *  can see the age of is a comment with extra steps. */
function Waited({ since }: { since: string }) {
  const days = (Date.now() - new Date(since).getTime()) / 86400000;
  return (
    <span className={`tka-waited${days >= 3 ? " late" : ""}`}>
      <Clock size={13} aria-hidden /> {ago(since)}
    </span>
  );
}

// ------------------------------------------------------------- on an issue --

export function AsksOnIssue({
  issueId, asks, users, me, onChanged,
}: {
  issueId: number;
  asks: Ask[];
  users: TrackerUser[];
  me: number;
  onChanged: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const open = asks.filter((a) => a.state === "open");
  const settled = asks.filter((a) => a.state !== "open");
  const [showSettled, setShowSettled] = useState(false);

  return (
    <div className="tka">
      {open.map((a) => (
        <AskCard key={a.id} ask={a} me={me} users={users} onChanged={onChanged} />
      ))}

      {asking ? (
        <AskComposer
          issueId={issueId}
          users={users.filter((u) => u.id !== me)}
          onDone={() => { setAsking(false); onChanged(); }}
          onCancel={() => setAsking(false)}
        />
      ) : (
        <button type="button" className="tka-new tk-layer" onClick={() => setAsking(true)}>
          + Ask somebody
        </button>
      )}

      {settled.length > 0 && (
        <button type="button" className="tka-more tk-layer"
                onClick={() => setShowSettled((v) => !v)}>
          {showSettled ? "Hide" : `${settled.length} already settled`}
        </button>
      )}
      {showSettled && settled.map((a) => (
        <AskCard key={a.id} ask={a} me={me} users={users} onChanged={onChanged} />
      ))}
    </div>
  );
}

function AskCard({ ask, me, users, onChanged }: {
  ask: Ask; me: number; users: TrackerUser[]; onChanged: () => void;
}) {
  const kind = kindOf(ask.kind);
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mine = ask.asked_of === me;
  const asked = ask.asked_by === me;

  async function act(what: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await what();
      setReplying(false);
      setText("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`tka-card tka-${ask.state}${ask.blocking ? " tka-blocking" : ""}`}>
      <header className="tka-head">
        <span className={`tka-kind tka-k-${ask.kind}`}>
          <kind.Icon size={14} aria-hidden /> {kind.label}
        </span>
        {ask.blocking && ask.state === "open" && (
          <span className="tka-stops" title="The work waits until this is answered">
            stops the work
          </span>
        )}
        {ask.state === "open"
          ? <Waited since={ask.asked_at} />
          : <span className="tk-dim tka-settled-when">{ask.state} · {ago(ask.answered_at ?? ask.asked_at)}</span>}
      </header>

      {/* Rendered, so a name typed in the question shows as the person it
          reached — and so a question with a list in it reads as a list. */}
      <div className="tka-question">
        <Markdown text={ask.question} people={users} />
      </div>

      <div className="tka-who">
        <Person size={18} name={ask.asked_by_name ?? undefined}
                avatar={ask.asked_by_avatar ?? undefined} />
        <span className="tk-dim">asked</span>
        <Person size={18} name={ask.asked_of_name ?? undefined}
                avatar={ask.asked_of_avatar ?? undefined} />
        <span className="tk-dim">for {kind.wants}</span>
      </div>

      {ask.answer && (
        <div className="tka-answer">
          <span className="tk-dim">{ask.answered_by_name ?? "Answered"}:</span>
          <Markdown text={ask.answer} people={users} />
        </div>
      )}

      {error && <p className="tk-error tka-error">{error}</p>}

      {ask.state === "open" && (mine || asked) && (
        replying ? (
          <div className="tka-reply">
            <Composer
              compact
              autoFocus
              people={users}
              value={text}
              placeholder={mine ? `Give them ${kind.wants}…` : "Why are you taking it back?"}
              onChange={setText}
            />
            <div className="tka-actions">
              <button type="button" className="tk-btn tk-layer" disabled={busy}
                      onClick={() => setReplying(false)}>Cancel</button>
              {/* Declining is kept apart from answering: "I am not the right
                  person" and "here is your answer" are different outcomes, and
                  a queue that cannot tell them apart is one people clear by
                  answering badly. */}
              <button type="button" className="tk-btn tk-layer" disabled={busy}
                      onClick={() => act(() => trackerApi.declineAsk(ask.id, text))}>
                Not mine
              </button>
              <button type="button" className="tk-btn tk-layer tk-btn-primary"
                      disabled={busy || !text.trim()}
                      onClick={() => act(() => trackerApi.answerAsk(ask.id, text))}>
                Answer
              </button>
            </div>
          </div>
        ) : (
          <div className="tka-actions">
            {asked && (
              <button type="button" className="tk-btn tk-layer" disabled={busy}
                      onClick={() => act(() => trackerApi.withdrawAsk(ask.id))}>
                Withdraw
              </button>
            )}
            {mine && (
              <button type="button" className="tk-btn tk-layer tk-btn-primary"
                      onClick={() => setReplying(true)}>
                Answer this
              </button>
            )}
          </div>
        )
      )}
    </article>
  );
}

// -------------------------------------------------------------- the composer --

function AskComposer({
  issueId, users, onDone, onCancel,
}: {
  issueId: number;
  users: TrackerUser[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<AskKind>("explain");
  const [who, setWho] = useState<number | null>(null);
  const [question, setQuestion] = useState("");
  const [blocking, setBlocking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const chosen = kindOf(kind);

  async function send() {
    if (!who || !question.trim()) return;
    setBusy(true);
    setError("");
    try {
      await trackerApi.ask({
        issue_id: issueId, asked_of: who, kind, question, blocking,
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tka-card tka-compose">
      {/* The kind first, because it decides what the person is being asked
          for — and the composer says which, rather than leaving them to guess
          what "confirm" wants back. */}
      <div className="tka-kinds">
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            className={`tka-kind-pick tk-layer${kind === k.id ? " on" : ""}`}
            title={k.hint}
            onClick={() => setKind(k.id)}
          >
            <k.Icon size={15} aria-hidden />
            {k.label}
          </button>
        ))}
      </div>

      <div className="tka-field">
        <span className="tkc-label">Of whom</span>
        <M3Select
          value={who ? String(who) : ""}
          width={260}
          placeholder="Choose somebody…"
          options={users.map((u) => ({
            value: String(u.id), label: u.display_name,
            avatar: u.avatar, person: true,
          }))}
          onChange={(v) => setWho(Number(v) || null)}
        />
      </div>

      {/* Of whom decides who has to answer. Naming somebody in the question
          itself is the other thing people do — "@Ana, is this the same as the
          one you fixed?" — and it has to reach them, so the box completes the
          name rather than trusting the speller. */}
      <Composer
        compact
        people={users}
        value={question}
        placeholder={chosen.hint}
        onChange={setQuestion}
      />

      <label className="tk-toggle tka-blocking-pick">
        <input type="checkbox" checked={blocking}
               onChange={(e) => setBlocking(e.target.checked)} />
        The work stops until this is answered
      </label>

      {error && <p className="tk-error tka-error">{error}</p>}

      <div className="tka-actions">
        <button type="button" className="tk-btn tk-layer" onClick={onCancel}>Cancel</button>
        <button type="button" className="tk-btn tk-layer tk-btn-primary"
                disabled={busy || !who || !question.trim()}
                onClick={send}>
          Ask for {chosen.wants}
        </button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------- on My work --

/** What other people need from you. Oldest first: newest-first would bury the
 *  thing that has waited three weeks under the thing that arrived this
 *  morning, which is the behaviour that turned these into comments nobody
 *  answered. */
export function AsksBand({
  asks, me, users, onOpen, onChanged,
}: {
  asks: Ask[];
  me: number;
  /** So answering one can name somebody. */
  users: TrackerUser[];
  onOpen: (key: string) => void;
  onChanged: () => void;
}) {
  if (!asks.length) return null;
  return (
    <section className="tkw-band tkw-band-col tka-band">
      <header>
        <h2>Waiting on you</h2>
        <span className="tk-dim">{asks.length}</span>
      </header>
      <p className="tk-dim tkw-band-hint">Somebody is held up until you answer.</p>
      {asks.map((a) => <QueuedAsk key={a.id} ask={a} me={me} users={users}
                                  onOpen={onOpen} onChanged={onChanged} />)}
    </section>
  );
}

/** An ask, in a column beside four other columns of cards.
 *
 *  So it is a card. It was its own object — its own header, its own frame, its
 *  own idea of what an issue looks like — sitting in a lane where everything
 *  else was an issue card, and it read as a different kind of thing rather
 *  than as the same work seen from another angle.
 *
 *  The card says which issue. What is particular to an ask goes where every
 *  other lane puts what is particular to it: underneath. Who is waiting, how
 *  long, and the one button that matters.
 *
 *  The question itself takes the card's note slot — the place a description
 *  preview sits on the board and a ranking reason sits in the other lanes.
 *  Plain rather than rendered: it is one line of a card, and a heading or a
 *  list in it would be a heading or a list in the middle of a card. The whole
 *  thing, formatted, is on the issue.
 */
function QueuedAsk({ ask, me, users, onOpen, onChanged }: {
  ask: Ask; me: number; users: TrackerUser[];
  onOpen: (key: string) => void; onChanged: () => void;
}) {
  const kind = kindOf(ask.kind);
  const [replying, setReplying] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function act(what: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await what();
      setReplying(false);
      setText("");
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // An ask about an issue this person cannot see comes back without one. It
  // is still their ask and still needs answering, so it keeps its place and
  // says what it can.
  if (!ask.issue) {
    return (
      <article className="tkw-card">
        <p className="tk-dim">{plain(ask.question)}</p>
      </article>
    );
  }

  return (
    <article className={`tkw-card tka-queued tka-k-${ask.kind}`}>
      {/* What is being asked for, as the heading of the thing it is asked
          about. Four kinds want four different shapes of answer, and which one
          this is decides whether you can deal with it in a sentence or have to
          book half an hour — so it is the first thing read, not a chip under
          the card. It takes the kind's own colour, which is the only place on
          this screen that colour means anything. */}
      <header className="tka-queued-title">
        <kind.Icon size={17} aria-hidden />
        <h3>{kind.label}</h3>
        {ask.blocking && (
          <span className="tka-stops" title="The work waits until this is answered">
            stops the work
          </span>
        )}
        <Waited since={ask.asked_at} />
      </header>
      <CardFace
        issue={ask.issue}
        status
        note={plain(ask.question)}
        onOpen={() => ask.issue_key && onOpen(ask.issue_key)}
      />

      <div className="tka-queued-who">
        <Person size={18} name={ask.asked_by_name ?? undefined}
                avatar={ask.asked_by_avatar ?? undefined} />
        <span className="tk-dim">wants {kind.wants}</span>
      </div>

      {error && <p className="tk-error tka-error">{error}</p>}

      {replying ? (
        <div className="tka-reply">
          <Composer
            compact
            autoFocus
            people={users}
            value={text}
            placeholder={`Give them ${kind.wants}…`}
            onChange={setText}
          />
          <div className="tka-actions">
            <button type="button" className="tk-btn tk-layer" disabled={busy}
                    onClick={() => setReplying(false)}>Cancel</button>
            {/* Declining is kept apart from answering: "I am not the right
                person" and "here is your answer" are different outcomes, and a
                queue that cannot tell them apart is one people clear by
                answering badly. */}
            <button type="button" className="tk-btn tk-layer" disabled={busy}
                    onClick={() => act(() => trackerApi.declineAsk(ask.id, text))}>
              Not mine
            </button>
            <button type="button" className="tk-btn tk-layer tk-btn-primary"
                    disabled={busy || !text.trim()}
                    onClick={() => act(() => trackerApi.answerAsk(ask.id, text))}>
              Answer
            </button>
          </div>
        </div>
      ) : (
        ask.asked_of === me && (
          <button type="button" className="tk-btn tk-layer tk-btn-primary"
                  onClick={() => setReplying(true)}>
            Answer this
          </button>
        )
      )}
    </article>
  );
}

export default AsksOnIssue;
