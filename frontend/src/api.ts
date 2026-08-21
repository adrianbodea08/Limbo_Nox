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

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
    },
    ...init,
  });
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
    throw new Error(detail);
  }
  return resp.status === 204 ? (undefined as T) : ((await resp.json()) as T);
}

export { http as request };

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

  setUserStatus: (id: number, status: string) =>
    http<User>(`/api/admin/users/${id}/status?status=${status}`, { method: "PUT" }),

  setUserRole: (id: number, role: string) =>
    http<User>(`/api/admin/users/${id}/role?role=${role}`, { method: "PUT" }),
};
