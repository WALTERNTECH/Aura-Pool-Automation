import { db, many, one, type Q } from "../config/db.js";
import { hashMsisdn, shortRef } from "../lib/crypto.js";
import { badRequest, conflict, notFound } from "../lib/http.js";
import { formatKsh, maskMsisdn, maskName, normaliseTableRef } from "../lib/kenya.js";
import { provider } from "../providers/index.js";
import type { CollectionCallback, VerifyResult } from "../providers/types.js";
import { raise, autoResolve } from "./alerts.js";
import { audit, SYSTEM, type AuditWho } from "./audit.js";
import { enqueue, onJob } from "./jobs.js";
import { merchantAccount, post, reverse, type Line } from "./ledger.js";
import { notifyMerchant } from "./notify.js";
import { commissionAmount, commissionFor } from "./pricing.js";
import { collectionTariff, getSetting } from "./settings.js";
import { kickDispatch } from "./unlocks.js";

// The collection pipeline (spec 6.1): store the callback once, verify it with the provider,
// match it to a table, apply the amount rules, write the ledger, create game credits and
// hand them to the unlock dispatcher. Each step is idempotent: a replayed callback or a
// re-run job never creates a second game or a second ledger entry.

export type PaymentRow = {
  id: string;
  provider: string;
  provider_txn_id: string;
  channel: "c2b" | "stk";
  shortcode: string | null;
  account_ref: string | null;
  amount_minor: number;
  payer_msisdn_hash: string | null;
  payer_msisdn_masked: string | null;
  status: string;
  problem: string | null;
  table_id: string | null;
  merchant_id: string | null;
  games_credited: number;
  commission_minor: number;
  merchant_share_minor: number;
  verification_status: string;
  received_at: Date;
};

/** Step 1–3: store the payment (unique provider id), queue its processing. */
export async function ingestCollection(cb: CollectionCallback, opts: { stkRequestId?: string } = {}): Promise<{ paymentId: string; duplicate: boolean }> {
  const p = provider();
  return db().tx(async (q) => {
    const row = await one<{ id: string }>(
      q,
      `insert into payments (provider, provider_txn_id, channel, shortcode, account_ref, account_ref_normalised, amount_minor,
                             payer_msisdn_hash, payer_msisdn_masked, payer_name_masked, trans_time, org_balance_minor, raw_payload, stk_request_id)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       on conflict (provider, provider_txn_id) do nothing
       returning id`,
      [
        p.name,
        cb.providerTxnId,
        cb.channel,
        cb.shortcode,
        cb.accountRef,
        normaliseTableRef(cb.accountRef),
        cb.amountMinor,
        cb.msisdn ? hashMsisdn(cb.msisdn) : null,
        cb.msisdn ? maskMsisdn(cb.msisdn) : null,
        maskName(cb.firstName, cb.middleName, cb.lastName),
        cb.transTime,
        cb.orgBalanceMinor,
        JSON.stringify(cb.raw ?? {}),
        opts.stkRequestId ?? null,
      ],
    );
    if (!row) {
      const prior = await one<{ id: string }>(q, `select id from payments where provider = $1 and provider_txn_id = $2`, [p.name, cb.providerTxnId]);
      return { paymentId: prior!.id, duplicate: true };
    }
    await enqueue(q, "payment.process", { paymentId: row.id }, { dedupeKey: `payment.process:${row.id}` });
    return { paymentId: row.id, duplicate: false };
  });
}

onJob("payment.process", async (p) => processPayment(String(p.paymentId)));
onJob("payment.verify", async (p) => verifyLater(String(p.paymentId), Number(p.round ?? 0)));

export async function processPayment(paymentId: string) {
  const pay = await one<PaymentRow>(db(), `select * from payments where id = $1`, [paymentId]);
  if (!pay) return;
  if (!["received", "verifying"].includes(pay.status)) return;
  const mode = await getSetting("verify_mode");
  if (mode === "sync" && pay.verification_status === "pending") {
    await db().query(`update payments set status = 'verifying' where id = $1 and status = 'received'`, [paymentId]);
    // Never block a paying customer on provider slowness: 5 seconds, then continue.
    const v = await safeVerify(pay, 5_000);
    await recordVerification(paymentId, v);
    if (v.status === "mismatch") return rejectForMismatch(paymentId, v.reason, v.detail, false);
    if (v.status === "unavailable") await enqueue(db(), "payment.verify", { paymentId, round: 1 }, { runAt: new Date(Date.now() + 60_000), dedupeKey: `payment.verify:${paymentId}` });
  }
  await matchAndCredit(paymentId);
  if (mode === "async" && pay.verification_status === "pending") {
    await enqueue(db(), "payment.verify", { paymentId, round: 0 }, { dedupeKey: `payment.verify:${paymentId}` });
  }
}

