import type { Request } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { db, many, one, type Q } from "../config/db.js";
import { provisionDevice, revokeDevice } from "../devices/devices.js";
import { Api, type AdminActor } from "../lib/api.js";
import { decrypt, verifyPassword, verifyTotp } from "../lib/crypto.js";
import { badRequest, conflict, notFound } from "../lib/http.js";
import { formatKsh, maskMsisdn, nairobiDate, nairobiInstant, normaliseMsisdn, tableId, addDays } from "../lib/kenya.js";
import { permissionsFor } from "../lib/permissions.js";
import { requestApproval } from "../services/approvals.js";
import { activity, audit, who } from "../services/audit.js";
import { floatPanel } from "../services/float.js";
import { merchantAvailable } from "../services/ledger.js";
import { createInvite, createMerchant } from "../services/merchants.js";
import { boundsFor, commissionFor, payoutLimits } from "../services/pricing.js";
import { listSessions, revokeAll } from "../services/sessions.js";
import { getSetting } from "../services/settings.js";
import { tableSheet } from "../services/sheet.js";
import { commandStatus, requestManualUnlock } from "../services/unlocks.js";
import { queueDepth } from "../services/jobs.js";

// /v1/a — Admin API, part 1: the admin's own session, the command dashboard, merchants,
// tables and devices. Every route names its permission; the API enforces it.

export const adminCoreApi = new Api("/v1/a", "Admin");
const r = adminCoreApi;
export const adm = (req: Request) => req.actor as AdminActor;
export const adminWho = (req: Request) => ({ ...who(req.actor, req.ip, String(req.headers["user-agent"] ?? "")), id: adm(req).id, label: `${adm(req).name} (${adm(req).role})` });
export const zPage = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(500).default(50) });
export const zReason = z.string().trim().min(3, "Give a reason").max(500);

// ------------------------------------------------------------------ me

r.route({ method: "get", path: "/me", summary: "The signed-in admin and their permissions", auth: "admin" }, async ({ req }) => {
  const a = adm(req);
  const row = await one<{ recovery_codes: string[]; phone: string | null; last_login_at: Date | null; ip_allowlist: string[] }>(db(), `select recovery_codes, phone, last_login_at, ip_allowlist from admin_users where id = $1`, [a.id]);
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    role: a.role,
    phone: row?.phone ? maskMsisdn(row.phone) : null,
    permissions: permissionsFor(a.role),
    recoveryCodesLeft: row?.recovery_codes.length ?? 0,
    reauthValidUntil: a.reauthAt ? new Date(a.reauthAt.getTime() + 10 * 60_000).toISOString() : null,
    environment: { provider: env.provider, darajaEnv: env.daraja.env, sandbox: env.provider === "simulated" || env.daraja.env === "sandbox", paybill: env.paybillNumber, merchantUrl: env.merchantUrl, otpOnScreen: env.otpEcho, virtualDevices: env.device.virtualDevices },
    singleOperator: await getSetting("single_operator"),
  };
});

r.route({ method: "post", path: "/me/reauth", summary: "Confirm it's you before a sensitive screen", auth: "admin", body: z.object({ code: z.string().regex(/^\d{6}$/).optional(), password: z.string().max(200).optional() }) }, async ({ req, body }) => {
  const a = adm(req);
  const row = await one<{ totp_secret_enc: string; password_hash: string; last_totp_step: number | null }>(db(), `select totp_secret_enc, password_hash, last_totp_step from admin_users where id = $1`, [a.id]);
  let ok = false;
  if (body.code) {
    const step = verifyTotp(decrypt(row!.totp_secret_enc), body.code);
    ok = step != null && (row!.last_totp_step == null || step > Number(row!.last_totp_step));
    if (ok) await db().query(`update admin_users set last_totp_step = $2 where id = $1`, [a.id, step]);
  } else if (body.password) ok = await verifyPassword(body.password, row!.password_hash);
  if (!ok) {
    await audit(db(), adminWho(req), "admin.reauth_failed", { type: "admin_user", id: a.id });
    throw badRequest("That isn't right", "reauth_wrong");
  }
  await db().query(`update sessions set reauth_at = now() where id = $1`, [a.sessionId]);
  await audit(db(), adminWho(req), "admin.reauth", { type: "admin_user", id: a.id });
  return { validUntil: new Date(Date.now() + 10 * 60_000).toISOString() };
});

r.route({ method: "get", path: "/me/sessions", summary: "Your active sessions", auth: "admin" }, async ({ req }) => ({ sessions: await listSessions(db(), "admin", adm(req).id, adm(req).sessionId) }));
r.route({ method: "delete", path: "/me/sessions/:id", summary: "Sign out one of your sessions", auth: "admin" }, async ({ req, params }) => {
  await db().query(`update sessions set revoked_at = now(), revoked_reason = 'signed out remotely' where id = $1 and user_id = $2 and kind = 'admin'`, [params.id, adm(req).id]);
  await audit(db(), adminWho(req), "admin.session_revoke", { type: "session", id: params.id });
  return { ok: true };
});

// ------------------------------------------------------------------ dashboard

