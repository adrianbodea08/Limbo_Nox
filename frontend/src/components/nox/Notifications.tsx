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
import { useNavigate } from "react-router-dom";
import { Person } from "./Face";
import { ago, trackerApi } from "./model";
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
  const wrap = useRef<HTMLDivElement>(null);
  const nav = useNavigate();

  const load = useCallback(async () => {
    try {
      const r = await trackerApi.notifications();
      setUnread(r.unread);
      setItems(r.items);
    } catch {
      // A bell that cannot reach the server says nothing rather than shouting.
    }
  }, []);

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