async function safeVerify(pay: PaymentRow, budgetMs: number): Promise<VerifyResult> {
  try {
    return await provider().verifyCollection(db(), { paymentId: pay.id, providerTxnId: pay.provider_txn_id, amountMinor: pay.amount_minor, shortcode: pay.shortcode ?? "" }, budgetMs);
  } catch (e) {
    return { status: "unavailable", reason: (e as Error).message };
  }
}

async function recordVerification(paymentId: string, v: VerifyResult) {
  await db().query(
    `update payments set verification_status = $2, verification_detail = $3, verified_at = case when $2 = 'verified' then now() else verified_at end where id = $1`,
    [paymentId, v.status, JSON.stringify(v.status === "verified" ? { detail: v.detail ?? null } : v.status === "mismatch" ? { reason: v.reason, detail: v.detail ?? null } : { reason: v.reason })],
  );
}

/** Async mode, and sync payments the provider couldn't confirm in time: check again later. */
async function verifyLater(paymentId: string, round: number) {
  const pay = await one<PaymentRow>(db(), `select * from payments where id = $1`, [paymentId]);
  if (!pay || !["pending", "unavailable"].includes(pay.verification_status) || pay.status === "rejected") return;
  const v = await safeVerify(pay, 20_000);
  await recordVerification(paymentId, v);
  if (v.status === "mismatch") return rejectForMismatch(paymentId, v.reason, v.detail, true);
  if (v.status === "unavailable") {
    if (round < 12) {
      await enqueue(db(), "payment.verify", { paymentId, round: round + 1 }, { runAt: new Date(Date.now() + 5 * 60_000), dedupeKey: `payment.verify:${paymentId}` });
    } else {
      await raise(db(), { type: "provider_error", severity: "warning", title: `Payment ${pay.provider_txn_id} could not be verified`, detail: v.reason, dedupeKey: `unverified:${paymentId}`, entity: { type: "payment", id: paymentId } });
    }
  }
}

/**
 * The provider contradicts the callback. Sync mode: nothing was credited, so reject it.
 * Async mode: freeze it and reverse what was credited. Either way the merchant's payouts
 * are suspended until an admin reviews it.
 */
async function rejectForMismatch(paymentId: string, reason: string, detail: unknown, reverseLedger: boolean) {
  await db().tx(async (q) => {
    const pay = await one<PaymentRow>(q, `select * from payments where id = $1 for update`, [paymentId]);
    if (!pay || pay.status === "rejected") return;
    if (reverseLedger) {
      const txs = await many<{ id: string }>(q, `select id from ledger_transactions where ref_type = 'payment' and ref_id = $1 and reverses is null and kind <> 'reversal'`, [paymentId]);
      for (const t of txs) await reverse(q, t.id, "reversal", "system", `Verification mismatch: ${reason}`);
      await q.query(`update game_credits set status = 'refunded', resolution = 'frozen: verification mismatch' where payment_id = $1 and status in ('pending','dispatched')`, [paymentId]);
      await q.query(`update partial_credits set status = 'refunded', resolution = '{"frozen": true}'::jsonb where $1 = any(payment_ids) and status = 'open'`, [paymentId]);
    }
    await q.query(`update payments set status = 'rejected', problem = 'verification_mismatch' where id = $1`, [paymentId]);
    const tableId = pay.table_id ?? normaliseTableRef(pay.account_ref);
    const t = tableId ? await one<{ merchant_id: string }>(q, `select merchant_id from pool_tables where id = $1`, [tableId]) : null;
    if (t) {
      await q.query(`update merchants set payouts_suspended = true, payouts_suspended_reason = $2 where id = $1`, [t.merchant_id, `Verification mismatch on ${pay.provider_txn_id}`]);
      await audit(q, SYSTEM, "merchant.payouts_suspended", { type: "merchant", id: t.merchant_id }, null, { reason: "verification_mismatch", payment: paymentId });
    }
    await raise(q, {
      type: "verification_mismatch",
      severity: "critical",
      title: `Payment ${pay.provider_txn_id} failed verification`,
      detail: `${reason}. ${t ? "That merchant's payouts are suspended until this is cleared." : ""}`.trim(),
      dedupeKey: `verification:${paymentId}`,
      entity: { type: "payment", id: paymentId },
      data: { detail },
    });
  });
}

