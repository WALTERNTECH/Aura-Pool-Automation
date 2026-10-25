import { randomUUID } from "node:crypto";
import { db, many, one, type Q } from "../config/db.js";
import { shortRef } from "../lib/crypto.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/http.js";
import { addDays, formatKsh, maskMsisdn, nairobiDate, nairobiInstant, nairobiTime } from "../lib/kenya.js";
import { resultParams } from "../providers/common.js";
import { provider } from "../providers/index.js";
import type { PayoutResult } from "../providers/types.js";
import { autoResolve, raise } from "./alerts.js";
import { activity, audit, SYSTEM, type AuditWho } from "./audit.js";
import { enqueue, onJob } from "./jobs.js";
import { merchantAccount, merchantAvailable, platformAvailable, post, type AccountCode, type Line } from "./ledger.js";
import { notifyMerchant } from "./notify.js";
import { payoutLimits } from "./pricing.js";
import { b2cTariff, getSetting, getSettingFresh } from "./settings.js";
import { latestBalances, recordSnapshot } from "./float.js";

// Payouts (spec section 8). The balance is reserved atomically at request time under a row
// lock on the merchant, with an idempotency key, so two quick taps can't pay out twice.
// Nothing is submitted while the kill switch is on, while float is short, during a
// number-change cooling-off, or before approval when one is needed. A payout whose outcome
// is unknown (timed out) is never retried until the provider confirms it failed.

export type PayoutRow = {
  id: string;
  ref: string;
  kind: "merchant" | "platform";
  merchant_id: string | null;
  gross_minor: number;
  fee_minor: number;
  net_minor: number;
  tariff_minor: number;
  fee_borne_by: "merchant" | "platform";
  msisdn: string;
  status: string;
  status_reason: string | null;
  trigger: "manual" | "scheduled" | "admin";
  requested_by: string;
  approval_required_reason: string | null;
  approved_by: string | null;
  idempotency_key: string;
  hold_until: Date | null;
  originator_conversation_id: string | null;
  conversation_id: string | null;
  mpesa_receipt: string | null;
  failure_reason: string | null;
  attempt: number;
  retry_of: string | null;
  requested_at: Date;
  submitted_at: Date | null;
  completed_at: Date | null;
};

const IN_FLIGHT = ["requested", "pending_approval", "held", "queued", "submitted", "timed_out"];

/** Fee so that what Safaricom charges on the net equals what the merchant is charged. */
async function feeFor(q: Q, gross: number, borneBy: "merchant" | "platform") {
  if (borneBy === "platform") return { fee: 0, net: gross, tariff: await b2cTariff(gross, q) };
  let fee = await b2cTariff(gross, q);
  for (let i = 0; i < 3; i++) {
    const again = await b2cTariff(gross - fee, q);
    if (again === fee) break;
    fee = again;
  }
  return { fee, net: gross - fee, tariff: fee };
}

async function dailyUsed(q: Q, merchantId: string) {
  const start = nairobiInstant(nairobiDate());
  const r = await one<{ s: number }>(q, `select coalesce(sum(gross_minor), 0) as s from payouts where merchant_id = $1 and requested_at >= $2 and status not in ('failed','rejected','cancelled')`, [merchantId, start]);
  return r?.s ?? 0;
}

type MerchantForPayout = {
  id: string;
  status: string;
  payout_msisdn: string | null;
  payout_msisdn_verified_at: Date | null;
  payout_hold_until: Date | null;
  payouts_suspended: boolean;
  payouts_suspended_reason: string | null;
  flagged_for_review: boolean;
  fee_policy: "merchant" | "platform" | null;
};

export type Quote = {
  availableMinor: number;
  grossMinor: number;
  feeMinor: number;
  netMinor: number;
  feeBorneBy: "merchant" | "platform";
  destinationMasked: string | null;
  minMinor: number;
  dailyCapMinor: number;
  dailyUsedMinor: number;
  dailyRemainingMinor: number;
  approvalThresholdMinor: number;
  needsApproval: boolean;
  approvalReason: string | null;
  heldUntil: string | null;
  killSwitch: { on: boolean; reason: string | null };
  blockers: { code: string; message: string }[];
};

