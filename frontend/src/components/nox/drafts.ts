// What you wrote but have not saved.
//
// An issue description has two versions once you start typing in it: the one
// the team can see, and the one you are still working on. Losing the second
// because you clicked away, opened another issue, or reloaded is the ordinary
// way tracker prose gets written twice — so it is kept.
//
// **On this machine only, and never sent anywhere.** That is not a shortcut, it
// is the requirement: a draft must not reach another account, and text that
// never leaves the browser cannot. There is no endpoint to get it wrong, no row
// to accidentally join, and nothing to redact. The cost is honest and worth
// saying out loud — a draft does not follow you to another computer.
//
// Keyed by person as well as issue, because two accounts do share a browser
// sometimes, and one of them reading the other's unsaved words would be the
// same failure by a shorter route.

const KEY = "nox-drafts";

/** Long enough to survive a holiday, short enough that abandoned text does not
 *  accumulate in somebody's browser for years. */
const KEEP_FOR = 30 * 24 * 60 * 60 * 1000;

/** Enough for anybody's real backlog. Past this the oldest goes, because
 *  localStorage is a few megabytes and silently failing to save is worse than
 *  dropping a draft nobody has touched in weeks. */
const KEEP_MOST = 50;

interface Draft {
  body: string;
  at: number;
}

type Bag = Record<string, Draft>;

const slot = (userId: number, issueId: number) => `${userId}:${issueId}`;

function load(): Bag {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Bag;
    const cutoff = Date.now() - KEEP_FOR;
    const kept: Bag = {};
    for (const [k, d] of Object.entries(raw)) {
      if (d && typeof d.body === "string" && d.at > cutoff) kept[k] = d;
    }
    return kept;
  } catch {
    // Corrupt or unavailable storage is not worth an error somebody has to
    // read. Nothing is lost that was not already lost.
    return {};
  }
}

function store(bag: Bag) {
  const entries = Object.entries(bag).sort((a, b) => b[1].at - a[1].at);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries.slice(0, KEEP_MOST))));
  } catch {
    /* private mode, or full. The draft is lost; the issue is not. */
  }
}

/** The unsaved version, if there is one. */
export function readDraft(userId: number, issueId: number): string | null {
  return load()[slot(userId, issueId)]?.body ?? null;
}

/** Keep this version — unless it matches what is already saved, in which case
 *  there is nothing to keep and holding on to it would light up a "you have
 *  unsaved work" mark that is not true. */
export function saveDraft(
  userId: number, issueId: number, body: string, saved: string,
) {
  if (body === saved) {
    clearDraft(userId, issueId);
    return;
  }
  const bag = load();
  bag[slot(userId, issueId)] = { body, at: Date.now() };
  store(bag);
}

export function clearDraft(userId: number, issueId: number) {
  const bag = load();
  delete bag[slot(userId, issueId)];
  store(bag);
}
