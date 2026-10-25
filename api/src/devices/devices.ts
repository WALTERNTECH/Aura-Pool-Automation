import { db, many, one, type Q } from "../config/db.js";
import { env } from "../config/env.js";
import { decrypt, encrypt, hashSecret, randomToken, safeEqual, shortRef } from "../lib/crypto.js";
import { conflict, notFound } from "../lib/http.js";
import { autoResolve, raise } from "../services/alerts.js";
import { audit, type AuditWho } from "../services/audit.js";
import { notifyMerchant } from "../services/notify.js";
import { getSetting } from "../services/settings.js";
import { topics, type DeviceEvent, type Status } from "./protocol.js";

// The device registry: provisioning, sign-in checks, heartbeats, online/offline, and the
// manual override button log. The ESP32 itself never decides anything except a local
// override press; every paid unlock is a signed command from here.

export const HEARTBEAT_S = 30;
export const OFFLINE_AFTER_S = 90;

export type DeviceRow = {
  id: string;
  table_id: string | null;
  status: string;
  credential_hash: string | null;
  hmac_secret_enc: string | null;
  virtual: boolean;
  virtual_password_enc: string | null;
  online: boolean;
  last_seen_at: Date | null;
  online_changed_at: Date | null;
  firmware_version: string | null;
  rssi: number | null;
};

/** MQTT sign-in: username is the device id, which must also be the client id. */
export async function authenticateDevice(username: string, password: string) {
  if (!/^D[A-Z0-9]{6,12}$/.test(username) || !password) return null;
  const d = await one<DeviceRow>(db(), `select * from devices where id = $1`, [username]);
  if (!d || d.status !== "provisioned" || !d.table_id || !d.credential_hash) return null;
  if (!safeEqual(hashSecret(password), d.credential_hash)) return null;
  return { deviceId: d.id, tableId: d.table_id };
}

export async function deviceSecret(q: Q, tableId: string): Promise<{ deviceId: string; secret: string } | null> {
  const d = await one<{ id: string; hmac_secret_enc: string | null }>(q, `select id, hmac_secret_enc from devices where table_id = $1 and status = 'provisioned'`, [tableId]);
  if (!d?.hmac_secret_enc) return null;
  return { deviceId: d.id, secret: decrypt(d.hmac_secret_enc) };
}

export type Provisioned = {
  deviceId: string;
  tableId: string;
  mqtt: { url: string; username: string; password: string; clientId: string; topics: ReturnType<typeof topics> };
  hmacSecret: string;
  shownOnce: true;
};

/**
 * Issues fresh credentials and an HMAC secret for a table's device. They are returned once,
 * for flashing; only a hash of the password and the sealed secret are kept.
 */
export async function provisionDevice(q: Q, tableId: string, opts: { virtual?: boolean; replace?: boolean }, who: AuditWho): Promise<Provisioned> {
  const t = await one<{ id: string }>(q, `select id from pool_tables where id = $1`, [tableId]);
  if (!t) throw notFound("Table not found");
  const existing = await one<DeviceRow>(q, `select * from devices where table_id = $1 for update`, [tableId]);
  const password = randomToken(24);
  const secret = randomToken(32);
  const virtual = Boolean(opts.virtual) && env.device.virtualDevices;
  let deviceId: string;
  if (existing && !opts.replace) {
    deviceId = existing.id;
    await q.query(
      `update devices set status = 'provisioned', credential_hash = $2, hmac_secret_enc = $3, credential_version = credential_version + 1,
              virtual = $4, virtual_password_enc = $5, provisioned_at = now() where id = $1`,
      [deviceId, hashSecret(password), encrypt(secret), virtual, virtual ? encrypt(password) : null],
    );
    await audit(q, who, "device.reprovision", { type: "device", id: deviceId }, { table: tableId }, { table: tableId, virtual });
  } else {
    if (existing) {
      await q.query(`update devices set status = 'retired', table_id = null, credential_hash = null, hmac_secret_enc = null, virtual_password_enc = null, online = false where id = $1`, [existing.id]);
      await audit(q, who, "device.retire", { type: "device", id: existing.id }, { table: tableId }, { table: null, reason: "replaced" });
    }
    deviceId = shortRef("D", 8);
    await q.query(
      `insert into devices (id, table_id, status, credential_hash, hmac_secret_enc, credential_version, virtual, virtual_password_enc, provisioned_at)
       values ($1,$2,'provisioned',$3,$4,1,$5,$6,now())`,
      [deviceId, tableId, hashSecret(password), encrypt(secret), virtual, virtual ? encrypt(password) : null],
    );
    await audit(q, who, existing ? "device.replace" : "device.provision", { type: "device", id: deviceId }, existing ? { device: existing.id } : null, { table: tableId, virtual });
  }
  return { deviceId, tableId, mqtt: { url: env.device.publicMqttUrl, username: deviceId, password, clientId: deviceId, topics: topics(tableId) }, hmacSecret: secret, shownOnce: true };
}

