// The release timeline — what is in flight, what overlaps, what is late.
//
// This is the view Swanly is bought for, and the reason we build it rather than
// integrate: the duplication Swanly exists to paper over is a Jira modelling
// problem we do not have. A release here already spans projects, so the
// timeline is a view of our own rows rather than a stitching exercise.
//
// The shape comes from the real data (docs/tracker/RELEASES.md): ~34 releases a
// month, a median of six days each, and up to 28 open at once. That rules out a
// row per release — it would be a screen you scroll forever — so bars are
// packed greedily into as few lanes as will hold them without overlapping.

import { useEffect, useMemo, useRef, useState } from "react";
import { trackerApi } from "./model";
import type { TimelineData, TimelineRelease } from "./model";
import { M3Segmented } from "../M3Segmented";

const DAY = 86_400_000;

/** Weeks for working, months for seeing the year. */
const SCALES = [
  // Names are shown at week scale and not at month scale, and that decides the
  // packing: a label has to be reserved room, and at 4px a day a twenty-letter
  // name reserves six weeks of track. Reserving it made the year view *taller*
  // than the working view, which is backwards.
  { id: "weeks" as const, label: "Weeks", pxPerDay: 14, labels: true },
  { id: "months" as const, label: "Months", pxPerDay: 4, labels: false },
];

const LANE_H = 34;
const BAR_H = 26;
const HEAD_H = 30;

function dayOf(value: string | null): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : Math.floor(t / DAY);
}

/** A release's window, as whole days. A same-day release still gets a bar wide
 *  enough to see and to click — a zero-width bar is a release you cannot open. */
function windowOf(r: TimelineRelease): { from: number; to: number } | null {
  const start = dayOf(r.cycle_start);
  const end = dayOf(r.shipped_at) ?? dayOf(r.planned_at);
  if (start === null && end === null) return null;
  const from = start ?? (end as number);
  const to = Math.max(end ?? from, from);
  return { from, to };
}