/** Steps 5–9: match, amount rules, ledger, credits. Safe to call more than once. */
export async function matchAndCredit(paymentId: string, opts: { assignTableId?: string; unlock?: boolean; who?: AuditWho } = {}) {
  let dispatchTable: string | null = null;
  let notify: { merchantId: string; tableId: string; games: number; amount: number; underpaid: boolean } | null = null;
  await db().tx(async (q) => {
    const pay = await one<PaymentRow & { account_ref_normalised: string | null }>(q, `select * from payments where id = $1 for update`, [paymentId]);
    if (!pay) throw notFound("Payment not found");
    const assigning = Boolean(opts.assignTableId);
    if (!assigning && !["received", "verifying"].includes(pay.status)) return;
    if (assigning && pay.status !== "unmatched") throw conflict("Only unmatched payments can be assigned to a table");

    const tableId = opts.assignTableId ?? pay.account_ref_normalised;
    const table = tableId
      ? await one<{ id: string; merchant_id: string; status: string; price_minor: number; m_status: string; block: boolean }>(
          q,
          `select t.id, t.merchant_id, t.status, t.price_minor, m.status as m_status, m.block_table_payments as block
             from pool_tables t join merchants m on m.id = t.merchant_id where t.id = $1`,
          [tableId],
        )
      : null;

    const available = table && table.status === "active" && table.m_status !== "closed" && !table.block;
    if (!table || (!available && !assigning)) {
      // Unmatched: the money waits in suspense for an admin. No unlock.
      const problem = !table ? "unknown_account" : "table_unavailable";
      await q.query(`update payments set status = 'unmatched', problem = $2, table_id = $3, merchant_id = $4, matched_at = now() where id = $1`, [paymentId, problem, table?.id ?? null, table?.merchant_id ?? null]);
      await post(q, { kind: "payment_unmatched", refType: "payment", refId: paymentId, idempotencyKey: `payment:${paymentId}:receive`, memo: `Unmatched ${pay.provider_txn_id} (${pay.account_ref ?? "no account"})`, lines: [{ account: "provider_utility", amount: pay.amount_minor }, { account: "suspense", amount: -pay.amount_minor }] });
      await bookCollectionFee(q, pay, null);
      await raise(q, {
        type: "unmatched_payment",
        severity: "critical",
        title: `${formatKsh(pay.amount_minor)} paid to account "${pay.account_ref ?? ""}"`,
        detail: !table ? "The account number doesn't match any table. The money is in suspense." : `Table ${table.id} isn't taking payments. The money is in suspense.`,
        dedupeKey: `unmatched:${paymentId}`,
        entity: { type: "payment", id: paymentId },
      });
      return;
    }

    const rules = await getSetting("amount_rules", q);
    const price = table.price_minor;
    const commission = await commissionFor(q, table.id, table.merchant_id);
    const fromSuspense = pay.status === "unmatched";

    // Money held from this payer's earlier part payment on the same table, if still within the window.
    const partial = !fromSuspense && pay.payer_msisdn_hash
      ? await one<{ id: string; amount_minor: number; payment_ids: string[] }>(
          q,
          `select id, amount_minor, payment_ids from partial_credits
            where table_id = $1 and payer_msisdn_hash = $2 and status = 'open' and expires_at > now()
            order by created_at limit 1 for update`,
          [table.id, pay.payer_msisdn_hash],
        )
      : null;
    const held = partial?.amount_minor ?? 0;
    const total = pay.amount_minor + held;
    const games = Math.min(Math.floor(total / price), rules.games_cap);
    const remainder = total - games * price;
    const expires = new Date(Date.now() + rules.partial_window_min * 60_000);
    const source = fromSuspense ? "suspense" : "provider_utility";

    if (partial) await q.query(`update partial_credits set status = 'consumed' where id = $1`, [partial.id]);

    if (games === 0) {
      await q.query(
        `update payments set status = 'underpaid', problem = 'underpaid', table_id = $2, merchant_id = $3, price_minor = $4, partial_applied_minor = $5, matched_at = now() where id = $1`,
        [paymentId, table.id, table.merchant_id, price, held],
      );
      if (!fromSuspense) {
        await post(q, { kind: "payment_held", refType: "payment", refId: paymentId, idempotencyKey: `payment:${paymentId}:receive`, memo: `Underpaid ${pay.provider_txn_id}`, lines: [{ account: "provider_utility", amount: pay.amount_minor }, { account: "suspense", amount: -pay.amount_minor }] });
        await bookCollectionFee(q, pay, null);
      }
      await q.query(
        `insert into partial_credits (table_id, merchant_id, payer_msisdn_hash, amount_minor, kind, payment_ids, expires_at) values ($1,$2,$3,$4,'underpaid',$5,$6)`,
        [table.id, table.merchant_id, pay.payer_msisdn_hash, total, [...(partial?.payment_ids ?? []), paymentId], expires],
      );
      notify = { merchantId: table.merchant_id, tableId: table.id, games: 0, amount: pay.amount_minor, underpaid: true };
      return;
    }

    const gross = games * price;
    const fee = commissionAmount(commission, games, price);
    const share = gross - fee;
    const lines: Line[] = [{ account: source, amount: pay.amount_minor }];
    if (held) lines.push({ account: "suspense", amount: held });
    lines.push({ account: merchantAccount(table.merchant_id), amount: -share });
    if (fee) lines.push({ account: "platform_revenue", amount: -fee });
    if (remainder) lines.push({ account: "suspense", amount: -remainder });
    await post(q, {
      kind: "payment_credit",
      refType: "payment",
      refId: paymentId,
      idempotencyKey: `payment:${paymentId}:credit`,
      memo: `${games} game${games > 1 ? "s" : ""} on ${table.id} (${pay.provider_txn_id})`,
      createdBy: opts.who?.id ?? "system",
      lines,
    });
    if (!fromSuspense) await bookCollectionFee(q, pay, table.merchant_id);

    await q.query(
      `update payments set status = 'credited', problem = null, table_id = $2, merchant_id = $3, price_minor = $4, games_credited = $5,
              partial_applied_minor = $6, remainder_minor = $7, commission_minor = $8, merchant_share_minor = $9,
              matched_at = coalesce(matched_at, now()), credited_at = now()
        where id = $1`,
      [paymentId, table.id, table.merchant_id, price, games, held, remainder, fee, share],
    );
    if (remainder) {
      await q.query(
        `insert into partial_credits (table_id, merchant_id, payer_msisdn_hash, amount_minor, kind, payment_ids, expires_at) values ($1,$2,$3,$4,'remainder',$5,$6)`,
        [table.id, table.merchant_id, pay.payer_msisdn_hash, remainder, [paymentId], expires],
      );
    }
    const unlock = opts.unlock ?? true;
    if (unlock) {
      const creditExpiry = new Date(Date.now() + rules.offline_retry_min * 60_000);
      await q.query(
        `insert into game_credits (payment_id, table_id, merchant_id, expires_at) select $1, $2, $3, $4 from generate_series(1, $5::int)`,
        [paymentId, table.id, table.merchant_id, creditExpiry, games],
      );
      dispatchTable = table.id;
    }
    if (assigning && opts.who) {
      await audit(q, opts.who, "payment.assign", { type: "payment", id: paymentId }, { status: "unmatched" }, { table: table.id, games, unlock });
      await autoResolve(q, `unmatched:${paymentId}`, `Assigned to ${table.id}`);
    }
    notify = { merchantId: table.merchant_id, tableId: table.id, games, amount: pay.amount_minor, underpaid: false };
  });
  if (dispatchTable) kickDispatch(dispatchTable);
  const n = notify as { merchantId: string; tableId: string; games: number; amount: number; underpaid: boolean } | null;
  if (n && !n.underpaid) {
    await notifyMerchant(db(), n.merchantId, { type: "payment_received", title: `${formatKsh(n.amount)} on ${n.tableId}`, body: `${n.games} game${n.games > 1 ? "s" : ""} paid`, url: `/payments/${paymentId}` });
  }
}

