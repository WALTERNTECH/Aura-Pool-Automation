import { randomUUID } from "node:crypto";
import { db, many, one, type Q } from "../config/db.js";
import { deviceSecret } from "../devices/devices.js";
import { buildCommand, topics, type Ack } from "../devices/protocol.js";
import type { DeviceTransport } from "../devices/transport.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/http.js";
import { formatKsh, nairobiDate, nairobiInstant } from "../lib/kenya.js";
import { autoResolve, raise } from "./alerts.js";
import { audit, type AuditWho } from "./audit.js";
import { enqueue, onJob } from "./jobs.js";
import { notifyMerchant } from "./notify.js";
import { getSetting } from "./settings.js";

// Unlock dispatch (spec 6.5, 6.7, 9). Each table runs one command at a time: the next game
// is sent only after the previous unlock has finished. A command is signed for the table's
// device and expires after 60 s. No ack in 10 s: resend once with the same cmd_id (a device
// that already ran it answers "duplicate", which counts as delivered), then mark it failed.
// A game credit keeps waiting for its table for 15 minutes, then expires and both the owner
// and the admin are told.

export const ACK_TIMEOUT_MS = 10_000;
const BUSY_RETRY_MS = 5_000;
let transport: DeviceTransport | null = null;

export function setTransport(t: DeviceTransport | null) {
  transport = t;
}

const pendingKicks = new Set<string>();
export function kickDispatch(tableId: string) {
  if (pendingKicks.has(tableId)) return;
  pendingKicks.add(tableId);
  setImmediate(() => {
    pendingKicks.delete(tableId);
    dispatchTable(tableId).catch((e) => console.error(`[unlock] dispatch ${tableId}:`, (e as Error).message));
  });
}

onJob("unlock.dispatch", async (p) => {
  await dispatchTable(String(p.tableId));
});

type Cmd = { cmd_id: string; table_id: string; game_credit_id: string | null; source: string; duration_s: number; nonce: string; issued_at: Date; expires_at: Date; status: string; attempts: number; sent_at: Date | null };

/** Sends the next unlock for a table, if its device is online and nothing is running. */
export async function dispatchTable(tableId: string): Promise<string | null> {
  const toSend = await db().tx(async (q) => {
    const t = await one<{ id: string; unlock_seconds: number; status: string }>(q, `select id, unlock_seconds, status from pool_tables where id = $1 for update`, [tableId]);
    if (!t) return null;
    const dev = await one<{ id: string; online: boolean }>(q, `select id, online from devices where table_id = $1 and status = 'provisioned'`, [tableId]);
    if (!dev?.online) return null;

    const running = await one<{ cmd_id: string; status: string; finishes_at: Date | null; sent_at: Date | null }>(
      q,
      `select cmd_id, status, finishes_at, sent_at from unlock_commands
        where table_id = $1 and (status in ('sent','busy') or (status = 'acked' and finishes_at > now()))
        order by issued_at desc limit 1`,
      [tableId],
    );
    if (running) return null;

    // Manual and test unlocks are queued as commands; paid games as credits. Oldest first.
    let cmd = await one<Cmd>(q, `select * from unlock_commands where table_id = $1 and status = 'queued' and expires_at > now() order by issued_at limit 1 for update`, [tableId]);
    const credit = await one<{ id: string; created_at: Date }>(
      q,
      `select id, created_at from game_credits where table_id = $1 and status = 'pending' and expires_at > now() order by created_at limit 1 for update skip locked`,
      [tableId],
    );
    if (credit && (!cmd || new Date(credit.created_at) < new Date(cmd.issued_at))) {
      if (t.status !== "active") return null;
      const now = new Date();
      cmd = (await one<Cmd>(
        q,
        `insert into unlock_commands (cmd_id, table_id, device_id, game_credit_id, source, duration_s, nonce, issued_at, expires_at)
         values ($1,$2,$3,$4,'payment',$5,$6,$7,$8) returning *`,
        [randomUUID(), tableId, dev.id, credit.id, t.unlock_seconds, randomUUID().replace(/-/g, "").slice(0, 16), now, new Date(now.getTime() + 60_000)],
      ))!;
      await q.query(`update game_credits set status = 'dispatched', dispatched_at = now(), attempts = attempts + 1 where id = $1`, [credit.id]);
    }
    if (!cmd) return null;
    await q.query(`update unlock_commands set status = 'sent', sent_at = now(), attempts = attempts + 1, device_id = $2 where cmd_id = $1`, [cmd.cmd_id, dev.id]);
    return cmd.cmd_id;
  });
  if (toSend) await publish(toSend);
  return toSend;
}

