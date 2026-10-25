import { z } from "zod";
import { db, many, one } from "../config/db.js";
import { Api } from "../lib/api.js";
import { badRequest, conflict, notFound } from "../lib/http.js";
import { addDays, formatKsh, maskMsisdn, nairobiDate, nairobiInstant } from "../lib/kenya.js";
import { provider } from "../providers/index.js";
import { announceToTeam, raise } from "../services/alerts.js";
import { requestApproval } from "../services/approvals.js";
import { activity, audit } from "../services/audit.js";
import { executeTransfer, floatPanel, pollBalances } from "../services/float.js";
import { FIXED_ACCOUNTS, platformAvailable } from "../services/ledger.js";
import { assignUnmatched, clearVerification, keepInSuspense, markRefund, recordRefund, resolvePartial, retryCredit } from "../services/payments.js";
import { approvePayout, rejectPayout, requestPlatformPayout, retryPayout } from "../services/payouts.js";
import { acknowledgeRun, recentRuns, runReconciliation } from "../services/reconciliation.js";
import { dailyClose, dailyCloseCsv, runDailyClose, shillings, toCsv } from "../services/reports.js";
import { getSetting, setSetting } from "../services/settings.js";
import { stats, sinceStarted } from "../services/stats.js";
import { adm, adminWho, exceptionCounts, zPage, zReason } from "./admin-core.js";

// /v1/a — Admin API, part 2: payments and exceptions, refunds, ledger, reconciliation,
// transfers, payouts, float, the kill switch, platform payouts, pricing and reports.
// Admins never edit amounts: every resolution writes its own ledger entries.

export const adminMoneyApi = new Api("/v1/a", "Admin");
const r = adminMoneyApi;
const requester = (req: Parameters<typeof adm>[0]) => ({ id: adm(req).id, label: adm(req).name });

// ------------------------------------------------------------------ payments explorer

