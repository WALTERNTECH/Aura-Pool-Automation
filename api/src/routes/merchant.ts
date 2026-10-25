import type { Request } from "express";
import { z } from "zod";
import { env, isSandbox } from "../config/env.js";
import { db, many, one, type Q } from "../config/db.js";
import { Api, decodeCursor, page, zCursor, zDate, zLimit, zPin, type MerchantActor } from "../lib/api.js";
import { shortRef } from "../lib/crypto.js";
import { badRequest, forbidden, notFound } from "../lib/http.js";
import { maskMsisdn, nairobiDate, nairobiInstant, addDays } from "../lib/kenya.js";
import { audit, who } from "../services/audit.js";
import { merchantAvailable } from "../services/ledger.js";
import { addStaff, changePin, createInvite, requirePin, resendNumberCode, revokeStaff, startNumberChange, verifyNumberChange } from "../services/merchants.js";
import { NOTIFICATION_TYPES } from "../services/notify.js";
import { ownerStatus, problemReason } from "../services/payments.js";
import { nextAutoRun, quote, rejectPayout, requestMerchantPayout } from "../services/payouts.js";
import { boundsFor, payoutLimits } from "../services/pricing.js";
import { shillings, statementCsv, statementData, statementPdf, toCsv } from "../services/reports.js";
import { listSessions, revokeAll } from "../services/sessions.js";
import { getSetting } from "../services/settings.js";
import { tableSheet } from "../services/sheet.js";
import { sinceStarted, stats, today } from "../services/stats.js";
import { commandStatus, manualUnlockCount, requestManualUnlock } from "../services/unlocks.js";
import { listCredentials, registerCredential, registrationOptions, removeCredential } from "../services/webauthn.js";

// /v1/m — the Merchant API. Every query is scoped by the signed-in user's merchant_id;
// nothing here takes a merchant id from the client. Attendants see today's games and
// payments, table status, and can use the limited manual unlock; nothing about money.

export const merchantApi = new Api("/v1/m", "Merchant");
const r = merchantApi;
const me = (req: Request) => req.actor as MerchantActor;
const isOwner = (req: Request) => me(req).role === "owner";
const actorWho = (req: Request) => ({ ...who(req.actor, req.ip, String(req.headers["user-agent"] ?? "")), id: me(req).userId, label: `${me(req).name} (${me(req).role})` });

/** Money actions are refused for a suspended or closed merchant (Merchant PRD 9). */
function assertCanAct(req: Request) {
  const s = me(req).merchantStatus;
  if (s === "suspended") throw forbidden("Your account is suspended, so changes and withdrawals are paused. You can still view your history. Contact support.", "suspended");
  if (s === "closed") throw forbidden("This account is closed.", "closed");
}

async function ownTable(q: Q, merchantId: string, tableId: string) {
  const t = await one<Record<string, unknown> & { id: string; merchant_id: string; price_minor: number; unlock_seconds: number; status: string; name: string }>(q, `select * from pool_tables where id = $1 and merchant_id = $2`, [tableId, merchantId]);
  if (!t) throw notFound("Table not found");
  return t;
}

// ------------------------------------------------------------------ me

r.route({ method: "get", path: "/me", summary: "Who is signed in, their business and preferences", auth: "merchant" }, async ({ req }) => {
  const a = me(req);
  const u = await one<{ prefs: Record<string, unknown>; tour_done_at: Date | null; phone: string; created_at: Date }>(db(), `select prefs, tour_done_at, phone, created_at from merchant_users where id = $1`, [a.userId]);
  const m = await one<{ id: string; code: string; business_name: string; owner_name: string; status: string; status_reason: string | null; payout_msisdn: string | null; payout_msisdn_verified_at: Date | null; location: string | null; email: string | null }>(db(), `select * from merchants where id = $1`, [a.merchantId]);
  const ks = await getSetting("kill_switch");
  return {
    user: { id: a.userId, name: a.name, role: a.role, phoneMasked: maskMsisdn(u!.phone), since: u!.created_at, impersonatedBy: a.impersonatedBy ?? null },
    merchant: { id: m!.id, code: m!.code, businessName: m!.business_name, ownerName: m!.owner_name, location: m!.location, email: a.role === "owner" ? m!.email : null, status: m!.status, statusReason: m!.status === "suspended" ? m!.status_reason : null },
    prefs: u!.prefs,
    tourDone: Boolean(u!.tour_done_at),
    payoutNumberVerified: Boolean(m!.payout_msisdn_verified_at),
    support: await getSetting("support"),
    notices: { killSwitch: ks.on ? "Withdrawals are paused by Aura Pool for a short while. Your balance is safe." : null },
    push: { vapidPublicKey: env.push.vapidPublic || null },
    testMode: { otpOnScreen: env.otpEcho, sandbox: isSandbox() },
    notificationTypes: Object.entries(NOTIFICATION_TYPES)
      .filter(([, v]) => v.audience === "all" || a.role === "owner")
      .map(([k, v]) => ({ type: k, label: v.label, critical: v.critical })),
    termsVersion: await getSetting("terms_version"),
  };
});

const zPrefs = z.object({
  notifications: z.record(z.string(), z.object({ push: z.boolean().optional() })).optional(),
  quietHours: z.object({ on: z.boolean(), from: z.string().regex(/^\d{2}:\d{2}$/), to: z.string().regex(/^\d{2}:\d{2}$/) }).optional(),
  language: z.enum(["en", "sw"]).optional(),
  theme: z.enum(["system", "light", "dark"]).optional(),
});
r.route({ method: "patch", path: "/me/prefs", summary: "Update language, theme, quiet hours and notification preferences", auth: "merchant", body: zPrefs }, async ({ req, body }) => {
  const u = await one<{ prefs: Record<string, unknown> }>(db(), `update merchant_users set prefs = prefs || $2::jsonb where id = $1 returning prefs`, [me(req).userId, JSON.stringify(body)]);
  return { prefs: u!.prefs };
});

r.route({ method: "post", path: "/me/tour-done", summary: "Mark the first-run tour as seen", auth: "merchant" }, async ({ req }) => {
  await db().query(`update merchant_users set tour_done_at = coalesce(tour_done_at, now()) where id = $1`, [me(req).userId]);
  return { ok: true };
});

r.route({ method: "post", path: "/me/pin", summary: "Change PIN (signs out other devices)", auth: "merchant", body: z.object({ currentPin: zPin, newPin: zPin }) }, async ({ req, body }) => {
  await changePin(me(req).userId, body.currentPin, body.newPin, me(req).sessionId);
  return { ok: true };
});

r.route({ method: "get", path: "/me/sessions", summary: "Signed-in devices", auth: "merchant" }, async ({ req }) => ({ sessions: await listSessions(db(), "merchant", me(req).userId, me(req).sessionId) }));
r.route({ method: "delete", path: "/me/sessions/:id", summary: "Sign out one device", auth: "merchant" }, async ({ req, params }) => {
  await db().query(`update sessions set revoked_at = now(), revoked_reason = 'signed out remotely' where id = $1 and user_id = $2 and kind = 'merchant'`, [params.id, me(req).userId]);
  return { ok: true };
});
r.route({ method: "post", path: "/me/sessions/revoke-all", summary: "Sign out of all devices", auth: "merchant" }, async ({ req, res }) => {
  await revokeAll(db(), "merchant", me(req).userId, "signed out everywhere");
  res.clearCookie("aura_m_at", { path: "/" });
  res.clearCookie("aura_m_rt", { path: "/v1/auth" });
  await audit(db(), actorWho(req), "merchant_user.sign_out_all", { type: "merchant_user", id: me(req).userId });
  return { ok: true };
});

