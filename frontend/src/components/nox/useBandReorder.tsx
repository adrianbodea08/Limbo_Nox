// Drag to reorder, inside a priority band and nowhere else.
//
// Every screen here that ranks work ranks it the same way: priority decides the
// order, and the hand-set rank only decides position *within* one priority. So
// dragging can move a card among its equals and cannot move it anywhere else —
// on the board, on My work, and on whatever ranks work next.
//
// That rule lives here once. A caller supplies the list it is showing and what
// to do with a new order; everything about how a drag behaves — where the
// placeholder goes, when it turns into a refusal, what the refusal says — is
// the same everywhere because it is the same code.
//
// The server enforces the rule independently (`work._reorder_within_band`), so
// this is the explanation of a constraint rather than the constraint itself.

import { useState } from "react";
import type { DragEvent } from "react";

/** The least an item has to be for its order to mean something. */
export interface Ranked {
  id: number;
  priority: string;
}

interface Options {
  /** A legal drop landed: this list's members of that band, in their new order.
   *  The ids are only the ones the caller was displaying — the server merges
   *  them into the full band, which it is the only one that can see. */
  onReorder: (listKey: string, priority: string, orderedIds: number[]) => void;
  /** Off while a request is in flight, or for a read-only view. */
  enabled?: boolean;
}

interface Slot {
  listKey: string;
  index: number;
  /** Set when this position is out of bounds, and says why. */
  refused?: string;
}

export function useBandReorder<T extends Ranked>({ onReorder, enabled = true }: Options) {
  const [dragging, setDragging] = useState<{ item: T; listKey: string } | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);

  function start(item: T, listKey: string, ev: DragEvent) {
    if (!enabled) return;
    ev.dataTransfer.effectAllowed = "move";
    // Some text, because a drag with an empty payload is refused outright by
    // some browsers.
    ev.dataTransfer.setData("text/plain", String(item.id));
    setDragging({ item, listKey });
  }

  function end() {
    setDragging(null);
    setSlot(null);
  }

  /** The stretch of a list holding the dragged item's priority.
   *
   *  A ranked list is always in priority order, so a band is always contiguous
   *  — which is what makes "anywhere in here and nowhere else" expressible as
   *  two indices. */
  function bandOf(items: T[]): { start: number; end: number } | null {
    if (!dragging) return null;
    const first = items.findIndex((i) => i.priority === dragging.item.priority);
    if (first < 0) return null;
    let last = first;
    while (last + 1 < items.length
           && items[last + 1].priority === dragging.item.priority) last++;
    return { start: first, end: last };
  }

  /** Hovering an item in the list the drag started from.
   *
   *  The placeholder is drawn where the pointer actually is, even when that is
   *  somewhere the card may not go — turning red and naming the rule it hit.
   *  Sliding it silently to the nearest legal spot leaves somebody wondering
   *  whether the drag registered; saying no, in the place they tried, teaches
   *  the rule in one go. */
  function hover(ev: DragEvent, listKey: string, items: T[], index: number) {
    if (!dragging || dragging.listKey !== listKey) return;
    const band = bandOf(items);
    if (!band) return;
    ev.preventDefault();
    ev.stopPropagation();

    const box = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    const after = ev.clientY > box.top + box.height / 2;
    const wanted = index + (after ? 1 : 0);

    const above = wanted < band.start;
    const below = wanted > band.end + 1;
    if (above || below) {
      // The item standing in the way, which is the one worth naming.
      const blocker = items[above ? band.start - 1 : band.end + 1];
      setSlot({
        listKey,
        index: wanted,
        refused: `${dragging.item.priority} can’t go ${above ? "above" : "below"} `
          + `${blocker.priority} — this list is in priority order`,
      });
      return;
    }
    setSlot({ listKey, index: wanted });
  }

  /** Apply the drop. Returns whether it was handled here, so a caller that also
   *  drags between lists knows to leave it alone. */
  function drop(listKey: string, items: T[]): boolean {
    if (!dragging || !slot || slot.listKey !== listKey) return false;
    // Dropped somewhere it was already told it could not go. Handled — it is a
    // drop inside its own list — but nothing happens.
    if (slot.refused) return true;

    const band = bandOf(items);
    if (!band) return false;
    const ids = items.slice(band.start, band.end + 1).map((i) => i.id);
    const was = ids.indexOf(dragging.item.id);
    if (was < 0) return false;

    const to = slot.index - band.start;
    const next = [...ids];
    next.splice(was, 1);
    next.splice(to > was ? to - 1 : to, 0, dragging.item.id);
    // Nothing actually moved — do not spend a request saying so.
    if (!next.every((id, i) => id === ids[i])) {
      onReorder(listKey, dragging.item.priority, next);
    }
    return true;
  }

  /** The props every draggable row needs, so a caller cannot wire half of them. */
  function rowProps(item: T, listKey: string, items: T[], index: number) {
    return {
      draggable: enabled,
      onDragStart: (ev: DragEvent) => start(item, listKey, ev),
      onDragEnd: end,
      onDragOver: (ev: DragEvent) => hover(ev, listKey, items, index),
    };
  }

  /** Whether the placeholder belongs at this position, and what it should say. */
  function slotAt(listKey: string, index: number): Slot | null {
    return slot && slot.listKey === listKey && slot.index === index ? slot : null;
  }

  return {
    /** The item being dragged, for callers that also drag between lists. */
    dragging: dragging?.item ?? null,
    draggingFrom: dragging?.listKey ?? null,
    start, end, hover, drop, rowProps, slotAt,
  };
}

/** Where the dragged item would land: an outline standing in its place, or the
 *  reason it cannot go there. */
export function DropSlot({ slot }: { slot: Slot | null }) {
  if (!slot) return null;
  if (!slot.refused) return <div className="tk-slot" aria-hidden="true" />;
  return (
    <div className="tk-slot tk-slot-no" role="status">
      <svg width="14" height="14" viewBox="0 -960 960 960" fill="currentColor" aria-hidden="true">
        <path d="M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q54 0 104-17.5t92-50.5L228-676q-33 42-50.5 92T160-480q0 134 93 227t227 93Zm252-124q33-42 50.5-92T800-480q0-134-93-227t-227-93q-54 0-104 17.5T284-732l448 448Z" />
      </svg>
      <span>{slot.refused}</span>
    </div>
  );
}