export async function revokeDevice(q: Q, deviceId: string, who: AuditWho) {
  const d = await one<DeviceRow>(q, `select * from devices where id = $1 for update`, [deviceId]);
  if (!d) throw notFound("Device not found");
  if (d.status === "revoked") throw conflict("Already revoked");
  await q.query(`update devices set status = 'revoked', credential_hash = null, hmac_secret_enc = null, virtual_password_enc = null, online = false, online_changed_at = now() where id = $1`, [deviceId]);
  await audit(q, who, "device.revoke", { type: "device", id: deviceId }, { status: d.status }, { status: "revoked" });
}

/** Credentials for in-process virtual devices only. */
export async function virtualDeviceCredentials(): Promise<{ deviceId: string; tableId: string; password: string; secret: string }[]> {
  if (!env.device.virtualDevices) return [];
  const rows = await many<DeviceRow>(db(), `select * from devices where virtual and status = 'provisioned' and table_id is not null and virtual_password_enc is not null`);
  return rows.map((d) => ({ deviceId: d.id, tableId: d.table_id!, password: decrypt(d.virtual_password_enc!), secret: decrypt(d.hmac_secret_enc!) }));
}

// ------------------------------------------------------------------ incoming

let onOnline: (tableId: string) => void = () => {};
export function whenOnline(fn: (tableId: string) => void) {
  onOnline = fn;
}

export async function handleStatus(tableId: string, s: Status, deviceId: string | null) {
  const d = await one<DeviceRow & { merchant_id: string }>(
    db(),
    `select d.*, t.merchant_id from devices d join pool_tables t on t.id = d.table_id where d.table_id = $1 and d.status = 'provisioned'`,
    [tableId],
  );
  if (!d || (deviceId && d.id !== deviceId)) return;
  if (s.online === false) return markOffline(d.id, "last will");
  await db().query(
    `update devices set last_seen_at = now(), firmware_version = coalesce($2, firmware_version), rssi = coalesce($3, rssi),
            uptime_s = coalesce($4, uptime_s), relay_state = coalesce($5, relay_state), ip = coalesce($6, ip),
            online = true, online_changed_at = case when online then online_changed_at else now() end
      where id = $1`,
    [d.id, s.fw ?? null, Number.isFinite(s.rssi) ? Math.round(s.rssi!) : null, Number.isFinite(s.uptime_s) ? Math.round(s.uptime_s!) : null, s.relay ?? null, s.ip ?? null],
  );
  if (!d.online) {
    await db().query(`insert into device_events (device_id, table_id, type, payload) values ($1,$2,'online',$3)`, [d.id, tableId, JSON.stringify({ fw: s.fw ?? null })]);
    // A table "goes live" the first time its device connects while it is active; Since-started counts from here.
    await db().query(`update pool_tables set started_at = now() where id = $1 and started_at is null and status = 'active'`, [tableId]);
    const wasAlerted = await autoResolve(db(), `offline:${tableId}`, "Heartbeat received");
    if (wasAlerted) {
      await notifyMerchant(db(), d.merchant_id, { type: "table_online", title: `${tableId} is back online`, body: "Payments will unlock the table again.", url: `/tables/${tableId}` });
    }
    onOnline(tableId);
  }
}

export async function markOffline(deviceId: string, why: string) {
  const d = await one<{ table_id: string | null; online: boolean }>(db(), `update devices set online = false, online_changed_at = now() where id = $1 and online returning table_id, online`, [deviceId]);
  if (d?.table_id) await db().query(`insert into device_events (device_id, table_id, type, payload) values ($1,$2,'offline',$3)`, [deviceId, d.table_id, JSON.stringify({ why })]);
}