r.route({ method: "post", path: "/me/webauthn/options", summary: "Start setting up fingerprint sign-in on this device", auth: "merchant" }, async ({ req }) => registrationOptions(me(req).userId));
r.route({ method: "post", path: "/me/webauthn", summary: "Finish setting up fingerprint sign-in", auth: "merchant", body: z.object({ response: z.any(), label: z.string().max(80).default("This phone") }) }, async ({ req, body }) => {
  await registerCredential(me(req).userId, body.response, body.label);
  return { ok: true };
});
r.route({ method: "get", path: "/me/webauthn", summary: "Devices with fingerprint sign-in", auth: "merchant" }, async ({ req }) => ({ credentials: await listCredentials(me(req).userId) }));
r.route({ method: "delete", path: "/me/webauthn/:id", summary: "Remove fingerprint sign-in from a device", auth: "merchant" }, async ({ req, params }) => {
  await removeCredential(me(req).userId, params.id);
  return { ok: true };
});

r.route({ method: "post", path: "/me/push", summary: "Register this device for push notifications", auth: "merchant", body: z.object({ endpoint: z.string().url().max(800), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) }) }, async ({ req, body, ua }) => {
  await db().query(
    `insert into push_subscriptions (merchant_user_id, endpoint, p256dh, auth, user_agent) values ($1,$2,$3,$4,$5)
     on conflict (endpoint) do update set merchant_user_id = excluded.merchant_user_id, p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`,
    [me(req).userId, body.endpoint, body.keys.p256dh, body.keys.auth, ua],
  );
  return { ok: true };
});
r.route({ method: "post", path: "/me/push/remove", summary: "Stop push notifications on this device", auth: "merchant", body: z.object({ endpoint: z.string().max(800) }) }, async ({ req, body }) => {
  await db().query(`delete from push_subscriptions where endpoint = $1 and merchant_user_id = $2`, [body.endpoint, me(req).userId]);
  return { ok: true };
});

// ------------------------------------------------------------------ home

async function tableCards(q: Q, merchantId: string) {
  const start = nairobiInstant(nairobiDate());
  return many<{ id: string; name: string; status: string; online: boolean | null; last_seen_at: Date | null; rssi: number | null; has_device: boolean; last_game_at: Date | null; games_today: number; waiting: number }>(
    q,
    `select t.id, t.name, t.status, d.online, d.last_seen_at, d.rssi, d.id is not null as has_device,
            (select max(acked_at) from game_credits g where g.table_id = t.id and g.status = 'acked') as last_game_at,
            (select count(*)::int from game_credits g where g.table_id = t.id and g.status = 'acked' and g.acked_at >= $2) as games_today,
            (select count(*)::int from game_credits g where g.table_id = t.id and g.status in ('pending','dispatched')) as waiting
       from pool_tables t left join devices d on d.table_id = t.id and d.status = 'provisioned'
      where t.merchant_id = $1 order by t.id`,
    [merchantId, start],
  );
}

function tableState(t: { status: string; online: boolean | null; has_device: boolean }) {
  if (t.status === "maintenance") return "maintenance";
  if (t.status === "disabled") return "disabled";
  return t.has_device && t.online ? "online" : "offline";
}

async function paymentRows(q: Q, where: string, params: unknown[], limit: number) {
  const rows = await many<{ id: string; received_at: Date; table_id: string | null; amount_minor: number; payer_msisdn_masked: string | null; payer_name_masked: string | null; status: string; problem: string | null; games_credited: number; provider_txn_id: string; credits: { status: string }[] | null }>(
    q,
    `select p.id, p.received_at, p.table_id, p.amount_minor, p.payer_msisdn_masked, p.payer_name_masked, p.status, p.problem, p.games_credited, p.provider_txn_id,
            (select json_agg(json_build_object('status', g.status)) from game_credits g where g.payment_id = p.id) as credits
       from payments p where ${where} order by p.received_at desc, p.id desc limit ${limit + 1}`,
    params,
  );
  return rows.map((p) => ({ ...p, credits: p.credits ?? [] }));
}

function paymentView(p: Awaited<ReturnType<typeof paymentRows>>[number]) {
  return { id: p.id, receivedAt: p.received_at, tableId: p.table_id, amountMinor: p.amount_minor, payer: p.payer_msisdn_masked, payerName: p.payer_name_masked, mpesaCode: p.provider_txn_id, games: p.games_credited, gamesPlayed: p.credits.filter((c) => c.status === "acked").length, status: ownerStatus(p) };
}

r.route({ method: "get", path: "/dashboard", summary: "Home: today, balance, tables, alerts, last payments", auth: "merchant" }, async ({ req }) => {
  const a = me(req);
  const q = db();
  const t = await today(q, a.merchantId);
  const tables = await tableCards(q, a.merchantId);
  const m = await one<{ business_name: string; owner_name: string; status: string; status_reason: string | null; payout_msisdn_verified_at: Date | null; payout_hold_until: Date | null; auto_withdraw_enabled: boolean; auto_withdraw_time: string | null; auto_withdraw_last_date: string | null }>(
    q,
    `select business_name, owner_name, status, status_reason, payout_msisdn_verified_at, payout_hold_until, auto_withdraw_enabled, auto_withdraw_time, to_char(auto_withdraw_last_date, 'YYYY-MM-DD') as auto_withdraw_last_date from merchants where id = $1`,
    [a.merchantId],
  );
  const alerts: { kind: string; tone: "bad" | "wait" | "info"; title: string; body: string; url: string }[] = [];
  if (m!.status === "suspended") alerts.push({ kind: "suspended", tone: "bad", title: "Your account is suspended", body: "You can view your history, but withdrawals and changes are paused. Contact support.", url: "/more/support" });
  for (const tb of tables) if (tableState(tb) === "offline" && tb.status === "active") alerts.push({ kind: "table_offline", tone: "bad", title: `${tb.id} ${tb.name} is offline`, body: tb.waiting ? `${tb.waiting} paid game${tb.waiting > 1 ? "s" : ""} waiting for it.` : "Check its power and Wi-Fi.", url: `/tables/${tb.id}` });
  if (t.needsAttention) alerts.push({ kind: "payment_attention", tone: "wait", title: `${t.needsAttention} payment${t.needsAttention > 1 ? "s" : ""} need${t.needsAttention > 1 ? "" : "s"} attention`, body: "Tap to see what happened.", url: "/payments?status=attention" });
  let balance = null;
  if (a.role === "owner") {
    const failed = await one<{ ref: string; id: string }>(q, `select ref, id from payouts where merchant_id = $1 and status = 'failed' and completed_at > now() - interval '2 days' and not exists (select 1 from payouts r where r.retry_of = payouts.id) order by completed_at desc limit 1`, [a.merchantId]);
    if (failed) alerts.push({ kind: "payout_failed", tone: "bad", title: `Withdrawal ${failed.ref} failed`, body: "The money is back in your balance.", url: "/money/history" });
    if (!m!.payout_msisdn_verified_at) alerts.push({ kind: "no_number", tone: "info", title: "Add your M-Pesa payout number", body: "You need it to withdraw your earnings.", url: "/money/number" });
    if (m!.payout_hold_until && new Date(m!.payout_hold_until) > new Date()) alerts.push({ kind: "cooling", tone: "info", title: "New payout number: withdrawals held", body: `For your safety, withdrawals resume ${new Date(m!.payout_hold_until).toISOString()}.`, url: "/money/number" });
    const ks = await getSetting("kill_switch");
    if (ks.on) alerts.push({ kind: "paused", tone: "info", title: "Withdrawals are paused for a short while", body: "Your balance is safe and keeps growing.", url: "/money" });
    balance = { availableMinor: await merchantAvailable(q, a.merchantId), autoWithdraw: { enabled: m!.auto_withdraw_enabled, time: m!.auto_withdraw_time, nextRunAt: nextAutoRun(m!) } };
  }
  const startToday = nairobiInstant(nairobiDate());
  const recent = await paymentRows(q, a.role === "owner" ? `p.merchant_id = $1` : `p.merchant_id = $1 and p.received_at >= $2`, a.role === "owner" ? [a.merchantId] : [a.merchantId, startToday], 5);
  return {
    businessName: m!.business_name,
    name: a.name,
    role: a.role,
    today: a.role === "owner" ? t : { games: t.games, needsAttention: t.needsAttention },
    balance,
    tables: tables.map((tb) => ({ id: tb.id, name: tb.name, state: tableState(tb), lastSeenAt: tb.last_seen_at, lastGameAt: tb.last_game_at, gamesToday: tb.games_today, waiting: tb.waiting })),
    alerts,
    recentPayments: recent.slice(0, 5).map(paymentView).map((p) => (a.role === "owner" ? p : { ...p, amountMinor: undefined })),
    updatedAt: new Date().toISOString(),
  };
});