async function figures(q: Q, from: Date, to: Date) {
  const r = await one<{ games: number; gross: number; revenue: number; merchants: number; payments: number }>(
    q,
    `select (select count(*)::int from game_credits where status = 'acked' and acked_at >= $1 and acked_at < $2) as games,
            (select coalesce(sum(amount_minor), 0) from payments where credited_at >= $1 and credited_at < $2) as gross,
            (select coalesce(sum(commission_minor), 0) from payments where credited_at >= $1 and credited_at < $2) as revenue,
            (select coalesce(sum(merchant_share_minor), 0) from payments where credited_at >= $1 and credited_at < $2) as merchants,
            (select count(*)::int from payments where received_at >= $1 and received_at < $2) as payments`,
    [from, to],
  );
  return { games: r!.games, grossMinor: r!.gross, platformRevenueMinor: r!.revenue, merchantEarningsMinor: r!.merchants, payments: r!.payments };
}

export async function exceptionCounts(q: Q) {
  return (await one<Record<string, number>>(
    q,
    `select (select count(*)::int from payments where status = 'unmatched' and resolution is null) as unmatched,
            (select count(*)::int from payments where status = 'unmatched') as in_suspense,
            (select count(*)::int from partial_credits where status = 'review' and kind = 'underpaid') as underpaid,
            (select count(*)::int from partial_credits where status = 'review' and kind = 'remainder') as overpaid,
            (select count(*)::int from partial_credits where status = 'open') as held,
            (select count(distinct payment_id)::int from game_credits where status in ('expired','failed')) as unlock_failed,
            (select count(*)::int from payments where status = 'rejected' and verification_status = 'mismatch') as verification_failed,
            (select count(*)::int from refunds where status = 'pending') as refund_pending`,
  ))!;
}

r.route({ method: "get", path: "/dashboard", summary: "Command dashboard", auth: "admin", perm: "dashboard.view" }, async () => {
  const q = db();
  const today = nairobiDate();
  const t0 = nairobiInstant(today);
  const t1 = nairobiInstant(addDays(today, 1));
  const y0 = nairobiInstant(addDays(today, -1));
  const m0 = nairobiInstant(`${today.slice(0, 8)}01`);
  const daysIn = Math.round((t1.getTime() - m0.getTime()) / 86_400_000);
  const pm0 = nairobiInstant(`${addDays(`${today.slice(0, 8)}01`, -1).slice(0, 8)}01`);
  const pm1 = new Date(pm0.getTime() + daysIn * 86_400_000);
  const fleet = await many<{ id: string; name: string; location: string | null; status: string; merchant: string; online: boolean | null; has_device: boolean; last_seen_at: Date | null; last_game_at: Date | null; games_today: number }>(
    q,
    `select t.id, t.name, t.location, t.status, m.business_name as merchant, d.online, d.id is not null as has_device, d.last_seen_at,
            (select max(acked_at) from game_credits g where g.table_id = t.id and g.status = 'acked') as last_game_at,
            (select count(*)::int from game_credits g where g.table_id = t.id and g.status = 'acked' and g.acked_at >= $1) as games_today
       from pool_tables t join merchants m on m.id = t.merchant_id left join devices d on d.table_id = t.id and d.status = 'provisioned'
      order by t.id`,
    [t0],
  );
  const state = (f: (typeof fleet)[number]) => (f.status === "maintenance" ? "maintenance" : f.status === "disabled" ? "disabled" : f.has_device && f.online ? "online" : "offline");
  const fl = await floatPanel(q);
  const owed = await one<{ s: number }>(q, `select -coalesce(sum(balance_minor), 0) as s from ledger_accounts where code like 'merchant_payable:%'`);
  const pending = await one<{ n: number; s: number }>(q, `select count(*)::int as n, coalesce(sum(gross_minor), 0) as s from payouts where status = 'pending_approval'`);
  const recon = await one<{ status: string; finished_at: Date | null; acknowledged_at: Date | null }>(q, `select status, finished_at, acknowledged_at from reconciliation_runs where status <> 'running' order by started_at desc limit 1`);
  const alertCounts = await many<{ severity: string; n: number }>(q, `select severity, count(*)::int as n from alerts where status <> 'resolved' group by 1`);
  const openAlerts = await many(q, `select id, type, severity, title, status, created_at, last_seen_at, occurrences, entity_type, entity_id from alerts where status <> 'resolved' order by case severity when 'critical' then 0 when 'warning' then 1 else 2 end, last_seen_at desc limit 12`);
  // The last 14 days by Nairobi day (same definitions as `figures`), and today by hour, for the charts.
  const d0 = addDays(today, -13);
  const dayMoney = await many<{ d: string; gross: number; revenue: number }>(
    q,
    `select to_char(credited_at at time zone 'Africa/Nairobi', 'YYYY-MM-DD') as d, coalesce(sum(amount_minor), 0) as gross, coalesce(sum(commission_minor), 0) as revenue
       from payments where credited_at >= $1 and credited_at < $2 group by 1`,
    [nairobiInstant(d0), t1],
  );
  const dayGames = await many<{ d: string; n: number }>(
    q,
    `select to_char(acked_at at time zone 'Africa/Nairobi', 'YYYY-MM-DD') as d, count(*)::int as n from game_credits where status = 'acked' and acked_at >= $1 and acked_at < $2 group by 1`,
    [nairobiInstant(d0), t1],
  );
  const trend: { date: string; grossMinor: number; platformRevenueMinor: number; games: number }[] = [];
  for (let d = d0; d <= today; d = addDays(d, 1)) {
    const m = dayMoney.find((x) => x.d === d);
    trend.push({ date: d, grossMinor: m?.gross ?? 0, platformRevenueMinor: m?.revenue ?? 0, games: dayGames.find((x) => x.d === d)?.n ?? 0 });
  }
  const hours = await many<{ h: number; n: number }>(q, `select extract(hour from acked_at at time zone 'Africa/Nairobi')::int as h, count(*)::int as n from game_credits where status = 'acked' and acked_at >= $1 and acked_at < $2 group by 1`, [t0, t1]);
  const topMerchants = await many<{ id: string; code: string; name: string; gross: number; games: number }>(
    q,
    `select m.id, m.code, m.business_name as name, coalesce(sum(p.amount_minor), 0) as gross,
            (select count(*)::int from game_credits g where g.merchant_id = m.id and g.status = 'acked' and g.acked_at >= $1 and g.acked_at < $2) as games
       from payments p join merchants m on m.id = p.merchant_id
      where p.credited_at >= $1 and p.credited_at < $2
      group by m.id order by gross desc limit 5`,
    [m0, t1],
  );
  const disputes = await one<{ n: number }>(q, `select count(*)::int as n from disputes where status in ('open','in_progress','waiting_merchant')`);
  return {
    today: { ...(await figures(q, t0, t1)), previous: await figures(q, y0, t0) },
    month: { ...(await figures(q, m0, t1)), previous: await figures(q, pm0, pm1) },
    allTime: await figures(q, new Date(0), t1),
    attention: await exceptionCounts(q),
    fleet: {
      total: fleet.length,
      online: fleet.filter((f) => state(f) === "online").length,
      offline: fleet.filter((f) => state(f) === "offline").length,
      maintenance: fleet.filter((f) => state(f) === "maintenance").length,
      disabled: fleet.filter((f) => state(f) === "disabled").length,
      tables: fleet.map((f) => ({ id: f.id, name: f.name, location: f.location, merchant: f.merchant, state: state(f), lastSeenAt: f.last_seen_at, lastGameAt: f.last_game_at, gamesToday: f.games_today })),
    },
    money: {
      utilityMinor: fl.utilityMinor,
      workingMinor: fl.workingMinor,
      balancesAt: fl.takenAt,
      owedToMerchantsMinor: owed?.s ?? 0,
      pendingApproval: { count: pending?.n ?? 0, amountMinor: pending?.s ?? 0 },
      float: { status: fl.status, requiredMinor: fl.requiredMinor, minimumMinor: fl.minimumMinor, suggestedTransferMinor: fl.suggestedTransferMinor },
      reconciliation: recon ? { status: recon.status, at: recon.finished_at, acknowledged: Boolean(recon.acknowledged_at) } : null,
      killSwitch: await getSetting("kill_switch"),
      autoPayoutsPaused: await getSetting("auto_payouts_paused"),
    },
    alerts: { counts: Object.fromEntries(alertCounts.map((a) => [a.severity, a.n])), open: openAlerts },
    trend,
    byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, games: hours.find((x) => x.h === h)?.n ?? 0 })),
    topMerchants: topMerchants.map((m) => ({ id: m.id, code: m.code, name: m.name, grossMinor: m.gross, games: m.games })),
    disputesOpen: disputes?.n ?? 0,
    activity: await many(q, `select id, type, title, entity_type, entity_id, at from activity order by at desc limit 30`),
    queue: await queueDepth(q),
    updatedAt: new Date().toISOString(),
  };
});

