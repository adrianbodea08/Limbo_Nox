// The four chart shapes the insights page needs, drawn by hand.
//
// docs/ANALYTICS.md says why there is no chart library: one arrives with its
// own type scale, its own palette, its own tooltip and its own idea of a
// rounded corner, and every one of those fights a design system that is now
// machine-checked. Four shapes at a hundred lines each against tokens that
// already exist is the cheaper trade, and it is the same trade the release
// timeline and the workflow diagram already made.
//
// Each chart measures its container rather than scaling a fixed viewBox. A
// scaled viewBox scales the *text* with it, which is how a chart ends up with
// 9px axis labels on a narrow screen and 20px ones on a wide one.

import { useEffect, useRef, useState } from "react";

/** The container's width, so the drawing can use real pixels. */
export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.round(entry.contentRect.width)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** Hours, said the way a person says them.
 *
 *  "958.8 hours" is a number nobody converts in their head. Past two days it
 *  becomes days, past three weeks it becomes weeks, and under a day it keeps
 *  its hours because that is the resolution that matters there. */
export function dur(hours: number): string {
  if (!hours) return "0";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  const days = hours / 24;
  if (days < 21) return `${days.toFixed(days < 10 ? 1 : 0)}d`;
  return `${Math.round(days / 7)}w`;
}

/** Round numbers up the axis, the last of which is at or above `max`.
 *
 *  The "at or above" is the part that was wrong: stopping at `max + step / 2`
 *  can leave the top tick *below* the largest value, and a point plotted
 *  against a scale that does not reach it is drawn outside its own chart. */
