import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { env } from "./config/env.js";
import { db, many, one, pgDb, pgliteDb, setDb, type Db } from "./config/db.js";
import { authenticateDevice, handleEvent, handleStatus, onDeviceGone, sweepDevices, whenOnline } from "./devices/devices.js";
import type { Ack, DeviceEvent, Status } from "./devices/protocol.js";
import { EmbeddedTransport, ExternalTransport, type DeviceTransport } from "./devices/transport.js";
import { startVirtualDevices, stopVirtualDevices, syncVirtualDevices, virtualAction, virtualSummary } from "./devices/virtual.js";
import { createApp } from "./app.js";
import { addDays, nairobiDate, nairobiInstant, nairobiTime } from "./lib/kenya.js";
import { migrate } from "./migrate.js";
import { setSimulatorTarget } from "./providers/simulated.js";
import { wireDeviceHooks } from "./routes/admin-core.js";
import { wireOps } from "./routes/admin-ops.js";
import { autoResolve, raise } from "./services/alerts.js";
import "./services/approval-actions.js";
import { runDelayedApprovals } from "./services/approvals.js";
import { evaluateFloat, pollBalances } from "./services/float.js";
import { enqueue, every, onJob, queueDepth, startScheduler, startWorker, stopScheduler, stopWorker } from "./services/jobs.js";
import { checkInvariants } from "./services/ledger.js";
import { completeCooling } from "./services/merchants.js";
import { sendSms } from "./services/messaging.js";
import { expirePartials } from "./services/payments.js";
import { runAutoWithdrawals, sweepPayouts } from "./services/payouts.js";
import { runReconciliation } from "./services/reconciliation.js";
import { runDailyClose, runMonthlySummary } from "./services/reports.js";
import { getSetting } from "./services/settings.js";
import { expireCredits, handleAck, kickDispatch, setTransport, sweepQueues } from "./services/unlocks.js";

// Starting the whole backend: database and migrations, the device transport, the HTTP
// server, background jobs and periodic sweeps. Tests start it the same way on a free port.

export type Running = { server: Server; url: string; db: Db; transport: DeviceTransport; stop: () => Promise<void> };

/** jobs: run the queue worker. periodic: run the timed sweeps (tests drive them with runPeriodicOnce). */
export async function start(opts: { port?: number; db?: Db; jobs?: boolean; periodic?: boolean; log?: (m: string) => void } = {}): Promise<Running> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const database = opts.db ?? (env.databaseUrl ? pgDb(env.databaseUrl) : await pgliteDb(env.pgliteDir ?? undefined));
  setDb(database);
  await migrate(database, (m) => log(`[db] ${m}`));

  const transport: DeviceTransport =
    env.device.transport === "external"
      ? new ExternalTransport({ url: env.device.mqttUrl, username: env.device.mqttUsername, password: env.device.mqttPassword })
      : new EmbeddedTransport(authenticateDevice, process.env.MQTT_TCP_PORT ? Number(process.env.MQTT_TCP_PORT) : undefined);
  transport.onMessage((m) => {
    const done = m.kind === "status" ? handleStatus(m.tableId, m.payload as Status, m.deviceId) : m.kind === "ack" ? handleAck(m.tableId, m.payload as Ack) : handleEvent(m.tableId, m.payload as DeviceEvent, m.deviceId);
    done.catch((e) => console.error(`[device] ${m.kind} from ${m.tableId}:`, (e as Error).message));
  });
  transport.onDisconnect((id) => void onDeviceGone(id.deviceId));
  setTransport(transport);
  whenOnline((tableId) => kickDispatch(tableId));

  const app = createApp();
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(opts.port ?? env.port);
    s.once("listening", () => resolve(s));
    s.once("error", (e) => reject(new Error(`Can't listen on port ${opts.port ?? env.port}: ${(e as Error).message}`)));
  });
  const port = (server.address() as AddressInfo).port;
  const localUrl = `http://127.0.0.1:${port}`;
  setSimulatorTarget(env.provider === "simulated" ? localUrl : env.publicUrl);
  await transport.start(server);

  wireDeviceHooks({ restartVirtual: syncVirtualDevices, disconnect: (id) => transport.disconnect(id) });
  wireOps({ deviceStatus: () => transport.status(), virtualDevices: virtualSummary, virtualAction, localUrl: () => localUrl });
  if (env.device.virtualDevices && transport.kind === "embedded") await startVirtualDevices(`ws://127.0.0.1:${port}/mqtt`);

  registerJobs();
  registerPeriodic();
  if (opts.jobs !== false) startWorker(200);
  if (opts.periodic !== false) startScheduler();
  log(`[aura] listening on :${port} (${env.nodeEnv}, ${database.kind}, provider ${env.provider}, devices ${transport.kind})`);

  return {
    server,
    url: localUrl,
    db: database,
    transport,
    stop: async () => {
      stopScheduler();
      stopWorker();
      await stopVirtualDevices();
      await transport.stop().catch(() => {});
      await new Promise<void>((res) => server.close(() => res()));
      server.closeAllConnections?.();
      if (!opts.db) await database.close();
    },
  };
}

