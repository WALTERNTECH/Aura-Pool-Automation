import { db, many, one, type Q } from "../config/db.js";
import { env } from "../config/env.js";
import { nairobiTime } from "../lib/kenya.js";
import { enqueue, onJob } from "./jobs.js";
import { sendPush, sendSms } from "./messaging.js";

// Notifications to owners and attendants (Merchant PRD 7.7). Every notification lands in the
// in-app list; push follows the user's preferences and quiet hours; critical ones (offline
// table, failed payout, payout-number change) also go by SMS and ignore quiet hours.

export const NOTIFICATION_TYPES = {
  table_offline: { critical: true, audience: "all", label: "Table offline" },
  table_online: { critical: false, audience: "all", label: "Table back online" },
  payment_attention: { critical: false, audience: "all", label: "Payment needs attention" },
  payment_received: { critical: false, audience: "owner", label: "Payment received", inApp: false },
  payout_succeeded: { critical: false, audience: "owner", label: "Withdrawal received" },
  payout_failed: { critical: true, audience: "owner", label: "Withdrawal failed" },
  payout_queued: { critical: false, audience: "owner", label: "Withdrawal waiting" },
  auto_withdraw: { critical: false, audience: "owner", label: "Automatic withdrawal" },
  number_change: { critical: true, audience: "owner", label: "Payout number change" },
  override_unusual: { critical: false, audience: "owner", label: "Unusual button use" },
  dispute_reply: { critical: false, audience: "owner", label: "Support replied" },
  announcement: { critical: false, audience: "all", label: "Announcements" },
  account: { critical: true, audience: "owner", label: "Account" },
} as const;
export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export type Prefs = {
  notifications?: Partial<Record<NotificationType, { push?: boolean }>>;
  quietHours?: { on: boolean; from: string; to: string };
  language?: "en" | "sw";
  theme?: "system" | "light" | "dark";
};

/** Defaults: push on for everything except each individual payment. */
export function wantsPush(prefs: Prefs, type: NotificationType): boolean {
  const p = prefs.notifications?.[type]?.push;
  return p ?? type !== "payment_received";
}

export function inQuietHours(prefs: Prefs, at = new Date()): boolean {
  const qh = prefs.quietHours;
  if (!qh?.on) return false;
  const now = nairobiTime(at);
  return qh.from <= qh.to ? now >= qh.from && now < qh.to : now >= qh.from || now < qh.to;
}

export async function notifyMerchant(
  q: Q,
  merchantId: string,
  n: { type: NotificationType; title: string; body: string; data?: Record<string, unknown>; url?: string; sms?: string; onlyUserId?: string },
) {
  const meta = NOTIFICATION_TYPES[n.type];
  const users = await many<{ id: string; role: string; phone: string; prefs: Prefs }>(
    q,
    `select id, role, phone, prefs from merchant_users where merchant_id = $1 and status = 'active' ${meta.audience === "owner" ? "and role = 'owner'" : ""}`,
    [merchantId],
  );
  for (const u of users) {
    if (n.onlyUserId && u.id !== n.onlyUserId) continue;
    const push = wantsPush(u.prefs, n.type) && (meta.critical || !inQuietHours(u.prefs));
    const sms = meta.critical && u.role === "owner";
    const channels = ["in_app", ...(push ? ["push"] : []), ...(sms ? ["sms"] : [])];
    let id: string | null = null;
    if (!("inApp" in meta) || meta.inApp !== false) {
      const row = await one<{ id: string }>(
        q,
        `insert into notifications (merchant_id, user_id, type, title, body, critical, data, channels) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
        [merchantId, u.id, n.type, n.title, n.body, meta.critical, JSON.stringify({ ...(n.data ?? {}), url: n.url ?? null }), channels],
      );
      id = row!.id;
    }
    if (push || sms) {
      await enqueue(q, "notify.deliver", {
        userId: u.id,
        phone: sms ? u.phone : null,
        title: n.title,
        body: n.body,
        sms: n.sms ?? `${n.title}. ${n.body}`,
        url: n.url ?? "/alerts",
        push,
        notificationId: id,
        tag: n.type,
      });
    }
  }
}

onJob("notify.deliver", async (p) => {
  if (p.push) await sendPush(db(), String(p.userId), { title: String(p.title), body: String(p.body), url: String(p.url ?? "/"), tag: String(p.tag ?? "") });
  if (p.phone) await sendSms(String(p.phone), `Aura Pool: ${String(p.sms).slice(0, 280)}${p.url ? ` ${env.merchantUrl}${p.url}` : ""}`);
});