const zPaymentSearch = zPage.extend({
  q: z.string().max(40).optional(),
  status: z.enum(["received", "verifying", "matched", "unmatched", "underpaid", "credited", "refund_pending", "refunded", "rejected"]).optional(),
  table: z.string().max(10).optional(),
  merchant: z.string().uuid().optional(),
  account: z.string().max(40).optional(),
  phone: z.string().max(20).optional(),
  amountMinor: z.coerce.number().int().positive().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

function paymentWhere(f: z.infer<typeof zPaymentSearch>) {
  const where = ["true"];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (f.q) add(`p.provider_txn_id ilike ?`, `%${f.q.replace(/[%_]/g, "")}%`);
  if (f.status) add(`p.status = ?`, f.status);
  if (f.table) add(`p.table_id = ?`, f.table.toUpperCase());
  if (f.merchant) add(`p.merchant_id = ?`, f.merchant);
  if (f.account) add(`p.account_ref ilike ?`, `%${f.account.replace(/[%_]/g, "")}%`);
  if (f.phone) add(`p.payer_msisdn_masked like ?`, `%${f.phone.replace(/[%_]/g, "")}%`);
  if (f.amountMinor) add(`p.amount_minor = ?`, f.amountMinor);
  if (f.from) add(`p.received_at >= ?`, nairobiInstant(f.from));
  if (f.to) add(`p.received_at < ?`, nairobiInstant(addDays(f.to, 1)));
  return { where: where.join(" and "), params };
}

r.route({ method: "get", path: "/payments", summary: "Search payments", auth: "admin", perm: "payments.view", query: zPaymentSearch }, async ({ query }) => {
  const { where, params } = paymentWhere(query);
  const rows = await many(
    db(),
    `select p.id, p.provider_txn_id, p.channel, p.account_ref, p.table_id, m.business_name as merchant, p.amount_minor, p.payer_msisdn_masked, p.status, p.problem,
            p.verification_status, p.games_credited, p.received_at, count(*) over () as total
       from payments p left join merchants m on m.id = p.merchant_id
      where ${where} order by p.received_at desc limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`,
    params,
  );
  return { items: rows.map((x) => ({ ...x, total: undefined })), total: Number(rows[0]?.total ?? 0), page: query.page, pageSize: query.pageSize };
});

r.route({ method: "get", path: "/payments/export", summary: "CSV of the filtered payments", auth: "admin", perm: "payments.view", raw: true, query: zPaymentSearch.omit({ page: true, pageSize: true }) }, async ({ req, res, query }) => {
  const { where, params } = paymentWhere({ ...query, page: 1, pageSize: 1 });
  const rows = await many(db(), `select p.received_at, p.provider_txn_id, p.channel, p.account_ref, p.table_id, p.merchant_id, p.amount_minor, p.payer_msisdn_masked, p.status, p.problem, p.verification_status, p.games_credited, p.commission_minor, p.merchant_share_minor from payments p where ${where} order by p.received_at desc limit 100000`, params);
  await audit(db(), adminWho(req), "payments.export", null, null, { rows: rows.length, filter: query });
  res.type("text/csv").attachment(`aura-payments-${nairobiDate()}.csv`).send(toCsv(rows.map((x) => ({ ...x, amount_kes: shillings(Number(x.amount_minor)), commission_kes: shillings(Number(x.commission_minor)), merchant_share_kes: shillings(Number(x.merchant_share_minor)) }))));
});

r.route({ method: "get", path: "/payments/:id", summary: "Payment detail: timeline, raw callback, ledger, commands", auth: "admin", perm: "payments.view" }, async ({ params }) => {
  const q = db();
  const p = await one<Record<string, unknown> & { id: string; provider_txn_id: string; payer_msisdn_hash: string | null }>(q, `select p.*, m.business_name as merchant from payments p left join merchants m on m.id = p.merchant_id where p.id = $1`, [params.id]);
  if (!p) throw notFound("Payment not found");
  const credits = await many(q, `select id, status, attempts, created_at, dispatched_at, acked_at, expires_at, resolution from game_credits where payment_id = $1 order by created_at`, [p.id]);
  const commands = await many(q, `select u.cmd_id, u.status, u.attempts, u.issued_at, u.sent_at, u.ack_at, u.ack_result, u.ack_reason from unlock_commands u join game_credits g on g.id = u.game_credit_id where g.payment_id = $1 order by u.issued_at`, [p.id]);
  const ledger = await many(
    q,
    `select t.id as transaction_id, t.kind, t.memo, t.created_at, a.code as account, e.amount_minor
       from ledger_transactions t join ledger_entries e on e.transaction_id = t.id join ledger_accounts a on a.id = e.account_id
      where (t.ref_type = 'payment' and t.ref_id = $1) or (t.ref_type = 'ledger_transaction' and t.ref_id in (select id::text from ledger_transactions where ref_type = 'payment' and ref_id = $1))
      order by t.created_at, e.id`,
    [p.id],
  );
  const callbacks = await many(q, `select id, kind, received_at, processing_ms, ok, error from callback_log where payload ->> 'TransID' = $1 or payload -> 'Body' -> 'stkCallback' ->> 'CheckoutRequestID' = (select checkout_request_id from stk_requests where id = $2) order by received_at`, [p.provider_txn_id, p.stk_request_id ?? null]);
  const firstCmd = commands[0] as { sent_at?: Date } | undefined;
  const timeline = [
    { step: "Callback received", at: p.received_at },
    { step: `Verification: ${p.verification_status}`, at: p.verified_at },
    { step: `Matched${p.table_id ? ` to ${p.table_id}` : ""}`, at: p.matched_at },
    { step: "Credit created", at: p.credited_at },
    { step: "Unlock dispatched", at: firstCmd?.sent_at ?? null },
    { step: "Acknowledged", at: (credits as { acked_at: Date | null }[]).map((c) => c.acked_at).filter(Boolean).sort()[0] ?? null },
  ];
  const { payer_msisdn_hash: _h, ...safe } = p;
  return { payment: safe, timeline, credits, commands, ledger, callbacks, refunds: await many(q, `select * from refunds where payment_id = $1 order by created_at`, [p.id]) };
});

r.route({ method: "get", path: "/exceptions", summary: "Exception queues with counts", auth: "admin", perm: "payments.view" }, async () => {
  const q = db();
  return {
    counts: await exceptionCounts(q),
    unmatched: await many(q, `select id, provider_txn_id, account_ref, amount_minor, payer_msisdn_masked, problem, received_at, resolution from payments where status = 'unmatched' order by received_at desc limit 200`),
    underpaid: await many(q, `select pc.id, pc.table_id, pc.amount_minor, pc.status, pc.created_at, pc.expires_at, pc.payment_ids, m.business_name as merchant from partial_credits pc left join merchants m on m.id = pc.merchant_id where pc.kind = 'underpaid' and pc.status in ('review','open') order by pc.created_at desc limit 200`),
    overpaid: await many(q, `select pc.id, pc.table_id, pc.amount_minor, pc.status, pc.created_at, pc.expires_at, pc.payment_ids, m.business_name as merchant from partial_credits pc left join merchants m on m.id = pc.merchant_id where pc.kind = 'remainder' and pc.status in ('review','open') order by pc.created_at desc limit 200`),
    unlockFailed: await many(
      q,
      `select g.id as credit_id, g.status, g.attempts, g.created_at, g.expires_at, g.table_id, p.id as payment_id, p.provider_txn_id, p.amount_minor, p.games_credited
         from game_credits g join payments p on p.id = g.payment_id where g.status in ('expired','failed') order by g.created_at desc limit 200`,
    ),
    verificationFailed: await many(q, `select id, provider_txn_id, account_ref, amount_minor, verification_detail, received_at, table_id from payments where status = 'rejected' and verification_status = 'mismatch' order by received_at desc limit 200`),
    refundPending: await many(q, `select id, ref, source_type, source_id, payment_id, amount_minor, msisdn_masked, reason, created_at from refunds where status = 'pending' order by created_at limit 200`),
  };
});

r.route({ method: "post", path: "/payments/:id/assign", summary: "Assign an unmatched payment to a table", auth: "admin", perm: "payments.resolve", body: z.object({ tableId: z.string().regex(/^T\d{3,}$/), unlock: z.boolean().default(true), reason: zReason }) }, async ({ req, params, body }) => {
  await assignUnmatched(params.id, body.tableId, body.unlock, body.reason, adminWho(req));
  return { ok: true };
});
r.route({ method: "post", path: "/payments/:id/keep", summary: "Keep an unmatched payment in suspense", auth: "admin", perm: "payments.resolve", body: z.object({ reason: zReason }) }, async ({ req, params, body }) => {
  await keepInSuspense(params.id, body.reason, adminWho(req));
  return { ok: true };
});
r.route({ method: "post", path: "/payments/:id/refund", summary: "Mark for refund", auth: "admin", perm: "payments.resolve", body: z.object({ reason: zReason }) }, async ({ req, params, body }) => {
  await markRefund(params.id, body.reason, adminWho(req));
  return { ok: true };
});
r.route({ method: "post", path: "/payments/:id/clear-verification", summary: "Clear a verification failure after review", auth: "admin", perm: "payments.resolve", reauth: true, body: z.object({ reason: zReason }) }, async ({ req, params, body }) => {
  await clearVerification(params.id, body.reason, adminWho(req));
  return { ok: true };
});
r.route({ method: "post", path: "/credits/:id/retry", summary: "Send the unlock for a failed or expired game again", auth: "admin", perm: "payments.resolve", body: z.object({ reason: zReason }) }, async ({ req, params, body }) => {
  await retryCredit(params.id, body.reason, adminWho(req));
  return { ok: true };
});
r.route({ method: "post", path: "/partials/:id/resolve", summary: "Decide an underpaid or left-over amount", auth: "admin", perm: "payments.resolve", body: z.object({ decision: z.enum(["refund", "credit_merchant", "grant_game"]), reason: zReason }) }, async ({ req, params, body }) => {
  await resolvePartial(params.id, body.decision, body.reason, adminWho(req));
  return { ok: true };
});

r.route({ method: "get", path: "/refunds", summary: "Refunds", auth: "admin", perm: "payments.view", query: z.object({ status: z.enum(["pending", "paid"]).optional() }) }, async ({ query }) => ({
  items: await many(db(), `select * from refunds ${query.status ? "where status = $1" : ""} order by created_at desc limit 500`, query.status ? [query.status] : []),
}));
r.route({ method: "post", path: "/refunds/:id/record", summary: "Record a refund made in the M-Pesa portal", auth: "admin", perm: "refunds.record", body: z.object({ mpesaRef: z.string().trim().min(6).max(20), paidFrom: z.enum(["utility", "working"]) }) }, async ({ req, params, body }) => {
  await recordRefund(params.id, body.mpesaRef.toUpperCase(), body.paidFrom, adminWho(req));
  return { ok: true };
});

// ------------------------------------------------------------------ ledger

r.route({ method: "get", path: "/ledger/accounts", summary: "Ledger accounts and balances", auth: "admin", perm: "ledger.view" }, async () => {
  const rows = await many<{ id: number; code: string; type: string; name: string; balance_minor: number; merchant: string | null }>(db(), `select a.id, a.code, a.type, a.name, a.balance_minor, m.business_name as merchant from ledger_accounts a left join merchants m on m.id = a.merchant_id order by a.code`);
  const fixed = FIXED_ACCOUNTS.map((f) => rows.find((r) => r.code === f.code) ?? { id: 0, code: f.code, type: f.type, name: f.name, balance_minor: 0, merchant: null });
  return { accounts: [...fixed, ...rows.filter((r) => r.code.startsWith("merchant_payable:"))], note: "Debits are positive, credits negative. Liabilities and revenue normally show negative." };
});

r.route(
  { method: "get", path: "/ledger/entries", summary: "Ledger entries, filtered", auth: "admin", perm: "ledger.view", query: zPage.extend({ account: z.string().max(80).optional(), merchant: z.string().uuid().optional(), ref: z.string().max(80).optional(), kind: z.string().max(40).optional(), from: z.string().optional(), to: z.string().optional() }) },
  async ({ query }) => {
    const where = ["true"];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replaceAll("?", `$${params.length}`));
    };
    if (query.account) add(`a.code = ?`, query.account);
    if (query.merchant) add(`a.merchant_id = ?`, query.merchant);
    if (query.ref) add(`(t.ref_id = ? or t.id::text = ?)`, query.ref);
    if (query.kind) add(`t.kind = ?`, query.kind);
    if (query.from) add(`e.created_at >= ?`, nairobiInstant(query.from));
    if (query.to) add(`e.created_at < ?`, nairobiInstant(addDays(query.to, 1)));
    const rows = await many(
      db(),
      `select e.id, e.created_at, a.code as account, a.name as account_name, e.amount_minor, t.id as transaction_id, t.kind, t.ref_type, t.ref_id, t.memo, t.created_by, t.reverses, count(*) over () as total
         from ledger_entries e join ledger_accounts a on a.id = e.account_id join ledger_transactions t on t.id = e.transaction_id
        where ${where.join(" and ")} order by e.id desc limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`,
      params,
    );
    return { items: rows.map((x) => ({ ...x, total: undefined })), total: Number(rows[0]?.total ?? 0), page: query.page, pageSize: query.pageSize };
  },
);

