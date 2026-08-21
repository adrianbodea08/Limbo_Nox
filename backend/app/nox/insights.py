"""What the event log knows about how work actually moves.

See docs/ANALYTICS.md for the reasoning. The short version: every other tracker
of this kind counts what is true right now, and can therefore tell you how many
things are open and how they split by priority. This module answers the
questions people actually ask in a retro — where does work wait, how long does
it really take, and who or what is moving it — because `events` has recorded
`at`, `field`, `from_value`, `to_value` and `actor_kind` since the first commit.

Everything here reads. No new tables, no writes, nothing to migrate.

The one expensive shape is reconstructing each issue's status history, which is
a scan of its status events in order. That is done in Python rather than in a
window function on purpose: the logic — what the *first* status was, what an
interval's end is when the issue is still open — is fiddly enough that having it
readable matters more than having it in SQL. It is measured, not assumed; if it
becomes slow the fix is a materialised interval table maintained by the worker,
and that is not built until it is needed.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

from sqlalchemy import Connection, and_, func, or_, select

from .schema import events, issue_pauses, issues, projects, statuses

# A period longer than this reads by week rather than by day. Ninety points on
# an axis is a chart; four hundred is a texture.
DAILY_UPTO_DAYS = 45


# ------------------------------------------------------------------ helpers --

def _now() -> datetime:
    return datetime.now(timezone.utc)


def _window(days: int) -> tuple[datetime, datetime, datetime]:
    """This period, and the one immediately before it, for the trend."""
    end = _now()
    start = end - timedelta(days=days)
    return start - timedelta(days=days), start, end


def _pct(values: list[float], fraction: float) -> float:
    """The value at a fraction through the sorted list.

    Written out rather than reached for from a library because the two callers
    want p50 and p85 of small lists, and `statistics.quantiles` refuses fewer
    than two data points — which is exactly the case a young project is in.
    """
    if not values:
        return 0.0
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = fraction * (len(ordered) - 1)
    low = int(position)
    high = min(low + 1, len(ordered) - 1)
    return ordered[low] + (ordered[high] - ordered[low]) * (position - low)


def _hours(delta: timedelta) -> float:
    return round(delta.total_seconds() / 3600, 2)


def _trend(now_value: float, before_value: float) -> dict:
    """The change against the previous period of the same length.

    `direction` is deliberately not "good" or "bad" — a rising cycle time and a
    rising throughput are both "up", and which of those is bad depends on the
    metric, which the caller knows and this does not.
    """
    if not before_value:
        return {"from": before_value, "change": None}
    change = (now_value - before_value) / before_value
    return {"from": round(before_value, 2), "change": round(change, 3)}


def _bucket(when: datetime, start: datetime, by_week: bool) -> str:
    if by_week:
        monday = when - timedelta(days=when.weekday())
        return monday.date().isoformat()
    return when.date().isoformat()


def _series(start: datetime, end: datetime, by_week: bool) -> list[str]:
    """Every bucket in the window, including the empty ones.

    A line drawn only through the days something happened slopes through the
    gaps and lies about the days it skipped.
    """
    step = timedelta(days=7 if by_week else 1)
    cursor = start - timedelta(days=start.weekday()) if by_week else start
    out: list[str] = []
    while cursor <= end:
        out.append(cursor.date().isoformat())
        cursor += step
    return out


# ------------------------------------------------------------- status facts --

def _status_lookup(conn: Connection) -> dict[int, dict]:
    rows = conn.execute(select(statuses.c.id, statuses.c.name, statuses.c.category,
                               statuses.c.colour)).all()
    return {r[0]: {"id": r[0], "name": r[1], "category": r[2], "colour": r[3]} for r in rows}


def _scope(project_id: int | None):
    """The issue filter both halves of the page share."""
    where = [issues.c.archived_at.is_(None)]
    if project_id:
        where.append(issues.c.project_id == project_id)
    return and_(*where)


def _status_intervals(
    conn: Connection, project_id: int | None,
) -> dict[int, list[tuple[int, datetime, datetime]]]:
    """Per issue, the (status_id, entered, left) spans of its whole life.

    The first span is the one nothing recorded: an issue is created *in* a
    status and the log only writes when something changes, so the opening status
    is the `from_value` of the earliest transition — and for an issue that has
    never moved, it is simply where it still is.
    """
    rows = conn.execute(
        select(events.c.entity_id, events.c.at, events.c.from_value, events.c.to_value)
        .select_from(events.join(issues, issues.c.id == events.c.entity_id))
        .where(events.c.entity_type == "issue")
        .where(events.c.kind == "field_changed")
        .where(events.c.field == "status_id")
        .where(_scope(project_id))
        .order_by(events.c.entity_id, events.c.at, events.c.id)
    ).all()

    moves: dict[int, list[tuple[datetime, str | None, str | None]]] = defaultdict(list)
    for issue_id, at, from_value, to_value in rows:
        moves[issue_id].append((at, from_value, to_value))

    live = {
        r[0]: (r[1], r[2], r[3])
        for r in conn.execute(
            select(issues.c.id, issues.c.created_at, issues.c.status_id, issues.c.resolved_at)
            .where(_scope(project_id))
        ).all()
    }

    now = _now()
    out: dict[int, list[tuple[int, datetime, datetime]]] = {}
    for issue_id, (created_at, status_id, resolved_at) in live.items():
        history = moves.get(issue_id) or []
        spans: list[tuple[int, datetime, datetime]] = []
        if not history:
            out[issue_id] = [(status_id, created_at, resolved_at or now)]
            continue

        opening = history[0][1]
        current = int(opening) if opening and opening.isdigit() else status_id
        entered = created_at
        for at, _from, to in history:
            spans.append((current, entered, at))
            current = int(to) if to and to.isdigit() else current
            entered = at
        spans.append((current, entered, resolved_at or now))
        out[issue_id] = spans
    return out


# ------------------------------------------------------------------ overview --

def overview(conn: Connection, *, project_id: int | None = None, days: int = 30) -> dict:
    """The table-stakes half: four numbers with a comparison, and the one chart
    that outranks everything else on the page."""
    was_start, start, end = _window(days)
    known = _status_lookup(conn)
    done_ids = [s["id"] for s in known.values() if s["category"] == "done"]

    open_now = conn.execute(
        select(func.count()).select_from(issues)
        .where(_scope(project_id))
        .where(issues.c.status_id.notin_(done_ids) if done_ids else True)
    ).scalar_one()

    def resolved_between(a: datetime, b: datetime) -> int:
        return conn.execute(
            select(func.count()).select_from(issues)
            .where(_scope(project_id))
            .where(issues.c.resolved_at >= a).where(issues.c.resolved_at < b)
        ).scalar_one()

    shipped, shipped_before = resolved_between(start, end), resolved_between(was_start, start)

    # Cycle time, from the same reconstruction the Flow tab uses, so the number
    # on the card and the cloud of dots can never disagree.
    cycles = _cycle_times(conn, project_id, known)
    in_window = [c["hours"] for c in cycles if start <= c["at"] < end]
    before_window = [c["hours"] for c in cycles if was_start <= c["at"] < start]

    lost, lost_before = _interrupted_hours(conn, project_id, start, end), \
        _interrupted_hours(conn, project_id, was_start, start)

    by_week = days > DAILY_UPTO_DAYS
    buckets = _series(start, end, by_week)
    created: dict[str, int] = {b: 0 for b in buckets}
    finished: dict[str, int] = {b: 0 for b in buckets}
    for made, done_at in conn.execute(
        select(issues.c.created_at, issues.c.resolved_at)
        .where(_scope(project_id))
        .where(or_(issues.c.created_at >= start, issues.c.resolved_at >= start))
    ).all():
        if made and made >= start:
            created[_bucket(made, start, by_week)] = created.get(_bucket(made, start, by_week), 0) + 1
        if done_at and done_at >= start:
            key = _bucket(done_at, start, by_week)
            finished[key] = finished.get(key, 0) + 1

    return {
        "days": days,
        "cards": [
            {"key": "open", "label": "Open", "value": open_now, "unit": "issues",
             "hint": "Not in a done status."},
            {"key": "shipped", "label": "Finished", "value": shipped, "unit": "issues",
             "trend": _trend(shipped, shipped_before), "better": "up",
             "hint": f"Reached a done status in the last {days} days."},
            {"key": "cycle", "label": "Median cycle time",
             "value": round(_pct(in_window, 0.5), 1), "unit": "hours",
             "trend": _trend(_pct(in_window, 0.5), _pct(before_window, 0.5)), "better": "down",
             "hint": "First move into progress until first move into done."},
            {"key": "lost", "label": "Lost to interruption", "value": round(lost, 1),
             "unit": "hours", "trend": _trend(lost, lost_before), "better": "down",
             "hint": "Time work spent paused because something else came first."},
        ],
        "throughput": {
            "buckets": buckets,
            "created": [created.get(b, 0) for b in buckets],
            "finished": [finished.get(b, 0) for b in buckets],
            "by_week": by_week,
        },
    }


# ---------------------------------------------------------------------- flow --

def _cycle_times(conn: Connection, project_id: int | None,
                 known: dict[int, dict]) -> list[dict]:
    """One entry per finished issue: how long it took, and when it landed."""
    out: list[dict] = []
    keys = _issue_keys(conn, project_id)
    for issue_id, spans in _status_intervals(conn, project_id).items():
        started = next((s[1] for s in spans
                        if known.get(s[0], {}).get("category") == "in_progress"), None)
        landed = next((s[1] for s in spans
                       if known.get(s[0], {}).get("category") == "done"), None)
        if not started or not landed or landed <= started:
            continue
        out.append({
            "id": issue_id, "key": keys.get(issue_id, ""),
            "hours": _hours(landed - started), "at": landed,
        })
    return out


def _issue_keys(conn: Connection, project_id: int | None) -> dict[int, str]:
    return {r[0]: r[1] for r in conn.execute(
        select(issues.c.id, issues.c.key).where(_scope(project_id))).all()}


def _interrupted_hours(conn: Connection, project_id: int | None,
                       start: datetime, end: datetime) -> float:
    total = timedelta()
    for paused_at, resumed_at in conn.execute(
        select(issue_pauses.c.paused_at, issue_pauses.c.resumed_at)
        .select_from(issue_pauses.join(issues, issues.c.id == issue_pauses.c.issue_id))
        .where(_scope(project_id))
        .where(issue_pauses.c.paused_at < end)
        .where(or_(issue_pauses.c.resumed_at.is_(None), issue_pauses.c.resumed_at >= start))
    ).all():
        # Clipped to the window, so a pause spanning the boundary is counted
        # once in each period rather than twice in whichever it started.
        began = max(paused_at, start)
        ended = min(resumed_at or _now(), end)
        if ended > began:
            total += ended - began
    return _hours(total)


def flow(conn: Connection, *, project_id: int | None = None, days: int = 30) -> dict:
    """The half that needs the log: waiting, spread, and who is doing the moving."""
    _, start, end = _window(days)
    known = _status_lookup(conn)

    # --- where work waits ---------------------------------------------------
    per_status: dict[int, list[float]] = defaultdict(list)
    for spans in _status_intervals(conn, project_id).values():
        totals: dict[int, timedelta] = defaultdict(timedelta)
        for status_id, entered, left in spans:
            # Time in a done status is not waiting, it is age — an issue that
            # shipped in March has sat in Live for five months and there is
            # nothing to fix about that. The question this chart asks is where
            # *unfinished* work stops moving.
            if known.get(status_id, {}).get("category") == "done":
                continue
            # Counted in full, not clipped to the window. Clipping made every
            # stale status report exactly the window length — a wall of
            # identical "4w / 4w" bars that said nothing. The question is how
            # long work waits *here*, and something that has sat for six months
            # waited six months whichever thirty days you happen to be looking
            # at. The window decides which spans are relevant, not how long
            # they were.
            if left > start and left > entered:
                totals[status_id] += left - entered
        for status_id, spent in totals.items():
            if spent.total_seconds() > 0:
                per_status[status_id].append(_hours(spent))

    waiting = [
        {
            "status": known.get(sid, {}).get("name", str(sid)),
            "category": known.get(sid, {}).get("category", ""),
            "colour": known.get(sid, {}).get("colour", ""),
            "median": round(_pct(v, 0.5), 1),
            "p85": round(_pct(v, 0.85), 1),
            "issues": len(v),
        }
        for sid, v in per_status.items()
    ]
    # Worst first: the point of the chart is the column with the trapdoor.
    waiting.sort(key=lambda r: r["p85"], reverse=True)
    # Ten bars is a chart somebody reads. Across every project there can be
    # thirty statuses, and the rest are reported rather than silently dropped.
    hidden = max(0, len(waiting) - 10)
    waiting = waiting[:10]

    # --- how long the whole thing takes -------------------------------------
    cycles = [c for c in _cycle_times(conn, project_id, known) if start <= c["at"] < end]
    hours = [c["hours"] for c in cycles]

    # --- who is moving it ---------------------------------------------------
    by_week = days > DAILY_UPTO_DAYS
    buckets = _series(start, end, by_week)
    actors: dict[str, dict[str, int]] = {
        kind: {b: 0 for b in buckets} for kind in ("human", "automation", "integration")
    }
    pairs: dict[tuple[str, str], dict[str, int]] = defaultdict(
        lambda: {"human": 0, "automation": 0, "integration": 0})

    for at, from_value, to_value, actor_kind in conn.execute(
        select(events.c.at, events.c.from_value, events.c.to_value, events.c.actor_kind)
        .select_from(events.join(issues, issues.c.id == events.c.entity_id))
        .where(events.c.entity_type == "issue")
        .where(events.c.kind == "field_changed")
        .where(events.c.field == "status_id")
        .where(events.c.at >= start)
        .where(_scope(project_id))
    ).all():
        kind = actor_kind if actor_kind in actors else "human"
        actors[kind][_bucket(at, start, by_week)] = \
            actors[kind].get(_bucket(at, start, by_week), 0) + 1
        a = known.get(int(from_value), {}).get("name") if (from_value or "").isdigit() else None
        b = known.get(int(to_value), {}).get("name") if (to_value or "").isdigit() else None
        if a and b:
            pairs[(a, b)][kind] += 1

    moves = [
        {"from": a, "to": b, "total": sum(counts.values()), **counts}
        for (a, b), counts in pairs.items()
    ]
    moves.sort(key=lambda m: m["total"], reverse=True)

    # --- what interruptions cost --------------------------------------------
    keys = _issue_keys(conn, project_id)
    interruptions = []
    for issue_id, for_issue, reason, paused_at, resumed_at in conn.execute(
        select(issue_pauses.c.issue_id, issue_pauses.c.paused_for_issue_id,
               issue_pauses.c.reason, issue_pauses.c.paused_at, issue_pauses.c.resumed_at)
        .select_from(issue_pauses.join(issues, issues.c.id == issue_pauses.c.issue_id))
        .where(_scope(project_id))
        .where(issue_pauses.c.paused_at >= start)
        .order_by(issue_pauses.c.paused_at.desc())
        .limit(50)
    ).all():
        interruptions.append({
            "issue": keys.get(issue_id, ""),
            "for": keys.get(for_issue, "") if for_issue else "",
            "reason": reason or "",
            "hours": _hours((resumed_at or _now()) - paused_at),
            "open": resumed_at is None,
        })

    total_moves = sum(sum(v.values()) for v in actors.values())
    automated = sum(actors["automation"].values()) + sum(actors["integration"].values())

    return {
        "days": days,
        # The window itself, so a chart can plot against the period the page is
        # showing rather than against the range its own data happens to cover.
        "from": start.isoformat(),
        "to": end.isoformat(),
        "waiting": waiting,
        "waiting_hidden": hidden,
        "cycle": {
            "points": [
                {"key": c["key"], "hours": c["hours"], "at": c["at"].date().isoformat()}
                for c in sorted(cycles, key=lambda c: c["at"])
            ],
            "median": round(_pct(hours, 0.5), 1),
            "p85": round(_pct(hours, 0.85), 1),
        },
        "actors": {
            "buckets": buckets,
            "human": [actors["human"].get(b, 0) for b in buckets],
            "automation": [actors["automation"].get(b, 0) for b in buckets],
            "integration": [actors["integration"].get(b, 0) for b in buckets],
            "by_week": by_week,
            "automated_share": round(automated / total_moves, 3) if total_moves else 0,
            "total": total_moves,
        },
        "moves": moves[:12],
        "interruptions": interruptions,
    }


def project_id_for(conn: Connection, key: str | None) -> int | None:
    if not key:
        return None
    return conn.execute(
        select(projects.c.id).where(projects.c.key == key.upper())).scalar_one_or_none()