export async function quote(q: Q, merchantId: string, grossInput?: number): Promise<Quote> {
  const m = await one<MerchantForPayout>(q, `select * from merchants where id = $1`, [merchantId]);
  if (!m) throw notFound("Merchant not found");
  const limits = await payoutLimits(q, merchantId);
  const available = await merchantAvailable(q, merchantId);
  const gross = grossInput ?? available;
  const policy = m.fee_policy ?? (await getSetting("fee_policy", q)).b2c;
  const f = gross > 0 ? await feeFor(q, gross, policy) : { fee: 0, net: 0, tariff: 0 };
  const used = await dailyUsed(q, merchantId);
  const ks = await getSetting("kill_switch", q);
  const blockers: Quote["blockers"] = [];
  if (m.status === "suspended") blockers.push({ code: "suspended", message: "Your account is suspended, so withdrawals are paused. Contact support." });
  if (m.status === "closed") blockers.push({ code: "closed", message: "This account is closed." });
  if (m.payouts_suspended) blockers.push({ code: "under_review", message: "Withdrawals are paused while our team reviews a payment. Contact support for details." });
  if (!m.payout_msisdn || !m.payout_msisdn_verified_at) blockers.push({ code: "no_number", message: "Add and verify your M-Pesa payout number first." });
  if (gross > available) blockers.push({ code: "over_balance", message: `That's more than your available balance of ${formatKsh(available)}.` });
  if (gross < limits.minMinor) blockers.push({ code: "under_minimum", message: `The minimum withdrawal is ${formatKsh(limits.minMinor)}.` });
  if (used + gross > limits.dailyCapMinor) blockers.push({ code: "daily_cap", message: `That's over today's limit. You can withdraw up to ${formatKsh(Math.max(0, limits.dailyCapMinor - used))} more today.` });
  if (gross > 0 && f.net <= 0) blockers.push({ code: "fee", message: "That amount doesn't cover the withdrawal fee." });
  const needsApproval = gross > limits.approvalThresholdMinor || m.flagged_for_review;
  const held = m.payout_hold_until && new Date(m.payout_hold_until) > new Date() ? new Date(m.payout_hold_until).toISOString() : null;
  return {
    availableMinor: available,
    grossMinor: gross,
    feeMinor: f.fee,
    netMinor: f.net,
    feeBorneBy: policy,
    destinationMasked: m.payout_msisdn ? maskMsisdn(m.payout_msisdn) : null,
    minMinor: limits.minMinor,
    dailyCapMinor: limits.dailyCapMinor,
    dailyUsedMinor: used,
    dailyRemainingMinor: Math.max(0, limits.dailyCapMinor - used),
    approvalThresholdMinor: limits.approvalThresholdMinor,
    needsApproval,
    approvalReason: needsApproval ? (m.flagged_for_review ? "Your account is flagged for review" : `Withdrawals over ${formatKsh(limits.approvalThresholdMinor)} are approved by our team`) : null,
    heldUntil: held,
    killSwitch: { on: ks.on, reason: ks.on ? ks.reason : null },
    blockers,
  };
}

export async function requestMerchantPayout(
  merchantId: string,
  opts: { grossMinor?: number; trigger: "manual" | "scheduled" | "admin"; idempotencyKey: string; requestedBy: string; requestedByLabel: string; who: AuditWho; retryOf?: string; attempt?: number },
): Promise<PayoutRow> {
  const row = await db().tx(async (q) => {
    // The row lock serialises every withdrawal for this merchant.
    await q.query(`select id from merchants where id = $1 for update`, [merchantId]);
    const prior = await one<PayoutRow>(q, `select * from payouts where merchant_id = $1 and idempotency_key = $2`, [merchantId, opts.idempotencyKey]);
    if (prior) return prior;
    const qt = await quote(q, merchantId, opts.grossMinor);
    if (qt.blockers.length) throw Object.assign(badRequest(qt.blockers[0].message, qt.blockers[0].code), { details: qt.blockers });
    const m = (await one<MerchantForPayout>(q, `select * from merchants where id = $1`, [merchantId]))!;
    const status = qt.needsApproval ? "pending_approval" : qt.heldUntil ? "held" : "requested";
    const ref = shortRef("WD-");
    const p = await one<PayoutRow>(
      q,
      `insert into payouts (ref, kind, merchant_id, gross_minor, fee_minor, net_minor, tariff_minor, fee_borne_by, msisdn, status, status_reason, trigger,
                            requested_by, requested_by_label, approval_required_reason, idempotency_key, hold_until, retry_of, attempt)
       values ($1,'merchant',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning *`,
      [
        ref,
        merchantId,
        qt.grossMinor,
        qt.feeMinor,
        qt.netMinor,
        (await feeFor(q, qt.grossMinor, qt.feeBorneBy)).tariff,
        qt.feeBorneBy,
        m.payout_msisdn,
        status,
        status === "held" ? "Held during the 24-hour cooling-off after a number change" : null,
        opts.trigger,
        opts.requestedBy,
        opts.requestedByLabel,
        qt.approvalReason,
        opts.idempotencyKey,
        qt.heldUntil,
        opts.retryOf ?? null,
        opts.attempt ?? 1,
      ],
    );
    await post(q, {
      kind: "payout_reserve",
      refType: "payout",
      refId: p!.id,
      idempotencyKey: `payout:${p!.id}:reserve`,
      memo: `${ref} requested`,
      createdBy: opts.requestedBy,
      lines: [{ account: merchantAccount(merchantId), amount: qt.grossMinor }, { account: "payout_in_transit", amount: -qt.grossMinor }],
    });
    await audit(q, opts.who, "payout.request", { type: "payout", id: p!.id }, null, { ref, gross: qt.grossMinor, fee: qt.feeMinor, net: qt.netMinor, status, trigger: opts.trigger });
    const rules = await getSetting("alert_rules", q);
    if (qt.grossMinor >= rules.large_payout_minor) await activity(q, "payout.large", `Large withdrawal ${formatKsh(qt.grossMinor)} requested (${ref})`, { type: "payout", id: p!.id });
    if (status === "pending_approval") {
      await raise(q, { type: "payout_needs_approval", severity: "info", title: `${ref} ${formatKsh(qt.grossMinor)} needs approval`, detail: qt.approvalReason ?? undefined, dedupeKey: `approve:${p!.id}`, entity: { type: "payout", id: p!.id } });
    }
    await enqueue(q, "payout.process", { payoutId: p!.id });
    return p!;
  });
  return row;
}

