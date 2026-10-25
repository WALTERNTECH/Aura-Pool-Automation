import { db, many, one, type Q } from "../config/db.js";
import { badRequest } from "../lib/http.js";
import { formatKsh } from "../lib/kenya.js";
import { provider } from "../providers/index.js";
import type { Balances } from "../providers/types.js";
import { autoResolve, raise } from "./alerts.js";
import { audit, type AuditWho } from "./audit.js";
import { enqueue } from "./jobs.js";
import { balance, post } from "./ledger.js";
import { getSetting } from "./settings.js";

// Float (spec 8.1). As understood, C2B collections land in the Paybill's Utility account and
// B2C payouts leave from its Working account, so merchant withdrawals fail unless money is
// moved across. We poll balances, work out what the next 24 hours of payouts need, warn
// before it runs short, and record the transfers the operator makes in the M-Pesa portal.

export type Snapshot = { utilityMinor: number | null; workingMinor: number | null; takenAt: Date; source: string };

export async function recordSnapshot(b: Balances, source: string, q: Q = db()): Promise<Snapshot> {
  const r = await one<{ taken_at: Date }>(
    q,
    `insert into provider_balance_snapshots (provider, utility_minor, working_minor, accounts, source) values ($1,$2,$3,$4,$5) returning taken_at`,
    [provider().name, b.utilityMinor, b.workingMinor, JSON.stringify(b.accounts ?? {}), source],
  );
  return { utilityMinor: b.utilityMinor, workingMinor: b.workingMinor, takenAt: r!.taken_at, source };
}

/** The newest snapshot with both balances, if younger than maxAgeS. */
export async function latestBalances(maxAgeS?: number, q: Q = db()): Promise<Snapshot | null> {
  const r = await one<{ utility_minor: number | null; working_minor: number | null; taken_at: Date; source: string }>(
    q,
    `select utility_minor, working_minor, taken_at, source from provider_balance_snapshots
      where working_minor is not null ${maxAgeS != null ? `and taken_at > now() - interval '${Math.floor(maxAgeS)} seconds'` : ""}
      order by taken_at desc limit 1`,
  );
  return r ? { utilityMinor: r.utility_minor, workingMinor: r.working_minor, takenAt: r.taken_at, source: r.source } : null;
}

/** Every float.poll_minutes: fresh balances, then re-evaluate the float alerts. */
export async function pollBalances(source = "poll"): Promise<Snapshot | null> {
  const b = await provider().getAccountBalance(20_000).catch((e) => {
    console.error("[float] balance query failed:", (e as Error).message);
    return null;
  });
  const snap = b ? await recordSnapshot(b, source) : null;
  await evaluateFloat();
  return snap;
}

export async function floatPanel(q: Q = db()) {
  const cfg = await getSetting("float", q);
  const snap = await latestBalances(undefined, q);
  const queued = await one<{ s: number; n: number }>(
    q,
    `select coalesce(sum(net_minor + tariff_minor), 0) as s, count(*)::int as n from payouts where status in ('requested','queued','held','pending_approval')`,
  );
  // Scheduled in the next 24 hours: every auto-withdraw merchant's current balance, if it meets their minimum.
  const sched = await many<{ id: string; available: number; min: number | null }>(
    q,
    `select m.id, -coalesce(a.balance_minor, 0) as available, m.auto_withdraw_min_minor as min
       from merchants m left join ledger_accounts a on a.code = 'merchant_payable:' || m.id
      where m.auto_withdraw_enabled and m.status = 'active'`,
  );
  const payoutMin = (await getSetting("payout", q)).min_minor;
  const scheduled = sched.filter((s) => s.available >= Math.max(s.min ?? 0, payoutMin)).reduce((t, s) => t + s.available, 0);
  const required = Math.ceil(((queued?.s ?? 0) + scheduled) * (1 + cfg.buffer_pct / 100));
  const working = snap?.workingMinor ?? null;
  const short = working == null ? null : Math.max(0, required - working);
  const belowMin = working == null ? null : Math.max(0, cfg.minimum_minor - working);
  const suggested = short == null ? null : Math.ceil(Math.max(short, belowMin ?? 0) / 100_000) * 100_000;
  const status: "ok" | "warning" | "critical" | "unknown" = working == null ? "unknown" : working < cfg.minimum_minor ? "critical" : working < required ? "warning" : "ok";
  const ledgerWorking = await balance(q, "provider_working");
  const ledgerUtility = await balance(q, "provider_utility");
  return {
    workingMinor: working,
    utilityMinor: snap?.utilityMinor ?? null,
    takenAt: snap?.takenAt ?? null,
    snapshotSource: snap?.source ?? null,
    ledgerWorkingMinor: ledgerWorking,
    ledgerUtilityMinor: ledgerUtility,
    queuedMinor: queued?.s ?? 0,
    queuedCount: queued?.n ?? 0,
    scheduledNext24hMinor: scheduled,
    bufferPct: cfg.buffer_pct,
    minimumMinor: cfg.minimum_minor,
    requiredMinor: required,
    shortMinor: short,
    suggestedTransferMinor: suggested && suggested > 0 ? suggested : 0,
    transferNeeded: Boolean(suggested && suggested > 0),
    status,
  };
}

