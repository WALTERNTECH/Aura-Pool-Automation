import { env } from "../config/env.js";
import { db, many, one, type Q } from "../config/db.js";
import { activity } from "./audit.js";
import { enqueue, onJob } from "./jobs.js";
import { sendEmail, sendSms } from "./messaging.js";
import { getSetting } from "./settings.js";

// Operator alerts (Admin PRD 5.10). One open alert per dedupe key: a repeat bumps its count
// instead of flooding the list. Conditions that clear resolve their alert automatically, and
// the history stays. Critical alerts go out by SMS and email at once.

export type Severity = "info" | "warning" | "critical";
export type AlertType =
  | "table_offline"
  | "webhook_failure"
  | "callback_silence"
  | "verification_mismatch"
  | "unmatched_payment"
  | "underpaid_review"
  | "overpaid_review"
  | "unlock_failed"
  | "credit_expired"
  | "payout_failed"
  | "payout_timed_out"
  | "payout_needs_approval"
  | "float_low"
  | "reconciliation_mismatch"
  | "ledger_invariant"
  | "override_unusual"
  | "failed_logins"
  | "queue_backlog"
  | "kill_switch"
  | "number_change"
  | "approval_requested"
  | "auto_withdraw_failed"
  | "provider_error";

const RANK: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

export type RaiseInput = {
  type: AlertType;
  severity: Severity;
  title: string;
  detail?: string;
  dedupeKey?: string;
  entity?: { type: string; id: string };
  data?: Record<string, unknown>;
};

export async function raise(q: Q, a: RaiseInput): Promise<string> {
  if (a.dedupeKey) {
    const open = await one<{ id: string; severity: Severity }>(q, `select id, severity from alerts where dedupe_key = $1 and status <> 'resolved' for update`, [a.dedupeKey]);
    if (open) {
      const escalate = RANK[a.severity] > RANK[open.severity];
      // The title follows the latest occurrence too, unless that one is milder than the alert.
      const retitle = RANK[a.severity] >= RANK[open.severity];
      await q.query(
        `update alerts set last_seen_at = now(), occurrences = occurrences + 1, detail = coalesce($2, detail),
                severity = case when $3 then $4 else severity end, data = data || $5::jsonb,
                title = case when $6 then $7 else title end
          where id = $1`,
        [open.id, a.detail ?? null, escalate, a.severity, JSON.stringify(a.data ?? {}), retitle, a.title],
      );
      if (escalate) {
        await q.query(`insert into alert_events (alert_id, kind, note) values ($1, 'escalated', $2)`, [open.id, `Now ${a.severity}`]);
        if (a.severity === "critical") await enqueue(q, "alert.deliver", { alertId: open.id });
      }
      return open.id;
    }
  }
  // A concurrent raise of the same key loses the insert race quietly and becomes a repeat.
  const row = await one<{ id: string }>(
    q,
    `insert into alerts (type, severity, dedupe_key, title, detail, entity_type, entity_id, data)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (dedupe_key) where status <> 'resolved' and dedupe_key is not null do nothing
     returning id`,
    [a.type, a.severity, a.dedupeKey ?? null, a.title, a.detail ?? null, a.entity?.type ?? null, a.entity?.id ?? null, JSON.stringify(a.data ?? {})],
  );
  if (!row) return raise(q, a);
  await q.query(`insert into alert_events (alert_id, kind, note) values ($1, 'opened', $2)`, [row!.id, a.detail ?? null]);
  if (a.severity === "critical") await enqueue(q, "alert.deliver", { alertId: row!.id });
  if (["table_offline", "payout_failed", "verification_mismatch", "reconciliation_mismatch", "kill_switch", "float_low"].includes(a.type)) {
    await activity(q, `alert.${a.type}`, a.title, { type: "alert", id: row!.id }, { severity: a.severity });
  }
  return row!.id;
}

/** The condition behind an alert has cleared. */
export async function autoResolve(q: Q, dedupeKey: string, note = "Condition cleared"): Promise<boolean> {
  const r = await one<{ id: string }>(
    q,
    `update alerts set status = 'resolved', resolved_at = now(), auto_resolved = true
      where dedupe_key = $1 and status <> 'resolved' returning id`,
    [dedupeKey],
  );
  if (r) await q.query(`insert into alert_events (alert_id, kind, note) values ($1, 'auto_resolved', $2)`, [r.id, note]);
  return Boolean(r);
}

export async function isOpen(q: Q, dedupeKey: string): Promise<boolean> {
  return Boolean(await one(q, `select 1 from alerts where dedupe_key = $1 and status <> 'resolved'`, [dedupeKey]));
}

export async function transition(q: Q, id: string, to: "acknowledged" | "resolved" | "open", adminId: string, label: string, note?: string) {
  const a = await one<{ status: string }>(q, `select status from alerts where id = $1 for update`, [id]);
  if (!a) return null;
  if (to === "acknowledged") await q.query(`update alerts set status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now(), owner_id = coalesce(owner_id, $2) where id = $1`, [id, adminId]);
  if (to === "resolved") await q.query(`update alerts set status = 'resolved', resolved_by = $2, resolved_at = now() where id = $1`, [id, adminId]);
  if (to === "open") await q.query(`update alerts set status = 'open', resolved_at = null, resolved_by = null where id = $1`, [id]);
  await q.query(`insert into alert_events (alert_id, kind, actor, note) values ($1,$2,$3,$4)`, [id, to, label, note ?? null]);
  return { before: a.status, after: to };
}

/** Everyone who should hear about a critical alert: the configured contacts and active super admins. */
export async function operatorContacts(q: Q = db()) {
  const contacts = await getSetting("operator_contacts", q);
  const admins = await many<{ email: string; phone: string | null }>(q, `select email, phone from admin_users where status = 'active' and role = 'super_admin'`);
  const sms = [...new Set([...contacts.sms, ...admins.map((a) => a.phone).filter((p): p is string => Boolean(p))])];
  const email = [...new Set([...contacts.email, ...admins.map((a) => a.email)])];
  return { sms, email };
}

onJob("alert.deliver", async (p) => {
  const a = await one<{ title: string; detail: string | null; severity: string; type: string; status: string }>(db(), `select title, detail, severity, type, status from alerts where id = $1`, [p.alertId]);
  if (!a || a.status === "resolved") return;
  const to = await operatorContacts();
  const text = `Aura Pool ${a.severity.toUpperCase()}: ${a.title}${a.detail ? `. ${a.detail}` : ""}`;
  for (const n of to.sms) await sendSms(n, text.slice(0, 300));
  await sendEmail(to.email, `[${a.severity}] ${a.title}`, `${text}\n\nOpen the console: ${env.adminUrl}/alerts/${p.alertId}`);
});

/** Message to the whole team (kill switch, single-operator approvals). */
export async function announceToTeam(q: Q, subject: string, text: string) {
  await enqueue(q, "team.announce", { subject, text });
}

onJob("team.announce", async (p) => {
  const to = await operatorContacts();
  for (const n of to.sms) await sendSms(n, `Aura Pool: ${String(p.text).slice(0, 280)}`);
  await sendEmail(to.email, String(p.subject), String(p.text));
});