export async function requestPlatformPayout(grossMinor: number, idempotencyKey: string, who: AuditWho & { id: string; label: string }): Promise<PayoutRow> {
  return db().tx(async (q) => {
    await q.query(`select pg_advisory_xact_lock(91220431)`);
    const prior = await one<PayoutRow>(q, `select * from payouts where merchant_id is null and idempotency_key = $1`, [idempotencyKey]);
    if (prior) return prior;
    const dest = (await getSetting("platform_payout", q)).msisdn;
    if (!dest) throw badRequest("Set the platform payout number in Settings first", "no_number");
    const available = await platformAvailable(q);
    if (grossMinor > available) throw badRequest(`That's more than the platform's available earnings of ${formatKsh(available)}`, "over_balance");
    const limits = await payoutLimits(q, null);
    if (grossMinor < limits.minMinor) throw badRequest(`The minimum payout is ${formatKsh(limits.minMinor)}`, "under_minimum");
    const tariff = await b2cTariff(grossMinor, q);
    const needsApproval = grossMinor > limits.approvalThresholdMinor;
    const ref = shortRef("PW-");
    const p = await one<PayoutRow>(
      q,
      `insert into payouts (ref, kind, gross_minor, fee_minor, net_minor, tariff_minor, fee_borne_by, msisdn, status, trigger, requested_by, requested_by_label, approval_required_reason, idempotency_key)
       values ($1,'platform',$2,0,$2,$3,'platform',$4,$5,'admin',$6,$7,$8,$9) returning *`,
      [ref, grossMinor, tariff, dest, needsApproval ? "pending_approval" : "requested", who.id, who.label, needsApproval ? `Payouts over ${formatKsh(limits.approvalThresholdMinor)} need a second approver` : null, idempotencyKey],
    );
    await post(q, { kind: "payout_reserve", refType: "payout", refId: p!.id, idempotencyKey: `payout:${p!.id}:reserve`, memo: `${ref} platform payout`, createdBy: who.id, lines: [{ account: "platform_drawings", amount: grossMinor }, { account: "payout_in_transit", amount: -grossMinor }] });
    await audit(q, who, "payout.platform_request", { type: "payout", id: p!.id }, null, { ref, gross: grossMinor, status: p!.status });
    await enqueue(q, "payout.process", { payoutId: p!.id });
    return p!;
  });
}

onJob("payout.process", async (p) => {
  await processPayout(String(p.payoutId));
});