export function ReleaseTimeline({ onOpen }: { onOpen: (id: number) => void }) {
  const [data, setData] = useState<TimelineData | null>(null);
  const [scale, setScale] = useState<"weeks" | "months">("weeks");
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const centred = useRef(false);

  useEffect(() => {
    trackerApi.releaseTimeline()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const { pxPerDay, labels: showLabels } = SCALES.find((s) => s.id === scale)!;

  // Lay the bars out: sort by start, then drop each into the first lane whose
  // last bar has finished. Labels need room too, so a lane is only free once
  // there is space for the text — otherwise a name lands on the next bar.
  const layout = useMemo(() => {
    if (!data) return null;
    const bars = data.releases
      .map((r) => ({ r, w: windowOf(r) }))
      .filter((b): b is { r: TimelineRelease; w: { from: number; to: number } } => !!b.w)
      .sort((a, b) => a.w.from - b.w.from || a.w.to - b.w.to);
    if (!bars.length) return null;

    const first = Math.min(...bars.map((b) => b.w.from)) - 3;
    const last = Math.max(...bars.map((b) => b.w.to)) + 3;

    const laneEnds: number[] = [];
    const placed = bars.map((b) => {
      const label = showLabels ? Math.ceil((b.r.name.length * 7 + 26) / pxPerDay) : 1;
      const need = b.w.to + label;
      let lane = laneEnds.findIndex((end) => end < b.w.from);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = need;
      return { ...b, lane };
    });
    return { placed, first, last, lanes: laneEnds.length };
  }, [data, pxPerDay, showLabels]);

  // Open on today rather than at the beginning of history.
  useEffect(() => {
    if (!layout || !scroller.current || centred.current || !data) return;
    centred.current = true;
    const today = Math.floor(Date.parse(data.today) / DAY);
    const x = (today - layout.first) * pxPerDay;
    scroller.current.scrollLeft = Math.max(0, x - scroller.current.clientWidth * 0.55);
  }, [layout, pxPerDay, data]);

  if (error) return <p className="tk-error">{error}</p>;
  if (!data) return <p className="tk-dim">Loading…</p>;
  if (!layout) return <p className="tk-dim">No release has a date yet.</p>;

  const { placed, first, last, lanes } = layout;
  const width = (last - first) * pxPerDay;
  const today = Math.floor(Date.parse(data.today) / DAY);

  // One tick per week or per month, depending on how far out we are zoomed.
  const ticks: { at: number; label: string; strong: boolean }[] = [];
  for (let d = first; d <= last; d++) {
    const date = new Date(d * DAY);
    if (scale === "weeks") {
      if (date.getUTCDay() !== 1) continue;
      ticks.push({
        at: d,
        label: date.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
        strong: date.getUTCDate() <= 7,
      });
    } else if (date.getUTCDate() === 1) {
      ticks.push({
        at: d,
        label: date.toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
        strong: date.getUTCMonth() === 0,
      });
    }
  }

  return (
    <div className="tkt">
      <div className="tkt-head">
        <h2>Timeline</h2>
        <M3Segmented
          label="Timeline scale"
          value={scale}
          options={SCALES.map((s) => ({ value: s.id, label: s.label }))}
          onChange={(next) => { centred.current = false; setScale(next); }}
        />
        <span className="tk-dim tkt-count">
          {placed.length} releases in {lanes} lane{lanes === 1 ? "" : "s"}
          {data.undated > 0 && ` · ${data.undated} with no date, not shown`}
        </span>
      </div>

      <div className="tkt-scroll" ref={scroller}>
        <div className="tkt-canvas" style={{ width, height: lanes * LANE_H + HEAD_H }}>
          {ticks.map((t) => (
            <div
              key={t.at}
              className={`tkt-tick${t.strong ? " tkt-tick-strong" : ""}`}
              style={{ left: (t.at - first) * pxPerDay }}
            >
              <span className="tkt-tick-label">{t.label}</span>
            </div>
          ))}

          {/* Without this, placing yourself means counting columns. */}
          <div className="tkt-today" style={{ left: (today - first) * pxPerDay }}>
            <span className="tkt-today-label">today</span>
          </div>

          {placed.map(({ r, w, lane }) => {
            const shipped = r.artifacts.filter((a) => a.shipped_at).length;
            const tone = r.state === "shipped" ? "shipped"
              : r.late ? "late"
                : r.state === "in_progress" ? "flight" : "plan";
            const left = (w.from - first) * pxPerDay;
            const barWidth = Math.max((w.to - w.from) * pxPerDay, 6);
            const when = `${new Date(w.from * DAY).toLocaleDateString()} - `
              + `${new Date(w.to * DAY).toLocaleDateString()}`;
            return (
              <button
                key={r.id}
                type="button"
                className={`tkt-bar tkt-${tone} tk-layer`}
                style={{ left, top: lane * LANE_H + HEAD_H, width: barWidth, height: BAR_H }}
                onClick={() => onOpen(r.id)}
                title={[
                  `${r.name} (${r.kind})`,
                  when,
                  `${shipped}/${r.artifacts.length} artifacts shipped`,
                  `${r.counts.done}/${r.counts.total} issues done`,
                  r.late ? "Past its planned date and not shipped." : "",
                ].filter(Boolean).join("\n")}
              >
                {/* One tick per artifact, filled once it has gone out — a
                    half-shipped release is the case worth seeing at a glance. */}
                <span className="tkt-arts">
                  {r.artifacts.slice(0, 12).map((a) => (
                    <span key={a.id} className={`tkt-art${a.shipped_at ? " out" : ""}`} />
                  ))}
                </span>
                <span className="tkt-bar-label" hidden={!showLabels}>
                  {/* Only when the name does not already say it — half of them
                      are called "Hotfix 20 JUL", and a badge repeating the
                      first word of the label is noise. */}
                  {r.kind === "hotfix" && !/^hotfix/i.test(r.name) && (
                    <span className="tkt-kind">hotfix</span>
                  )}
                  {r.name}
                  {r.artifacts.length > 0 && (
                    <span className="tkt-bar-meta">{` ${shipped}/${r.artifacts.length}`}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="tkt-key">
        {([["plan", "planning"], ["flight", "in flight"], ["shipped", "shipped"],
          ["late", "past its date"]] as const).map(([tone, label]) => (
          <span key={tone} className="tkt-key-item">
            <span className={`tkt-key-dot tkt-${tone}`} />{label}
          </span>
        ))}
      </div>
    </div>
  );
}
