// Run a state change as a View Transition, so the shared surfaces morph into
// their new shape (M3's container transform) rather than blinking out.
//
// The API is Chromium-only for now, and a transition holds a snapshot of the
// page while React re-renders — so this stays a progressive enhancement: where
// it is missing, or the viewer asked for less motion, the update just happens.

type ViewTransition = { ready: Promise<void>; finished: Promise<void> };
type StartViewTransition = (cb: () => void) => ViewTransition;

export function morph(update: () => void): void {
  const doc = document as Document & { startViewTransition?: StartViewTransition };
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (!doc.startViewTransition || still) {
    update();
    return;
  }
  const t = doc.startViewTransition(() => {
    // React 18 batches inside this callback; the transition captures the DOM
    // once flushSync has painted it.
    update();
  });
  // A transition is aborted outright when the page cannot paint — a background
  // tab, a hidden window. The DOM update still lands; only the animation is
  // dropped. Swallow the rejection so that never reaches the console.
  t.ready.catch(() => {});
  t.finished.catch(() => {});
}