/** Moves a payout forward if nothing stops it: holds, kill switch, float, then B2C. */
export async function processPayout(payoutId: string): Promise<string> {
  // Decide in a transaction, call the provider after it commits.
  const decision = await db().tx(async (q) => {
    const p = await one<PayoutRow>(q, `select * from payouts where id = $1 for update`, [payoutId]);
    if (!p) return { action: "none" as const, why: "missing" };
    if (p.status === "held" && p.hold_until && new Date(p.hold_until) <= new Date()) {
      await q.query(`update payouts set status = 'requested', status_reason = null, updated_at = now() where id = $1`, [p.id]);
      p.status = "requested";
    }
    if (!["requested", "queued"].includes(p.status)) return { action: "none" as const, why: p.status };

    const ks = await getSettingFresh("kill_switch", q);
    if (ks.on) {
      await setReason(q, p.id, "Payouts are paused by the operator");
      return { action: "none" as const, why: "kill_switch" };
    }
    if (p.trigger === "scheduled" && (await getSettingFresh("auto_payouts_paused", q)).on) {
      await setReason(q, p.id, "Automatic payouts are paused until a reconciliation difference is cleared");
      return { action: "none" as const, why: "recon_pause" };
    }
    if (p.merchant_id) {
      const m = await one<{ status: string; payouts_suspended: boolean }>(q, `select status, payouts_suspended from merchants where id = $1`, [p.merchant_id]);
      if (m?.payouts_suspended || m?.status === "suspended") {
        await setReason(q, p.id, "Withdrawals for this account are paused for review");
        return { action: "none" as const, why: "suspended" };
      }
    }
    return { action: "check_float" as const, p };
  });
  if (decision.action === "none") return decision.why;
  const p = decision.p;

  // Float: the Working account must cover this payout and its fee, after payouts already in
  // flight since the balance was read. (The buffer percentage sizes the 24-hour requirement and
  // its alerts in float.ts; applying it to each payout would strand the last shillings forever.)
  const floatCfg = await getSetting("float");
  let bal = await latestBalances(floatCfg.max_snapshot_age_s);
  if (!bal) {
    const fresh = await provider().getAccountBalance(10_000).catch(() => null);
    if (fresh) bal = await recordSnapshot(fresh, "pre_payout");
  }
  if (bal?.workingMinor != null) {
    const inFlight = await one<{ s: number }>(db(), `select coalesce(sum(net_minor + tariff_minor), 0) as s from payouts where status = 'submitted' and submitted_at >= $1`, [bal.takenAt]);
    const effective = bal.workingMinor - (inFlight?.s ?? 0);
    const need = p.net_minor + p.tariff_minor;
    if (effective < need) {
      await queueForFloat(p, effective, need);
      return "queued";
    }
  }

  const originator = `AURA-${p.ref}-${p.attempt}-${randomUUID().slice(0, 6)}`;
  const claimed = await one<PayoutRow>(
    db(),
    `update payouts set status = 'submitted', status_reason = null, submitted_at = now(), originator_conversation_id = $2, updated_at = now()
      where id = $1 and status in ('requested','queued') returning *`,
    [p.id, originator],
  );
  if (!claimed) return "raced";
  await autoResolve(db(), `float_wait:${p.id}`, "Submitted");
  const res = await provider()
    .initiatePayout({ payoutId: p.id, originatorConversationId: originator, msisdn: p.msisdn, amountMinor: p.net_minor, remarks: `Aura Pool ${p.ref}` })
    .catch((e: Error) => ({ accepted: false as const, reason: e.message, retryable: false }));
  if (res.accepted) {
    await db().query(`update payouts set conversation_id = $2 where id = $1`, [p.id, res.conversationId]);
    return "submitted";
  }
  if (res.retryable) {
    // The provider refused the request outright, so nothing was sent.
    await failPayout(p.id, `Not sent: ${res.reason}`, null);
    return "failed";
  }
  // We can't tell whether it went. Treat it as timed out and ask.
  await markTimedOut(p.id, `No clear answer from M-Pesa: ${res.reason}`);
  return "timed_out";
}

async function setReason(q: Q, id: string, reason: string) {
  await q.query(`update payouts set status_reason = $2, updated_at = now() where id = $1 and status_reason is distinct from $2`, [id, reason]);
}

async function queueForFloat(p: PayoutRow, effective: number, need: number) {
  const est = (await getSetting("payout")).float_wait_estimate_hours;
  const wasQueued = p.status === "queued";
  await db().query(`update payouts set status = 'queued', status_reason = $2, updated_at = now() where id = $1 and status in ('requested','queued')`, [p.id, `Waiting for the payout account to be topped up. Usually sent within ${est} hours.`]);
  await raise(db(), {
    type: "float_low",
    severity: "warning",
    title: "Payouts are waiting for Working account float",
    detail: `Working float covers ${formatKsh(Math.max(0, effective))}; the next payout needs ${formatKsh(need)} with buffer. Record a transfer from Utility.`,
    dedupeKey: "float:queued",
    entity: { type: "float", id: "working" },
  });
  if (!wasQueued && p.merchant_id) {
    await notifyMerchant(db(), p.merchant_id, { type: "payout_queued", title: `Withdrawal ${p.ref} is queued`, body: `${formatKsh(p.gross_minor)} will be sent as soon as our payout account is topped up, usually within ${est} hours.`, url: "/money/history" });
  }
}

// ------------------------------------------------------------------ results

