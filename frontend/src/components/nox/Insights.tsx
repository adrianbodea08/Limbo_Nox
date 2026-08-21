// What the event log knows about how work actually moves.
//
// Two tabs, following the split Plane got right: **Overview** is the
// table-stakes half that anybody can read, **Flow** is the instrument for
// whoever is trying to fix something. See docs/ANALYTICS.md.
//
// Every section says in one line what it is showing and what a bad shape looks
// like. A chart nobody can read is decoration, and the reason this page exists
// is that the questions it answers are ones no comparable tool can — so the
// answers have to arrive with their meaning attached.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { M3Segmented } from "../M3Segmented";
import { M3Select } from "../M3Select";
import { Bars, Lines, Scatter, Stacked, dur } from "./Charts";
import type { Dot } from "./Charts";
import { trackerApi } from "./model";
import type { InsightsFlow, InsightsOverview, TrackerProject } from "./model";

const PERIODS = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "180", label: "6 months" },
];

type Tab = "overview" | "flow";

export function Insights({ projects }: { projects: TrackerProject[] }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [days, setDays] = useState("30");
  const [project, setProject] = useState("");
  const [overview, setOverview] = useState<InsightsOverview | null>(null);
  const [flow, setFlow] = useState<InsightsFlow | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const nav = useNavigate();

  useEffect(() => {
    setBusy(true);
    setError("");
    const n = Number(days);
    const load = tab === "overview"
      ? trackerApi.insightsOverview(project || undefined, n).then(setOverview)
      : trackerApi.insightsFlow(project || undefined, n).then(setFlow);
    load
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, [tab, days, project]);

  const scope = projects.find((p) => p.key === project);

  return (
    <div className="tki">
      <header className="tk-page-head tki-head">
        <div>
          <h1>Insights</h1>
          <p className="tk-dim">
            {scope ? scope.name : "Every project"} · the last {dayLabel(days)}
          </p>
        </div>
        <div className="tki-controls">
          <M3Select
            value={project}
            width={200}
            placeholder="Every project"
            options={[{ value: "", label: "Every project" },
              ...projects.map((p) => ({ value: p.key, label: p.name, hint: p.key }))]}
            onChange={setProject}
          />
          <M3Select value={days} width={150} options={PERIODS} onChange={setDays} />
        </div>
      </header>

      <M3Segmented
        label="Which half"
        value={tab}
        options={[
          { value: "overview", label: "Overview" },
          { value: "flow", label: "Flow" },
        ] as const}
        onChange={setTab}
      />

      {error && <p className="tk-error">{error}</p>}

      {tab === "overview"
        ? <Overview data={overview} busy={busy} days={days} />
        : <Flow data={flow} busy={busy} onPick={(key) => nav(`/issue/${key}`)} />}
    </div>
  );
}

function dayLabel(days: string) {
  const n = Number(days);
  return n >= 180 ? "six months" : n >= 90 ? "ninety days" : `${n} days`;
}

/** Nothing to draw is information. A blank rectangle is a bug report. */
function Empty({ children }: { children: React.ReactNode }) {
  return <p className="tki-empty">{children}</p>;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="tki-note">{children}</p>;
}

// --------------------------------------------------------------- overview --

function Overview({ data, busy, days }:
  { data: InsightsOverview | null; busy: boolean; days: string }) {
  if (busy && !data) return <p className="tk-dim">Reading the log…</p>;
  if (!data) return null;
  const t = data.throughput;
  const anything = t.created.some(Boolean) || t.finished.some(Boolean);

  return (
    <>
      <div className="tki-cards">
        {data.cards.map((c) => <Card key={c.key} card={c} />)}
      </div>

      <section className="tki-section">
        <h2>Created against finished</h2>
        <Note>
          If the created line sits above the finished one for long enough,
          nothing else on this page matters.
        </Note>
        {anything ? (
          <>
            <Lines
              buckets={t.buckets}
              lines={[
                { label: "Created", values: t.created, colour: "var(--warn)" },
                { label: "Finished", values: t.finished, colour: "var(--ok)" },
              ]}
            />
            <Legend items={[
              { label: "Created", colour: "var(--warn)" },
              { label: "Finished", colour: "var(--ok)" },
            ]} />
          </>
        ) : (
          <Empty>Nothing was created or finished in the last {dayLabel(days)}.</Empty>
        )}
      </section>
    </>
  );
}

function Card({ card }: { card: InsightsOverview["cards"][number] }) {
  const change = card.trend?.change;
  // Up is not good and down is not bad — it depends on the metric, and the
  // metric says which it wants in `better`.
  const good = change == null || change === 0 ? null
    : (change > 0) === (card.better === "up");
  const arrow = change == null ? "" : change > 0 ? "▲" : change < 0 ? "▼" : "";

  return (
    <article className="tki-card" title={card.hint}>
      <h3>{card.label}</h3>
      <div className="tki-card-value">
        {card.unit === "hours" ? dur(card.value) : card.value}
        {card.unit !== "hours" && <span className="tki-card-unit">{card.unit}</span>}
      </div>
      {change != null ? (
        <p className={`tki-trend${good === null ? "" : good ? " good" : " bad"}`}>
          {arrow} {Math.abs(Math.round(change * 100))}% <span className="tk-dim">on the period before</span>
        </p>
      ) : (
        <p className="tki-trend tk-dim">no earlier period to compare</p>
      )}
    </article>
  );
}

function Legend({ items }: { items: { label: string; colour: string }[] }) {
  return (
    <div className="tki-legend">
      {items.map((i) => (
        <span key={i.label} className="tki-legend-item">
          <span className="tki-swatch" style={{ background: i.colour }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------- flow --

function Flow({ data, busy, onPick }:
  { data: InsightsFlow | null; busy: boolean; onPick: (key: string) => void }) {
  if (busy && !data) return <p className="tk-dim">Reading the log…</p>;
  if (!data) return null;

  const share = Math.round(data.actors.automated_share * 100);
  const dots: Dot[] = data.cycle.points;

  return (
    <>
      <section className="tki-section">
        <h2>Where work waits</h2>
        <Note>
          The solid bar is the typical case, the faint one behind it the bad
          case. A status where those two are far apart is not slow — it is one
          things occasionally fall into, and that is a different problem.
          Finished statuses are left out: time spent there is age, not waiting.
        </Note>
        {data.waiting.length ? (
          <Bars rows={data.waiting.map((w) => ({
            label: w.status,
            median: w.median,
            p85: w.p85,
            colour: w.colour || undefined,
          }))} />
        ) : (
          <Empty>No work has sat anywhere long enough to measure.</Empty>
        )}
        {data.waiting_hidden > 0 && (
          <p className="tk-dim tki-cap">
            The ten slowest statuses. {data.waiting_hidden} more are not shown —
            pick a project to narrow it.
          </p>
        )}
      </section>

      <section className="tki-section">
        <h2>How long the whole thing takes</h2>
        <Note>
          One dot per finished issue — first move into progress until first move
          into done. Click one to open it.
        </Note>
        {dots.length ? (
          <Scatter dots={dots} median={data.cycle.median} p85={data.cycle.p85}
                   from={data.from} to={data.to} onPick={onPick} />
        ) : (
          <Empty>Nothing finished in this period.</Empty>
        )}
      </section>

      <section className="tki-section">
        <h2>Who is moving it</h2>
        <Note>
          {data.actors.total > 0 ? (
            <>
              <strong>{share}%</strong> of the {data.actors.total} status changes in
              this period were made by a rule or an integration rather than by a
              person. A rising share is usually good and occasionally a warning —
              it can also mean a rule is flapping.
            </>
          ) : "Nothing moved in this period."}
        </Note>
        {data.actors.total > 0 && (
          <>
            <Stacked
              buckets={data.actors.buckets}
              lines={[
                { label: "People", values: data.actors.human, colour: "var(--text-faint)" },
                { label: "Rules", values: data.actors.automation, colour: "var(--accent)" },
                { label: "Integrations", values: data.actors.integration, colour: "var(--merged)" },
              ]}
            />
            <Legend items={[
              { label: "People", colour: "var(--text-faint)" },
              { label: "Rules", colour: "var(--accent)" },
              { label: "Integrations", colour: "var(--merged)" },
            ]} />
          </>
        )}

        {!!data.moves.length && (
          <div className="tki-scroll">
            <table className="tk-table tki-table">
              <thead>
                <tr>
                  <th>Move</th>
                  <th style={{ width: 90 }}>Times</th>
                  <th style={{ width: 250 }}>By whom</th>
                </tr>
              </thead>
              <tbody>
                {data.moves.map((m) => {
                  const auto = m.automation + m.integration;
                  const pct = Math.round((auto / m.total) * 100);
                  return (
                    <tr key={`${m.from}->${m.to}`}>
                      <td>
                        <span className="tki-move">{m.from}</span>
                        <span className="tk-dim"> → </span>
                        <span className="tki-move">{m.to}</span>
                      </td>
                      <td className="tk-num">{m.total}</td>
                      <td>
                        <span className="tki-split">
                          <span className="tki-split-fill"
                                style={{ width: `${pct}%`, background: "var(--accent)" }} />
                        </span>
                        <span className="tk-dim tki-split-label">
                          {pct === 0 ? "all by hand"
                            : pct === 100 ? "always automatic"
                            : `${pct}% automatic`}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="tki-section">
        <h2>What interruptions cost</h2>
        <Note>
          Every time somebody put work down because something else came first.
          Nox is the only one of these tools that records this at all.
        </Note>
        {data.interruptions.length ? (
          <div className="tki-scroll">
            <table className="tk-table tki-table">
              <thead>
                <tr>
                  <th style={{ width: 110 }}>Put down</th>
                  <th style={{ width: 110 }}>For</th>
                  <th style={{ width: 120 }}>Cost</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {data.interruptions.map((i, n) => (
                  <tr key={`${i.issue}-${n}`}>
                    <td>
                      <button type="button" className="tki-link"
                              onClick={() => onPick(i.issue)}>{i.issue}</button>
                    </td>
                    <td>
                      {i.for
                        ? <button type="button" className="tki-link"
                                  onClick={() => onPick(i.for)}>{i.for}</button>
                        : <span className="tk-dim">—</span>}
                    </td>
                    <td className="tk-num tki-cost">
                      {dur(i.hours)}{i.open && <span className="tk-dim"> so far</span>}
                    </td>
                    <td className="tk-dim">{i.reason || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>Nobody was pulled off anything in this period.</Empty>
        )}
      </section>
    </>
  );
}

export default Insights;
