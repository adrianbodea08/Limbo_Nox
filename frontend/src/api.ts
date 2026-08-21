// Talking to Nox.
//
// Small on purpose. The app this was extracted from had one api.ts carrying
// every endpoint of five features; Nox has accounts and the tracker, and the
// tracker keeps its own surface next to its page (components/nox/model.ts) —
// same auth, same error handling, just not in one list nobody can read.

import type { User } from "./types";

const TOKEN_KEY = "nox_token";
let authToken: string | null = localStorage.getItem(TOKEN_KEY);
let onUnauthorized: (() => void) | null = null;

export function setAuthToken(t: string | null) {
  authToken = t;
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getAuthToken() {
  return authToken;
}

/** Called when the server stops believing our session — so one place decides
 *  what that means, rather than every caller inventing its own. */
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

/** What went wrong, in a form the caller can act on.
 *
 *  Everything used to arrive as a bare `Error`, which made "the server said no"
 *  and "there was no server" the same event. They are opposite answers to the
 *  question that matters at boot — *does the server still believe our session?*
 *  — and a caller that cannot tell them apart has to guess. Guessing wrong the
 *  safe-looking way threw away a session that was good for another 29 days
 *  because the api container happened to be restarting.
 *
 *  `status` is what the server answered. `offline` means it never answered:
 *  the connection dropped, DNS failed, the container is coming back up. */
export class ApiError extends Error {
  readonly status: number;
  /** Whatever fetch threw, kept for the console. Held as a field rather than
   *  passed to `super` because this project's TS target predates
   *  `new Error(msg, { cause })`. */
  readonly reason?: unknown;

  constructor(message: string, status: number, reason?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.reason = reason;
  }

  /** Nothing was heard back, so nothing has been decided. */
  get offline() {
    return this.status === 0;
  }

  /** The server is up but broken. Also not a verdict on our session. */
  get serverFault() {
    return this.status >= 500;
  }
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      },
      ...init,
    });
  } catch (cause) {
    // fetch rejects only when the request never completed at all. Status 0 is
    // the honest answer here: there is no status, because nobody replied.
    throw new ApiError("Cannot reach Nox.", 0, cause);
  }
  if (!resp.ok) {
    // A 401 on the sign-in call is "wrong password", not "your session died" —
    // bouncing the user to the login page they are already on would lose the
    // message telling them what went wrong.
    if (resp.status === 401 && !url.includes("/api/auth/")) onUnauthorized?.();
    let detail = resp.statusText;
    try {
      detail = (await resp.json()).detail ?? detail;
    } catch {
      /* the body was not JSON; the status text will have to do */
    }
    throw new ApiError(detail, resp.status);
  }
  return resp.status === 204 ? (undefined as T) : ((await resp.json()) as T);
}

export { http as request };

/** One admin action: a permission that changed, and who changed it. */
export interface AuditEntry {
  id: number;
  at: string;
  kind: string;
  /** Already a sentence — "changed a role" — so the screen does not have to
   *  keep its own copy of the vocabulary. */
  what: string;
  actor: string;
  subject: string;
  subject_type: string;
  was: string | null;
  now: string | null;
  detail: Record<string, unknown>;
}

export interface LoginResult {
  token: string;
  user: User;
}

export interface RegisterResult {
  status: "approved" | "pending";
  first?: boolean;
  token?: string;
  user?: User;
  message?: string;
}

export const api = {
  /** Whether anybody has registered yet — the sign-in page asks before it
   *  decides whether to offer "create the first account". */
  setupStatus: () => http<{ needsFirstAccount: boolean }>("/api/setup/status"),

  login: (username: string, password: string) =>
    http<LoginResult>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),

  register: (username: string, email: string, password: string) =>
    http<RegisterResult>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, email, password }),
    }),

  logout: () => http<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),

  me: () => http<User>("/api/auth/me"),

  changePassword: (currentPassword: string, newPassword: string) =>
    http<{ ok: boolean }>("/api/auth/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // --- admin ---

  users: () => http<User[]>("/api/admin/users"),

  /** Who granted what. Admin-only, because it is a list of who has power. */
  audit: (limit = 100) => http<AuditEntry[]>(`/api/admin/audit?limit=${limit}`),

  setUserStatus: (id: number, status: string) =>
    http<User>(`/api/admin/users/${id}/status?status=${status}`, { method: "PUT" }),

  setUserRole: (id: number, role: string) =>
    http<User>(`/api/admin/users/${id}/role?role=${role}`, { method: "PUT" }),
};