r.route({ method: "get", path: "/ledger/transactions/:id", summary: "One ledger transaction", auth: "admin", perm: "ledger.view" }, async ({ params }) => {
  const t = await one(db(), `select * from ledger_transactions where id = $1`, [params.id]);
  if (!t) throw notFound("Transaction not found");
  return { transaction: t, entries: await many(db(), `select e.id, a.code as account, e.amount_minor from ledger_entries e join ledger_accounts a on a.id = e.account_id where e.transaction_id = $1 order by e.id`, [params.id]) };
});

r.route({ method: "get", path: "/ledger/merchant-balances", summary: "Available, reserved, lifetime earned and paid out per merchant", auth: "admin", perm: "ledger.view" }, async () => ({
  items: await many(
    db(),
    `select m.id, m.code, m.business_name, m.status,
            -coalesce(a.balance_minor, 0) as available,
            (select coalesce(sum(gross_minor), 0) from payouts p where p.merchant_id = m.id and p.status in ('requested','pending_approval','held','queued','submitted','timed_out')) as reserved,
            (select coalesce(sum(merchant_share_minor), 0) from payments p where p.merchant_id = m.id) as lifetime_earned,
            (select coalesce(sum(gross_minor), 0) from payouts p where p.merchant_id = m.id and p.status = 'succeeded') as lifetime_paid_out
       from merchants m left join ledger_accounts a on a.code = 'merchant_payable:' || m.id order by m.code`,
  ),
}));