export async function handlePayoutResult(r: PayoutResult): Promise<string> {
  const p = await one<PayoutRow>(
    db(),
    `select * from payouts where (originator_conversation_id = $1 and $1 is not null) or (conversation_id = $2 and $2 is not null) limit 1`,
    [r.originatorConversationId, r.conversationId],
  );
  if (!p) return "unknown";
  if (r.workingBalanceMinor != null || r.utilityBalanceMinor != null) {
    await recordSnapshot({ workingMinor: r.workingBalanceMinor, utilityMinor: r.utilityBalanceMinor, accounts: {} }, "b2c_result").catch(() => {});
  }
  await db().query(`update payouts set provider_result = $2 where id = $1`, [p.id, JSON.stringify(r.raw ?? {})]);
  if (r.outcome === "succeeded") return succeedPayout(p.id, r.receipt);
  if (r.outcome === "timed_out") {
    await markTimedOut(p.id, r.resultDesc || "Timed out in the M-Pesa queue");
    return "timed_out";
  }
  // Insufficient float isn't the merchant's problem: keep it reserved and wait for top-up.
  if (r.resultCode === "1" && ["submitted", "timed_out"].includes(p.status)) {
    await db().query(`update payouts set status = 'queued', originator_conversation_id = null, updated_at = now() where id = $1`, [p.id]);
    await queueForFloat({ ...p, status: "submitted" }, 0, p.net_minor + p.tariff_minor);
    return "queued";
  }
  await failPayout(p.id, friendlyFailure(r.resultCode, r.resultDesc), r.resultCode);
  return "failed";
}

function friendlyFailure(code: string, desc: string): string {
  if (code === "2001") return "M-Pesa rejected the request (initiator details). Our team has been alerted.";
  if (/not registered|not a registered/i.test(desc)) return "The payout number isn't registered for M-Pesa.";
  if (/limit/i.test(desc)) return "The payout number has reached an M-Pesa limit.";
  return desc ? `M-Pesa: ${desc}` : "M-Pesa could not complete the payment.";
}

async function succeedPayout(payoutId: string, receipt: string | null): Promise<string> {
  const done = await db().tx(async (q) => {
    const p = await one<PayoutRow>(q, `select * from payouts where id = $1 for update`, [payoutId]);
    if (!p || !["submitted", "timed_out"].includes(p.status)) return null;
    const lines: Line[] = [
      { account: "payout_in_transit", amount: p.gross_minor },
      { account: "provider_working", amount: -(p.net_minor + p.tariff_minor) },
    ];
    const feeNet = p.tariff_minor - p.fee_minor;
    if (feeNet) lines.push({ account: "provider_fees_expense", amount: feeNet });
    await post(q, { kind: "payout_success", refType: "payout", refId: p.id, idempotencyKey: `payout:${p.id}:success`, memo: `${p.ref} paid${receipt ? ` (${receipt})` : ""}`, lines });
    await q.query(`update payouts set status = 'succeeded', status_reason = null, mpesa_receipt = coalesce($2, mpesa_receipt), completed_at = now(), updated_at = now() where id = $1`, [p.id, receipt]);
    await audit(q, { type: "provider", label: "M-Pesa" }, "payout.succeeded", { type: "payout", id: p.id }, { status: p.status }, { status: "succeeded", receipt });
    await autoResolve(q, `timeout:${p.id}`, "Confirmed paid");
    if (p.trigger === "scheduled" && p.merchant_id) {
      await q.query(`update merchants set auto_withdraw_last_run = $2 where id = $1`, [p.merchant_id, JSON.stringify({ at: new Date().toISOString(), outcome: "paid", amountMinor: p.gross_minor, ref: p.ref })]);
    }
    return p;
  });
  if (!done) return "ignored";
  if (done.merchant_id) {
    await notifyMerchant(db(), done.merchant_id, {
      type: done.trigger === "scheduled" ? "auto_withdraw" : "payout_succeeded",
      title: `${formatKsh(done.net_minor)} sent to ${maskMsisdn(done.msisdn)}`,
      body: `${done.trigger === "scheduled" ? "Automatic withdrawal" : "Withdrawal"} ${done.ref} received${receipt ? `, M-Pesa ${receipt}` : ""}.`,
      url: "/money/history",
    });
  }
  return "succeeded";
}

