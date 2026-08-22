// The workflow as a diagram — statuses as boxes, transitions as labelled
// arrows, and a panel on the right for whichever status you click.
//
// A grid of checkboxes is the better editor for bulk work and the worse one for
// understanding, and understanding is what people open a workflow for. Both are
// here: Diagram to read it, Grid to change a lot of it at once.
//
// Layout is auto until somebody drags a box, then it is remembered on the
// workflow — not per person, because a diagram everyone arranges differently is
// one nobody can point at during a conversation.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { M3Select } from "../M3Select";
import { trackerApi } from "./model";
import type { ProjectSettingsData } from "./model";
import { ArrowLeft, X } from "lucide-react";

const NODE_W = 172;
const NODE_H = 48;
const GAP_X = 130;
const GAP_Y = 128;

type Pos = { x: number; y: number };
type Act = (fn: () => Promise<ProjectSettingsData>) => Promise<void>;

/** Boustrophedon: rows alternate direction, so the last box of one row sits
 *  above the first of the next and the arrow between them is short.
 *
 *  How many fit per row comes from the width available rather than a constant,
 *  because the same seventeen statuses want four rows in a panel and two on a
 *  full screen. */
function autoLayout(ids: number[], width: number): Record<string, Pos> {
  // n boxes span n*NODE_W + (n-1)*GAP_X, inside the canvas padding and a
  // margin either side. Solved rather than guessed, so the row never runs off
  // the edge and forces a sideways scroll on a diagram that would have fitted.
  const usable = Math.max(240, width - 112);
  const perRow = Math.max(2, Math.floor((usable + GAP_X) / (NODE_W + GAP_X)));
  const out: Record<string, Pos> = {};
  ids.forEach((id, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const x = row % 2 === 0 ? col : perRow - 1 - col;
    out[String(id)] = { x: 40 + x * (NODE_W + GAP_X), y: 48 + row * (NODE_H + GAP_Y) };
  });
  return out;
}

/** Where a line between two boxes should meet each one's edge. */
function anchor(from: Pos, to: Pos) {
  const fc = { x: from.x + NODE_W / 2, y: from.y + NODE_H / 2 };
  const tc = { x: to.x + NODE_W / 2, y: to.y + NODE_H / 2 };
  const dx = tc.x - fc.x;
  const dy = tc.y - fc.y;
  const horizontal = Math.abs(dx) > Math.abs(dy);
  const start = horizontal
    ? { x: fc.x + Math.sign(dx) * (NODE_W / 2), y: fc.y }
    : { x: fc.x, y: fc.y + Math.sign(dy) * (NODE_H / 2) };
  const end = horizontal
    ? { x: tc.x - Math.sign(dx) * (NODE_W / 2 + 7), y: tc.y }
    : { x: tc.x, y: tc.y - Math.sign(dy) * (NODE_H / 2 + 7) };
  return { start, end };
}