r.route({ method: "get", path: "/ledger/platform", summary: "Platform revenue, provider fees and net", auth: "admin", perm: "ledger.view" }, async () => {
  const b = await many<{ code: string; balance_minor: number }>(db(), `select code, balance_minor from ledger_accounts where code in ('platform_revenue','provider_fees_expense','platform_drawings')`);
  const v = (c: string) => b.find((x) => x.code === c)?.balance_minor ?? 0;
  return { revenueMinor: -v("platform_revenue"), providerFeesMinor: v("provider_fees_expense"), netMinor: -v("platform_revenue") - v("provider_fees_expense"), withdrawnMinor: v("platform_drawings"), availableMinor: await platformAvailable(db()) };
});

const zLine = z.object({ account: z.string().regex(/^(provider_utility|provider_working|platform_revenue|provider_fees_expense|payout_in_transit|refunds_payable|suspense|platform_drawings|merchant_payable:[0-9a-f-]{36})$/), amountMinor: z.number().int() });
r.route(
  { method: "post", path: "/ledger/adjustments", summary: "Request a correcting entry or a reversal (second approver)", auth: "admin", perm: "ledger.adjust", reauth: true, body: z.object({ reason: zReason, reverses: z.string().uuid().optional(), lines: z.array(zLine).min(2).max(10).optional() }) },
  async ({ req, body }) => {
    if (!body.reverses && !body.lines) throw badRequest("Give the lines of the correcting entry, or the transaction to reverse");
    if (body.lines) {
      const sum = body.lines.reduce((s, l) => s + l.amountMinor, 0);
      if (sum !== 0) throw badRequest(`The lines must balance (they're off by ${formatKsh(sum)})`);
      if (body.lines.some((l) => l.amountMinor === 0)) throw badRequest("Remove lines with a zero amount");
    }
    if (body.reverses && !(await one(db(), `select 1 from ledger_transactions where id = $1`, [body.reverses]))) throw notFound("That transaction doesn't exist");
    const summary = body.reverses ? `Reverse ledger transaction ${body.reverses.slice(0, 8)}` : `Adjustment: ${body.lines!.map((l) => `${l.account} ${formatKsh(l.amountMinor)}`).join(", ")}`;
    return db().tx((q) => requestApproval(q, { action: "ledger.adjustment", payload: { reverses: body.reverses ?? null, lines: body.lines ?? null, memo: body.reason }, summary, reason: body.reason }, requester(req), adminWho(req)));
  },
);