async function publish(cmdId: string) {
  const c = await one<Cmd>(db(), `select * from unlock_commands where cmd_id = $1`, [cmdId]);
  if (!c) return;
  const sec = await deviceSecret(db(), c.table_id);
  if (!sec || !transport) {
    await db().query(`update unlock_commands set status = 'queued' where cmd_id = $1 and status = 'sent'`, [cmdId]);
    return;
  }
  const payload = buildCommand(c.cmd_id, c.duration_s, new Date(c.issued_at), new Date(c.expires_at), sec.secret, c.nonce);
  try {
    await transport.publish(topics(c.table_id).cmd, payload);
  } catch (e) {
    console.error(`[unlock] publish ${cmdId}:`, (e as Error).message);
  }
  // The ack, or the timeout sweep, decides what happens next.
  await enqueue(db(), "unlock.timeout", { cmdId, attempt: c.attempts }, { runAt: new Date(Date.now() + ACK_TIMEOUT_MS + 200) });
}

onJob("unlock.timeout", async (p) => checkTimeout(String(p.cmdId), Number(p.attempt)));

async function checkTimeout(cmdId: string, attempt: number) {
  const c = await one<Cmd>(db(), `select * from unlock_commands where cmd_id = $1`, [cmdId]);
  if (!c || c.status !== "sent" || c.attempts !== attempt) return;
  if (Date.now() - new Date(c.sent_at!).getTime() < ACK_TIMEOUT_MS) return;
  if (c.attempts < 2 && new Date(c.expires_at).getTime() > Date.now() + 2_000) {
    await db().query(`update unlock_commands set attempts = attempts + 1, sent_at = now() where cmd_id = $1 and status = 'sent'`, [cmdId]);
    return publish(cmdId);
  }
  await failCommand(cmdId, "timeout", "No acknowledgement from the table");
}

/** The command did not run. A paid game goes back in the queue until its window ends. */
async function failCommand(cmdId: string, status: "timeout" | "failed" | "rejected", reason: string) {
  const tableId = await db().tx(async (q) => {
    const c = await one<Cmd>(q, `update unlock_commands set status = $2, ack_reason = coalesce(ack_reason, $3) where cmd_id = $1 and status in ('sent','busy','queued') returning *`, [cmdId, status, reason]);
    if (!c) return null;
    if (c.game_credit_id) {
      const credit = await one<{ attempts: number; payment_id: string }>(q, `update game_credits set status = 'pending' where id = $1 and status = 'dispatched' returning attempts, payment_id`, [c.game_credit_id]);
      if (credit && credit.attempts >= 3) {
        await raise(q, { type: "unlock_failed", severity: "warning", title: `Unlocks on ${c.table_id} are failing`, detail: `${reason} (${credit.attempts} tries).`, dedupeKey: `unlock_failed:${c.table_id}`, entity: { type: "table", id: c.table_id } });
      }
    }
    return c.table_id;
  });
  if (tableId) kickDispatch(tableId);
}