/** Paybill charges Safaricom keeps from the Utility account, per the fee policy. */
async function bookCollectionFee(q: Q, pay: PaymentRow, merchantId: string | null) {
  const fee = await collectionTariff(pay.amount_minor, q);
  if (!fee) return;
  const policy = await getSetting("fee_policy", q);
  const debit: Line = policy.collection === "merchant" && merchantId ? { account: merchantAccount(merchantId), amount: fee } : { account: "provider_fees_expense", amount: fee };
  await post(q, { kind: "collection_fee", refType: "payment", refId: pay.id, idempotencyKey: `payment:${pay.id}:collection_fee`, memo: `Paybill charge on ${pay.provider_txn_id}`, lines: [debit, { account: "provider_utility", amount: -fee }] });
}

// ------------------------------------------------------------------ part payments

/** Part payments and remainders whose window has passed go to admin review. */
export async function expirePartials() {
  const due = await many<{ id: string; kind: string; amount_minor: number; table_id: string; merchant_id: string; payment_ids: string[] }>(
    db(),
    `update partial_credits set status = 'review' where status = 'open' and expires_at <= now() returning id, kind, amount_minor, table_id, merchant_id, payment_ids`,
  );
  for (const p of due) {
    await raise(db(), {
      type: p.kind === "underpaid" ? "underpaid_review" : "overpaid_review",
      severity: "warning",
      title: `${formatKsh(p.amount_minor)} ${p.kind === "underpaid" ? "underpaid" : "left over"} on ${p.table_id}`,
      detail: p.kind === "underpaid" ? "Not enough for a game and no top-up came. Refund it or credit it." : "More than the games paid for. Refund the rest or credit it.",
      dedupeKey: `partial:${p.id}`,
      entity: { type: "partial_credit", id: p.id },
    });
    if (p.kind === "underpaid") {
      await notifyMerchant(db(), p.merchant_id, { type: "payment_attention", title: `Underpaid payment on ${p.table_id}`, body: `${formatKsh(p.amount_minor)} wasn't enough for a game. Our team will refund or review it.`, url: p.payment_ids[0] ? `/payments/${p.payment_ids[0]}` : "/payments" });
    }
  }
  return due.length;
}