// ------------------------------------------------------------------ reconciliation and transfers

r.route({ method: "get", path: "/reconciliation", summary: "Reconciliation runs, latest first", auth: "admin", perm: "ledger.view" }, async () => ({ runs: await recentRuns(30), autoPayoutsPaused: await getSetting("auto_payouts_paused") }));
r.route({ method: "post", path: "/reconciliation/run", summary: "Run reconciliation now", auth: "admin", perm: "reconciliation.run" }, async ({ req }) => runReconciliation("manual", adminWho(req)));
r.route({ method: "post", path: "/reconciliation/:id/acknowledge", summary: "Acknowledge a mismatch with a note (releases the payout pause)", auth: "admin", perm: "reconciliation.ack", reauth: true, body: z.object({ note: zReason }) }, async ({ req, params, body }) => {
  await acknowledgeRun(params.id, body.note, adminWho(req));
  return { ok: true };
});

r.route({ method: "get", path: "/transfers", summary: "Recorded Utility ↔ Working transfers", auth: "admin", perm: "ledger.view" }, async () => ({
  items: await many(db(), `select t.*, a.name as recorded_by_name from provider_transfers t left join admin_users a on a.id = t.recorded_by order by t.transferred_at desc limit 500`),
  pending: await many(db(), `select id, summary, requested_by, requested_at, executable_after from approvals where action = 'transfer.large' and status = 'pending' order by requested_at desc`),
}));

r.route(
  { method: "post", path: "/transfers", summary: "Record a transfer made in the M-Pesa portal", auth: "admin", perm: "transfers.record", body: z.object({ from: z.enum(["utility", "working"]), to: z.enum(["utility", "working"]), amountMinor: z.number().int().positive(), reference: z.string().trim().min(6).max(30), transferredAt: z.string().datetime(), note: z.string().max(500).optional() }) },
  async ({ req, body }) => {
    if (body.from === body.to) throw badRequest("Pick two different accounts");
    const cfg = await getSetting("float");
    const a = requester(req);
    if (body.amountMinor > cfg.transfer_approval_threshold_minor) {
      const ap = await db().tx((q) => requestApproval(q, { action: "transfer.large", payload: { transfer: body }, summary: `Transfer ${formatKsh(body.amountMinor)} ${body.from} → ${body.to} (${body.reference})`, reason: body.note ?? "Float top-up", entity: { type: "transfer", id: body.reference } }, a, adminWho(req)));
      return { status: "pending_approval", approvalId: ap.id };
    }
    const id = await db().tx((q) => executeTransfer(q, body, a.id, null, null, adminWho(req)));
    return { status: "recorded", id };
  },
);

// ------------------------------------------------------------------ payouts and float