// ------------------------------------------------------------------ merchants

const zMerchantFields = {
  businessName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(2).max(80),
  phone: z.string().min(9).max(16),
  email: z.string().email().nullable().optional(),
  location: z.string().max(160).nullable().optional(),
  payoutMsisdn: z.string().min(9).max(16).nullable().optional(),
  priceMinMinor: z.number().int().positive().nullable().optional(),
  priceMaxMinor: z.number().int().positive().nullable().optional(),
  unlockMinS: z.number().int().min(5).max(60).nullable().optional(),
  unlockMaxS: z.number().int().min(5).max(60).nullable().optional(),
  payoutMinMinor: z.number().int().positive().nullable().optional(),
  payoutDailyCapMinor: z.number().int().positive().nullable().optional(),
  payoutApprovalThresholdMinor: z.number().int().positive().nullable().optional(),
  manualUnlockDailyLimit: z.number().int().min(0).max(100).nullable().optional(),
};

r.route(
  {
    method: "get",
    path: "/merchants",
    summary: "Merchants: search, filter, sort",
    auth: "admin",
    perm: "merchants.view",
    query: zPage.extend({ q: z.string().max(80).optional(), status: z.enum(["invited", "active", "suspended", "closed"]).optional(), sort: z.enum(["created_at", "business_name", "balance", "last_payment"]).default("created_at"), dir: z.enum(["asc", "desc"]).default("desc") }),
  },
  async ({ query }) => {
    const where = ["true"];
    const params: unknown[] = [];
    if (query.q) {
      params.push(`%${query.q.replace(/[%_]/g, "")}%`);
      where.push(`(m.business_name ilike $${params.length} or m.code ilike $${params.length} or m.owner_name ilike $${params.length} or m.phone like $${params.length})`);
    }
    if (query.status) {
      params.push(query.status);
      where.push(`m.status = $${params.length}`);
    }
    const order = { created_at: "m.created_at", business_name: "m.business_name", balance: "available", last_payment: "last_payment_at" }[query.sort];
    const rows = await many(
      db(),
      `select m.id, m.code, m.business_name, m.owner_name, m.phone, m.status, m.flagged_for_review, m.payouts_suspended, m.created_at,
              -coalesce(a.balance_minor, 0) as available,
              (select count(*)::int from pool_tables t where t.merchant_id = m.id) as tables,
              (select max(received_at) from payments p where p.merchant_id = m.id) as last_payment_at,
              count(*) over () as total
         from merchants m left join ledger_accounts a on a.code = 'merchant_payable:' || m.id
        where ${where.join(" and ")}
        order by ${order} ${query.dir} nulls last, m.id
        limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`,
      params,
    );
    return { items: rows.map((m) => ({ ...m, phone: maskMsisdn(String(m.phone)), total: undefined })), total: Number(rows[0]?.total ?? 0), page: query.page, pageSize: query.pageSize };
  },
);