export async function evaluateFloat() {
  const f = await floatPanel();
  if (f.status === "unknown") return f;
  if (f.status === "ok") {
    await autoResolve(db(), "float:low", "Float covers the requirement");
    await autoResolve(db(), "float:queued", "Float covers the requirement");
    return f;
  }
  await raise(db(), {
    type: "float_low",
    severity: f.status === "critical" ? "critical" : "warning",
    title: f.status === "critical" ? `Working float is below the minimum (${formatKsh(f.workingMinor!)})` : `Working float is short of the next 24 hours of payouts`,
    detail: `Needs ${formatKsh(f.requiredMinor)} with a ${f.bufferPct}% buffer; has ${formatKsh(f.workingMinor!)}. Suggested transfer from Utility: ${formatKsh(f.suggestedTransferMinor)}.`,
    dedupeKey: "float:low",
    entity: { type: "float", id: "working" },
    data: { suggestedTransferMinor: f.suggestedTransferMinor },
  });
  return f;
}

export type TransferInput = { from: "utility" | "working"; to: "utility" | "working"; amountMinor: number; reference: string; transferredAt: string; note?: string };

/** Books a transfer made in the M-Pesa portal: balanced ledger entries and a record of who did it. */
export async function executeTransfer(q: Q, t: TransferInput, recordedBy: string, approvedBy: string | null, approvalId: string | null, who: AuditWho) {
  if (t.from === t.to) throw badRequest("Pick two different accounts");
  const dup = await one(q, `select 1 from provider_transfers where reference = $1 and status = 'recorded'`, [t.reference.trim().toUpperCase()]);
  if (dup) throw badRequest("A transfer with that M-Pesa reference is already recorded");
  const row = await one<{ id: string }>(
    q,
    `insert into provider_transfers (from_account, to_account, amount_minor, reference, transferred_at, note, recorded_by, approved_by, status, approval_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'recorded',$9) returning id`,
    [t.from, t.to, t.amountMinor, t.reference.trim().toUpperCase(), new Date(t.transferredAt), t.note ?? null, recordedBy, approvedBy, approvalId],
  );
  const toAcc = t.to === "working" ? "provider_working" : "provider_utility";
  const fromAcc = t.from === "working" ? "provider_working" : "provider_utility";
  const txId = await post(q, { kind: "provider_transfer", refType: "provider_transfer", refId: row!.id, idempotencyKey: `transfer:${row!.id}`, memo: `${t.from} → ${t.to} (${t.reference})`, createdBy: recordedBy, lines: [{ account: toAcc, amount: t.amountMinor }, { account: fromAcc, amount: -t.amountMinor }] });
  await q.query(`update provider_transfers set ledger_transaction_id = $2 where id = $1`, [row!.id, txId]);
  await audit(q, who, "transfer.record", { type: "provider_transfer", id: row!.id }, null, { ...t, approvedBy });
  // Queued payouts may now fit.
  await enqueue(q, "float.after_transfer", {});
  return row!.id;
}