export type PartialDecision = "refund" | "credit_merchant" | "grant_game";

export async function resolvePartial(id: string, decision: PartialDecision, reason: string, who: AuditWho & { id: string }) {
  let dispatchTable: string | null = null;
  await db().tx(async (q) => {
    const p = await one<{ id: string; kind: string; status: string; amount_minor: number; table_id: string; merchant_id: string; payment_ids: string[] }>(q, `select * from partial_credits where id = $1 for update`, [id]);
    if (!p) throw notFound("Not found");
    if (!["review", "open"].includes(p.status)) throw conflict("This has already been resolved");
    if (decision === "grant_game" && p.kind !== "underpaid") throw badRequest("Only an underpayment can be turned into a game");
    let status = "credited";
    if (decision === "refund") {
      await post(q, { kind: "refund_marked", refType: "partial_credit", refId: id, idempotencyKey: `partial:${id}:refund`, createdBy: who.id, memo: reason, lines: [{ account: "suspense", amount: p.amount_minor }, { account: "refunds_payable", amount: -p.amount_minor }] });
      const pay = await one<{ id: string; payer_msisdn_masked: string | null }>(q, `select id, payer_msisdn_masked from payments where id = $1`, [p.payment_ids[0]]);
      await q.query(`insert into refunds (ref, source_type, source_id, payment_id, merchant_id, amount_minor, msisdn_masked, reason, requested_by) values ($1,'partial',$2,$3,$4,$5,$6,$7,$8)`, [shortRef("RF-"), id, pay?.id ?? null, p.merchant_id, p.amount_minor, pay?.payer_msisdn_masked ?? null, reason, who.id]);
      status = "refund_pending";
    } else if (decision === "credit_merchant") {
      await post(q, { kind: "partial_credit_merchant", refType: "partial_credit", refId: id, idempotencyKey: `partial:${id}:credit`, createdBy: who.id, memo: reason, lines: [{ account: "suspense", amount: p.amount_minor }, { account: merchantAccount(p.merchant_id), amount: -p.amount_minor }] });
    } else {
      const commission = await commissionFor(q, p.table_id, p.merchant_id);
      const fee = Math.min(commission.commissionMinor, p.amount_minor);
      await post(q, {
        kind: "partial_grant_game",
        refType: "partial_credit",
        refId: id,
        idempotencyKey: `partial:${id}:grant`,
        createdBy: who.id,
        memo: reason,
        lines: [{ account: "suspense", amount: p.amount_minor }, { account: merchantAccount(p.merchant_id), amount: -(p.amount_minor - fee) }, ...(fee ? [{ account: "platform_revenue" as const, amount: -fee }] : [])],
      });
      const rules = await getSetting("amount_rules", q);
      await q.query(`insert into game_credits (payment_id, table_id, merchant_id, expires_at, resolution) values ($1,$2,$3,$4,'granted by admin')`, [p.payment_ids[p.payment_ids.length - 1], p.table_id, p.merchant_id, new Date(Date.now() + rules.offline_retry_min * 60_000)]);
      dispatchTable = p.table_id;
      status = "granted";
    }
    await q.query(`update partial_credits set status = $2, resolution = $3, resolved_by = $4, resolved_at = now() where id = $1`, [id, status, JSON.stringify({ decision, reason }), who.id]);
    await audit(q, who, `partial.${decision}`, { type: "partial_credit", id }, { status: p.status }, { status, reason });
    await autoResolve(q, `partial:${id}`, `Resolved: ${decision}`);
  });
  if (dispatchTable) kickDispatch(dispatchTable);
}

