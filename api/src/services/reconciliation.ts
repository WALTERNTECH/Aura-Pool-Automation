import { db, many, one } from "../config/db.js";
import { env } from "../config/env.js";
import { conflict, notFound } from "../lib/http.js";
import { formatKsh } from "../lib/kenya.js";
import { provider } from "../providers/index.js";
import { autoResolve, raise } from "./alerts.js";
import { audit, type AuditWho } from "./audit.js";
import { recordSnapshot } from "./float.js";
import { balance, checkInvariants } from "./ledger.js";
import { getSetting, setSetting } from "./settings.js";

// Reconciliation (spec 12, Admin PRD 5.6). Compares the ledger's Utility and Working
// balances with what the provider reports, separately, and checks the ledger's own
// invariants. Any difference above tolerance opens a critical alert and pauses automatic
// payouts until an authorised user acknowledges it with a note.

export type ReconLine = { check: string; ledgerMinor: number | null; providerMinor: number | null; differenceMinor: number; ok: boolean; note?: string };

export async function runReconciliation(trigger: "nightly" | "manual", who?: AuditWho) {
  const run = await one<{ id: string }>(db(), `insert into reconciliation_runs (trigger, status) values ($1, 'running') returning id`, [trigger]);
  const id = run!.id;
  try {
    const tol = (await getSetting("reconciliation")).tolerance_minor;
    const b = await provider().getAccountBalance(25_000);
    if (!b || b.workingMinor == null || b.utilityMinor == null) throw new Error("The provider did not return account balances");
    await recordSnapshot(b, "reconciliation");
    const lines: ReconLine[] = [];
    // Payouts submitted but not yet confirmed have left (or are leaving) the Working account
    // without a ledger entry yet: they explain a difference of exactly their sum.
    const inflight = (await one<{ s: number }>(db(), `select coalesce(sum(net_minor + tariff_minor), 0) as s from payouts where status in ('submitted','timed_out')`))?.s ?? 0;
    for (const [name, code, prov] of [
      ["Utility account", "provider_utility", b.utilityMinor],
      ["Working account", "provider_working", b.workingMinor],
    ] as const) {
      const ledger = await balance(db(), code);
      let diff = prov - ledger;
      let note: string | undefined;
      if (code === "provider_working" && inflight && Math.abs(prov - (ledger - inflight)) < Math.abs(diff)) {
        diff = prov - (ledger - inflight);
        note = `Allows for ${formatKsh(inflight)} of payouts in flight`;
      }
      lines.push({ check: name, ledgerMinor: ledger, providerMinor: prov, differenceMinor: diff, ok: Math.abs(diff) <= tol, note });
    }
    const inv = await checkInvariants(db());
    lines.push({ check: "Ledger invariants", ledgerMinor: null, providerMinor: null, differenceMinor: 0, ok: inv.ok, note: inv.ok ? "Entries balance and cached balances match" : inv.problems.join("; ") });
    const unverified = await one<{ n: number }>(db(), `select count(*)::int as n from payments where verification_status in ('pending','unavailable') and received_at < now() - interval '1 hour' and status <> 'rejected'`);
    lines.push({ check: "Payments not yet verified with the provider (over 1 hour old)", ledgerMinor: null, providerMinor: null, differenceMinor: 0, ok: (unverified?.n ?? 0) === 0, note: `${unverified?.n ?? 0} payment(s)` });
    if (env.provider === "simulated") {
      // The simulator keeps its own transaction list: every collection it took must be on our books.
      const missing = await one<{ n: number; s: number }>(
        db(),
        `select count(*)::int as n, coalesce(sum(t.amount_minor), 0) as s from sim_transactions t
          where t.kind in ('c2b','stk') and not exists (select 1 from payments p where p.provider_txn_id = t.txn_id)`,
      );
      lines.push({ check: "Provider collections missing from our records", ledgerMinor: null, providerMinor: missing?.s ?? 0, differenceMinor: missing?.s ?? 0, ok: (missing?.n ?? 0) === 0, note: `${missing?.n ?? 0} transaction(s)` });
    }
    const money = lines.filter((l) => l.check.endsWith("account") || l.check.startsWith("Provider collections") || l.check === "Ledger invariants");
    const mismatch = money.some((l) => !l.ok);
    await db().query(`update reconciliation_runs set status = $2, lines = $3, finished_at = now() where id = $1`, [id, mismatch ? "mismatch" : "match", JSON.stringify(lines)]);
    if (mismatch) {
      const bad = money.filter((l) => !l.ok).map((l) => `${l.check}: ${l.differenceMinor ? formatKsh(l.differenceMinor) : l.note}`);
      await raise(db(), { type: "reconciliation_mismatch", severity: "critical", title: "Reconciliation found a difference", detail: `${bad.join(". ")}. Automatic payouts are paused until someone acknowledges this.`, dedupeKey: "reconciliation", entity: { type: "reconciliation_run", id } });
      await setSetting("auto_payouts_paused", { on: true, reason: bad.join("; ").slice(0, 300), run_id: id }, "reconciliation");
    } else {
      await autoResolve(db(), "reconciliation", "Latest run matched");
    }
    if (who) await audit(db(), who, "reconciliation.run", { type: "reconciliation_run", id }, null, { status: mismatch ? "mismatch" : "match" });
    return { id, status: mismatch ? "mismatch" : "match", lines };
  } catch (e) {
    await db().query(`update reconciliation_runs set status = 'error', error = $2, finished_at = now() where id = $1`, [id, (e as Error).message]);
    await raise(db(), { type: "reconciliation_mismatch", severity: "warning", title: "Reconciliation could not run", detail: (e as Error).message, dedupeKey: "reconciliation:error" });
    return { id, status: "error", error: (e as Error).message, lines: [] as ReconLine[] };
  }
}

export async function acknowledgeRun(runId: string, note: string, who: AuditWho & { id: string }) {
  const r = await one<{ status: string; acknowledged_at: Date | null }>(db(), `select status, acknowledged_at from reconciliation_runs where id = $1`, [runId]);
  if (!r) throw notFound("Run not found");
  if (r.status !== "mismatch") throw conflict("Only a mismatch needs acknowledging");
  if (r.acknowledged_at) throw conflict("Already acknowledged");
  await db().query(`update reconciliation_runs set acknowledged_by = $2, acknowledged_at = now(), ack_note = $3 where id = $1`, [runId, who.id, note]);
  const paused = await getSetting("auto_payouts_paused");
  // Acknowledging the run that paused payouts (or any later one) releases the pause.
  const later = paused.run_id ? await one(db(), `select 1 from reconciliation_runs where id = $1 and started_at <= (select started_at from reconciliation_runs where id = $2)`, [paused.run_id, runId]) : true;
  if (paused.on && later) await setSetting("auto_payouts_paused", { on: false, reason: null, run_id: null }, who.id);
  await audit(db(), who, "reconciliation.acknowledge", { type: "reconciliation_run", id: runId }, { paused: paused.on }, { paused: false, note });
}

export async function recentRuns(limit = 30) {
  return many(db(), `select id, trigger, started_at, finished_at, status, lines, error, acknowledged_by, acknowledged_at, ack_note from reconciliation_runs order by started_at desc limit $1`, [limit]);
}