/** Confirmed failed: the reservation is reversed and the money is back in the balance. */
async function failPayout(payoutId: string, reason: string, code: string | null): Promise<void> {
  const p = await db().tx(async (q) => {
    const p = await one<PayoutRow>(q, `select * from payouts where id = $1 for update`, [payoutId]);
    if (!p || !["submitted", "timed_out", "requested", "queued"].includes(p.status)) return null;
    await reverseReservation(q, p, "payout_failed");
    await q.query(`update payouts set status = 'failed', failure_reason = $2, status_reason = null, completed_at = now(), updated_at = now() where id = $1`, [p.id, reason]);
    await audit(q, { type: "provider", label: "M-Pesa" }, "payout.failed", { type: "payout", id: p.id }, { status: p.status }, { status: "failed", reason, code });
    await autoResolve(q, `timeout:${p.id}`, "Confirmed failed");
    await raise(q, { type: "payout_failed", severity: "warning", title: `Payout ${p.ref} failed (${formatKsh(p.gross_minor)})`, detail: reason, dedupeKey: `payout_failed:${p.id}`, entity: { type: "payout", id: p.id } });
    return p;
  });
  if (!p) return;
  if (p.merchant_id) {
    await notifyMerchant(db(), p.merchant_id, {
      type: "payout_failed",
      title: `Withdrawal ${p.ref} failed`,
      body: `${reason} ${formatKsh(p.gross_minor)} is back in your balance.`,
      sms: `Your withdrawal ${p.ref} of ${formatKsh(p.gross_minor)} failed. The money is back in your balance.`,
      url: "/money/history",
    });
    if (p.trigger === "scheduled") await scheduleAutoRetry(p);
  }
}

async function reverseReservation(q: Q, p: PayoutRow, kind: string) {
  const back: AccountCode = p.kind === "platform" ? "platform_drawings" : merchantAccount(p.merchant_id!);
  await post(q, { kind, refType: "payout", refId: p.id, idempotencyKey: `payout:${p.id}:reverse`, memo: `${p.ref} returned to balance`, lines: [{ account: "payout_in_transit", amount: p.gross_minor }, { account: back, amount: -p.gross_minor }] });
}

async function markTimedOut(payoutId: string, reason: string) {
  const p = await one<PayoutRow>(db(), `update payouts set status = 'timed_out', status_reason = $2, updated_at = now() where id = $1 and status = 'submitted' returning *`, [payoutId, reason]);
  if (!p) return;
  await raise(db(), {
    type: "payout_timed_out",
    severity: "critical",
    title: `Payout ${p.ref} timed out (${formatKsh(p.gross_minor)})`,
    detail: "Its real outcome is unknown. It must not be retried until M-Pesa confirms it failed. A status query has been sent.",
    dedupeKey: `timeout:${p.id}`,
    entity: { type: "payout", id: p.id },
  });
  // Give M-Pesa a moment to settle before asking; the sweep keeps asking every 10 minutes.
  await enqueue(db(), "payout.query", { payoutId: p.id }, { dedupeKey: `payout.query:${p.id}`, runAt: new Date(Date.now() + 30_000) });
}

onJob("payout.query", async (p) => {
  const row = await one<PayoutRow>(db(), `select * from payouts where id = $1`, [p.payoutId]);
  if (!row || !["submitted", "timed_out"].includes(row.status) || !row.originator_conversation_id) return;
  await provider().queryPayoutStatus({ payoutId: row.id, originatorConversationId: row.originator_conversation_id, receipt: row.mpesa_receipt });
});

/** A Transaction Status answer about a payout. */
export async function handlePayoutStatus(payoutId: string, result: unknown): Promise<string> {
  const r = ((result as { Result?: Record<string, unknown> })?.Result ?? result ?? {}) as Record<string, unknown>;
  const params = resultParams(r);
  const code = String(r.ResultCode ?? "");
  if (code === "0" && /completed/i.test(String(params.TransactionStatus ?? ""))) return succeedPayout(payoutId, params.ReceiptNo ? String(params.ReceiptNo) : null);
  if (code !== "0" && /invalid|not found|does not exist/i.test(String(r.ResultDesc ?? ""))) {
    await failPayout(payoutId, "M-Pesa confirmed the payment was never made.", code);
    return "failed";
  }
  if (code === "0" && /fail|declin|cancel/i.test(String(params.TransactionStatus ?? ""))) {
    await failPayout(payoutId, `M-Pesa reports it ${String(params.TransactionStatus).toLowerCase()}.`, code);
    return "failed";
  }
  return "unknown";
}

/** Every minute: payouts submitted with no result past the timeout become timed out. */
export async function sweepPayouts() {
  const cfg = await getSetting("payout");
  const stale = await many<{ id: string }>(db(), `select id from payouts where status = 'submitted' and submitted_at < now() - ($1 || ' minutes')::interval`, [String(cfg.result_timeout_min)]);
  for (const s of stale) await markTimedOut(s.id, "No result from M-Pesa in time");
  // Timed-out payouts: ask again every 10 minutes until the truth is known.
  const unknown = await many<{ id: string }>(db(), `select id from payouts where status = 'timed_out' and updated_at < now() - interval '10 minutes'`);
  for (const u of unknown) {
    await db().query(`update payouts set updated_at = now() where id = $1`, [u.id]);
    await enqueue(db(), "payout.query", { payoutId: u.id }, { dedupeKey: `payout.query:${u.id}` });
  }
  const ready = await many<{ id: string }>(db(), `select id from payouts where status in ('requested','queued') or (status = 'held' and hold_until <= now()) order by requested_at limit 50`);
  for (const r of ready) await processPayout(r.id);
}