// ------------------------------------------------------------------ admin resolutions

export async function assignUnmatched(paymentId: string, tableId: string, unlock: boolean, reason: string, who: AuditWho & { id: string }) {
  const t = await one(db(), `select 1 from pool_tables where id = $1`, [tableId]);
  if (!t) throw badRequest("That table doesn't exist");
  await matchAndCredit(paymentId, { assignTableId: tableId, unlock, who });
  await db().query(`update payments set resolution = $2, resolved_by = $3, resolved_at = now() where id = $1`, [paymentId, JSON.stringify({ action: "assign", tableId, unlock, reason }), who.id]);
}

export async function keepInSuspense(paymentId: string, reason: string, who: AuditWho & { id: string }) {
  await db().tx(async (q) => {
    const p = await one<{ status: string }>(q, `select status from payments where id = $1 for update`, [paymentId]);
    if (!p) throw notFound("Payment not found");
    if (p.status !== "unmatched") throw conflict("Only unmatched payments sit in suspense");
    await q.query(`update payments set resolution = $2, resolved_by = $3, resolved_at = now() where id = $1`, [paymentId, JSON.stringify({ action: "keep_in_suspense", reason }), who.id]);
    await q.query(`update alerts set status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() where dedupe_key = $1 and status = 'open'`, [`unmatched:${paymentId}`, who.id]);
    await audit(q, who, "payment.keep_in_suspense", { type: "payment", id: paymentId }, null, { reason });
  });
}

/**
 * Marks money for refund: an unmatched payment, an underpayment, or the games of a credited
 * payment whose unlock failed. The ledger moves it to refunds_payable; the refund itself is
 * made in the M-Pesa portal and recorded afterwards.
 */