r.route(
  { method: "post", path: "/merchants", summary: "Create a merchant and send the owner an SMS invite", auth: "admin", perm: "merchants.manage", body: z.object({ ...zMerchantFields, feePolicy: z.enum(["merchant", "platform"]).nullable().optional() }) },
  async ({ req, body }) => createMerchant(body, adm(req), adminWho(req)),
);

r.route({ method: "get", path: "/merchants/:id", summary: "Merchant detail", auth: "admin", perm: "merchants.view" }, async ({ params }) => {
  const q = db();
  const m = await one<Record<string, unknown> & { id: string; payout_msisdn: string | null; phone: string }>(q, `select * from merchants where id = $1`, [params.id]);
  if (!m) throw notFound("Merchant not found");
  const pending = await one<{ s: number }>(q, `select coalesce(sum(gross_minor), 0) as s from payouts where merchant_id = $1 and status in ('requested','pending_approval','held','queued','submitted','timed_out')`, [m.id]);
  const earned = await one<{ s: number }>(q, `select coalesce(sum(merchant_share_minor), 0) as s from payments where merchant_id = $1`, [m.id]);
  const paid = await one<{ s: number }>(q, `select coalesce(sum(gross_minor), 0) as s from payouts where merchant_id = $1 and status = 'succeeded'`, [m.id]);
  const change = await one(q, `select id, kind, status, new_msisdn, old_msisdn, hold_until, created_at from payout_number_changes where merchant_id = $1 and status in ('otp_pending','cooling') order by created_at desc limit 1`, [m.id]);
  return {
    merchant: { ...m, phone: maskMsisdn(m.phone), payout_msisdn: m.payout_msisdn ? maskMsisdn(m.payout_msisdn) : null },
    balance: { availableMinor: await merchantAvailable(q, m.id), pendingMinor: pending?.s ?? 0, totalEarnedMinor: earned?.s ?? 0, totalPaidOutMinor: paid?.s ?? 0 },
    limits: await payoutLimits(q, m.id),
    tables: await many(q, `select t.id, t.name, t.status, t.price_minor, t.unlock_seconds, d.online, d.last_seen_at from pool_tables t left join devices d on d.table_id = t.id and d.status = 'provisioned' where t.merchant_id = $1 order by t.id`, [m.id]),
    recentPayments: await many(q, `select id, provider_txn_id, table_id, amount_minor, status, received_at from payments where merchant_id = $1 order by received_at desc limit 10`, [m.id]),
    payouts: await many(q, `select id, ref, gross_minor, fee_minor, net_minor, status, trigger, requested_at, completed_at from payouts where merchant_id = $1 order by requested_at desc limit 10`, [m.id]),
    staff: (await many<{ id: string; name: string; role: string; phone: string; status: string; last_login_at: Date | null; last_seen_at: Date | null }>(q, `select id, name, role, phone, status, last_login_at, last_seen_at from merchant_users where merchant_id = $1 order by role, created_at`, [m.id])).map((u) => ({ ...u, phone: maskMsisdn(u.phone) })),
    notes: await many(q, `select id, author_label, body, created_at from merchant_notes where merchant_id = $1 order by created_at desc`, [m.id]),
    documents: await many(q, `select id, kind, filename, mime, size, created_at from merchant_documents where merchant_id = $1 order by created_at desc`, [m.id]),
    pendingNumberChange: change ? { ...change, new_msisdn: maskMsisdn(String(change.new_msisdn)), old_msisdn: change.old_msisdn ? maskMsisdn(String(change.old_msisdn)) : null } : null,
    activity: await many(
      q,
      `select id, actor_type, actor_label, action, entity_type, entity_id, after, at from audit_log
        where (entity_type = 'merchant' and entity_id = $1::text) or actor_id in (select id::text from merchant_users where merchant_id = $1::text::uuid)
           or (entity_type = 'table' and entity_id in (select id from pool_tables where merchant_id = $1::text::uuid))
        order by at desc limit 60`,
      [m.id],
    ),
  };
});