export function FlowDiagram({
  data, busy, act,
}: { data: ProjectSettingsData; busy: boolean; act: Act }) {
  const cols = data.workflow.columns;
  const [selected, setSelected] = useState<number | null>(cols[0]?.id ?? null);
  const [labels, setLabels] = useState(true);
  const [zoom, setZoom] = useState(1);
  const [full, setFull] = useState(false);
  const [drag, setDrag] = useState<{ id: number; dx: number; dy: number } | null>(null);
  const [local, setLocal] = useState<Record<string, Pos> | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1000);

  // The automatic layout depends on how much room there is, so it is measured
  // rather than assumed — and measured more than one way on purpose.
  //
  // A ResizeObserver is the right tool and catches every later change, but its
  // callbacks are delivered during the rendering steps, so a page that is not
  // compositing never gets one and the layout silently keeps its initial guess.
  // The synchronous read in useLayoutEffect is what makes the first paint
  // correct regardless; the timeout catches a layout that settles a frame late.
  useLayoutEffect(() => {
    const measure = () => {
      const w = surface.current?.getBoundingClientRect().width ?? 0;
      if (w > 0) setWidth(w);
    };
    measure();
    const settle = setTimeout(measure, 120);
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (surface.current && observer) observer.observe(surface.current);
    return () => {
      clearTimeout(settle);
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, [full]);

  // Escape leaves full screen, which is what everyone tries first.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const saved = data.workflow.layout ?? {};
  const positions = useMemo(() => {
    const auto = autoLayout(cols.map((c) => c.id), width);
    const merged: Record<string, Pos> = { ...auto };
    for (const [id, pos] of Object.entries(saved)) {
      if (merged[id]) merged[id] = pos;
    }
    return merged;
  }, [cols, saved, width]);

  const live = local ?? positions;
  useEffect(() => setLocal(null), [data]);

  const extent = useMemo(() => {
    const xs = Object.values(live).map((p) => p.x);
    const ys = Object.values(live).map((p) => p.y);
    return {
      w: Math.max(700, Math.max(...xs, 0) + NODE_W + 60),
      h: Math.max(360, Math.max(...ys, 0) + NODE_H + 60),
    };
  }, [live]);

  function onMove(e: React.MouseEvent) {
    if (!drag || !surface.current) return;
    const box = surface.current.getBoundingClientRect();
    const x = (e.clientX - box.left) / zoom - drag.dx;
    const y = (e.clientY - box.top) / zoom - drag.dy;
    setLocal({ ...(local ?? positions), [String(drag.id)]: { x: Math.max(0, x), y: Math.max(0, y) } });
  }

  function onDrop() {
    if (!drag) return;
    setDrag(null);
    if (local) act(() => trackerApi.setLayout(data.project.id, local));
  }

  // Where each label goes, placed so they do not sit on top of each other.
  //
  // The nudge-by-neighbour-count version of this looked fine on paper and left
  // nine overlapping pairs on an eight-status board. This does the honest
  // thing: keep the boxes already placed, and for each new one try positions
  // along its own arrow — then progressively further off it — until one is
  // clear. Sliding along the line is tried first because a label that stays on
  // its arrow is still obviously that arrow's label.
  const labelSpots = useMemo(() => {
    const placed: { l: number; r: number; t: number; b: number }[] = [];
    const spots = new Map<number, Pos>();
    const H = 22;

    const clashes = (box: { l: number; r: number; t: number; b: number }) =>
      placed.some((p) => box.l < p.r && p.l < box.r && box.t < p.b && p.t < box.b);

    for (const t of data.workflow.transitions) {
      const from = t.from_status_id !== null ? live[String(t.from_status_id)] : null;
      const to = live[String(t.to_status_id)];
      if (!from || !to) continue;
      const { start, end } = anchor(from, to);
      const w = Math.min(120, 16 + (t.name?.length ?? 6) * 6.1);
      const nx = end.y - start.y;
      const ny = start.x - end.x;
      const len = Math.hypot(nx, ny) || 1;

      let best: Pos | null = null;
      // Along the arrow first, then further and further off it.
      outer: for (const push of [0, 15, -15, 30, -30, 46, -46, 64, -64]) {
        for (const along of [0.5, 0.36, 0.64, 0.26, 0.74, 0.44, 0.58]) {
          const x = start.x + (end.x - start.x) * along + (nx / len) * push;
          const y = start.y + (end.y - start.y) * along + (ny / len) * push;
          const box = { l: x - w / 2, r: x + w / 2, t: y - H / 2, b: y + H / 2 };
          if (!clashes(box)) {
            placed.push(box);
            best = { x, y };
            break outer;
          }
        }
      }
      // Nowhere clear: put it back on the middle of its own line rather than
      // dropping it, and accept the overlap.
      if (!best) {
        best = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
        placed.push({ l: best.x - w / 2, r: best.x + w / 2, t: best.y - H / 2, b: best.y + H / 2 });
      }
      spots.set(t.id, best);
    }
    return spots;
  }, [data.workflow.transitions, live]);

  const current = cols.find((c) => c.id === selected) ?? null;

  return (
    <div className={`tkf${full ? " tkf-full" : ""}`}>
      <div className="tkf-canvas-wrap">
        {/* `tkf-tools`, not `tkf-bar`: the search box owns that name. */}
        <div className="tkf-tools">
          <label className="tks-req">
            <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} />
            Show transition labels
          </label>
          <span className="tkf-zoom">
            <button type="button" className="tks-mini tk-layer"
                    onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))}>−</button>
            <span className="tk-dim tk-num">{Math.round(zoom * 100)}%</span>
            <button type="button" className="tks-mini tk-layer"
                    onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.1).toFixed(2)))}>+</button>
          </span>
          <button
            type="button"
            className="tk-btn tk-layer"
            disabled={busy}
            title="Put every box back where the automatic layout would place it"
            onClick={() => act(() => trackerApi.setLayout(data.project.id, {}))}
          >
            Reset layout
          </button>
          <button
            type="button"
            className="tk-btn tk-layer"
            title={full ? "Back to the settings page (Esc)" : "Fill the window"}
            onClick={() => setFull((v) => !v)}
          >
            {full ? "Exit full screen" : "Full screen"}
          </button>
        </div>

        <div
          className="tkf-canvas"
          ref={surface}
          onMouseMove={onMove}
          onMouseUp={onDrop}
          onMouseLeave={onDrop}
        >
          <div className="tkf-surface"
               style={{ width: extent.w, height: extent.h, transform: `scale(${zoom})` }}>
            <svg className="tkf-edges" width={extent.w} height={extent.h}>
              {/* Labels are placed along their own arrow and nudged apart when
                  several land in the same spot — a dozen chips stacked on one
                  another is worse than no labels at all. */}
              <defs>
                <marker id="tkf-arrow" viewBox="0 0 10 10" refX="9" refY="5"
                        markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong)" />
                </marker>
                <marker id="tkf-arrow-on" viewBox="0 0 10 10" refX="9" refY="5"
                        markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
                </marker>
              </defs>
              {data.workflow.transitions.map((t) => {
                const from = t.from_status_id !== null ? live[String(t.from_status_id)] : null;
                const to = live[String(t.to_status_id)];
                if (!from || !to) return null;
                const { start, end } = anchor(from, to);
                const touches = selected !== null
                  && (t.from_status_id === selected || t.to_status_id === selected);
                const mid = labelSpots.get(t.id)
                  ?? { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
                return (
                  <g key={t.id} className={touches ? "tkf-edge on" : "tkf-edge"}>
                    <path
                      d={`M ${start.x} ${start.y} C ${(start.x + end.x) / 2} ${start.y}, ${(start.x + end.x) / 2} ${end.y}, ${end.x} ${end.y}`}
                      markerEnd={`url(#${touches ? "tkf-arrow-on" : "tkf-arrow"})`}
                    />
                    {labels && (
                      <foreignObject x={mid.x - 62} y={mid.y - 13} width={124} height={26}>
                        <span className="tkf-label">{t.name}</span>
                      </foreignObject>
                    )}
                  </g>
                );
              })}
            </svg>

            {cols.map((c) => {
              const pos = live[String(c.id)];
              if (!pos) return null;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={`tkf-node tk-layer${selected === c.id ? " on" : ""}`}
                  style={{
                    left: pos.x, top: pos.y, width: NODE_W, height: NODE_H,
                    borderColor: c.colour,
                  }}
                  onMouseDown={(e) => {
                    const box = surface.current!.getBoundingClientRect();
                    setDrag({
                      id: c.id,
                      dx: (e.clientX - box.left) / zoom - pos.x,
                      dy: (e.clientY - box.top) / zoom - pos.y,
                    });
                    setSelected(c.id);
                  }}
                  onClick={() => setSelected(c.id)}
                >
                  <span className="tkf-node-dot" style={{ background: c.colour }} />
                  <span className="tkf-node-name">{c.name}</span>
                  {!!c.issue_count && <span className="tkf-node-count">{c.issue_count}</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <StatusPanel
        data={data}
        status={current}
        busy={busy}
        act={act}
        onPick={setSelected}
      />
    </div>
  );
}

// ------------------------------------------------------------- right panel --

function StatusPanel({
  data, status, busy, act, onPick,
}: {
  data: ProjectSettingsData;
  status: ProjectSettingsData["workflow"]["columns"][number] | null;
  busy: boolean;
  act: Act;
  onPick: (id: number) => void;
}) {
  const [name, setName] = useState("");
  const [colour, setColour] = useState("");
  const [addTo, setAddTo] = useState("");
  const [renaming, setRenaming] = useState<number | null>(null);
  const [label, setLabel] = useState("");

  useEffect(() => {
    setName(status?.name ?? "");
    setColour(status?.colour ?? "");
    setRenaming(null);
  }, [status?.id, status?.name, status?.colour]);

  if (!status) {
    return (
      <aside className="tkf-panel">
        <p className="tk-dim">Click a status to see its settings.</p>
      </aside>
    );
  }

  const cols = data.workflow.columns;
  const out = data.workflow.transitions.filter((t) => t.from_status_id === status.id);
  const into = data.workflow.transitions.filter((t) => t.to_status_id === status.id);
  const reachable = new Set(out.map((t) => t.to_status_id));
  const spare = cols.filter((c) => c.id !== status.id && !reachable.has(c.id));
  const index = cols.findIndex((c) => c.id === status.id);

  function shift(by: number) {
    const ids = cols.map((c) => c.id);
    const target = index + by;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    act(() => trackerApi.reorderColumns(data.project.id, ids));
  }

  return (
    <aside className="tkf-panel">
      <header className="tkf-panel-head">
        <span className="tk-dot" style={{ background: status.colour }} />
        <h3>{status.name}</h3>
      </header>

      <div className="tkf-panel-body">
        <section className="tkf-sec">
          <h4>This status</h4>
          {/* Statuses are global. Saying so here is the price of them being
              global, which is what makes cross-project reporting possible. */}
          <p className="tk-dim">
            Statuses are shared by every board. Renaming or recolouring this one changes it
            everywhere it is used.
          </p>
          <label className="tkc-field">
            <span className="tkc-label">Name</span>
            <input className="tkc-input tkc-input-sm" value={name}
                   onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="tkc-field">
            <span className="tkc-label">Category</span>
            <M3Select
              value={status.category}
              width={200}
              options={[
                { value: "todo", label: "To do", hint: "Not started" },
                { value: "in_progress", label: "In progress", hint: "Being worked on" },
                { value: "done", label: "Done", hint: "Counts as finished in every report" },
              ]}
              onChange={(v) => act(() => trackerApi.patchStatus(data.project.id, status.id, { category: v }))}
            />
          </label>
          <label className="tkc-field">
            <span className="tkc-label">Colour</span>
            <span className="tkf-colours">
              {["#8b949e", "#5b8cff", "#a371f7", "#d29922", "#3fb950", "#2dd4bf", "#f0883e", "#f85149", "#6e7681"]
                .map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={`tkf-swatch${colour === c ? " on" : ""}`}
                    style={{ background: c }}
                    title={c}
                    onClick={() => {
                      setColour(c);
                      act(() => trackerApi.patchStatus(data.project.id, status.id, { colour: c }));
                    }}
                  />
                ))}
            </span>
          </label>
          <button
            type="button"
            className="tk-btn tk-layer tk-btn-primary"
            disabled={busy || !name.trim() || name === status.name}
            onClick={() => act(() => trackerApi.patchStatus(data.project.id, status.id, { name: name.trim() }))}
          >
            Rename everywhere
          </button>
        </section>

        <section className="tkf-sec">
          <h4>On this board</h4>
          <div className="tkf-row">
            <span className="tk-dim">
              Column {index + 1} of {cols.length} · {status.issue_count} issue
              {status.issue_count === 1 ? "" : "s"}
            </span>
          </div>
          <div className="tkf-row">
            <button type="button" className="tk-btn tk-layer" disabled={busy || index === 0}
                    onClick={() => shift(-1)}><ArrowLeft size={16} aria-hidden /> Earlier</button>
            <button type="button" className="tk-btn tk-layer" disabled={busy || index === cols.length - 1}
                    onClick={() => shift(1)}>Later →</button>
          </div>
          <button
            type="button"
            className="tk-btn tk-layer tkf-danger"
            disabled={busy}
            title={status.issue_count
              ? `${status.issue_count} issue(s) are still here — move them first`
              : "Take this status off this board"}
            onClick={() => act(() => trackerApi.removeColumn(data.project.id, status.id))}
          >
            Remove from this board
          </button>
        </section>

        <section className="tkf-sec">
          <h4>Moves out ({out.length})</h4>
          {out.length === 0 && (
            <p className="tk-dim">
              Nothing. An issue that reaches {status.name} cannot leave.
            </p>
          )}
          {out.map((t) => {
            const target = cols.find((c) => c.id === t.to_status_id);
            const guessed = (t.conditions as { inferred?: boolean } | null)?.inferred;
            return (
              <div key={t.id} className="tkf-move">
                {renaming === t.id ? (
                  <>
                    <input className="tkc-input tkc-input-sm" value={label} autoFocus
                           onChange={(e) => setLabel(e.target.value)}
                           onKeyDown={(e) => {
                             if (e.key !== "Enter" || !label.trim()) return;
                             act(async () => {
                               const next = await trackerApi.renameTransition(
                                 data.project.id, t.id, label.trim());
                               setRenaming(null);
                               return next;
                             });
                           }} />
                    <button type="button" className="tks-mini tk-layer"
                            onClick={() => setRenaming(null)}><X size={16} aria-hidden /></button>
                  </>
                ) : (
                  <>
                    <button type="button" className="tkf-move-name tk-layer"
                            title="Rename this move"
                            onClick={() => { setRenaming(t.id); setLabel(t.name); }}>
                      {t.name}
                    </button>
                    <button type="button" className="tkf-move-to tk-layer"
                            onClick={() => target && onPick(target.id)}>
                      <span className="tk-dot" style={{ background: target?.colour }} />
                      {target?.name}
                    </button>
                    {guessed && <span className="tk-chip tk-chip-quiet" title="No issue was in this status when the workflow was captured">guessed</span>}
                    <button
                      type="button"
                      className="tks-mini tks-danger tk-layer"
                      disabled={busy}
                      onClick={() => act(() => trackerApi.setTransition(
                        data.project.id, status.id, t.to_status_id, false))}
                    ><X size={16} aria-hidden /></button>
                  </>
                )}
              </div>
            );
          })}
          {spare.length > 0 && (
            <div className="tkf-row">
              <M3Select
                value={addTo}
                width={200}
                placeholder="Allow a move to…"
                options={spare.map((c) => ({ value: String(c.id), label: c.name }))}
                onChange={setAddTo}
              />
              <button
                type="button"
                className="tk-btn tk-layer"
                disabled={!addTo || busy}
                onClick={() => act(async () => {
                  const next = await trackerApi.setTransition(
                    data.project.id, status.id, Number(addTo), true);
                  setAddTo("");
                  return next;
                })}
              >
                Add
              </button>
            </div>
          )}
        </section>

        <section className="tkf-sec">
          <h4>Moves in ({into.length})</h4>
          {into.length === 0 && (
            <p className="tk-dim">
              Nothing reaches {status.name} — an issue can only start here.
            </p>
          )}
          {into.map((t) => {
            const source = cols.find((c) => c.id === t.from_status_id);
            return (
              <div key={t.id} className="tkf-move">
                <button type="button" className="tkf-move-to tk-layer"
                        onClick={() => source && onPick(source.id)}>
                  <span className="tk-dot" style={{ background: source?.colour }} />
                  {source?.name ?? "anywhere"}
                </button>
                <span className="tk-dim">{t.name}</span>
              </div>
            );
          })}
        </section>
      </div>
    </aside>
  );
}