function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw)
    ?? magnitude * 10;
  const out: number[] = [];
  // One step past `max`, so the top tick is always at or above the largest
  // value. Rounded because a 2.5 step lands on 0.30000000000000004 sooner or
  // later and an axis should not say that.
  for (let v = 0; v < max + step; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

// --------------------------------------------------------------- bars --

export interface BarRow {
  label: string;
  /** The typical case. */
  median: number;
  /** The bad case. The gap between the two is the whole point. */
  p85: number;
  colour?: string;
  meta?: string;
}

/** A row per thing, the typical case solid and the bad case behind it.
 *
 *  Two bars rather than one because a mean hides the trapdoor: a column whose
 *  median is four hours and whose p85 is nine days is not slow, it is a column
 *  things occasionally fall into, and those want different fixes. */
export function Bars({ rows, unit = dur }: { rows: BarRow[]; unit?: (n: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const LABEL = 116;
  const VALUE = 92;
  const ROW = 30;
  const plot = Math.max(60, width - LABEL - VALUE);
  const max = Math.max(...rows.map((r) => r.p85), 1);
  const height = rows.length * ROW + 8;

  return (
    <div className="tki-chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height} role="img">
          {rows.map((r, i) => {
            const y = i * ROW + 4;
            const worst = (r.p85 / max) * plot;
            const typical = (r.median / max) * plot;
            const colour = r.colour || "var(--accent)";
            return (
              <g key={r.label}>
                <text x={0} y={y + 15} className="tki-axis" dominantBaseline="middle">
                  {r.label}
                </text>
                <rect x={LABEL} y={y + 5} width={Math.max(worst, 1)} height={20} rx={4}
                      fill={colour} opacity={0.22} />
                <rect x={LABEL} y={y + 5} width={Math.max(typical, 1)} height={20} rx={4}
                      fill={colour} opacity={0.85} />
                <text x={LABEL + worst + 8} y={y + 15} className="tki-value"
                      dominantBaseline="middle">
                  {unit(r.median)} <tspan className="tki-faint">/ {unit(r.p85)}</tspan>
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

// -------------------------------------------------------------- lines --

export interface Line {
  label: string;
  values: number[];
  colour: string;
}

/** Two or three series over the same buckets. */
export function Lines({ buckets, lines }: { buckets: string[]; lines: Line[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const H = 190;
  const PAD_L = 34;
  const PAD_B = 22;
  const plotW = Math.max(40, width - PAD_L - 8);
  const plotH = H - PAD_B - 8;
  const max = Math.max(1, ...lines.flatMap((l) => l.values));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;

  const x = (i: number) =>
    PAD_L + (buckets.length < 2 ? plotW / 2 : (i / (buckets.length - 1)) * plotW);
  const y = (v: number) => 8 + plotH - (v / top) * plotH;

  return (
    <div className="tki-chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={H} role="img">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={width - 8} y1={y(t)} y2={y(t)} className="tki-grid" />
              <text x={0} y={y(t)} className="tki-axis" dominantBaseline="middle">{t}</text>
            </g>
          ))}
          {lines.map((l) => (
            <polyline
              key={l.label}
              fill="none"
              stroke={l.colour}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              points={l.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")}
            />
          ))}
          {/* First and last only. A label under every bucket is a smear. */}
          {buckets.length > 0 && (
            <>
              <text x={PAD_L} y={H - 4} className="tki-axis">{shortDate(buckets[0])}</text>
              <text x={width - 8} y={H - 4} className="tki-axis" textAnchor="end">
                {shortDate(buckets[buckets.length - 1])}
              </text>
            </>
          )}
        </svg>
      )}
    </div>
  );
}

// -------------------------------------------------------- stacked area --

/** Three bands summing to the whole, over the same buckets. */
export function Stacked({ buckets, lines }: { buckets: string[]; lines: Line[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const H = 170;
  const PAD_L = 34;
  const PAD_B = 22;
  const plotW = Math.max(40, width - PAD_L - 8);
  const plotH = H - PAD_B - 8;
  const totals = buckets.map((_, i) => lines.reduce((a, l) => a + (l.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;

  const x = (i: number) =>
    PAD_L + (buckets.length < 2 ? plotW / 2 : (i / (buckets.length - 1)) * plotW);
  const y = (v: number) => 8 + plotH - (v / top) * plotH;

  // Bottom-up, each band riding on the sum of the ones below it.
  let floor = buckets.map(() => 0);
  const bands = lines.map((l) => {
    const ceiling = floor.map((f, i) => f + (l.values[i] ?? 0));
    const path = [
      ...ceiling.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`),
      // Back along the floor, right to left, to close the band.
      ...floor.map((_, i) => {
        const j = floor.length - 1 - i;
        return `L${x(j)},${y(floor[j])}`;
      }),
      "Z",
    ].join(" ");
    floor = ceiling;
    return { ...l, path };
  });

  return (
    <div className="tki-chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={H} role="img">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={width - 8} y1={y(t)} y2={y(t)} className="tki-grid" />
              <text x={0} y={y(t)} className="tki-axis" dominantBaseline="middle">{t}</text>
            </g>
          ))}
          {bands.map((b) => (
            <path key={b.label} d={b.path} fill={b.colour} opacity={0.65} />
          ))}
          {buckets.length > 0 && (
            <>
              <text x={PAD_L} y={H - 4} className="tki-axis">{shortDate(buckets[0])}</text>
              <text x={width - 8} y={H - 4} className="tki-axis" textAnchor="end">
                {shortDate(buckets[buckets.length - 1])}
              </text>
            </>
          )}
        </svg>
      )}
    </div>
  );
}

// ------------------------------------------------------------ scatter --

export interface Dot { key: string; hours: number; at: string }

/** One dot per finished issue, with the median and p85 drawn across it.
 *
 *  A distribution rather than an average, because an average of three days made
 *  of one-day and fifteen-day tickets is two different processes reported as
 *  one. The shape of the cloud is the finding; a dot is a ticket you can open. */
export function Scatter({
  dots, median, p85, from, to, onPick,
}: {
  dots: Dot[];
  median: number;
  p85: number;
  /** The window the page is showing. The axis is the period, not the range the
   *  data happens to occupy — four issues finished in one afternoon should sit
   *  in that afternoon's corner of the month, not spread across it. */
  from: string;
  to: string;
  onPick?: (key: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const H = 200;
  const PAD_L = 42;
  const PAD_B = 22;
  const plotW = Math.max(40, width - PAD_L - 12);
  const plotH = H - PAD_B - 10;
  const max = Math.max(1, ...dots.map((d) => d.hours), p85);
  const ticks = niceTicks(max, 3);
  const top = ticks[ticks.length - 1] || 1;

  const first = new Date(from).getTime();
  const last = Math.max(new Date(to).getTime(), first + 1);
  const x = (at: string) =>
    PAD_L + Math.min(1, Math.max(0, (new Date(at).getTime() - first) / (last - first)))
      * plotW;
  const y = (v: number) => 10 + plotH - (v / top) * plotH;

  return (
    <div className="tki-chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={H} role="img">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={width - 8} y1={y(t)} y2={y(t)} className="tki-grid" />
              <text x={0} y={y(t)} className="tki-axis" dominantBaseline="middle">{dur(t)}</text>
            </g>
          ))}
          {/* Labelled on the left. On the right they sat exactly where the most
              recent dots are, and the newest work is what anybody looks at
              first. */}
          {[{ v: median, label: "median" }, { v: p85, label: "p85" }].map((r) => (
            <g key={r.label}>
              <line x1={PAD_L} x2={width - 8} y1={y(r.v)} y2={y(r.v)} className="tki-rule" />
              <text x={PAD_L + 6} y={y(r.v) - 5} className="tki-axis">
                {r.label} {dur(r.v)}
              </text>
            </g>
          ))}
          <text x={PAD_L} y={H - 4} className="tki-axis">{shortDate(from)}</text>
          <text x={width - 8} y={H - 4} className="tki-axis" textAnchor="end">
            {shortDate(to)}
          </text>
          {dots.map((d) => (
            <circle
              key={d.key}
              cx={x(d.at)}
              cy={y(d.hours)}
              r={5}
              className={`tki-dot${onPick ? " tki-dot-click" : ""}`}
              onClick={onPick ? () => onPick(d.key) : undefined}
            >
              <title>{`${d.key} · ${dur(d.hours)} · finished ${shortDate(d.at)}`}</title>
            </circle>
          ))}
        </svg>
      )}
    </div>
  );
}