r.route(
  { method: "patch", path: "/merchants/:id", summary: "Edit merchant details and limits", auth: "admin", perm: "merchants.manage", body: z.object(zMerchantFields).partial().extend({ flaggedForReview: z.boolean().optional() }) },
  async ({ req, params, body }) => {
    return db().tx(async (q) => {
      const m = await one<Record<string, unknown> & { id: string; phone: string }>(q, `select * from merchants where id = $1 for update`, [params.id]);
      if (!m) throw notFound("Merchant not found");
      const map: Record<string, string> = {
        businessName: "business_name",
        ownerName: "owner_name",
        email: "email",
        location: "location",
        priceMinMinor: "price_min_minor",
        priceMaxMinor: "price_max_minor",
        unlockMinS: "unlock_min_s",
        unlockMaxS: "unlock_max_s",
        payoutMinMinor: "payout_min_minor",
        payoutDailyCapMinor: "payout_daily_cap_minor",
        payoutApprovalThresholdMinor: "payout_approval_threshold_minor",
        manualUnlockDailyLimit: "manual_unlock_daily_limit",
        flaggedForReview: "flagged_for_review",
      };
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const [k, col] of Object.entries(map)) {
        const v = (body as Record<string, unknown>)[k];
        if (v === undefined) continue;
        before[k] = m[col];
        after[k] = v;
        await q.query(`update merchants set ${col} = $2 where id = $1`, [m.id, v]);
      }
      if (body.phone) {
        const phone = normaliseMsisdn(body.phone);
        if (!phone) throw badRequest("Enter a valid phone number");
        if (phone !== m.phone) {
          if (await one(q, `select 1 from merchant_users where phone = $1`, [phone])) throw conflict("That number already has an account");
          await q.query(`update merchants set phone = $2 where id = $1`, [m.id, phone]);
          const owner = await one<{ id: string }>(q, `update merchant_users set phone = $2, token_version = token_version + 1 where merchant_id = $1 and role = 'owner' returning id`, [m.id, phone]);
          if (owner) await revokeAll(q, "merchant", owner.id, "owner phone changed by admin");
          before.phone = maskMsisdn(m.phone);
          after.phone = maskMsisdn(phone);
        }
      }
      if (body.payoutMsisdn !== undefined) throw badRequest("The payout number is set and verified by the owner. Use fast-track only for a change in progress.");
      await audit(q, adminWho(req), "merchant.update", { type: "merchant", id: m.id }, before, after);
      return { ok: true };
    });
  },
);

r.route({ method: "post", path: "/merchants/:id/suspend", summary: "Suspend: stops payouts, optionally blocks table payments", auth: "admin", perm: "merchants.manage", body: z.object({ reason: zReason, blockTablePayments: z.boolean().default(false) }) }, async ({ req, params, body }) => {
  await db().tx(async (q) => {
    const m = await one<{ status: string; business_name: string }>(q, `select status, business_name from merchants where id = $1 for update`, [params.id]);
    if (!m) throw notFound("Merchant not found");
    if (m.status === "closed") throw conflict("This merchant is closed");
    await q.query(`update merchants set status = 'suspended', status_reason = $2, block_table_payments = $3 where id = $1`, [params.id, body.reason, body.blockTablePayments]);
    await audit(q, adminWho(req), "merchant.suspend", { type: "merchant", id: params.id }, { status: m.status }, { status: "suspended", reason: body.reason, blockTablePayments: body.blockTablePayments });
    await activity(q, "merchant.suspended", `${m.business_name} suspended`, { type: "merchant", id: params.id });
  });
  return { ok: true };
});

r.route({ method: "post", path: "/merchants/:id/reactivate", summary: "Lift a suspension", auth: "admin", perm: "merchants.manage", body: z.object({ reason: zReason }) }, async ({ req, params, body }) => {
  await db().tx(async (q) => {
    const m = await one<{ status: string; owner_active: boolean }>(q, `select m.status, exists (select 1 from merchant_users u where u.merchant_id = m.id and u.role = 'owner' and u.status = 'active') as owner_active from merchants m where m.id = $1 for update`, [params.id]);
    if (!m) throw notFound("Merchant not found");
    if (m.status !== "suspended") throw conflict("Only a suspended merchant can be reactivated");
    const next = m.owner_active ? "active" : "invited";
    await q.query(`update merchants set status = $2, status_reason = null, block_table_payments = false where id = $1`, [params.id, next]);
    await audit(q, adminWho(req), "merchant.reactivate", { type: "merchant", id: params.id }, { status: "suspended" }, { status: next, reason: body.reason });
  });
  return { ok: true };
});

r.route({ method: "post", path: "/merchants/:id/close", summary: "Close a merchant (second approver; zero balance)", auth: "admin", perm: "merchants.manage", body: z.object({ reason: zReason }) }, async ({ req, params, body }) => {
  const m = await one<{ business_name: string; code: string }>(db(), `select business_name, code from merchants where id = $1`, [params.id]);
  if (!m) throw notFound("Merchant not found");
  const bal = await merchantAvailable(db(), params.id);
  if (bal !== 0) throw conflict(`${m.business_name} still has ${formatKsh(bal)} available. Pay it out or settle it first.`);
  const a = adm(req);
  return db().tx((q) => requestApproval(q, { action: "merchant.close", payload: { merchantId: params.id, reason: body.reason }, summary: `Close ${m.business_name} (${m.code})`, reason: body.reason, entity: { type: "merchant", id: params.id } }, { id: a.id, label: a.name }, adminWho(req)));
});

r.route({ method: "post", path: "/merchants/:id/resend-invite", summary: "Send the owner's invite again", auth: "admin", perm: "merchants.manage" }, async ({ req, params }) => {
  const u = await one<{ id: string; phone: string; status: string; business_name: string }>(db(), `select u.id, u.phone, u.status, m.business_name from merchant_users u join merchants m on m.id = u.merchant_id where u.merchant_id = $1 and u.role = 'owner'`, [params.id]);
  if (!u) throw notFound("Owner not found");
  if (u.status !== "invited") throw conflict("The owner has already joined");
  const link = await db().tx((q) => createInvite(q, u.id, u.business_name, u.phone));
  await audit(db(), adminWho(req), "merchant.resend_invite", { type: "merchant", id: params.id });
  return { ok: true, inviteLink: env.otpEcho ? link : undefined };
});

r.route({ method: "post", path: "/merchants/:id/notes", summary: "Add an internal note", auth: "admin", perm: "merchants.notes", body: z.object({ body: z.string().trim().min(1).max(4000) }) }, async ({ req, params, body }) => {
  const n = await one(db(), `insert into merchant_notes (merchant_id, author_id, author_label, body) values ($1,$2,$3,$4) returning id, created_at`, [params.id, adm(req).id, adm(req).name, body.body]);
  await audit(db(), adminWho(req), "merchant.note", { type: "merchant", id: params.id });
  return n;
});

