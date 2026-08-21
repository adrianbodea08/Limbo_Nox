// The bell.
//
// Four kinds and no more — see docs/ASKS.md section 5. Everything it can show
// you is either somebody waiting on you or somebody answering you, which is the
// test anything new has to pass before it is added.
//
// The count is what makes or ruins this. A badge that is usually meaningful
// gets looked at; a badge that is usually noise gets learned around, and once
// somebody has learned to ignore it, it is worth nothing for anything —
// including the one time it mattered.

import { AtSign, Bell, MessageCircleQuestion, Reply, UserPlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Person } from "./Face";
import { ago, trackerApi } from "./model";
import { badgeIcon, badgeTitle, showDesktop } from "./reach";
import type { Notification } from "./model";

const LOOK: Record<string, { Icon: typeof Bell; tone: string }> = {
  asked: { Icon: MessageCircleQuestion, tone: "ask" },
  ask_answered: { Icon: Reply, tone: "answer" },
  assigned: { Icon: UserPlus, tone: "assign" },
  mentioned: { Icon: AtSign, tone: "mention" },
};

/** How often to look again while the tab is open.
 *
 *  Ninety seconds, not five. A notification about somebody waiting on you is
 *  not urgent to the second, and a poll that runs every few seconds is a cost
 *  paid all day for the appearance of immediacy. */
const LOOK_AGAIN = 90_000;

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Notification[]>([]);
  const [busy, setBusy] = useState(false);
  // What landed while you were looking at something else. Shown once, briefly,
  // and never again — a toast is a tap on the shoulder, and the bell is where
  // it lives afterwards.
  const [landed, setLanded] = useState<Notification[]>([]);
  // The count as of the previous poll, so "three unread" and "one new one just
  // arrived" stay different events.
  const seen = useRef<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  const load = useCallback(async () => {
    try {
      const r = await trackerApi.notifications();
      // Only what is genuinely new since the last look. On the first poll of a
      // session there is no "since", so nothing is announced — arriving to
      // eleven toasts for things that happened last week is not news.
      const before = seen.current;
      if (before !== null && r.unread > before) {
        const fresh = r.items.filter((n) => !n.read).slice(0, r.unread - before);
        setLanded(fresh);
        window.setTimeout(() => setLanded([]), 6000);
        for (const n of fresh) {
          showDesktop(n.text, n.issue_summary ?? "", () => nav(`/issue/${n.issue_key}`));
        }
      }
      seen.current = r.unread;
      setUnread(r.unread);
      setItems(r.items);
    } catch {
      // A bell that cannot reach the server says nothing rather than shouting.
    }
  }, [nav]);

  // The tab and the icon, which are the only two things a backgrounded window
  // can still say — and the only ones that work on every origin.
  useEffect(() => {
    badgeTitle(unread);
    badgeIcon(unread);
  }, [unread]);

  useEffect(() => {
    load();
    // Stops while the tab is hidden: nobody is reading a badge they cannot see,
    // and a backgrounded tab polling all afternoon is somebody's battery.
    const tick = () => { if (!document.hidden) load(); };
    const timer = window.setInterval(tick, LOOK_AGAIN);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [open]);

  async function readAll() {
    setBusy(true);
    try {
      const r = await trackerApi.readNotifications();
      setUnread(r.unread);
      setItems(r.items);
    } finally {
      setBusy(false);
    }
  }

  async function go(n: Notification) {
    setOpen(false);
    if (!n.read) {
      trackerApi.readNotifications([n.id]).then((r) => {
        setUnread(r.unread);
        setItems(r.items);
      }).catch(() => {});
    }
    nav(`/issue/${n.issue_key}`);
  }

  return (
    <div className="tkn" ref={wrap}>
      {/* Away from the bell on purpose: it announces something that has just
          happened, and putting it under the button would mean it is only seen
          by somebody already looking there. */}
      {!!landed.length && createPortal(
        <div className="tkn-toasts" role="status" aria-live="polite">
          {landed.map((n) => (
            <button
              key={n.id}
              type="button"
              className="tkn-toast tk-layer"
              onClick={() => { setLanded([]); go(n); }}
            >
              <span className="tkn-toast-text">{n.text}</span>
              <span className="tkn-toast-sub">{n.issue_summary}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
      <button
        type="button"
        className={`tkn-bell tk-layer${unread ? " has" : ""}`}
        aria-label={unread ? `${unread} unread` : "Notifications"}
        aria-expanded={open}
        title={unread ? `${unread} unread` : "Nothing new"}
        onClick={() => { setOpen((o) => !o); if (!open) load(); }}
      >
        <Bell size={19} aria-hidden />
        {/* Past nine it says 9+. The exact number stops being information and
            starts being a wide badge. */}
        {unread > 0 && <span className="tkn-count">{unread > 9 ? "9+" : unread}</span>}
      </button>

      {open && (
        <div className="tkn-panel" role="dialog" aria-label="Notifications">
          <header className="tkn-head">
            <h2>Notifications</h2>
            {unread > 0 && (
              <button type="button" className="tkn-readall tk-layer" disabled={busy}
                      onClick={readAll}>
                Mark all read
              </button>
            )}
          </header>

          <div className="tkn-list">
            {items.map((n) => {
              const look = LOOK[n.kind] ?? { Icon: Bell, tone: "ask" };
              return (
                <button
                  key={n.id}
                  type="button"
                  className={`tkn-row tk-layer${n.read ? " read" : ""}`}
                  onClick={() => go(n)}
                >
                  <span className={`tkn-icon tkn-t-${look.tone}`}>
                    <look.Icon size={16} aria-hidden />
                  </span>
                  <span className="tkn-body">
                    <span className="tkn-text">{n.text}</span>
                    <span className="tkn-sub">
                      {n.issue_summary} · {ago(n.at)}
                    </span>
                  </span>
                  {n.actor_name && (
                    <Person size={20} name={n.actor_name}
                            avatar={n.actor_avatar ?? undefined} />
                  )}
                </button>
              );
            })}

            {/* Nothing here is good news, and it should read like it rather
                than like a page that failed to load. */}
            {!items.length && (
              <p className="tkn-empty">
                Nothing needs you. Anything somebody is waiting on you for turns
                up here.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default NotificationBell;