// ------------------------------------------------------------------ tables

r.route({ method: "get", path: "/tables", summary: "Tables with status and games today", auth: "merchant" }, async ({ req }) => {
  const tables = await tableCards(db(), me(req).merchantId);
  return { tables: tables.map((t) => ({ id: t.id, name: t.name, state: tableState(t), lastSeenAt: t.last_seen_at, lastGameAt: t.last_game_at, gamesToday: t.games_today, waiting: t.waiting, rssi: t.rssi })) };
});

r.route({ method: "get", path: "/tables/:id", summary: "Table detail: device, price, figures, payments, override log", auth: "merchant" }, async ({ req, params }) => {
  const a = me(req);
  const q = db();
  const t = await ownTable(q, a.merchantId, params.id);
  const d = await one<{ id: string; online: boolean; rssi: number | null; last_seen_at: Date | null; firmware_version: string | null; relay_state: string | null; uptime_s: number | null }>(q, `select id, online, rssi, last_seen_at, firmware_version, relay_state, uptime_s from devices where table_id = $1 and status = 'provisioned'`, [t.id]);
  const bounds = await boundsFor(q, t as never, a.merchantId);
  const startToday = nairobiInstant(nairobiDate());
  const startWeek = nairobiInstant(addDays(nairobiDate(), -6));
  const startMonth = nairobiInstant(`${nairobiDate().slice(0, 8)}01`);
  const fig = async (from: Date) =>
    (await one<{ games: number; earnings: number }>(
      q,
      `select (select count(*)::int from game_credits where table_id = $1 and status = 'acked' and acked_at >= $2) as games,
              (select coalesce(sum(merchant_share_minor), 0) from payments where table_id = $1 and credited_at >= $2) as earnings`,
      [t.id, from],
    ))!;
  const [ft, fw, fm] = [await fig(startToday), await fig(startWeek), await fig(startMonth)];
  const recent = await paymentRows(q, a.role === "owner" ? `p.table_id = $1` : `p.table_id = $1 and p.received_at >= $2`, a.role === "owner" ? [t.id] : [t.id, startToday], 10);
  const overrides = await many<{ at: Date; device_ts: Date | null }>(q, `select at, device_ts from device_events where table_id = $1 and type = 'manual_override' order by at desc limit 30`, [t.id]);
  const mu = await getSetting("manual_unlock");
  const ml = await one<{ manual_unlock_daily_limit: number | null }>(q, `select manual_unlock_daily_limit from merchants where id = $1`, [a.merchantId]);
  const owner = a.role === "owner";
  const money = (x: { games: number; earnings: number }) => (owner ? { games: x.games, earningsMinor: x.earnings } : { games: x.games });
  return {
    id: t.id,
    name: t.name,
    location: t.location,
    status: t.status,
    statusReason: t.status_reason,
    state: tableState({ status: t.status, online: d?.online ?? null, has_device: Boolean(d) }),
    priceMinor: t.price_minor,
    unlockSeconds: t.unlock_seconds,
    bounds,
    openingHours: t.opening_hours ?? null,
    startedAt: t.started_at ?? null,
    device: d ? { online: d.online, rssi: d.rssi, lastSeenAt: d.last_seen_at, firmware: d.firmware_version, relay: d.relay_state, uptimeS: d.uptime_s } : null,
    figures: { today: money(ft), week: money(fw), month: money(fm) },
    recentPayments: recent.slice(0, 10).map(paymentView).map((p) => (owner ? p : { ...p, amountMinor: undefined })),
    paymentInstructions: { paybill: env.paybillNumber, account: t.id, payPageUrl: `${env.publicUrl}/t/${t.id}` },
    overrideLog: overrides.map((o) => ({ at: o.device_ts ?? o.at })),
    manualUnlock: { limit: ml?.manual_unlock_daily_limit ?? mu.daily_limit, usedToday: await manualUnlockCount(q, t.id), reasons: mu.reasons },
  };
});

r.route(
  { method: "patch", path: "/tables/:id", summary: "Change price or unlock time, within the admin's limits", auth: "owner", body: z.object({ priceMinor: z.number().int().positive().optional(), unlockSeconds: z.number().int().min(5).max(60).optional(), name: z.string().min(2).max(60).optional() }) },
  async ({ req, params, body }) => {
    assertCanAct(req);
    const a = me(req);
    return db().tx(async (q) => {
      const t = await ownTable(q, a.merchantId, params.id);
      const b = await boundsFor(q, t as never, a.merchantId);
      if (body.priceMinor != null) {
        if (body.priceMinor % 100) throw badRequest("Use whole shillings");
        if (body.priceMinor < b.priceMinMinor || body.priceMinor > b.priceMaxMinor) throw badRequest(`The price must be between KSh ${b.priceMinMinor / 100} and KSh ${b.priceMaxMinor / 100}`, "out_of_bounds");
      }
      if (body.unlockSeconds != null && (body.unlockSeconds < b.unlockMinS || body.unlockSeconds > b.unlockMaxS)) throw badRequest(`Unlock time must be between ${b.unlockMinS} and ${b.unlockMaxS} seconds`, "out_of_bounds");
      const before = { priceMinor: t.price_minor, unlockSeconds: t.unlock_seconds, name: t.name };
      const after = { priceMinor: body.priceMinor ?? t.price_minor, unlockSeconds: body.unlockSeconds ?? t.unlock_seconds, name: body.name?.trim() ?? t.name };
      await q.query(`update pool_tables set price_minor = $2, unlock_seconds = $3, name = $4 where id = $1`, [t.id, after.priceMinor, after.unlockSeconds, after.name]);
      await audit(q, actorWho(req), "table.owner_update", { type: "table", id: t.id }, before, after);
      return after;
    });
  },
);