export async function markRefund(paymentId: string, reason: string, who: AuditWho & { id: string }) {
  await db().tx(async (q) => {
    const p = await one<PaymentRow & { price_minor: number | null }>(q, `select * from payments where id = $1 for update`, [paymentId]);
    if (!p) throw notFound("Payment not found");
    let amount = 0;
    const lines: Line[] = [];
    if (p.status === "unmatched") {
      amount = p.amount_minor;
      lines.push({ account: "suspense", amount }, { account: "refunds_payable", amount: -amount });
    } else if (p.status === "credited") {
      const failed = await many<{ id: string }>(q, `select id from game_credits where payment_id = $1 and status in ('expired','failed') for update`, [paymentId]);
      if (!failed.length) throw conflict("Every game on this payment was played; there is nothing to refund");
      const perShare = Math.round(p.merchant_share_minor / Math.max(1, p.games_credited));
      const perFee = Math.round(p.commission_minor / Math.max(1, p.games_credited));
      const share = perShare * failed.length;
      const fee = perFee * failed.length;
      amount = share + fee;
      lines.push({ account: merchantAccount(p.merchant_id!), amount: share });
      if (fee) lines.push({ account: "platform_revenue", amount: fee });
      lines.push({ account: "refunds_payable", amount: -amount });
      await q.query(`update game_credits set status = 'refunded', resolution = $2 where id = any($1::uuid[])`, [failed.map((f) => f.id), `refund: ${reason}`]);
    } else {
      throw conflict(p.status === "underpaid" ? "Underpayments are refunded from the review queue" : `A ${p.status.replace("_", " ")} payment can't be refunded`);
    }
    await post(q, { kind: "refund_marked", refType: "payment", refId: paymentId, idempotencyKey: `payment:${paymentId}:refund:${Date.now()}`, createdBy: who.id, memo: reason, lines });
    await q.query(`update payments set status = 'refund_pending', refund_minor = refund_minor + $2, resolution = $3, resolved_by = $4, resolved_at = now() where id = $1`, [paymentId, amount, JSON.stringify({ action: "refund", reason }), who.id]);
    await q.query(`insert into refunds (ref, source_type, source_id, payment_id, merchant_id, amount_minor, msisdn_masked, reason, requested_by) values ($1,'payment',$2,$2,$3,$4,$5,$6,$7)`, [shortRef("RF-"), paymentId, p.merchant_id, amount, p.payer_msisdn_masked, reason, who.id]);
    await audit(q, who, "payment.mark_refund", { type: "payment", id: paymentId }, { status: p.status }, { status: "refund_pending", amount, reason });
    await autoResolve(q, `unmatched:${paymentId}`, "Marked for refund");
    await autoResolve(q, `expired:${paymentId}`, "Marked for refund");
  });
}

/** Records a refund made by hand in the M-Pesa portal, and closes it. */
export async function recordRefund(refundId: string, mpesaRef: string, paidFrom: "utility" | "working", who: AuditWho & { id: string }) {
  await db().tx(async (q) => {
    const r = await one<{ id: string; status: string; amount_minor: number; source_type: string; source_id: string; payment_id: string | null }>(q, `select * from refunds where id = $1 for update`, [refundId]);
    if (!r) throw notFound("Refund not found");
    if (r.status === "paid") throw conflict("This refund is already recorded");
    await post(q, { kind: "refund_paid", refType: "refund", refId: refundId, idempotencyKey: `refund:${refundId}:paid`, createdBy: who.id, memo: `M-Pesa ${mpesaRef}`, lines: [{ account: "refunds_payable", amount: r.amount_minor }, { account: paidFrom === "utility" ? "provider_utility" : "provider_working", amount: -r.amount_minor }] });
    await q.query(`update refunds set status = 'paid', mpesa_ref = $2, paid_from = $3, paid_by = $4, paid_at = now() where id = $1`, [refundId, mpesaRef, paidFrom, who.id]);
    if (r.source_type === "payment") await q.query(`update payments set status = 'refunded' where id = $1 and status = 'refund_pending'`, [r.source_id]);
    else await q.query(`update partial_credits set status = 'refunded' where id = $1`, [r.source_id]);
    await audit(q, who, "refund.record", { type: "refund", id: refundId }, { status: "pending" }, { status: "paid", mpesaRef, paidFrom, amount: r.amount_minor });
  });
}

/** An admin confirms a payment that failed verification is genuine; it then continues normally. */
export async function clearVerification(paymentId: string, reason: string, who: AuditWho & { id: string }) {
  await db().tx(async (q) => {
    const p = await one<PaymentRow>(q, `select * from payments where id = $1 for update`, [paymentId]);
    if (!p) throw notFound("Payment not found");
    if (p.status !== "rejected" || p.verification_status !== "mismatch") throw conflict("Only payments rejected by verification can be cleared");
    const reversed = await one(q, `select 1 from ledger_transactions where ref_type = 'ledger_transaction' and kind = 'reversal' and ref_id in (select id::text from ledger_transactions where ref_type = 'payment' and ref_id = $1)`, [paymentId]);
    if (reversed) throw conflict("This payment's credit was already reversed; post a correcting adjustment instead");
    await q.query(`update payments set status = 'received', problem = null, verification_status = 'verified', verification_detail = $2, verified_at = now() where id = $1`, [paymentId, JSON.stringify({ manual: true, by: who.id, reason })]);
    await audit(q, who, "payment.clear_verification", { type: "payment", id: paymentId }, { verification: "mismatch" }, { verification: "verified (manual)", reason });
    await autoResolve(q, `verification:${paymentId}`, "Cleared by admin");
    const others = p.merchant_id
      ? await one(q, `select 1 from payments where merchant_id = $1 and verification_status = 'mismatch' and status = 'rejected' and id <> $2`, [p.merchant_id, paymentId])
      : null;
    const tableId = p.table_id ?? normaliseTableRef(p.account_ref);
    const t = tableId ? await one<{ merchant_id: string }>(q, `select merchant_id from pool_tables where id = $1`, [tableId]) : null;
    if (t && !others) {
      await q.query(`update merchants set payouts_suspended = false, payouts_suspended_reason = null where id = $1 and payouts_suspended_reason like 'Verification mismatch%'`, [t.merchant_id]);
      await audit(q, who, "merchant.payouts_restored", { type: "merchant", id: t.merchant_id }, null, { reason: "verification cleared" });
    }
  });
  await matchAndCredit(paymentId);
}