export async function handleAck(tableId: string, ack: Ack) {
  if (!ack || typeof ack.cmd_id !== "string") return;
  const next = await db().tx(async (q) => {
    const c = await one<Cmd>(q, `select * from unlock_commands where cmd_id = $1 and table_id = $2 for update`, [ack.cmd_id, tableId]);
    if (!c) {
      await q.query(`insert into device_events (table_id, type, payload) values ($1,'unknown_ack',$2)`, [tableId, JSON.stringify(ack)]);
      return null;
    }
    if (c.status === "acked") return null;
    const reason = String(ack.reason ?? "").slice(0, 80) || null;
    // A resend the device had already run comes back as a duplicate: it was delivered.
    const delivered = ack.result === "ok" || (ack.result === "rejected" && reason === "duplicate" && c.attempts > 1);
    if (delivered) {
      await q.query(
        `update unlock_commands set status = 'acked', ack_at = now(), ack_result = $2, ack_reason = $3, finishes_at = now() + (duration_s || ' seconds')::interval where cmd_id = $1`,
        [c.cmd_id, ack.result, reason],
      );
      if (c.game_credit_id) await q.query(`update game_credits set status = 'acked', acked_at = now() where id = $1`, [c.game_credit_id]);
      await autoResolve(q, `unlock_failed:${tableId}`, "An unlock succeeded");
      await enqueue(q, "unlock.dispatch", { tableId }, { runAt: new Date(Date.now() + c.duration_s * 1000 + 500) });
      return null;
    }
    if (ack.result === "busy") {
      await q.query(`update unlock_commands set status = 'busy', ack_result = 'busy', ack_reason = $2 where cmd_id = $1`, [c.cmd_id, reason]);
      await enqueue(q, "unlock.busy", { cmdId: c.cmd_id }, { runAt: new Date(Date.now() + BUSY_RETRY_MS) });
      return null;
    }
    await q.query(`update unlock_commands set ack_result = 'rejected', ack_reason = $2 where cmd_id = $1`, [c.cmd_id, reason]);
    return { cmdId: c.cmd_id, reason: reason ?? "rejected" };
  });
  if (next) await failCommand(next.cmdId, "rejected", `Table refused the command (${next.reason})`);
}

onJob("unlock.busy", async (p) => {
  const c = await one<Cmd>(db(), `update unlock_commands set status = 'sent', sent_at = now() where cmd_id = $1 and status = 'busy' and expires_at > now() + interval '2 seconds' returning *`, [p.cmdId]);
  if (c) return publish(c.cmd_id);
  const stale = await one<Cmd>(db(), `select * from unlock_commands where cmd_id = $1 and status = 'busy'`, [p.cmdId]);
  if (stale) await failCommand(stale.cmd_id, "failed", "Table stayed busy until the command expired");
});

/** Every 30 s: game credits past their window expire; commands stuck queued expire too. */
export async function expireCredits() {
  const expired = await many<{ id: string; payment_id: string; table_id: string; merchant_id: string; amount_minor: number; txn: string }>(
    db(),
    `with e as (
       update game_credits set status = 'expired' where status in ('pending','dispatched') and expires_at <= now() returning id, payment_id, table_id, merchant_id
     )
     select e.*, p.amount_minor, p.provider_txn_id as txn from e join payments p on p.id = e.payment_id`,
  );
  const byPayment = new Map<string, (typeof expired)[number]>();
  for (const e of expired) byPayment.set(e.payment_id, e);
  for (const e of byPayment.values()) {
    await raise(db(), {
      type: "credit_expired",
      severity: "warning",
      title: `Paid game on ${e.table_id} did not unlock`,
      detail: `Payment ${e.txn} (${formatKsh(e.amount_minor)}). Send a manual unlock or mark it for refund.`,
      dedupeKey: `expired:${e.payment_id}`,
      entity: { type: "payment", id: e.payment_id },
    });
    await notifyMerchant(db(), e.merchant_id, {
      type: "payment_attention",
      title: `Paid, table did not unlock (${e.table_id})`,
      body: `${formatKsh(e.amount_minor)} from ${e.txn}. Our team has been alerted and will unlock it or refund the customer.`,
      url: `/payments/${e.payment_id}`,
    });
  }
  await db().query(`update unlock_commands set status = 'failed', ack_reason = coalesce(ack_reason, 'expired before it could be sent') where status = 'queued' and expires_at <= now()`);
  // Belt and braces: commands still "sent" well past their ack window.
  const stuck = await many<{ cmd_id: string }>(db(), `select cmd_id from unlock_commands where status = 'sent' and sent_at < now() - interval '30 seconds'`);
  for (const s of stuck) await failCommand(s.cmd_id, "timeout", "No acknowledgement from the table");
  return expired.length;
}

