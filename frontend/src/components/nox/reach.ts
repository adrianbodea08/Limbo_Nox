// Getting a notification past the bell.
//
// The bell is only seen by somebody already looking at Nox. Everything here is
// about the other case: the tab is behind three others, or on another screen,
// and an ask that stops somebody's work is sitting in it.
//
// **Real push is not possible here yet, and it is worth saying why.** The Push
// API needs a service worker, a service worker needs a secure context, and the
// team reaches Nox at `http://<machine>:8090` — checked, not assumed:
// `isSecureContext` is false there and `navigator.serviceWorker` is not merely
// unusable, it is absent. Localhost is exempt, which is exactly the trap: it
// works perfectly for whoever is running the server and for nobody else. Push
// arrives with HTTPS and not before.
//
// So what is here works over plain HTTP, for everybody, with no permission
// prompt:
//
//   * the tab's own title
//   * the favicon
//   * a toast, when something lands while you are looking
//
// and one that only works where the browser allows it, opt-in:
//
//   * a desktop notification

const TITLE = document.title;

/** The count, in the one place a backgrounded tab can still show it.
 *
 *  Costs nothing, needs no permission, and works on every browser and every
 *  origin — which makes it the only one of these that reaches the whole team
 *  today. */
export function badgeTitle(unread: number) {
  document.title = unread > 0 ? `(${unread}) ${TITLE}` : TITLE;
}

let originalIcon: string | null = null;

/** A dot on the favicon.
 *
 *  Drawn rather than swapped for a second file, so it stays right if the icon
 *  is ever redesigned — and it degrades to doing nothing rather than to a
 *  broken image if anything about the icon changes shape. */
export function badgeIcon(unread: number) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) return;
  if (originalIcon === null) originalIcon = link.href;

  if (unread <= 0) {
    if (originalIcon) link.href = originalIcon;
    return;
  }

  const img = new Image();
  img.onload = () => {
    const size = 64;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, size, size);

    // Bottom-right, with a ring in the page's own background colour so the dot
    // reads as a dot rather than as part of the mark underneath it.
    const r = size * 0.28;
    const cx = size - r - 2;
    const cy = size - r - 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
    ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#0d1117";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#f85149";
    ctx.fill();

    try {
      link.href = canvas.toDataURL("image/png");
    } catch {
      /* tainted canvas — the title badge still says it */
    }
  };
  img.onerror = () => { /* leave the icon alone */ };
  img.src = originalIcon || "";
}

// ------------------------------------------------------------ the desktop --

/** Whether the browser would even let us ask.
 *
 *  Not the same question as "has the user said yes". Over plain HTTP the answer
 *  is no and there is nothing anybody can do about it from inside the page, so
 *  the setting says that instead of offering a switch that does nothing. */
export function desktopPossible(): boolean {
  return typeof Notification !== "undefined" && window.isSecureContext;
}

export function desktopState(): "off" | "on" | "blocked" | "impossible" {
  if (!desktopPossible()) return "impossible";
  if (Notification.permission === "granted") return "on";
  if (Notification.permission === "denied") return "blocked";
  return "off";
}

/** Only ever from a click. A permission prompt on page load is the reason
 *  people click Block without reading, and Block is permanent. */
export async function askDesktop(): Promise<boolean> {
  if (!desktopPossible()) return false;
  const answer = await Notification.requestPermission();
  return answer === "granted";
}

export function showDesktop(text: string, body: string, onClick?: () => void) {
  if (desktopState() !== "on") return;
  try {
    const note = new Notification(text, { body, icon: "/favicon.svg", tag: "nox" });
    if (onClick) {
      note.onclick = () => {
        window.focus();
        onClick();
        note.close();
      };
    }
  } catch {
    /* some browsers refuse outside a service worker; the tab title still says it */
  }
}