// ------------------------------------------------------------------ admin and owner actions

export async function approvePayout(payoutId: string, admin: { id: string; role: string; label: string }, who: AuditWho, note?: string) {
  await db().tx(async (q) => {
    const p = await one<PayoutRow>(q, `select * from payouts where id = $1 for update`, [payoutId]);
    if (!p) throw notFound("Payout not found");
    if (p.status !== "pending_approval") throw conflict("This payout isn't waiting for approval");
    const cfg = await getSetting("payout", q);
    if (admin.role === "finance" && p.gross_minor > cfg.finance_approval_limit_minor) throw forbidden(`Finance can approve up to ${formatKsh(cfg.finance_approval_limit_minor)}; a super admin must approve this one`);
    if (p.requested_by === admin.id) {
      const so = await getSetting("single_operator", q);
      if (!so.on) throw forbidden("You requested this payout, so someone else must approve it", "own_request");
      const wait = new Date(p.requested_at).getTime() + so.delay_minutes * 60_000 - Date.now();
      if (wait > 0) throw forbidden(`Single-operator mode: you can approve your own request in ${Math.ceil(wait / 60_000)} minutes`, "approval_delay");
    }
    const next = p.hold_until && new Date(p.hold_until) > new Date() ? "held" : "requested";
    await q.query(`update payouts set status = $2, approved_by = $3, approved_at = now(), decided_by = $3, updated_at = now() where id = $1`, [p.id, next, admin.id]);
    await audit(q, who, "payout.approve", { type: "payout", id: p.id }, { status: p.status }, { status: next, note: note ?? null });
    await autoResolve(q, `approve:${p.id}`, `Approved by ${admin.label}`);
    await enqueue(q, "payout.process", { payoutId: p.id });
  });
}

export async function rejectPayout(payoutId: string, reason: string, who: AuditWho & { id: string }, asOwner = false) {
  const p = await db().tx(async (q) => {
    const p = await one<PayoutRow>(q, `select * from payouts where id = $1 for update`, [payoutId]);
    if (!p) throw notFound("Payout not found");
    if (!["pending_approval", "held", "queued", "requested"].includes(p.status)) throw conflict(asOwner ? "This withdrawal has already been sent and can't be cancelled" : "Only a payout not yet sent can be rejected");
    await reverseReservation(q, p, asOwner ? "payout_cancelled" : "payout_rejected");
    const status = asOwner ? "cancelled" : "rejected";
    await q.query(`update payouts set status = $2, failure_reason = $3, decided_by = $4, completed_at = now(), updated_at = now() where id = $1`, [p.id, status, reason, asOwner ? null : who.id]);
    await audit(q, who, asOwner ? "payout.cancel" : "payout.reject", { type: "payout", id: p.id }, { status: p.status }, { status, reason });
    await autoResolve(q, `approve:${p.id}`, status);
    return p;
  });
  if (p.merchant_id && !asOwner) {
    await notifyMerchant(db(), p.merchant_id, { type: "payout_failed", title: `Withdrawal ${p.ref} was not approved`, body: `${reason}. ${formatKsh(p.gross_minor)} is back in your balance.`, url: "/money/history" });
  }
}

/** Retry: allowed only for a payout confirmed failed. Creates a fresh attempt. */
export async function retryPayout(payoutId: string, who: AuditWho & { id: string; label: string }) {
  const p = await one<PayoutRow>(db(), `select * from payouts where id = $1`, [payoutId]);
  if (!p) throw notFound("Payout not found");
  if (p.status === "timed_out") throw conflict("This payout timed out and its outcome is unknown. Query its status first; it can't be retried until M-Pesa confirms it failed.", "outcome_unknown");
  if (p.status !== "failed") throw conflict("Only a failed payout can be retried");
  const again = await one(db(), `select 1 from payouts where retry_of = $1`, [p.id]);
  if (again) throw conflict("This payout was already retried");
  if (p.kind === "platform") throw conflict("Request a new platform payout instead");
  return requestMerchantPayout(p.merchant_id!, { grossMinor: p.gross_minor, trigger: p.trigger === "scheduled" ? "scheduled" : "admin", idempotencyKey: `retry:${p.id}`, requestedBy: who.id, requestedByLabel: who.label, who, retryOf: p.id, attempt: p.attempt + 1 });
}