r.route(
  { method: "post", path: "/merchants/:id/documents", summary: "Upload an ID or agreement (base64, up to 5 MB)", auth: "admin", perm: "merchants.documents", body: z.object({ kind: z.enum(["id", "agreement", "other"]), filename: z.string().min(1).max(160), mime: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp"]), dataBase64: z.string().max(7_000_000) }) },
  async ({ req, params, body }) => {
    const bytes = Buffer.from(body.dataBase64, "base64");
    if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw badRequest("Files must be under 5 MB");
    const d = await one(db(), `insert into merchant_documents (merchant_id, kind, filename, mime, bytes, size, uploaded_by) values ($1,$2,$3,$4,$5,$6,$7) returning id, kind, filename, size, created_at`, [params.id, body.kind, body.filename, body.mime, bytes, bytes.length, adm(req).id]);
    await audit(db(), adminWho(req), "merchant.document_upload", { type: "merchant", id: params.id }, null, { kind: body.kind, filename: body.filename, size: bytes.length });
    return d;
  },
);

r.route({ method: "get", path: "/merchants/:id/documents/:docId", summary: "Download a document", auth: "admin", perm: "merchants.documents", raw: true }, async ({ req, res, params }) => {
  const d = await one<{ filename: string; mime: string; bytes: Buffer | Uint8Array }>(db(), `select filename, mime, bytes from merchant_documents where id = $1 and merchant_id = $2`, [params.docId, params.id]);
  if (!d) throw notFound("Document not found");
  await audit(db(), adminWho(req), "merchant.document_download", { type: "merchant", id: params.id }, null, { document: params.docId });
  res.type(d.mime).attachment(d.filename).send(Buffer.from(d.bytes));
});

r.route({ method: "post", path: "/merchants/:id/payout-number/fast-track", summary: "End a number change's cooling-off early (second approver)", auth: "admin", perm: "merchants.manage", body: z.object({ reason: zReason }) }, async ({ req, params, body }) => {
  const c = await one(db(), `select 1 from payout_number_changes where merchant_id = $1 and status = 'cooling'`, [params.id]);
  if (!c) throw conflict("There's no number change in its cooling-off period");
  const m = await one<{ business_name: string }>(db(), `select business_name from merchants where id = $1`, [params.id]);
  const a = adm(req);
  return db().tx((q) => requestApproval(q, { action: "payout_number.fast_track", payload: { merchantId: params.id }, summary: `Fast-track the payout number change for ${m!.business_name}`, reason: body.reason, entity: { type: "merchant", id: params.id } }, { id: a.id, label: a.name }, adminWho(req)));
});

r.route({ method: "post", path: "/merchants/:id/fee-policy", summary: "Override who bears the B2C fee for one merchant (second approver)", auth: "admin", perm: "pricing.manage", body: z.object({ b2c: z.enum(["merchant", "platform"]).nullable(), reason: zReason }) }, async ({ req, params, body }) => {
  const m = await one<{ business_name: string }>(db(), `select business_name from merchants where id = $1`, [params.id]);
  if (!m) throw notFound("Merchant not found");
  const a = adm(req);
  return db().tx((q) => requestApproval(q, { action: "pricing.fee_policy", payload: { merchantId: params.id, b2c: body.b2c }, summary: `B2C fee for ${m.business_name}: ${body.b2c ?? "platform default"}`, reason: body.reason, entity: { type: "merchant", id: params.id } }, { id: a.id, label: a.name }, adminWho(req)));
});

// ------------------------------------------------------------------ tables and devices

r.route(
  { method: "get", path: "/tables", summary: "Tables and devices", auth: "admin", perm: "tables.view", query: zPage.extend({ merchant: z.string().uuid().optional(), status: z.enum(["active", "disabled", "maintenance"]).optional(), q: z.string().max(60).optional() }) },
  async ({ query }) => {
    const where = ["true"];
    const params: unknown[] = [];
    if (query.merchant) params.push(query.merchant), where.push(`t.merchant_id = $${params.length}`);
    if (query.status) params.push(query.status), where.push(`t.status = $${params.length}`);
    if (query.q) params.push(`%${query.q.replace(/[%_]/g, "")}%`), where.push(`(t.id ilike $${params.length} or t.name ilike $${params.length} or t.location ilike $${params.length})`);
    const rows = await many(
      db(),
      `select t.id, t.name, t.location, t.status, t.price_minor, t.unlock_seconds, t.started_at, m.id as merchant_id, m.business_name as merchant,
              d.id as device_id, d.status as device_status, d.online, d.last_seen_at, d.rssi, d.firmware_version, d.virtual,
              (select max(acked_at) from game_credits g where g.table_id = t.id and g.status = 'acked') as last_game_at,
              (select count(*)::int from game_credits g where g.table_id = t.id and g.status in ('pending','dispatched')) as waiting,
              count(*) over () as total
         from pool_tables t join merchants m on m.id = t.merchant_id left join devices d on d.table_id = t.id and d.status in ('provisioned','revoked')
        where ${where.join(" and ")} order by t.seq limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`,
      params,
    );
    return { items: rows.map((x) => ({ ...x, total: undefined })), total: Number(rows[0]?.total ?? 0), page: query.page, pageSize: query.pageSize };
  },
);

const zTableFields = {
  name: z.string().trim().min(2).max(60),
  location: z.string().max(160).nullable().optional(),
  priceMinor: z.number().int().positive().optional(),
  unlockSeconds: z.number().int().min(5).max(60).optional(),
  status: z.enum(["active", "disabled", "maintenance"]).default("active"),
  openingHours: z.any().optional(),
  priceMinMinor: z.number().int().positive().nullable().optional(),
  priceMaxMinor: z.number().int().positive().nullable().optional(),
  unlockMinS: z.number().int().min(5).max(60).nullable().optional(),
  unlockMaxS: z.number().int().min(5).max(60).nullable().optional(),
};

r.route({ method: "post", path: "/tables", summary: "Create a table; the next ID (T001, T002…) is assigned", auth: "admin", perm: "tables.manage", body: z.object({ merchantId: z.string().uuid(), ...zTableFields }) }, async ({ req, body }) => {
  return db().tx(async (q) => {
    const m = await one<{ status: string }>(q, `select status from merchants where id = $1`, [body.merchantId]);
    if (!m) throw badRequest("Pick a merchant");
    if (m.status === "closed") throw conflict("That merchant is closed");
    await q.query(`select pg_advisory_xact_lock(40210011)`);
    const seq = (await one<{ n: number }>(q, `select coalesce(max(seq), 0) + 1 as n from pool_tables`))!.n;
    const d = await getSetting("defaults", q);
    const id = tableId(seq);
    await q.query(
      `insert into pool_tables (id, seq, merchant_id, name, location, status, price_minor, unlock_seconds, opening_hours, price_min_minor, price_max_minor, unlock_min_s, unlock_max_s)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, seq, body.merchantId, body.name, body.location ?? null, body.status, body.priceMinor ?? d.price_minor, body.unlockSeconds ?? d.unlock_seconds, body.openingHours ? JSON.stringify(body.openingHours) : null, body.priceMinMinor ?? null, body.priceMaxMinor ?? null, body.unlockMinS ?? null, body.unlockMaxS ?? null],
    );
    await audit(q, adminWho(req), "table.create", { type: "table", id }, null, body);
    await activity(q, "table.new", `Table ${id} ${body.name} created`, { type: "table", id });
    return { id };
  });
});

r.route({ method: "get", path: "/tables/:id", summary: "Table and device detail", auth: "admin", perm: "tables.view" }, async ({ params }) => {
  const q = db();
  const t = await one<Record<string, unknown> & { id: string; merchant_id: string }>(q, `select t.*, m.business_name as merchant from pool_tables t join merchants m on m.id = t.merchant_id where t.id = $1`, [params.id]);
  if (!t) throw notFound("Table not found");
  const device = await one(q, `select id, status, virtual, firmware_version, last_seen_at, rssi, relay_state, uptime_s, ip, online, online_changed_at, provisioned_at, credential_version from devices where table_id = $1`, [t.id]);
  return {
    table: t,
    pricing: { bounds: await boundsFor(q, t as never, t.merchant_id), commission: await commissionFor(q, t.id, t.merchant_id) },
    device,
    commands: await many(q, `select cmd_id, source, reason, issued_by_label, status, attempts, issued_at, sent_at, ack_at, ack_result, ack_reason, duration_s from unlock_commands where table_id = $1 order by issued_at desc limit 30`, [t.id]),
    events: await many(q, `select id, type, payload, device_ts, at from device_events where table_id = $1 order by at desc limit 60`, [t.id]),
    waiting: await many(q, `select g.id, g.status, g.created_at, g.expires_at, p.provider_txn_id from game_credits g join payments p on p.id = g.payment_id where g.table_id = $1 and g.status in ('pending','dispatched') order by g.created_at`, [t.id]),
    recentPayments: await many(q, `select id, provider_txn_id, amount_minor, status, received_at, games_credited from payments where table_id = $1 order by received_at desc limit 15`, [t.id]),
    paymentInstructions: { paybill: env.paybillNumber, account: t.id, payPageUrl: `${env.publicUrl}/t/${t.id}` },
  };
});

r.route({ method: "patch", path: "/tables/:id", summary: "Edit a table (name, location, price, bounds, hours, started date)", auth: "admin", perm: "tables.manage", body: z.object({ ...zTableFields, startedAt: z.string().datetime().nullable().optional() }).omit({ status: true }).partial() }, async ({ req, params, body }) => {
  return db().tx(async (q) => {
    const t = await one<Record<string, unknown>>(q, `select * from pool_tables where id = $1 for update`, [params.id]);
    if (!t) throw notFound("Table not found");
    const map: Record<string, string> = { name: "name", location: "location", priceMinor: "price_minor", unlockSeconds: "unlock_seconds", priceMinMinor: "price_min_minor", priceMaxMinor: "price_max_minor", unlockMinS: "unlock_min_s", unlockMaxS: "unlock_max_s", startedAt: "started_at" };
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const [k, col] of Object.entries(map)) {
      const v = (body as Record<string, unknown>)[k];
      if (v === undefined) continue;
      before[k] = t[col];
      after[k] = v;
      await q.query(`update pool_tables set ${col} = $2 where id = $1`, [params.id, v]);
    }
    if (body.openingHours !== undefined) {
      before.openingHours = t.opening_hours;
      after.openingHours = body.openingHours;
      await q.query(`update pool_tables set opening_hours = $2 where id = $1`, [params.id, body.openingHours ? JSON.stringify(body.openingHours) : null]);
    }
    await audit(q, adminWho(req), "table.update", { type: "table", id: params.id }, before, after);
    return { ok: true };
  });
});

r.route(
  { method: "post", path: "/tables/:id/status", summary: "Enable, disable or set maintenance (warns about waiting games)", auth: "admin", perm: "tables.manage", body: z.object({ status: z.enum(["active", "disabled", "maintenance"]), reason: zReason, confirm: z.boolean().default(false) }) },
  async ({ req, params, body }) => {
    return db().tx(async (q) => {
      const t = await one<{ status: string }>(q, `select status from pool_tables where id = $1 for update`, [params.id]);
      if (!t) throw notFound("Table not found");
      const waiting = await one<{ n: number }>(q, `select count(*)::int as n from game_credits where table_id = $1 and status in ('pending','dispatched')`, [params.id]);
      if (body.status !== "active" && (waiting?.n ?? 0) > 0 && !body.confirm) {
        throw conflict(`${waiting!.n} paid game${waiting!.n > 1 ? "s are" : " is"} waiting on this table. Disabling it means they will expire and need refunds.`, "pending_games", { waiting: waiting!.n });
      }
      await q.query(`update pool_tables set status = $2, status_reason = $3 where id = $1`, [params.id, body.status, body.status === "active" ? null : body.reason]);
      await audit(q, adminWho(req), "table.status", { type: "table", id: params.id }, { status: t.status }, { status: body.status, reason: body.reason });
      return { status: body.status };
    });
  },
);

r.route({ method: "post", path: "/tables/:id/move", summary: "Move a table to another merchant", auth: "admin", perm: "tables.manage", body: z.object({ merchantId: z.string().uuid(), reason: zReason }) }, async ({ req, params, body }) => {
  return db().tx(async (q) => {
    const t = await one<{ merchant_id: string }>(q, `select merchant_id from pool_tables where id = $1 for update`, [params.id]);
    if (!t) throw notFound("Table not found");
    if (t.merchant_id === body.merchantId) throw badRequest("It already belongs to that merchant");
    const waiting = await one<{ n: number }>(q, `select count(*)::int as n from game_credits where table_id = $1 and status in ('pending','dispatched')`, [params.id]);
    if ((waiting?.n ?? 0) > 0) throw conflict("Paid games are still waiting on this table. Move it once they're played or resolved.");
    const to = await one<{ status: string }>(q, `select status from merchants where id = $1`, [body.merchantId]);
    if (!to || to.status === "closed") throw badRequest("Pick an open merchant");
    await q.query(`update pool_tables set merchant_id = $2 where id = $1`, [params.id, body.merchantId]);
    await audit(q, adminWho(req), "table.move", { type: "table", id: params.id }, { merchantId: t.merchant_id }, { merchantId: body.merchantId, reason: body.reason });
    return { ok: true };
  });
});

r.route({ method: "post", path: "/tables/:id/provision", summary: "Issue device credentials (shown once)", auth: "admin", perm: "tables.manage", reauth: true, body: z.object({ virtual: z.boolean().default(false), replace: z.boolean().default(false) }) }, async ({ req, params, body }) => {
  const out = await db().tx((q) => provisionDevice(q, params.id, { virtual: body.virtual, replace: body.replace }, adminWho(req)));
  await restartVirtual();
  return out;
});

r.route({ method: "post", path: "/devices/:id/revoke", summary: "Revoke a device's credentials", auth: "admin", perm: "tables.manage", body: z.object({ reason: zReason }) }, async ({ req, params }) => {
  await db().tx((q) => revokeDevice(q, params.id, adminWho(req)));
  disconnectDevice(params.id);
  return { ok: true };
});

r.route({ method: "post", path: "/tables/:id/test-unlock", summary: "Send a test unlock (reason required)", auth: "admin", perm: "tables.test_unlock", body: z.object({ reason: zReason }) }, async ({ req, params, body }) => {
  const a = adminWho(req);
  return { cmdId: await db().tx((q) => requestManualUnlock(q, params.id, "test", body.reason, a)) };
});

r.route({ method: "post", path: "/tables/:id/manual-unlock", summary: "Admin manual unlock (not counted as a paid game)", auth: "admin", perm: "tables.manual_unlock", body: z.object({ reason: zReason }) }, async ({ req, params, body }) => {
  const a = adminWho(req);
  return { cmdId: await db().tx((q) => requestManualUnlock(q, params.id, "manual_admin", body.reason, a)) };
});

r.route({ method: "get", path: "/tables/:id/commands/:cmdId", summary: "Live status of a command", auth: "admin", perm: "tables.view" }, async ({ params }) => {
  const c = await commandStatus(db(), params.cmdId);
  if (!c || c.table_id !== params.id) throw notFound("Command not found");
  return c;
});

r.route({ method: "get", path: "/tables/:id/sheet", summary: "Printable table sheet (QR, Paybill, account)", auth: "admin", perm: "tables.view", raw: true }, async ({ res, params }) => {
  const t = await one<{ id: string; name: string; price_minor: number; business_name: string }>(db(), `select t.id, t.name, t.price_minor, m.business_name from pool_tables t join merchants m on m.id = t.merchant_id where t.id = $1`, [params.id]);
  if (!t) throw notFound("Table not found");
  res.type("html").set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:").send(await tableSheet(t));
});

// The server wires these to the device transport and the virtual-device runner.
let restartVirtual: () => Promise<void> = async () => {};
let disconnectDevice: (id: string) => void = () => {};
export function wireDeviceHooks(h: { restartVirtual: () => Promise<void>; disconnect: (id: string) => void }) {
  restartVirtual = h.restartVirtual;
  disconnectDevice = h.disconnect;
}