r.route({ method: "post", path: "/tables/:id/maintenance", summary: "Turn maintenance mode on or off", auth: "owner", body: z.object({ on: z.boolean() }) }, async ({ req, params, body }) => {
  assertCanAct(req);
  const a = me(req);
  return db().tx(async (q) => {
    const t = await ownTable(q, a.merchantId, params.id);
    if (t.status === "disabled") throw forbidden("This table was disabled by Aura Pool. Contact support.");
    const next = body.on ? "maintenance" : "active";
    await q.query(`update pool_tables set status = $2, status_reason = $3 where id = $1`, [t.id, next, body.on ? "Maintenance (set by owner)" : null]);
    await audit(q, actorWho(req), body.on ? "table.maintenance_on" : "table.maintenance_off", { type: "table", id: t.id }, { status: t.status }, { status: next });
    return { status: next };
  });
});

const zHours = z.record(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]), z.array(z.tuple([z.string().regex(/^\d{2}:\d{2}$/), z.string().regex(/^\d{2}:\d{2}$/)])).max(3)).nullable();
r.route({ method: "put", path: "/tables/:id/hours", summary: "Set opening hours (or clear them)", auth: "owner", body: z.object({ openingHours: zHours }) }, async ({ req, params, body }) => {
  assertCanAct(req);
  const a = me(req);
  const t = await ownTable(db(), a.merchantId, params.id);
  await db().query(`update pool_tables set opening_hours = $2 where id = $1`, [t.id, body.openingHours ? JSON.stringify(body.openingHours) : null]);
  await audit(db(), actorWho(req), "table.hours", { type: "table", id: t.id }, { openingHours: t.opening_hours ?? null }, { openingHours: body.openingHours });
  return { ok: true };
});

r.route({ method: "post", path: "/tables/:id/unlock", summary: "Manual unlock (reason, PIN, daily limit)", auth: "merchant", body: z.object({ reason: z.string().min(2).max(60), pin: zPin }) }, async ({ req, params, body }) => {
  assertCanAct(req);
  const a = me(req);
  await ownTable(db(), a.merchantId, params.id);
  await requirePin(a.userId, body.pin);
  const cmdId = await db().tx((q) => requestManualUnlock(q, params.id, a.role === "owner" ? "manual_owner" : "manual_staff", body.reason, actorWho(req)));
  return { cmdId };
});

r.route({ method: "get", path: "/tables/:id/commands/:cmdId", summary: "Live status of an unlock command", auth: "merchant" }, async ({ req, params }) => {
  await ownTable(db(), me(req).merchantId, params.id);
  const c = await commandStatus(db(), params.cmdId);
  if (!c || c.table_id !== params.id) throw notFound("Command not found");
  return c;
});

r.route({ method: "get", path: "/tables/:id/sheet", summary: "Printable QR and payment instructions", auth: "owner", raw: true }, async ({ req, res, params }) => {
  const t = await ownTable(db(), me(req).merchantId, params.id);
  const m = await one<{ business_name: string }>(db(), `select business_name from merchants where id = $1`, [me(req).merchantId]);
  res.type("html").set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:").send(await tableSheet({ ...t, business_name: m!.business_name }));
});

// ------------------------------------------------------------------ payments

const zPaymentQuery = z.object({
  from: zDate.optional(),
  to: zDate.optional(),
  table: z.string().regex(/^T\d{3,}$/).optional(),
  status: z.enum(["attention", "game_started", "waiting_table", "unlock_failed", "underpaid", "wrong_table", "verifying", "refund_pending", "refunded", "rejected"]).optional(),
  q: z.string().max(30).optional(),
  cursor: zCursor,
  limit: zLimit,
});

const STATUS_SQL: Record<string, string> = {
  game_started: `p.status = 'credited' and exists (select 1 from game_credits g where g.payment_id = p.id) and not exists (select 1 from game_credits g where g.payment_id = p.id and g.status <> 'acked')`,
  waiting_table: `p.status = 'credited' and exists (select 1 from game_credits g where g.payment_id = p.id and g.status in ('pending','dispatched'))`,
  unlock_failed: `p.status = 'credited' and exists (select 1 from game_credits g where g.payment_id = p.id and g.status in ('expired','failed'))`,
  underpaid: `p.status = 'underpaid'`,
  wrong_table: `p.status = 'unmatched'`,
  verifying: `p.status in ('received','verifying','matched')`,
  refund_pending: `p.status = 'refund_pending'`,
  refunded: `p.status = 'refunded'`,
  rejected: `p.status = 'rejected'`,
};
STATUS_SQL.attention = `(${STATUS_SQL.underpaid} or ${STATUS_SQL.unlock_failed} or ${STATUS_SQL.waiting_table} or ${STATUS_SQL.refund_pending})`;

function paymentFilter(req: Request, f: z.infer<typeof zPaymentQuery>) {
  const a = me(req);
  const where = [`p.merchant_id = $1`];
  const params: unknown[] = [a.merchantId];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  // Attendants only ever see today.
  const from = a.role === "staff" ? nairobiDate() : f.from;
  if (from) add(`p.received_at >= ?`, nairobiInstant(from));
  if (f.to && a.role === "owner") add(`p.received_at < ?`, nairobiInstant(addDays(f.to, 1)));
  if (f.table) add(`p.table_id = ?`, f.table);
  if (f.q) add(`p.provider_txn_id ilike ?`, `%${f.q.replace(/[%_]/g, "")}%`);
  if (f.status) where.push(STATUS_SQL[f.status]);
  return { where, params };
}

