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

export interface Invite {
  token: string;
  email: string;
  role: string;
  /** Which tracker person this account becomes on arrival, if any. */
  claims: number | null;
  note: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by: number | null;
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

  /** Whether an invitation link is still good. Asked before anybody signs in,
   *  because the whole point is that they have no account yet. */
  checkInvite: (token: string) =>
    http<{ email: string; role: string; note: string; becomes: string | null }>(
      `/api/auth/invite/check?token=${encodeURIComponent(token)}`),

  acceptInvite: (token: string, username: string, password: string) =>
    http<LoginResult>("/api/auth/invite/accept", {
      method: "POST",
      body: JSON.stringify({ token, username, password }),
    }),

  me: () => http<User>("/api/auth/me"),

  changePassword: (currentPassword: string, newPassword: string) =>
    http<{ ok: boolean }>("/api/auth/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // --- admin ---

  users: () => http<User[]>("/api/admin/users"),

  invites: () => http<Invite[]>("/api/admin/invites"),

  invite: (body: { email: string; role: string; claims: number | null; note: string }) =>
    http<Invite>("/api/admin/invites", { method: "POST", body: JSON.stringify(body) }),

  revokeInvite: (token: string) =>
    http<{ ok: boolean }>(`/api/admin/invites/${encodeURIComponent(token)}`,
      { method: "DELETE" }),

  /** People in the tracker nobody signs in as — the seeded ones. Offered when
   *  writing an invitation so "you are this person" is a pick, not an id. */
  unclaimed: () =>
    http<{ id: number; display_name: string; avatar: string; issues: number }[]>(
      "/api/nox/people/unclaimed"),

  setUserStatus: (id: number, status: string) =>
    http<User>(`/api/admin/users/${id}/status?status=${status}`, { method: "PUT" }),

  setUserRole: (id: number, role: string) =>
    http<User>(`/api/admin/users/${id}/role?role=${role}`, { method: "PUT" }),
};