r.route(
  { method: "get", path: "/payouts", summary: "Payout queue", auth: "admin", perm: "payouts.view", query: zPage.extend({ status: z.string().max(160).optional(), merchant: z.string().uuid().optional(), kind: z.enum(["merchant", "platform"]).optional() }) },
  async ({ query }) => {
    const where = ["true"];
    const params: unknown[] = [];
    if (query.status) params.push(query.status.split(",")), where.push(`p.status = any($${params.length}::text[])`);
    if (query.merchant) params.push(query.merchant), where.push(`p.merchant_id = $${params.length}`);
    if (query.kind) params.push(query.kind), where.push(`p.kind = $${params.length}`);
    const rows = await many<Record<string, unknown> & { msisdn: string; requested_at: Date }>(
      db(),
      `select p.id, p.ref, p.kind, p.merchant_id, m.business_name as merchant, p.gross_minor, p.fee_minor, p.net_minor, p.msisdn, p.status, p.status_reason, p.trigger,
              p.requested_by, p.requested_by_label, p.approval_required_reason, p.hold_until, p.failure_reason, p.mpesa_receipt, p.requested_at, p.submitted_at, p.completed_at, p.attempt, p.retry_of,
              exists (select 1 from payouts x where x.retry_of = p.id) as retried, count(*) over () as total
         from payouts p left join merchants m on m.id = p.merchant_id
        where ${where.join(" and ")} order by p.requested_at desc limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`,
      params,
    );
    const counts = await many<{ status: string; n: number; s: number }>(db(), `select status, count(*)::int as n, coalesce(sum(gross_minor), 0) as s from payouts group by status`);
    return {
      items: rows.map((p) => ({ ...p, msisdn: maskMsisdn(p.msisdn), ageMinutes: Math.round((Date.now() - new Date(p.requested_at).getTime()) / 60_000), total: undefined })),
      total: Number(rows[0]?.total ?? 0),
      page: query.page,
      pageSize: query.pageSize,
      counts: Object.fromEntries(counts.map((c) => [c.status, { count: c.n, amountMinor: c.s }])),
    };
  },
);

r.route({ method: "get", path: "/payouts/:id", summary: "Payout detail", auth: "admin", perm: "payouts.view" }, async ({ params }) => {
  const p = await one<Record<string, unknown> & { msisdn: string }>(db(), `select p.*, m.business_name as merchant from payouts p left join merchants m on m.id = p.merchant_id where p.id = $1`, [params.id]);
  if (!p) throw notFound("Payout not found");
  const ledger = await many(db(), `select t.id as transaction_id, t.kind, t.created_at, a.code as account, e.amount_minor from ledger_transactions t join ledger_entries e on e.transaction_id = t.id join ledger_accounts a on a.id = e.account_id where t.ref_type = 'payout' and t.ref_id = $1 order by t.created_at, e.id`, [params.id]);
  const requests = await many(db(), `select kind, status, created_at, completed_at, result from provider_requests where ref_type = 'payout' and ref_id = $1 order by created_at`, [params.id]);
  const audits = await many(db(), `select actor_label, action, after, at from audit_log where entity_type = 'payout' and entity_id = $1 order by at`, [params.id]);
  return { payout: { ...p, msisdn: maskMsisdn(p.msisdn) }, ledger, providerRequests: requests, history: audits };
});

r.route({ method: "post", path: "/payouts/:id/approve", summary: "Approve a payout (not your own)", auth: "admin", perm: "payouts.approve", body: z.object({ note: z.string().max(500).optional() }) }, async ({ req, params, body }) => {
  await approvePayout(params.id, { id: adm(req).id, role: adm(req).role, label: adm(req).name }, adminWho(req), body.note);
  return { ok: true };
});
r.route({ method: "post", path: "/payouts/:id/reject", summary: "Reject a payout (money returns to the balance)", auth: "admin", perm: "payouts.approve", body: z.object({ reason: zReason }) }, async ({ req, params, body }) => {
  await rejectPayout(params.id, body.reason, adminWho(req));
  return { ok: true };
});
r.route({ method: "post", path: "/payouts/:id/retry", summary: "Retry a payout confirmed failed", auth: "admin", perm: "payouts.retry" }, async ({ req, params }) => {
  const p = await retryPayout(params.id, adminWho(req));
  return { id: p.id, ref: p.ref, status: p.status };
});
r.route({ method: "post", path: "/payouts/:id/query", summary: "Ask the provider for a payout's real status", auth: "admin", perm: "payouts.retry" }, async ({ req, params }) => {
  const p = await one<{ status: string; originator_conversation_id: string | null; mpesa_receipt: string | null }>(db(), `select status, originator_conversation_id, mpesa_receipt from payouts where id = $1`, [params.id]);
  if (!p) throw notFound("Payout not found");
  if (!["submitted", "timed_out", "succeeded"].includes(p.status) || !p.originator_conversation_id) throw conflict("Only a payout sent to M-Pesa can be queried");
  await provider().queryPayoutStatus({ payoutId: params.id, originatorConversationId: p.originator_conversation_id, receipt: p.mpesa_receipt });
  await audit(db(), adminWho(req), "payout.query", { type: "payout", id: params.id });
  return { ok: true, note: "The answer arrives on the status result URL and updates the payout." };
});