r.route({ method: "get", path: "/payments", summary: "Payments, filtered and paginated", auth: "merchant", query: zPaymentQuery }, async ({ req, query }) => {
  const { where, params } = paymentFilter(req, query);
  const c = decodeCursor(query.cursor);
  if (c) {
    params.push(c.at, c.id);
    where.push(`(p.received_at, p.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  const rows = await paymentRows(db(), where.join(" and "), params, query.limit);
  const pg = page(rows as never[], query.limit, "received_at" as never, "id" as never);
  const owner = isOwner(req);
  return { items: (pg.items as typeof rows).map(paymentView).map((p) => (owner ? p : { ...p, amountMinor: undefined })), nextCursor: pg.nextCursor };
});

r.route({ method: "get", path: "/payments/export", summary: "CSV of payments for the current filter", auth: "owner", query: zPaymentQuery.omit({ cursor: true, limit: true }), raw: true }, async ({ req, res, query }) => {
  const { where, params } = paymentFilter(req, { ...query, limit: 50 });
  const rows = await paymentRows(db(), where.join(" and "), params, 20_000);
  const csv = toCsv(
    rows.map((p) => {
      const v = paymentView(p);
      return { received_at: p.received_at, table: p.table_id, mpesa_code: p.provider_txn_id, amount_kes: shillings(p.amount_minor), payer: p.payer_msisdn_masked, games: p.games_credited, games_played: v.gamesPlayed, status: v.status.label };
    }),
    ["received_at", "table", "mpesa_code", "amount_kes", "payer", "games", "games_played", "status"],
  );
  await audit(db(), actorWho(req), "payments.export", { type: "merchant", id: me(req).merchantId }, null, { rows: rows.length, filter: query });
  res.type("text/csv").attachment(`aura-payments-${nairobiDate()}.csv`).send(csv);
});

r.route({ method: "get", path: "/payments/:id", summary: "Payment detail with timeline and money split", auth: "merchant" }, async ({ req, params }) => {
  const a = me(req);
  const q = db();
  const p = await one<{ id: string; provider_txn_id: string; received_at: Date; verified_at: Date | null; verification_status: string; credited_at: Date | null; table_id: string | null; amount_minor: number; commission_minor: number; merchant_share_minor: number; remainder_minor: number; refund_minor: number; payer_msisdn_masked: string | null; payer_name_masked: string | null; status: string; problem: string | null; games_credited: number; channel: string }>(
    q,
    `select * from payments where id = $1 and merchant_id = $2`,
    [params.id, a.merchantId],
  );
  if (!p) throw notFound("Payment not found");
  if (a.role === "staff" && new Date(p.received_at) < nairobiInstant(nairobiDate())) throw forbidden("Attendants can see today's payments only");
  const credits = await many<{ id: string; status: string; dispatched_at: Date | null; acked_at: Date | null; expires_at: Date }>(q, `select id, status, dispatched_at, acked_at, expires_at from game_credits where payment_id = $1 order by created_at`, [p.id]);
  const firstSent = await one<{ at: Date | null }>(q, `select min(u.sent_at) as at from unlock_commands u join game_credits g on g.id = u.game_credit_id where g.payment_id = $1`, [p.id]);
  const firstAck = credits.map((c) => c.acked_at).filter(Boolean).sort()[0] ?? null;
  const st = ownerStatus({ ...p, credits });
  const owner = a.role === "owner";
  return {
    id: p.id,
    mpesaCode: p.provider_txn_id,
    channel: p.channel,
    tableId: p.table_id,
    payer: p.payer_msisdn_masked,
    payerName: p.payer_name_masked,
    receivedAt: p.received_at,
    games: p.games_credited,
    status: st,
    reason: problemReason({ ...p, credits }),
    timeline: [
      { step: "received", at: p.received_at, done: true },
      { step: "verified", at: p.verified_at, done: p.verification_status === "verified", state: p.verification_status },
      { step: "unlock_sent", at: firstSent?.at ?? null, done: Boolean(firstSent?.at) },
      { step: "unlocked", at: firstAck, done: credits.length > 0 && credits.every((c) => c.status === "acked") },
    ],
    games_detail: credits.map((c) => ({ status: c.status, ackedAt: c.acked_at, expiresAt: c.expires_at })),
    split: owner ? { totalMinor: p.amount_minor, commissionMinor: p.commission_minor, shareMinor: p.merchant_share_minor, heldMinor: p.remainder_minor, refundedMinor: p.refund_minor } : null,
    disputes: await many(q, `select id, ref, status, subject, created_at from disputes where payment_id = $1 and merchant_id = $2 order by created_at desc`, [p.id, a.merchantId]),
  };
});

// ------------------------------------------------------------------ money

r.route({ method: "get", path: "/money", summary: "Balance, earnings by day, auto-withdraw and payout number", auth: "owner" }, async ({ req }) => {
  const a = me(req);
  const q = db();
  const available = await merchantAvailable(q, a.merchantId);
  const pending = await one<{ s: number; n: number }>(q, `select coalesce(sum(gross_minor), 0) as s, count(*)::int as n from payouts where merchant_id = $1 and status in ('requested','pending_approval','held','queued','submitted','timed_out')`, [a.merchantId]);
  const earned = await one<{ s: number }>(
    q,
    `select -coalesce(sum(e.amount_minor), 0) as s from ledger_entries e join ledger_accounts ac on ac.id = e.account_id join ledger_transactions t on t.id = e.transaction_id
      where ac.code = $1 and t.kind in ('payment_credit','partial_credit_merchant','partial_grant_game','refund_marked','reversal','collection_fee')`,
    [`merchant_payable:${a.merchantId}`],
  );
  const withdrawn = await one<{ s: number }>(q, `select coalesce(sum(gross_minor), 0) as s from payouts where merchant_id = $1 and status = 'succeeded'`, [a.merchantId]);
  const days = await many<{ d: string; games: number; earnings: number }>(
    q,
    `with days as (select generate_series(($2::date - 13), $2::date, interval '1 day')::date as d)
     select to_char(days.d, 'YYYY-MM-DD') as d,
            (select count(*)::int from game_credits g where g.merchant_id = $1 and g.status = 'acked' and (g.acked_at at time zone 'Africa/Nairobi')::date = days.d) as games,
            (select coalesce(sum(merchant_share_minor), 0) from payments p where p.merchant_id = $1 and (p.credited_at at time zone 'Africa/Nairobi')::date = days.d) as earnings
       from days order by days.d desc`,
    [a.merchantId, nairobiDate()],
  );
  const m = await one<{ auto_withdraw_enabled: boolean; auto_withdraw_time: string | null; auto_withdraw_min_minor: number | null; auto_withdraw_last_run: unknown; auto_withdraw_last_date: string | null; payout_msisdn: string | null; payout_msisdn_verified_at: Date | null; payout_hold_until: Date | null }>(
    q,
    `select auto_withdraw_enabled, auto_withdraw_time, auto_withdraw_min_minor, auto_withdraw_last_run, to_char(auto_withdraw_last_date, 'YYYY-MM-DD') as auto_withdraw_last_date, payout_msisdn, payout_msisdn_verified_at, payout_hold_until from merchants where id = $1`,
    [a.merchantId],
  );
  const limits = await payoutLimits(q, a.merchantId);
  const ks = await getSetting("kill_switch");
  return {
    availableMinor: available,
    pendingWithdrawalsMinor: pending?.s ?? 0,
    pendingWithdrawals: pending?.n ?? 0,
    totalEarnedMinor: earned?.s ?? 0,
    totalWithdrawnMinor: withdrawn?.s ?? 0,
    daily: days.map((d) => ({ date: d.d, games: d.games, earningsMinor: d.earnings })),
    limits,
    autoWithdraw: { enabled: m!.auto_withdraw_enabled, time: m!.auto_withdraw_time, minMinor: m!.auto_withdraw_min_minor, nextRunAt: nextAutoRun(m!), lastRun: m!.auto_withdraw_last_run },
    payoutNumber: { masked: m!.payout_msisdn && m!.payout_msisdn_verified_at ? maskMsisdn(m!.payout_msisdn) : null, holdUntil: m!.payout_hold_until && new Date(m!.payout_hold_until) > new Date() ? m!.payout_hold_until : null },
    paused: ks.on ? "Withdrawals are paused by Aura Pool for a short while. Your balance is safe." : null,
  };
});

r.route({ method: "get", path: "/payouts/quote", summary: "Fee, net and limits for a withdrawal amount", auth: "owner", query: z.object({ amountMinor: z.coerce.number().int().positive().optional() }) }, async ({ req, query }) => quote(db(), me(req).merchantId, query.amountMinor));

r.route(
  { method: "post", path: "/payouts", summary: "Withdraw to the verified payout number", auth: "owner", idempotent: true, body: z.object({ amountMinor: z.number().int().positive().optional(), pin: zPin }) },
  async ({ req, body }) => {
    assertCanAct(req);
    const a = me(req);
    await requirePin(a.userId, body.pin);
    const key = String(req.headers["idempotency-key"]);
    const p = await requestMerchantPayout(a.merchantId, { grossMinor: body.amountMinor, trigger: "manual", idempotencyKey: key, requestedBy: a.userId, requestedByLabel: a.name, who: actorWho(req) });
    return payoutView(p);
  },
);

function payoutStage(p: { status: string }) {
  switch (p.status) {
    case "succeeded":
      return { code: "received", label: "Received", tone: "ok" };
    case "submitted":
      return { code: "sent", label: "Sent", tone: "wait" };
    case "timed_out":
      return { code: "sent", label: "Sent, confirming with M-Pesa", tone: "wait" };
    case "failed":
      return { code: "failed", label: "Failed", tone: "bad" };
    case "pending_approval":
      return { code: "needs_approval", label: "Needs approval", tone: "wait" };
    case "queued":
      return { code: "queued", label: "Queued", tone: "wait" };
    case "held":
      return { code: "held", label: "Held for new number", tone: "wait" };
    case "rejected":
      return { code: "rejected", label: "Not approved", tone: "bad" };
    case "cancelled":
      return { code: "cancelled", label: "Cancelled", tone: "info" };
    default:
      return { code: "requested", label: "Requested", tone: "wait" };
  }
}

function payoutView(p: { id: string; ref: string; gross_minor: number; fee_minor: number; net_minor: number; msisdn: string; status: string; status_reason: string | null; trigger: string; failure_reason: string | null; mpesa_receipt: string | null; requested_at: Date; submitted_at: Date | null; completed_at: Date | null; hold_until: Date | null; approval_required_reason: string | null }) {
  return {
    id: p.id,
    ref: p.ref,
    amountMinor: p.gross_minor,
    feeMinor: p.fee_minor,
    receivedMinor: p.net_minor,
    destination: maskMsisdn(p.msisdn),
    trigger: p.trigger,
    stage: payoutStage(p),
    note: p.status === "failed" ? `${p.failure_reason ?? "It didn't go through."} The money is back in your balance.` : p.status === "pending_approval" ? `${p.approval_required_reason ?? "Our team approves large withdrawals"}. Usually within a few hours.` : p.status_reason,
    receipt: p.mpesa_receipt,
    requestedAt: p.requested_at,
    sentAt: p.submitted_at,
    completedAt: p.completed_at,
    heldUntil: p.hold_until,
    steps: [
      { step: "requested", done: true, at: p.requested_at },
      { step: "sent", done: Boolean(p.submitted_at), at: p.submitted_at },
      { step: p.status === "failed" ? "failed" : "received", done: ["succeeded", "failed"].includes(p.status), at: p.completed_at },
    ],
    cancellable: ["requested", "pending_approval", "held", "queued"].includes(p.status),
  };
}

r.route({ method: "get", path: "/payouts", summary: "Withdrawal history", auth: "owner", query: z.object({ cursor: zCursor, limit: zLimit }) }, async ({ req, query }) => {
  const c = decodeCursor(query.cursor);
  const rows = await many<Parameters<typeof payoutView>[0] & { requested_at: Date }>(
    db(),
    `select * from payouts where merchant_id = $1 ${c ? `and (requested_at, id) < ($2::timestamptz, $3::uuid)` : ""} order by requested_at desc, id desc limit ${query.limit + 1}`,
    c ? [me(req).merchantId, c.at, c.id] : [me(req).merchantId],
  );
  const pg = page(rows as never[], query.limit, "requested_at" as never, "id" as never);
  return { items: (pg.items as typeof rows).map(payoutView), nextCursor: pg.nextCursor };
});

r.route({ method: "get", path: "/payouts/:id", summary: "One withdrawal, for live status", auth: "owner" }, async ({ req, params }) => {
  const p = await one<Parameters<typeof payoutView>[0]>(db(), `select * from payouts where id = $1 and merchant_id = $2`, [params.id, me(req).merchantId]);
  if (!p) throw notFound("Withdrawal not found");
  return payoutView(p);
});

r.route({ method: "post", path: "/payouts/:id/cancel", summary: "Cancel a withdrawal that hasn't been sent", auth: "owner", body: z.object({ pin: zPin }) }, async ({ req, params, body }) => {
  const a = me(req);
  const p = await one(db(), `select 1 from payouts where id = $1 and merchant_id = $2`, [params.id, a.merchantId]);
  if (!p) throw notFound("Withdrawal not found");
  await requirePin(a.userId, body.pin);
  await rejectPayout(params.id, "Cancelled by the owner", actorWho(req), true);
  return { ok: true };
});

r.route({ method: "get", path: "/auto-withdraw", summary: "Automatic withdrawal settings", auth: "owner" }, async ({ req }) => {
  const m = await one<{ auto_withdraw_enabled: boolean; auto_withdraw_time: string | null; auto_withdraw_min_minor: number | null; auto_withdraw_last_run: unknown; auto_withdraw_last_date: string | null }>(
    db(),
    `select auto_withdraw_enabled, auto_withdraw_time, auto_withdraw_min_minor, auto_withdraw_last_run, to_char(auto_withdraw_last_date, 'YYYY-MM-DD') as auto_withdraw_last_date from merchants where id = $1`,
    [me(req).merchantId],
  );
  const limits = await payoutLimits(db(), me(req).merchantId);
  return { enabled: m!.auto_withdraw_enabled, time: m!.auto_withdraw_time ?? "22:00", minMinor: m!.auto_withdraw_min_minor ?? limits.minMinor, platformMinMinor: limits.minMinor, presets: ["20:00", "22:00", "00:00"], nextRunAt: nextAutoRun(m!), lastRun: m!.auto_withdraw_last_run, timeZone: "Africa/Nairobi" };
});

r.route(
  { method: "put", path: "/auto-withdraw", summary: "Change automatic withdrawal (PIN)", auth: "owner", body: z.object({ enabled: z.boolean(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Pick a time"), minMinor: z.number().int().positive(), pin: zPin }) },
  async ({ req, body }) => {
    assertCanAct(req);
    const a = me(req);
    await requirePin(a.userId, body.pin);
    const limits = await payoutLimits(db(), a.merchantId);
    if (body.minMinor < limits.minMinor) throw badRequest(`The minimum can't be below KSh ${limits.minMinor / 100}`);
    return db().tx(async (q) => {
      const before = await one<{ auto_withdraw_enabled: boolean; auto_withdraw_time: string | null; auto_withdraw_min_minor: number | null; payout_msisdn_verified_at: Date | null }>(q, `select auto_withdraw_enabled, auto_withdraw_time, auto_withdraw_min_minor, payout_msisdn_verified_at from merchants where id = $1 for update`, [a.merchantId]);
      if (body.enabled && !before!.payout_msisdn_verified_at) throw badRequest("Add and verify your payout number first", "no_number");
      await q.query(`update merchants set auto_withdraw_enabled = $2, auto_withdraw_time = $3, auto_withdraw_min_minor = $4 where id = $1`, [a.merchantId, body.enabled, body.time, body.minMinor]);
      await audit(q, actorWho(req), "auto_withdraw.update", { type: "merchant", id: a.merchantId }, before, { enabled: body.enabled, time: body.time, minMinor: body.minMinor });
      const m = await one<{ auto_withdraw_enabled: boolean; auto_withdraw_time: string | null; auto_withdraw_last_date: string | null }>(q, `select auto_withdraw_enabled, auto_withdraw_time, to_char(auto_withdraw_last_date, 'YYYY-MM-DD') as auto_withdraw_last_date from merchants where id = $1`, [a.merchantId]);
      return { enabled: body.enabled, time: body.time, minMinor: body.minMinor, nextRunAt: nextAutoRun(m!) };
    });
  },
);

r.route({ method: "get", path: "/payout-number", summary: "Payout number and any change in progress", auth: "owner" }, async ({ req }) => {
  const m = await one<{ payout_msisdn: string | null; payout_msisdn_verified_at: Date | null; payout_hold_until: Date | null }>(db(), `select payout_msisdn, payout_msisdn_verified_at, payout_hold_until from merchants where id = $1`, [me(req).merchantId]);
  const pending = await one<{ id: string; new_msisdn: string; old_msisdn: string | null; status: string; needs_old_otp: boolean; hold_until: Date | null; kind: string; created_at: Date }>(
    db(),
    `select id, new_msisdn, old_msisdn, status, needs_old_otp, hold_until, kind, created_at from payout_number_changes where merchant_id = $1 and status in ('otp_pending','cooling') order by created_at desc limit 1`,
    [me(req).merchantId],
  );
  return {
    verified: Boolean(m!.payout_msisdn_verified_at),
    masked: m!.payout_msisdn ? maskMsisdn(m!.payout_msisdn) : null,
    suggestedMasked: !m!.payout_msisdn_verified_at && m!.payout_msisdn ? maskMsisdn(m!.payout_msisdn) : null,
    holdUntil: m!.payout_hold_until && new Date(m!.payout_hold_until) > new Date() ? m!.payout_hold_until : null,
    change: pending ? { id: pending.id, kind: pending.kind, status: pending.status, newMasked: maskMsisdn(pending.new_msisdn), oldMasked: pending.old_msisdn ? maskMsisdn(pending.old_msisdn) : null, needsOldCode: pending.needs_old_otp, holdUntil: pending.hold_until } : null,
    coolingHours: (await getSetting("payout")).cooling_hours,
  };
});

r.route(
  { method: "post", path: "/payout-number", summary: "Add or change the payout number (PIN); sends codes", auth: "owner", body: z.object({ msisdn: z.string().min(9).max(16).optional(), useSuggested: z.boolean().optional(), oldNumberUnavailable: z.boolean().default(false), pin: zPin }) },
  async ({ req, body }) => {
    assertCanAct(req);
    const a = me(req);
    await requirePin(a.userId, body.pin);
    let msisdn = body.msisdn;
    if (!msisdn && body.useSuggested) msisdn = (await one<{ payout_msisdn: string | null }>(db(), `select payout_msisdn from merchants where id = $1 and payout_msisdn_verified_at is null`, [a.merchantId]))?.payout_msisdn ?? undefined;
    if (!msisdn) throw badRequest("Enter the M-Pesa number to pay out to");
    return startNumberChange(a.merchantId, a.userId, msisdn, body.oldNumberUnavailable);
  },
);

r.route(
  { method: "post", path: "/payout-number/verify", summary: "Confirm the codes for a payout-number change", auth: "owner", body: z.object({ changeId: z.string().uuid(), codeNew: z.string().regex(/^\d{6}$/), codeOld: z.string().regex(/^\d{6}$/).optional() }) },
  async ({ req, body }) => {
    assertCanAct(req);
    return verifyNumberChange(me(req).merchantId, me(req).userId, body.changeId, body.codeNew, body.codeOld);
  },
);

r.route({ method: "post", path: "/payout-number/resend", summary: "Send a code again", auth: "owner", body: z.object({ changeId: z.string().uuid(), which: z.enum(["new", "old"]) }) }, async ({ req, body }) => resendNumberCode(me(req).merchantId, body.changeId, body.which));

r.route({ method: "post", path: "/payout-number/:id/cancel", summary: "Cancel a change before it's confirmed", auth: "owner" }, async ({ req, params }) => {
  await db().query(`update payout_number_changes set status = 'cancelled' where id = $1 and merchant_id = $2 and status = 'otp_pending'`, [params.id, me(req).merchantId]);
  return { ok: true };
});

// ------------------------------------------------------------------ stats and statements

const zStats = z.object({ period: z.enum(["today", "7d", "month", "year", "all", "custom"]).default("7d"), from: zDate.optional(), to: zDate.optional(), table: z.string().regex(/^T\d{3,}$/).optional() });
r.route({ method: "get", path: "/stats", summary: "KPIs and chart series for a period", auth: "owner", query: zStats }, async ({ req, query }) => {
  if (query.table) await ownTable(db(), me(req).merchantId, query.table);
  return stats(db(), query.period, { merchantId: me(req).merchantId, tableId: query.table ?? null }, query.from, query.to);
});

r.route({ method: "get", path: "/stats/since-started", summary: "Lifetime cards per table, with milestones", auth: "owner" }, async ({ req }) => ({ tables: await sinceStarted(db(), { merchantId: me(req).merchantId }) }));

r.route({ method: "get", path: "/reports/statement", summary: "Monthly statement (CSV or PDF)", auth: "owner", raw: true, query: z.object({ month: z.string().regex(/^\d{4}-\d{2}$/), format: z.enum(["csv", "pdf"]).default("csv") }) }, async ({ req, res, query }) => {
  const s = await statementData(db(), me(req).merchantId, query.month);
  await audit(db(), actorWho(req), "statement.download", { type: "merchant", id: me(req).merchantId }, null, { month: query.month, format: query.format });
  if (query.format === "pdf") {
    res.type("application/pdf").attachment(`aura-statement-${query.month}.pdf`).send(await statementPdf(s));
  } else {
    res.type("text/csv").attachment(`aura-statement-${query.month}.csv`).send(statementCsv(s));
  }
});

// ------------------------------------------------------------------ notifications

r.route({ method: "get", path: "/notifications", summary: "In-app notifications", auth: "merchant", query: z.object({ cursor: zCursor, limit: zLimit }) }, async ({ req, query }) => {
  const c = decodeCursor(query.cursor);
  const rows = await many<{ id: string; type: string; title: string; body: string; critical: boolean; data: Record<string, unknown>; read_at: Date | null; created_at: Date }>(
    db(),
    `select id, type, title, body, critical, data, read_at, created_at from notifications where user_id = $1 ${c ? `and (created_at, id) < ($2::timestamptz, $3::uuid)` : ""} order by created_at desc, id desc limit ${query.limit + 1}`,
    c ? [me(req).userId, c.at, c.id] : [me(req).userId],
  );
  const pg = page(rows, query.limit, "created_at", "id");
  const unread = await one<{ n: number }>(db(), `select count(*)::int as n from notifications where user_id = $1 and read_at is null`, [me(req).userId]);
  return { items: pg.items, nextCursor: pg.nextCursor, unread: unread?.n ?? 0 };
});

r.route({ method: "get", path: "/notifications/unread", summary: "Unread count", auth: "merchant" }, async ({ req }) => {
  const unread = await one<{ n: number }>(db(), `select count(*)::int as n from notifications where user_id = $1 and read_at is null`, [me(req).userId]);
  return { unread: unread?.n ?? 0 };
});

r.route({ method: "post", path: "/notifications/read", summary: "Mark notifications read", auth: "merchant", body: z.object({ ids: z.array(z.string().uuid()).max(200).optional(), all: z.boolean().optional() }) }, async ({ req, body }) => {
  if (body.all) await db().query(`update notifications set read_at = now() where user_id = $1 and read_at is null`, [me(req).userId]);
  else if (body.ids?.length) await db().query(`update notifications set read_at = now() where user_id = $1 and id = any($2::uuid[]) and read_at is null`, [me(req).userId, body.ids]);
  return { ok: true };
});

// ------------------------------------------------------------------ staff

r.route({ method: "get", path: "/staff", summary: "Attendants", auth: "owner" }, async ({ req }) => {
  const rows = await many<{ id: string; name: string; phone: string; status: string; last_seen_at: Date | null; created_at: Date }>(db(), `select id, name, phone, status, last_seen_at, created_at from merchant_users where merchant_id = $1 and role = 'staff' order by created_at`, [me(req).merchantId]);
  return { staff: rows.map((s) => ({ id: s.id, name: s.name, phoneMasked: maskMsisdn(s.phone), status: s.status, lastSeenAt: s.last_seen_at, addedAt: s.created_at })) };
});

r.route({ method: "post", path: "/staff", summary: "Add an attendant (they get an SMS invite)", auth: "owner", body: z.object({ name: z.string().min(2).max(60), phone: z.string().min(9).max(16) }) }, async ({ req, body }) => {
  assertCanAct(req);
  return addStaff(me(req).merchantId, { id: me(req).userId, label: me(req).name }, body.name, body.phone);
});

r.route({ method: "post", path: "/staff/:id/revoke", summary: "Remove an attendant's access now", auth: "owner" }, async ({ req, params }) => {
  await revokeStaff(me(req).merchantId, { id: me(req).userId, label: me(req).name }, params.id);
  return { ok: true };
});

r.route({ method: "post", path: "/staff/:id/resend", summary: "Send an attendant's invite again", auth: "owner" }, async ({ req, params }) => {
  const s = await one<{ id: string; phone: string; status: string }>(db(), `select id, phone, status from merchant_users where id = $1 and merchant_id = $2 and role = 'staff'`, [params.id, me(req).merchantId]);
  if (!s || s.status !== "invited") throw notFound("No pending invite for that attendant");
  const m = await one<{ business_name: string }>(db(), `select business_name from merchants where id = $1`, [me(req).merchantId]);
  const link = await db().tx((q) => createInvite(q, s.id, m!.business_name, s.phone));
  return { ok: true, inviteLink: env.otpEcho ? link : undefined };
});

r.route({ method: "get", path: "/staff/:id/activity", summary: "What an attendant has done", auth: "owner" }, async ({ req, params }) => {
  const s = await one(db(), `select 1 from merchant_users where id = $1 and merchant_id = $2 and role = 'staff'`, [params.id, me(req).merchantId]);
  if (!s) throw notFound("Staff member not found");
  const rows = await many<{ action: string; entity_type: string | null; entity_id: string | null; after: unknown; at: Date }>(db(), `select action, entity_type, entity_id, after, at from audit_log where actor_id = $1 order by at desc limit 200`, [params.id]);
  const unlocks = await many(db(), `select cmd_id, table_id, reason, status, issued_at, ack_at from unlock_commands where issued_by = $1 order by issued_at desc limit 100`, [params.id]);
  return { activity: rows, unlocks };
});

// ------------------------------------------------------------------ disputes and support

r.route({ method: "get", path: "/disputes", summary: "Reported problems and their replies", auth: "owner" }, async ({ req }) => ({
  disputes: await many(db(), `select d.id, d.ref, d.kind, d.subject, d.status, d.payment_id, d.table_id, d.created_at, d.updated_at, (select count(*)::int from dispute_messages m where m.dispute_id = d.id and not m.internal) as messages from disputes d where d.merchant_id = $1 order by d.updated_at desc`, [me(req).merchantId]),
}));

r.route(
  { method: "post", path: "/disputes", summary: "Report a problem with a payment or a table", auth: "merchant", body: z.object({ kind: z.enum(["payment", "table", "other"]), paymentId: z.string().uuid().optional(), tableId: z.string().regex(/^T\d{3,}$/).optional(), subject: z.string().min(3).max(120), message: z.string().min(3).max(2000) }) },
  async ({ req, body }) => {
    const a = me(req);
    if (body.paymentId && !(await one(db(), `select 1 from payments where id = $1 and merchant_id = $2`, [body.paymentId, a.merchantId]))) throw notFound("Payment not found");
    if (body.tableId) await ownTable(db(), a.merchantId, body.tableId);
    return db().tx(async (q) => {
      const ref = shortRef("DS-");
      const d = await one<{ id: string }>(q, `insert into disputes (ref, merchant_id, payment_id, table_id, kind, subject, opened_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [ref, a.merchantId, body.paymentId ?? null, body.tableId ?? null, body.kind, body.subject.trim(), a.userId]);
      await q.query(`insert into dispute_messages (dispute_id, author_type, author_id, author_label, body) values ($1,'merchant',$2,$3,$4)`, [d!.id, a.userId, a.name, body.message.trim()]);
      await audit(q, actorWho(req), "dispute.open", { type: "dispute", id: d!.id }, null, { ref, kind: body.kind, subject: body.subject });
      return { id: d!.id, ref };
    });
  },
);

r.route({ method: "get", path: "/disputes/:id", summary: "A reported problem with its messages", auth: "merchant" }, async ({ req, params }) => {
  const d = await one(db(), `select id, ref, kind, subject, status, payment_id, table_id, created_at, updated_at from disputes where id = $1 and merchant_id = $2`, [params.id, me(req).merchantId]);
  if (!d) throw notFound("Not found");
  const messages = await many(db(), `select id, author_type, author_label, body, created_at from dispute_messages where dispute_id = $1 and not internal order by created_at`, [params.id]);
  return { ...d, messages };
});

r.route({ method: "post", path: "/disputes/:id/messages", summary: "Reply on a reported problem", auth: "merchant", body: z.object({ body: z.string().min(1).max(2000) }) }, async ({ req, params, body }) => {
  const a = me(req);
  const d = await one<{ status: string }>(db(), `select status from disputes where id = $1 and merchant_id = $2`, [params.id, a.merchantId]);
  if (!d) throw notFound("Not found");
  await db().query(`insert into dispute_messages (dispute_id, author_type, author_id, author_label, body) values ($1,'merchant',$2,$3,$4)`, [params.id, a.userId, a.name, body.body.trim()]);
  await db().query(`update disputes set updated_at = now(), status = case when status in ('waiting_merchant','resolved') then 'open' else status end where id = $1`, [params.id]);
  return { ok: true };
});