/** Puts an expired or failed credit back in the queue for another try. */
export async function retryCredit(creditId: string, reason: string, who: AuditWho & { id: string }) {
  let tableId = "";
  await db().tx(async (q) => {
    const c = await one<{ id: string; status: string; table_id: string; payment_id: string }>(q, `select id, status, table_id, payment_id from game_credits where id = $1 for update`, [creditId]);
    if (!c) throw notFound("Game credit not found");
    if (!["expired", "failed"].includes(c.status)) throw conflict("Only an expired or failed unlock can be retried");
    const rules = await getSetting("amount_rules", q);
    await q.query(`update game_credits set status = 'pending', attempts = 0, expires_at = $2, resolution = $3 where id = $1`, [creditId, new Date(Date.now() + rules.offline_retry_min * 60_000), `retry: ${reason}`]);
    await audit(q, who, "credit.retry_unlock", { type: "game_credit", id: creditId }, { status: c.status }, { status: "pending", reason });
    tableId = c.table_id;
  });
  kickDispatch(tableId);
}

// ------------------------------------------------------------------ labels

/** What an owner sees for a payment (Merchant PRD 7.4). */
export function ownerStatus(p: { status: string; problem: string | null; credits?: { status: string }[]; tableOnline?: boolean }): { code: string; label: string; tone: "ok" | "wait" | "bad" | "info" } {
  const credits = p.credits ?? [];
  switch (p.status) {
    case "credited": {
      if (credits.some((c) => c.status === "expired" || c.status === "failed")) return { code: "unlock_failed", label: "Paid, table did not unlock", tone: "bad" };
      if (credits.some((c) => c.status === "pending" || c.status === "dispatched")) return { code: "waiting_table", label: "Paid, waiting for table", tone: "wait" };
      if (!credits.length) return { code: "credited", label: "Paid, credited", tone: "ok" };
      return { code: "game_started", label: "Paid, game started", tone: "ok" };
    }
    case "underpaid":
      return { code: "underpaid", label: "Underpaid", tone: "bad" };
    case "unmatched":
      return { code: "wrong_table", label: "Wrong table number", tone: "bad" };
    case "received":
    case "verifying":
    case "matched":
      return { code: "verifying", label: "Verifying", tone: "info" };
    case "refund_pending":
      return { code: "refund_pending", label: "Refund pending", tone: "wait" };
    case "refunded":
      return { code: "refunded", label: "Refunded", tone: "info" };
    case "rejected":
      return { code: "rejected", label: "Rejected", tone: "bad" };
    default:
      return { code: p.status, label: p.status, tone: "info" };
  }
}

/** A plain-language reason for a problem, for the payment detail screen. */
export function problemReason(p: { status: string; problem: string | null; credits?: { status: string }[] }): string | null {
  const s = ownerStatus(p).code;
  if (s === "unlock_failed") return "The table didn't confirm the unlock after retrying for 15 minutes. Our team has been alerted and will unlock it or refund the customer.";
  if (s === "waiting_table") return "The table is offline. We keep trying for up to 15 minutes, and the game starts as soon as it reconnects.";
  if (s === "underpaid") return "The customer paid less than the price of a game. We hold it briefly in case they top up, then refund or review it.";
  if (s === "wrong_table") return "The account number didn't match a table that's taking payments. An admin is reviewing it.";
  if (s === "rejected") return "This payment failed a safety check with M-Pesa and was not credited. An admin is reviewing it.";
  if (s === "refund_pending") return "This money is being refunded to the customer.";
  return null;
}
