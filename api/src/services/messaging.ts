import webpush from "web-push";
import { env } from "../config/env.js";
import { many, type Q } from "../config/db.js";
import { maskMsisdn } from "../lib/kenya.js";

// SMS (Africa's Talking or Celcom), email (Resend) and web push. Without credentials a
// message is written to the log instead, which is how codes reach a developer before the
// accounts exist. Message bodies are never logged in production except in that fallback.

export type SendResult = { ok: boolean; channel: string; detail?: string };

export const smsConfigured = () => env.sms.provider !== "log";
export const emailConfigured = () => Boolean(env.email.resendApiKey);
export const pushConfigured = () => Boolean(env.push.vapidPublic && env.push.vapidPrivate);

export async function sendSms(to: string, message: string): Promise<SendResult> {
  if (env.sms.provider === "log") {
    console.log(`[sms:log] to ${env.nodeEnv === "production" ? maskMsisdn(to) : to}: ${message}`);
    return { ok: false, channel: "log", detail: "No SMS provider is configured" };
  }
  try {
    if (env.sms.provider === "africastalking") {
      const host = env.sms.atUsername === "sandbox" ? "https://api.sandbox.africastalking.com" : "https://api.africastalking.com";
      const form = new URLSearchParams({ username: env.sms.atUsername, to: `+${to.replace(/^\+/, "")}`, message });
      if (env.sms.atSenderId) form.set("from", env.sms.atSenderId);
      const r = await fetch(`${host}/version1/messaging`, {
        method: "POST",
        headers: { apiKey: env.sms.atApiKey, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
      return { ok: r.ok, channel: "africastalking", detail: r.ok ? undefined : `HTTP ${r.status}` };
    }
    // Celcom Africa bulk SMS.
    const r = await fetch("https://isms.celcomafrica.com/api/services/sendsms/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apikey: env.sms.celcomApiKey, partnerID: env.sms.celcomPartnerId, shortcode: env.sms.celcomShortcode, mobile: to.replace(/^\+/, ""), message }),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: r.ok, channel: "celcom", detail: r.ok ? undefined : `HTTP ${r.status}` };
  } catch (e) {
    console.error("[sms] failed", (e as Error).message);
    return { ok: false, channel: env.sms.provider, detail: (e as Error).message };
  }
}

export async function sendEmail(to: string[], subject: string, text: string, attachments?: { filename: string; content: string }[]): Promise<SendResult> {
  if (!to.length) return { ok: false, channel: "email", detail: "No recipients" };
  if (!emailConfigured()) {
    console.log(`[email:log] to ${to.length} recipient(s): ${subject}`);
    return { ok: false, channel: "log", detail: "No email provider is configured" };
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.email.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: env.email.from, to, subject, text, attachments }),
      signal: AbortSignal.timeout(15_000),
    });
    return { ok: r.ok, channel: "resend", detail: r.ok ? undefined : `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, channel: "resend", detail: (e as Error).message };
  }
}

let vapidSet = false;
function ensureVapid() {
  if (!vapidSet && pushConfigured()) {
    webpush.setVapidDetails(env.push.subject, env.push.vapidPublic, env.push.vapidPrivate);
    vapidSet = true;
  }
}

/** Sends a push to every subscription of a user; drops subscriptions the push service has expired. */
export async function sendPush(q: Q, userId: string, payload: { title: string; body: string; url?: string; tag?: string }): Promise<SendResult> {
  if (!pushConfigured()) return { ok: false, channel: "push", detail: "Push is not configured" };
  ensureVapid();
  const subs = await many<{ id: string; endpoint: string; p256dh: string; auth: string }>(q, `select id, endpoint, p256dh, auth from push_subscriptions where merchant_user_id = $1`, [userId]);
  let delivered = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600 });
      delivered++;
      await q.query(`update push_subscriptions set last_ok_at = now(), failures = 0 where id = $1`, [s.id]);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await q.query(`delete from push_subscriptions where id = $1`, [s.id]);
      else await q.query(`update push_subscriptions set failures = failures + 1 where id = $1`, [s.id]);
    }
  }
  return { ok: delivered > 0, channel: "push", detail: `${delivered}/${subs.length} delivered` };
}
