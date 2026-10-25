import { env } from "../config/env.js";
import { db, one, type Q } from "../config/db.js";

// Shared provider plumbing: callback URLs, the asynchronous request register, health counters.

export function callbackUrls(base = env.publicUrl) {
  const s = env.callbackSecret;
  return {
    c2bValidation: `${base}/cb/daraja/c2b/${s}/validation`,
    c2bConfirmation: `${base}/cb/daraja/c2b/${s}/confirmation`,
    stk: `${base}/cb/daraja/stk/${s}`,
    b2cResult: `${base}/cb/daraja/b2c/${s}/result`,
    b2cTimeout: `${base}/cb/daraja/b2c/${s}/timeout`,
    statusResult: `${base}/cb/daraja/status/${s}/result`,
    statusTimeout: `${base}/cb/daraja/status/${s}/timeout`,
    balance: `${base}/cb/daraja/balance/${s}`,
  };
}

export async function recordHealth(api: string, ok: boolean, ms: number, error?: string) {
  await db()
    .query(
      `insert into provider_health (api, last_ok_at, last_error_at, last_error, ok_count, error_count, last_ms)
       values ($1, case when $2 then now() end, case when $2 then null else now() end, $3, case when $2 then 1 else 0 end, case when $2 then 0 else 1 end, $4)
       on conflict (api) do update set
         last_ok_at = case when $2 then now() else provider_health.last_ok_at end,
         last_error_at = case when $2 then provider_health.last_error_at else now() end,
         last_error = case when $2 then provider_health.last_error else $3 end,
         ok_count = provider_health.ok_count + case when $2 then 1 else 0 end,
         error_count = provider_health.error_count + case when $2 then 0 else 1 end,
         last_ms = $4`,
      [api, ok, error?.slice(0, 300) ?? null, ms],
    )
    .catch(() => {});
}

export async function openRequest(kind: string, originatorConversationId: string | null, conversationId: string | null, ref: { type: string; id: string } | null, request: unknown): Promise<string> {
  const r = await one<{ id: string }>(
    db(),
    `insert into provider_requests (kind, originator_conversation_id, conversation_id, ref_type, ref_id, request) values ($1,$2,$3,$4,$5,$6) returning id`,
    [kind, originatorConversationId, conversationId, ref?.type ?? null, ref?.id ?? null, JSON.stringify(request ?? {})],
  );
  return r!.id;
}

/** Completes the pending request a result callback answers. Returns it, or null if unknown. */
export async function completeRequest(q: Q, ids: { originatorConversationId?: string | null; conversationId?: string | null }, status: "completed" | "timeout" | "error", result: unknown) {
  return one<{ id: string; kind: string; ref_type: string | null; ref_id: string | null }>(
    q,
    `update provider_requests set status = $3, result = $4, completed_at = now()
      where id = (select id from provider_requests
                   where (originator_conversation_id = $1 and $1 is not null) or (conversation_id = $2 and $2 is not null)
                   order by created_at desc limit 1)
      returning id, kind, ref_type, ref_id`,
    [ids.originatorConversationId ?? null, ids.conversationId ?? null, status, JSON.stringify(result ?? {})],
  );
}

/** Polls a provider request until its result arrives or the budget runs out. */
export async function waitForRequest(id: string, budgetMs: number): Promise<{ status: string; result: unknown } | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const r = await one<{ status: string; result: unknown }>(db(), `select status, result from provider_requests where id = $1`, [id]);
    if (r && r.status !== "pending") return r;
    if (Date.now() >= deadline) return null;
    await new Promise((res) => setTimeout(res, Math.min(250, Math.max(10, deadline - Date.now()))));
  }
}

/** Daraja's ResultParameters list → a plain object. */
export function resultParams(result: unknown): Record<string, unknown> {
  const list = (result as { ResultParameters?: { ResultParameter?: unknown } })?.ResultParameters?.ResultParameter;
  const arr = Array.isArray(list) ? list : list ? [list] : [];
  const out: Record<string, unknown> = {};
  for (const p of arr as { Key?: string; Value?: unknown }[]) if (p?.Key) out[p.Key] = p.Value;
  return out;
}

/** "Working Account|KES|700000.00|700000.00|0.00|0.00&Utility Account|KES|228037.00|..." */
export function parseAccountBalance(s: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of String(s ?? "").split("&")) {
    const [name, , available] = part.split("|");
    if (name && available != null) out[name.trim()] = Math.round(Number(available) * 100);
  }
  return out;
}
