// Talks to the API on this app's own origin (/v1, proxied), with httpOnly session cookies.
// Expired access tokens are refreshed once, in a single flight. GET responses are kept on the
// phone so the last data stays visible offline, with the time it was loaded.

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

let refreshing: Promise<boolean> | null = null;
let onSignedOut: () => void = () => {};
export function whenSignedOut(fn: () => void) {
  onSignedOut = fn;
}

const base = "/v1/m";

async function refresh(): Promise<boolean> {
  refreshing ??= fetch("/v1/auth/refresh", { method: "POST", headers: { "X-Aura-Client": "merchant" }, credentials: "same-origin" })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

type Opts = { method?: string; body?: unknown; idem?: string; raw?: boolean; auth?: boolean };

export async function call<T = unknown>(path: string, opts: Opts = {}): Promise<T> {
  const url = path.startsWith("/v1/") ? path : `${base}${path}`;
  const headers: Record<string, string> = { "X-Aura-Client": "merchant" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idem) headers["Idempotency-Key"] = opts.idem;
  const go = () => fetch(url, { method: opts.method ?? "GET", headers, credentials: "same-origin", body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let res: Response;
  try {
    res = await go();
  } catch {
    throw new ApiError(0, "network", "network");
  }
  if (res.status === 401 && !url.startsWith("/v1/auth/")) {
    // Expired, or no token at all (a browser that dropped the cookie): try the refresh token once.
    const j = await res.clone().json().catch(() => ({}));
    if ((j?.error?.code === "token_expired" || j?.error?.code === "unauthorized") && (await refresh())) res = await go();
  }
  if (res.status === 401 && opts.auth !== false && !url.startsWith("/v1/auth/")) onSignedOut();
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    throw new ApiError(res.status, e?.code ?? (res.status === 502 ? "api_unreachable" : "http_" + res.status), e?.message ?? "error", e?.details);
  }
  return data as T;
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ------------------------------------------------------------------ offline cache

const KEY = (path: string) => `aura:cache:${base}${path}`;

export type Cached<T> = { data: T; savedAt: number };

export function readCache<T>(path: string): Cached<T> | null {
  try {
    const v = localStorage.getItem(KEY(path));
    return v ? (JSON.parse(v) as Cached<T>) : null;
  } catch {
    return null;
  }
}

export function writeCache(path: string, data: unknown) {
  try {
    localStorage.setItem(KEY(path), JSON.stringify({ data, savedAt: Date.now() }));
  } catch {
    // Storage full: drop the oldest cached screens and try once more.
    try {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith("aura:cache:"));
      keys.slice(0, Math.ceil(keys.length / 2)).forEach((k) => localStorage.removeItem(k));
      localStorage.setItem(KEY(path), JSON.stringify({ data, savedAt: Date.now() }));
    } catch {
      /* give up quietly */
    }
  }
}

export function clearCache() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("aura:cache:"))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/** A plain-language message for any error. */
export function message(e: unknown, t: (k: string) => string): string {
  if (e instanceof ApiError) {
    if (e.code === "network") return t("errors.network");
    if (e.code === "api_unreachable") return t("errors.waking");
    if (e.message && e.message !== "error") return e.message;
  }
  return t("errors.generic");
}