/** Re-sends for every table that has paid games waiting, e.g. after a restart. */
export async function sweepQueues() {
  const tables = await many<{ table_id: string }>(
    db(),
    `select distinct table_id from game_credits where status = 'pending' and expires_at > now()
     union select distinct table_id from unlock_commands where status = 'queued' and expires_at > now()`,
  );
  for (const t of tables) await dispatchTable(t.table_id);
}

// ------------------------------------------------------------------ manual and test unlocks

export type ManualSource = "manual_owner" | "manual_staff" | "manual_admin" | "test";

export async function manualUnlockCount(q: Q, tableId: string) {
  const start = nairobiInstant(nairobiDate());
  const r = await one<{ n: number }>(q, `select count(*)::int as n from unlock_commands where table_id = $1 and source in ('manual_owner','manual_staff') and issued_at >= $2 and status <> 'failed'`, [tableId, start]);
  return r?.n ?? 0;
}

export async function requestManualUnlock(q: Q, tableId: string, source: ManualSource, reason: string, who: AuditWho & { id: string; label: string }): Promise<string> {
  const t = await one<{ id: string; merchant_id: string; unlock_seconds: number; status: string }>(q, `select id, merchant_id, unlock_seconds, status from pool_tables where id = $1 for update`, [tableId]);
  if (!t) throw notFound("Table not found");
  if (!reason?.trim()) throw badRequest("Give a reason for the unlock");
  if (source === "manual_owner" || source === "manual_staff") {
    const s = await getSetting("manual_unlock", q);
    const m = await one<{ manual_unlock_daily_limit: number | null }>(q, `select manual_unlock_daily_limit from merchants where id = $1`, [t.merchant_id]);
    const limit = m?.manual_unlock_daily_limit ?? s.daily_limit;
    if (!s.reasons.includes(reason)) throw badRequest("Pick a reason from the list");
    if ((await manualUnlockCount(q, tableId)) >= limit) throw forbidden(`You've used all ${limit} manual unlocks for this table today`, "manual_limit");
    if (t.status === "disabled") throw conflict("This table is disabled");
  }
  const dev = await one<{ id: string }>(q, `select id from devices where table_id = $1 and status = 'provisioned'`, [tableId]);
  if (!dev) throw conflict("This table has no device yet");
  const now = new Date();
  const cmdId = randomUUID();
  await q.query(
    `insert into unlock_commands (cmd_id, table_id, device_id, source, reason, issued_by, issued_by_label, duration_s, nonce, issued_at, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [cmdId, tableId, dev.id, source, reason.slice(0, 200), who.id, who.label, t.unlock_seconds, randomUUID().replace(/-/g, "").slice(0, 16), now, new Date(now.getTime() + 60_000)],
  );
  await audit(q, who, source === "test" ? "table.test_unlock" : "table.manual_unlock", { type: "table", id: tableId }, null, { cmdId, reason, source });
  await enqueue(q, "unlock.dispatch", { tableId });
  return cmdId;
}

export async function commandStatus(q: Q, cmdId: string) {
  return one(q, `select cmd_id, table_id, source, reason, status, attempts, issued_at, sent_at, ack_at, ack_result, ack_reason, duration_s, finishes_at from unlock_commands where cmd_id = $1`, [cmdId]);
}