let jobsRegistered = false;
export function registerJobs() {
  if (jobsRegistered) return;
  jobsRegistered = true;
  onJob("sms.send", async (p) => {
    await sendSms(String(p.phone), String(p.text));
  });
  onJob("payouts.sweep", async () => sweepPayouts());
  onJob("float.after_transfer", async () => {
    await pollBalances("after_transfer");
    await sweepPayouts();
  });
}

let periodicRegistered = false;
export function registerPeriodic() {
  if (periodicRegistered) return;
  periodicRegistered = true;
  every("devices", 15_000, sweepDevices);
  every("credits", 10_000, async () => {
    await expireCredits();
  });
  every("dispatch", 30_000, sweepQueues);
  every("payouts", 30_000, sweepPayouts);
  every("auto_withdraw", 60_000, async () => {
    await runAutoWithdrawals();
  });
  every("partials", 60_000, async () => {
    await expirePartials();
  });
  every("cooling", 60_000, async () => {
    await completeCooling();
  });
  every("approvals", 60_000, runDelayedApprovals);
  every("float", 60_000, async () => {
    const cfg = await getSetting("float");
    const last = await one<{ taken_at: Date }>(db(), `select taken_at from provider_balance_snapshots where source = 'poll' order by taken_at desc limit 1`);
    if (!last || Date.now() - new Date(last.taken_at).getTime() >= cfg.poll_minutes * 60_000) await pollBalances("poll");
    else await evaluateFloat();
  });
  every("verify_stuck", 5 * 60_000, async () => {
    const stuck = await many<{ id: string }>(db(), `select id from payments where verification_status in ('pending','unavailable') and status not in ('rejected') and received_at < now() - interval '2 minutes' and received_at > now() - interval '2 days' limit 100`);
    for (const s of stuck) await enqueue(db(), "payment.verify", { paymentId: s.id, round: 1 }, { dedupeKey: `payment.verify:${s.id}` });
  });
  every("callback_silence", 5 * 60_000, async () => {
    const rules = await getSetting("alert_rules");
    const hour = Number(nairobiTime().slice(0, 2));
    const online = await one<{ n: number }>(db(), `select count(*)::int as n from devices where online and status = 'provisioned'`);
    const last = await one<{ at: Date | null }>(db(), `select max(received_at) as at from callback_log where kind in ('c2b_confirmation','stk')`);
    const silentFor = last?.at ? (Date.now() - new Date(last.at).getTime()) / 60_000 : Infinity;
    const busyHours = hour >= 10 && hour < 23;
    const recentGames = await one<{ n: number }>(db(), `select count(*)::int as n from game_credits where status = 'acked' and acked_at > now() - interval '7 days'`);
    if (busyHours && (online?.n ?? 0) > 0 && (recentGames?.n ?? 0) > 0 && silentFor > rules.callback_silence_minutes) {
      await raise(db(), { type: "callback_silence", severity: "warning", title: "No payment callbacks while tables are online", detail: `Nothing from M-Pesa for ${Number.isFinite(silentFor) ? Math.round(silentFor) : "many"} minutes with ${online!.n} table(s) online. Check the callback URLs and Daraja status.`, dedupeKey: "callback_silence" });
    } else if (silentFor <= rules.callback_silence_minutes) {
      await autoResolve(db(), "callback_silence", "Callbacks arriving again");
    }
  });
  every("queue_backlog", 2 * 60_000, async () => {
    const rules = await getSetting("alert_rules");
    const q = await queueDepth();
    if (q.due > rules.queue_backlog) await raise(db(), { type: "queue_backlog", severity: "warning", title: `${q.due} background jobs waiting`, detail: `Oldest has waited ${q.oldest_s ?? 0} seconds.`, dedupeKey: "queue_backlog" });
    else await autoResolve(db(), "queue_backlog", "Queue drained");
  });
  every("stk_expire", 60_000, async () => {
    await db().query(`update stk_requests set status = 'expired', updated_at = now() where status = 'pending' and created_at < now() - interval '3 minutes'`);
  });
  // 00:05 Nairobi: reconciliation, ledger invariants and yesterday's close. 1st of the month: the monthly summary.
  every("nightly", 60_000, async () => {
    if (nairobiTime() < "00:05") return;
    const today = nairobiDate();
    const ran = await one(db(), `select 1 from reconciliation_runs where trigger = 'nightly' and started_at >= $1`, [nairobiInstant(today)]);
    if (ran) return;
    await runReconciliation("nightly");
    const inv = await checkInvariants(db());
    if (!inv.ok) await raise(db(), { type: "ledger_invariant", severity: "critical", title: "Ledger invariant check failed", detail: inv.problems.slice(0, 5).join("; "), dedupeKey: "ledger_invariant" });
    else await autoResolve(db(), "ledger_invariant", "Invariants hold");
    await runDailyClose(addDays(today, -1));
    if (today.endsWith("-01")) await runMonthlySummary();
  });
  every("cleanup", 6 * 3600_000, async () => {
    await db().query(`delete from idempotency_keys where created_at < now() - interval '7 days'`);
    await db().query(`delete from jobs where status = 'done' and done_at < now() - interval '7 days'`);
    await db().query(`delete from otp_codes where created_at < now() - interval '2 days'`);
    await db().query(`delete from webauthn_challenges where expires_at < now() - interval '1 day'`);
    await db().query(`delete from sessions where (revoked_at is not null and revoked_at < now() - interval '30 days') or expires_at < now() - interval '30 days'`);
  });
}
