// The console's API client. Same-origin /v1 (proxied), httpOnly cookies, one refresh in
// flight, and a re-authentication prompt when a sensitive action needs it.

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
let onReauth: () => Promise<boolean> = async () => false;
export function hooks(h: { signedOut: () => void; reauth: () => Promise<boolean> }) {
  onSignedOut = h.signedOut;
  onReauth = h.reauth;
}

async function refresh() {
  refreshing ??= fetch("/v1/auth/admin/refresh", { method: "POST", headers: { "X-Aura-Client": "admin" }, credentials: "same-origin" })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => setTimeout(() => (refreshing = null), 0));
  return refreshing;
}

export type CallOpts = { method?: string; body?: unknown; idem?: string; background?: boolean; quiet?: boolean };

export async function call<T = any>(path: string, opts: CallOpts = {}): Promise<T> {
  const url = path.startsWith("/v1/") ? path : `/v1/a${path}`;
  const headers: Record<string, string> = { "X-Aura-Client": "admin" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.idem) headers["Idempotency-Key"] = opts.idem;
  if (opts.background) headers["X-Background"] = "1";
  const go = () => fetch(url, { method: opts.method ?? "GET", headers, credentials: "same-origin", body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  let res: Response;
  try {
    res = await go();
  } catch {
    throw new ApiError(0, "network", "No connection to the server.");
  }
  if (res.status === 401) {
    const j = await res.clone().json().catch(() => ({}));
    if (j?.error?.code === "token_expired" && (await refresh())) res = await go();
  }
  if (res.status === 401 && !url.startsWith("/v1/auth/") && !opts.quiet) onSignedOut();
  if (res.status === 403) {
    const j = await res.clone().json().catch(() => ({}));
    if (j?.error?.code === "reauth_required" && (await onReauth())) res = await go();
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } })?.error;
    throw new ApiError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? (res.status === 502 ? "The API is waking up or unreachable. Try again in a moment." : "Something went wrong."), e?.details);
  }
  return data as T;
}

export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function errText(e: unknown) {
  return e instanceof ApiError ? e.message : (e as Error)?.message ?? "Something went wrong.";
}

/** Builds a query string, dropping empty values. */
export function qs(params: Record<string, string | number | boolean | null | undefined>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== "" && v != null && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}
