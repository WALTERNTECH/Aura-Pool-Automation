import { db, type Q } from "../config/db.js";
import type { Actor } from "../lib/api.js";

// The append-only audit trail: who, what, before and after, IP, device, time. The table has
// a trigger that refuses UPDATE and DELETE for every role, this service included.

export type AuditWho = { type: "admin" | "merchant" | "system" | "device" | "provider"; id?: string | null; label?: string | null; ip?: string | null; ua?: string | null };

export function who(actor: Actor | undefined, ip?: string, ua?: string): AuditWho {
  if (!actor) return { type: "system", ip, ua };
  if (actor.kind === "admin") return { type: "admin", id: actor.id, label: `${actor.name} (${actor.role})`, ip, ua };
  return { type: "merchant", id: actor.userId, label: `${actor.name} (${actor.role})`, ip, ua };
}

export const SYSTEM: AuditWho = { type: "system", label: "system" };

export async function audit(
  q: Q,
  w: AuditWho,
  action: string,
  entity: { type: string; id?: string | null } | null,
  before?: unknown,
  after?: unknown,
) {
  await q.query(
    `insert into audit_log (actor_type, actor_id, actor_label, action, entity_type, entity_id, before, after, ip, user_agent)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      w.type,
      w.id ?? null,
      w.label ?? null,
      action,
      entity?.type ?? null,
      entity?.id ?? null,
      before === undefined ? null : JSON.stringify(redact(before)),
      after === undefined ? null : JSON.stringify(redact(after)),
      w.ip ?? null,
      w.ua ?? null,
    ],
  );
}

/** Secrets never reach the audit log, even as "before" values. */
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object" && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = /pin|password|secret|token|credential|hash|totp|recovery/i.test(k) ? "[redacted]" : redact(val);
    }
    return out;
  }
  return v;
}

/** The admin dashboard's activity feed: important events, in plain words. */
export async function activity(q: Q, type: string, title: string, entity?: { type: string; id: string } | null, data: Record<string, unknown> = {}) {
  await q.query(`insert into activity (type, title, entity_type, entity_id, data) values ($1,$2,$3,$4,$5)`, [type, title, entity?.type ?? null, entity?.id ?? null, JSON.stringify(data)]);
}

export async function auditNow(w: AuditWho, action: string, entity: { type: string; id?: string | null } | null, before?: unknown, after?: unknown) {
  await audit(db(), w, action, entity, before, after);
}