// ------------------------------------------------------------------ auto-withdraw

/** Every minute: run each merchant's daily withdrawal once its chosen time has passed. */
export async function runAutoWithdrawals(now = new Date()) {
  const today = nairobiDate(now);
  const time = nairobiTime(now);
  const due = await many<{ id: string; auto_withdraw_time: string; auto_withdraw_min_minor: number | null }>(
    db(),
    `select id, auto_withdraw_time, auto_withdraw_min_minor from merchants
      where auto_withdraw_enabled and status = 'active' and auto_withdraw_time <= $1
        and (auto_withdraw_last_date is null or auto_withdraw_last_date < $2::date)`,
    [time, today],
  );
  const paused = (await getSetting("auto_payouts_paused")).on;
  let ran = 0;
  for (const m of due) {
    if (paused) {
      await db().query(`update merchants set auto_withdraw_last_run = $2 where id = $1`, [m.id, JSON.stringify({ at: now.toISOString(), outcome: "paused", note: "Automatic payouts are paused by the platform" })]);
      continue;
    }
    await autoWithdraw(m.id, today, 1, now);
    ran++;
  }
  return ran;
}

async function autoWithdraw(merchantId: string, date: string, attempt: number, now = new Date()) {
  const m = await one<{ auto_withdraw_min_minor: number | null }>(db(), `select auto_withdraw_min_minor from merchants where id = $1`, [merchantId]);
  const limits = await payoutLimits(db(), merchantId);
  const min = Math.max(m?.auto_withdraw_min_minor ?? 0, limits.minMinor);
  const available = await merchantAvailable(db(), merchantId);
  const record = (run: Record<string, unknown>) =>
    db().query(`update merchants set auto_withdraw_last_date = $2::date, auto_withdraw_last_run = $3 where id = $1`, [merchantId, date, JSON.stringify({ at: now.toISOString(), attempt, ...run })]);
  if (available < min) {
    await record({ outcome: "skipped", note: `Balance ${formatKsh(available)} is below the ${formatKsh(min)} minimum` });
    return;
  }
  try {
    const p = await requestMerchantPayout(merchantId, { trigger: "scheduled", idempotencyKey: `auto:${merchantId}:${date}:${attempt}`, requestedBy: "system:auto-withdraw", requestedByLabel: "Automatic withdrawal", who: { ...SYSTEM, label: "auto-withdraw" } });
    await record({ outcome: "requested", amountMinor: p.gross_minor, ref: p.ref, status: p.status });
  } catch (e) {
    await record({ outcome: "blocked", note: (e as Error).message });
  }
}

async function scheduleAutoRetry(p: PayoutRow) {
  const run = await one<{ auto_withdraw_last_date: string | null }>(db(), `select auto_withdraw_last_date from merchants where id = $1`, [p.merchant_id]);
  const date = run?.auto_withdraw_last_date ?? nairobiDate();
  const attempt = Number(p.idempotency_key.match(/^auto:[^:]+:[^:]+:(\d+)$/)?.[1] ?? p.attempt);
  if (attempt >= 4) {
    await raise(db(), { type: "auto_withdraw_failed", severity: "warning", title: `Automatic withdrawal failed 4 times for ${p.ref}`, detail: p.failure_reason ?? undefined, dedupeKey: `auto_failed:${p.merchant_id}:${date}`, entity: { type: "merchant", id: p.merchant_id! } });
    await notifyMerchant(db(), p.merchant_id!, { type: "auto_withdraw", title: "Automatic withdrawal didn't go through", body: "We tried 4 times. Your money is safe in your balance; withdraw it by hand or contact support.", url: "/money" });
    return;
  }
  await enqueue(db(), "auto.retry", { merchantId: p.merchant_id, date, attempt: attempt + 1 }, { runAt: new Date(Date.now() + 15 * 60_000), dedupeKey: `auto.retry:${p.merchant_id}:${date}:${attempt + 1}` });
}

onJob("auto.retry", async (p) => autoWithdraw(String(p.merchantId), String(p.date), Number(p.attempt)));

export function nextAutoRun(m: { auto_withdraw_enabled: boolean; auto_withdraw_time: string | null; auto_withdraw_last_date: string | null }, now = new Date()): string | null {
  if (!m.auto_withdraw_enabled || !m.auto_withdraw_time) return null;
  const today = nairobiDate(now);
  // Not yet run today: today's slot (if it has just passed, the minute sweep picks it up now).
  const date = m.auto_withdraw_last_date === today ? addDays(today, 1) : today;
  return nairobiInstant(date, m.auto_withdraw_time).toISOString();
}

export const PAYOUT_IN_FLIGHT = IN_FLIGHT;