r.route({ method: "get", path: "/float", summary: "Working float, requirement and suggested transfer", auth: "admin", perm: "float.view" }, async () => ({
  ...(await floatPanel()),
  history: await many(db(), `select utility_minor, working_minor, source, taken_at from provider_balance_snapshots order by taken_at desc limit 96`),
  settings: await getSetting("float"),
}));
r.route({ method: "post", path: "/float/poll", summary: "Ask the provider for balances now", auth: "admin", perm: "float.view" }, async () => ({ snapshot: await pollBalances("manual"), panel: await floatPanel() }));

r.route({ method: "get", path: "/kill-switch", summary: "Payout kill switch state", auth: "admin", perm: "payouts.view" }, async () => ({
  state: await getSetting("kill_switch"),
  pendingRelease: await one(db(), `select id, requested_by, requested_at, executable_after from approvals where action = 'killswitch.release' and status = 'pending'`),
}));

r.route({ method: "post", path: "/kill-switch/engage", summary: "Pause all payouts now", auth: "admin", perm: "killswitch.engage", body: z.object({ reason: zReason }) }, async ({ req, body }) => {
  await db().tx(async (q) => {
    const a = adm(req);
    const { before } = await setSetting("kill_switch", { on: true, reason: body.reason, by: a.name, at: new Date().toISOString() }, a.id, q);
    if (before.on) throw conflict("Payouts are already paused");
    await audit(q, adminWho(req), "killswitch.engage", { type: "setting", id: "kill_switch" }, before, { on: true, reason: body.reason });
    await raise(q, { type: "kill_switch", severity: "critical", title: "Payout kill switch is ON", detail: `${a.name}: ${body.reason}`, dedupeKey: "kill_switch" });
    await announceToTeam(q, "Payouts paused", `${a.name} paused all payouts: ${body.reason}`);
    await activity(q, "killswitch.engage", `Payouts paused by ${a.name}`);
  });
  return { on: true };
});

r.route({ method: "post", path: "/kill-switch/release", summary: "Request release of the kill switch (second approver)", auth: "admin", perm: "killswitch.engage", body: z.object({ reason: zReason }) }, async ({ req, body }) => {
  if (!(await getSetting("kill_switch")).on) throw conflict("Payouts aren't paused");
  return db().tx((q) => requestApproval(q, { action: "killswitch.release", payload: {}, summary: "Release the payout kill switch", reason: body.reason }, requester(req), adminWho(req)));
});

r.route({ method: "get", path: "/platform-payouts", summary: "Operator commission withdrawals", auth: "admin", perm: "payouts.view" }, async () => ({
  availableMinor: await platformAvailable(db()),
  destination: (await getSetting("platform_payout")).msisdn ? maskMsisdn((await getSetting("platform_payout")).msisdn) : null,
  items: await many(db(), `select id, ref, gross_minor, net_minor, status, status_reason, requested_by_label, approved_by, requested_at, completed_at, mpesa_receipt, failure_reason from payouts where kind = 'platform' order by requested_at desc limit 200`),
}));

r.route({ method: "post", path: "/platform-payouts", summary: "Withdraw platform commission", auth: "admin", perm: "payouts.platform", idempotent: true, reauth: true, body: z.object({ amountMinor: z.number().int().positive() }) }, async ({ req, body }) => {
  const p = await requestPlatformPayout(body.amountMinor, String(req.headers["idempotency-key"]), adminWho(req));
  return { id: p.id, ref: p.ref, status: p.status };
});

// ------------------------------------------------------------------ pricing and commission

r.route({ method: "get", path: "/pricing", summary: "Defaults, bounds, commission rules and fee policy", auth: "admin", perm: "pricing.view" }, async () => ({
  defaults: await getSetting("defaults"),
  feePolicy: await getSetting("fee_policy"),
  b2cTariff: await getSetting("b2c_tariff"),
  collectionTariff: await getSetting("collection_tariff"),
  amountRules: await getSetting("amount_rules"),
  payout: await getSetting("payout"),
  rules: await many(
    db(),
    `select r.id, r.scope, r.scope_id, r.commission_minor, r.commission_pct, r.effective_from, r.created_at, r.approval_id,
            case r.scope when 'merchant' then (select business_name from merchants where id::text = r.scope_id) when 'table' then (select name from pool_tables where id = r.scope_id) end as scope_name
       from pricing_rules r order by r.effective_from desc limit 200`,
  ),
  pending: await many(db(), `select id, action, summary, requested_at, executable_after from approvals where action like 'pricing.%' and status = 'pending' order by requested_at desc`),
}));