/** Every 15 s: a device silent for 90 s is offline; one offline past the threshold raises the alarm. */
export async function sweepDevices() {
  const silent = await many<{ id: string }>(db(), `select id from devices where online and status = 'provisioned' and (last_seen_at is null or last_seen_at < now() - interval '${OFFLINE_AFTER_S} seconds')`);
  for (const s of silent) await markOffline(s.id, "no heartbeat");
  const rules = await getSetting("alert_rules");
  const long = await many<{ id: string; table_id: string; merchant_id: string; name: string; online_changed_at: Date | null; last_seen_at: Date | null }>(
    db(),
    `select d.id, d.table_id, t.merchant_id, t.name, d.online_changed_at, d.last_seen_at
       from devices d join pool_tables t on t.id = d.table_id
      where d.status = 'provisioned' and not d.online and t.status = 'active'
        and coalesce(d.online_changed_at, d.provisioned_at) < now() - ($1 || ' minutes')::interval`,
    [String(rules.offline_minutes)],
  );
  for (const t of long) {
    const key = `offline:${t.table_id}`;
    const fresh = !(await one(db(), `select 1 from alerts where dedupe_key = $1 and status <> 'resolved'`, [key]));
    await raise(db(), {
      type: "table_offline",
      severity: "warning",
      title: `${t.table_id} ${t.name} is offline`,
      detail: t.last_seen_at ? `Last heard from ${Math.round((Date.now() - new Date(t.last_seen_at).getTime()) / 60_000)} minutes ago.` : "It has never connected.",
      dedupeKey: key,
      entity: { type: "table", id: t.table_id },
    });
    if (fresh) {
      await notifyMerchant(db(), t.merchant_id, {
        type: "table_offline",
        title: `${t.table_id} ${t.name} is offline`,
        body: "Customers who pay now will wait until it reconnects. Check its power and Wi-Fi.",
        sms: `${t.table_id} ${t.name} has been offline for over ${rules.offline_minutes} minutes. Check its power and Wi-Fi.`,
        url: `/tables/${t.table_id}`,
      });
    }
  }
}

export async function handleEvent(tableId: string, e: DeviceEvent, deviceId: string | null) {
  const d = await one<{ id: string; merchant_id: string; name: string }>(
    db(),
    `select d.id, t.merchant_id, t.name from devices d join pool_tables t on t.id = d.table_id where d.table_id = $1 and d.status = 'provisioned'`,
    [tableId],
  );
  if (!d || (deviceId && d.id !== deviceId)) return;
  const type = String(e?.type ?? "unknown").slice(0, 40);
  const ts = Number.isFinite(e?.ts) ? new Date(Number(e.ts) * 1000) : null;
  await db().query(`insert into device_events (device_id, table_id, type, payload, device_ts) values ($1,$2,$3,$4,$5)`, [d.id, tableId, type, JSON.stringify(e ?? {}), ts]);
  await db().query(`update devices set last_seen_at = now() where id = $1`, [d.id]);
  if (type !== "manual_override") return;
  const rules = await getSetting("alert_rules");
  const c = await one<{ n: number }>(db(), `select count(*)::int as n from device_events where table_id = $1 and type = 'manual_override' and at > now() - interval '1 hour'`, [tableId]);
  if ((c?.n ?? 0) > rules.override_presses_per_hour) {
    const hour = new Date().toISOString().slice(0, 13);
    const key = `override:${tableId}:${hour}`;
    const fresh = !(await one(db(), `select 1 from alerts where dedupe_key = $1`, [key]));
    await raise(db(), {
      type: "override_unusual",
      severity: "warning",
      title: `Override button on ${tableId} pressed ${c!.n} times this hour`,
      detail: `The limit is ${rules.override_presses_per_hour} an hour. Each press releases the balls without payment.`,
      dedupeKey: key,
      entity: { type: "table", id: tableId },
    });
    if (fresh) {
      await notifyMerchant(db(), d.merchant_id, { type: "override_unusual", title: `Override button used ${c!.n} times on ${tableId}`, body: "Each press releases the balls without payment. Check who is using it.", url: `/tables/${tableId}` });
    }
  }
}

export async function onDeviceGone(deviceId: string) {
  // A clean disconnect has no last will; mark it now rather than waiting 90 s.
  await markOffline(deviceId, "disconnected").catch(() => {});
}