r.route(
  { method: "post", path: "/pricing/commission", summary: "Request a commission change (second approver; future payments only)", auth: "admin", perm: "pricing.manage", body: z.object({ scope: z.enum(["default", "merchant", "table"]), scopeId: z.string().max(60).optional(), commissionMinor: z.number().int().min(0), commissionPct: z.number().min(0).max(50).default(0), effectiveFrom: z.string().datetime().optional(), reason: zReason }) },
  async ({ req, body }) => {
    if (body.scope !== "default" && !body.scopeId) throw badRequest("Pick the merchant or table");
    if (body.scope === "merchant" && !(await one(db(), `select 1 from merchants where id::text = $1`, [body.scopeId]))) throw notFound("Merchant not found");
    if (body.scope === "table" && !(await one(db(), `select 1 from pool_tables where id = $1`, [body.scopeId]))) throw notFound("Table not found");
    const label = body.scope === "default" ? "platform default" : `${body.scope} ${body.scopeId}`;
    return db().tx((q) =>
      requestApproval(
        q,
        { action: "pricing.commission", payload: { scope: body.scope, scopeId: body.scopeId ?? null, commissionMinor: body.commissionMinor, commissionPct: body.commissionPct, effectiveFrom: body.effectiveFrom ?? new Date().toISOString() }, summary: `Commission for ${label}: ${formatKsh(body.commissionMinor)} per game${body.commissionPct ? ` + ${body.commissionPct}%` : ""}`, reason: body.reason, entity: { type: "pricing", id: `${body.scope}:${body.scopeId ?? "default"}` } },
        requester(req),
        adminWho(req),
      ),
    );
  },
);

r.route({ method: "post", path: "/pricing/fee-policy", summary: "Request a fee policy change (second approver)", auth: "admin", perm: "pricing.manage", body: z.object({ b2c: z.enum(["merchant", "platform"]), collection: z.enum(["platform", "merchant"]), reason: zReason }) }, async ({ req, body }) =>
  db().tx((q) => requestApproval(q, { action: "pricing.fee_policy", payload: { b2c: body.b2c, collection: body.collection }, summary: `Fee policy: B2C fee borne by ${body.b2c}, Paybill fee by ${body.collection}`, reason: body.reason, entity: { type: "pricing", id: "fee_policy" } }, requester(req), adminWho(req))),
);

// ------------------------------------------------------------------ reports and analytics

r.route({ method: "get", path: "/reports/daily", summary: "Daily close report", auth: "admin", perm: "reports.view", query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }) }, async ({ query }) => {
  const date = query.date ?? addDays(nairobiDate(), -1);
  const stored = await one<{ data: unknown; emailed_at: Date | null }>(db(), `select data, emailed_at from daily_reports where report_date = $1`, [date]);
  return { date, report: stored?.data ?? (await dailyClose(db(), date)), stored: Boolean(stored), emailedAt: stored?.emailed_at ?? null, recent: await many(db(), `select to_char(report_date, 'YYYY-MM-DD') as date, emailed_at from daily_reports order by report_date desc limit 60`) };
});

r.route({ method: "get", path: "/reports/daily.csv", summary: "Daily close as CSV", auth: "admin", perm: "reports.view", raw: true, query: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }) }, async ({ req, res, query }) => {
  await audit(db(), adminWho(req), "report.export", null, null, { report: "daily_close", date: query.date });
  res.type("text/csv").attachment(`aura-daily-close-${query.date}.csv`).send(dailyCloseCsv(await dailyClose(db(), query.date)));
});

r.route({ method: "post", path: "/reports/daily/run", summary: "Rebuild (and email) a day's close", auth: "admin", perm: "reports.manage", body: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }) }, async ({ body }) => runDailyClose(body.date));

const zStats = z.object({ period: z.enum(["today", "7d", "month", "year", "all", "custom"]).default("month"), from: z.string().optional(), to: z.string().optional(), merchant: z.string().uuid().optional(), table: z.string().max(10).optional() });
r.route({ method: "get", path: "/stats", summary: "Platform analytics (all merchants, or one)", auth: "admin", perm: "reports.view", query: zStats }, async ({ query }) => stats(db(), query.period, { merchantId: query.merchant ?? null, tableId: query.table ?? null }, query.from, query.to));
r.route({ method: "get", path: "/stats/since-started", summary: "Lifetime per table", auth: "admin", perm: "reports.view", query: z.object({ merchant: z.string().uuid().optional() }) }, async ({ query }) => ({ tables: await sinceStarted(db(), { merchantId: query.merchant ?? null }) }));
