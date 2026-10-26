import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import mqtt from "mqtt";
import { addTable, boot, Client, connectDevice, inviteAdmin, onboardMerchant, pay, reauth, waitFor, type World } from "./helpers.js";
import { buildCommand, checkCommand, sign } from "../src/devices/protocol.js";
import type { VirtualDevice } from "../src/devices/simulator.js";
import { db } from "../src/config/db.js";

let w: World;
let m: Awaited<ReturnType<typeof onboardMerchant>>;
let t1: Awaited<ReturnType<typeof addTable>>;
let t2: Awaited<ReturnType<typeof addTable>>;
let dev: VirtualDevice;

before(async () => {
  w = await boot();
  m = await onboardMerchant(w, { name: "Secure Venue" });
  t1 = await addTable(w, m.id, "One");
  t2 = await addTable(w, m.id, "Two");
  await w.admin.patch(`/v1/a/tables/${t1.tableId}`, { unlockSeconds: 5 });
  dev = await connectDevice(w, t1.cred);
});
after(async () => {
  await dev?.close();
  await w?.stop();
});

describe("first-admin setup key", () => {
  const body = (setupToken: string) => ({ setupToken, email: "second@aura.test", name: "Second", password: "a long enough password" });
  it("accepts the key pasted as the whole line, with stray whitespace", async () => {
    // The key is checked before "already set up", so a 409 means the key itself was accepted.
    const c = new Client(w.url, "admin");
    for (const k of ["ADMIN_SETUP_TOKEN=test-setup-token", " test-setup-token\r\n", '"test-setup-token"']) {
      await c.post("/v1/auth/admin/setup", body(k), 409);
    }
  });
  it("still refuses a wrong key", async () => {
    const c = new Client(w.url, "admin");
    await c.post("/v1/auth/admin/setup", body("test-setup-tokenx"), 403);
    await c.post("/v1/auth/admin/setup", body("OTHER_NAME=test-setup-token"), 403);
  });
});

describe("signed commands", () => {
  const secret = "device-secret-for-tests";
  const now = new Date();
  it("accepts a fresh, correctly signed command", () => {
    const c = buildCommand("c1", 20, now, new Date(now.getTime() + 60_000), secret);
    assert.deepEqual(checkCommand(c, secret, Math.floor(Date.now() / 1000), []), { ok: true });
  });
  it("rejects a tampered command (bad HMAC)", () => {
    const c = buildCommand("c1", 20, now, new Date(now.getTime() + 60_000), secret);
    assert.deepEqual(checkCommand({ ...c, duration_s: 60 }, secret, Math.floor(Date.now() / 1000), []), { ok: false, reason: "bad_signature" });
    assert.deepEqual(checkCommand(c, "another-secret", Math.floor(Date.now() / 1000), []), { ok: false, reason: "bad_signature" });
  });
  it("rejects a replayed command id and an expired command", () => {
    const c = buildCommand("c2", 20, now, new Date(now.getTime() + 60_000), secret);
    assert.deepEqual(checkCommand(c, secret, Math.floor(Date.now() / 1000), ["c2"]), { ok: false, reason: "duplicate" });
    const old = buildCommand("c3", 20, new Date(now.getTime() - 120_000), new Date(now.getTime() - 60_000), secret);
    assert.deepEqual(checkCommand(old, secret, Math.floor(Date.now() / 1000), []), { ok: false, reason: "expired" });
  });
  it("signs the documented canonical string", () => {
    const base = { cmd_id: "x", action: "unlock" as const, duration_s: 20, issued_at: 1, expires_at: 61, nonce: "n" };
    assert.equal(sign(base, "k").length, 64);
  });
});

describe("the broker", () => {
  const url = () => `${w.url.replace("http", "ws")}/mqtt`;
  const connect = (username: string, password: string) =>
    new Promise<mqtt.MqttClient>((resolve, reject) => {
      const c = mqtt.connect(url(), { clientId: username, username, password, reconnectPeriod: 0, connectTimeout: 5000 });
      c.once("connect", () => resolve(c));
      c.once("error", (e) => {
        c.end(true);
        reject(e);
      });
    });

  it("refuses a device with the wrong password", async () => {
    await assert.rejects(connect(t2.cred.deviceId, "wrong-password"));
  });

  it("won't let a device subscribe to another table's commands", async () => {
    const c = await connect(t2.cred.deviceId, t2.cred.mqtt.password);
    // mqtt.js reports a SUBACK of 0x80 as an error.
    const err = await new Promise<Error | null>((res) => c.subscribe(`pool/${t1.tableId}/cmd`, { qos: 1 }, (e) => res(e ?? null)));
    assert.match(String(err?.message), /Subscribe error/, "subscription refused");
    const own = await new Promise<Error | null>((res) => c.subscribe(`pool/${t2.tableId}/cmd`, { qos: 1 }, (e) => res(e ?? null)));
    assert.equal(own, null, "its own command topic is allowed");
    // Publishing as another table is silently dropped: T001 stays as it is.
    c.publish(`pool/${t1.tableId}/status`, JSON.stringify({ online: false }), { qos: 1 });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await w.admin.get(`/v1/a/tables/${t1.tableId}`)).device.online, true);
    c.end(true);
  });

  it("revoked credentials stop working", async () => {
    await w.admin.post(`/v1/a/devices/${t2.cred.deviceId}/revoke`, { reason: "Stolen controller" });
    await assert.rejects(connect(t2.cred.deviceId, t2.cred.mqtt.password));
  });
});

describe("callbacks", () => {
  it("answers 404 without the secret path", async () => {
    const r = await fetch(`${w.url}/cb/daraja/c2b/not-the-secret/confirmation`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ TransID: "ABC123456", TransAmount: "50", BusinessShortCode: "600000", BillRefNumber: "T001" }) });
    assert.equal(r.status, 404);
  });
  it("rejects a malformed payload", async () => {
    const r = await fetch(`${w.url}/cb/daraja/c2b/test-callback-secret/confirmation`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ hello: "world" }) });
    assert.equal(r.status, 400);
  });
});

describe("sessions and sign-in", () => {
  it("requires the client header on writes (CSRF)", async () => {
    const r = await fetch(`${w.url}/v1/m/me/tour-done`, { method: "POST", headers: { Cookie: [...m.owner.cookies].map(([k, v]) => `${k}=${v}`).join("; ") } });
    assert.equal(r.status, 403);
  });

  it("locks a merchant after five wrong PINs", async () => {
    const c = new Client(w.url, "merchant");
    for (let i = 0; i < 4; i++) assert.equal((await c.call("POST", "/v1/auth/login", { phone: m.phone, pin: "000000" })).status, 400);
    const fifth = await c.call("POST", "/v1/auth/login", { phone: m.phone, pin: "000000" });
    assert.equal(fifth.status, 423);
    const right = await c.call("POST", "/v1/auth/login", { phone: m.phone, pin: m.pin });
    assert.equal(right.status, 423, "still locked for 15 minutes");
    await db().query(`update merchant_users set locked_until = null where phone = '254' || substr($1, 2)`, [m.phone]);
  });

  it("revokes the session when a rotated refresh token is replayed", async () => {
    const c = new Client(w.url, "merchant");
    await c.post("/v1/auth/login", { phone: m.phone, pin: m.pin });
    const stolen = c.cookies.get("aura_m_rt")!;
    await c.post("/v1/auth/refresh");
    await db().query(`update sessions set rotated_at = now() - interval '1 minute' where refresh_hash is not null`);
    const thief = new Client(w.url, "merchant");
    thief.cookies.set("aura_m_rt", stolen);
    assert.equal((await thief.call("POST", "/v1/auth/refresh")).status, 401);
    // The real device is signed out too.
    assert.equal((await c.call("POST", "/v1/auth/refresh")).status, 401);
  });

  it("locks an admin after repeated failed sign-ins and raises an alert", async () => {
    const c = new Client(w.url, "admin");
    for (let i = 0; i < 5; i++) await c.call("POST", "/v1/auth/login/admin", { email: "owner@aura.test", password: "nope nope nope" });
    const r = await c.call("POST", "/v1/auth/login/admin", { email: "owner@aura.test", password: w.adminPassword });
    assert.equal(r.status, 423);
    const alerts = (await w.admin.get("/v1/a/alerts")).items as any[];
    assert.ok(alerts.some((a) => a.type === "failed_logins"));
    await db().query(`update admin_users set locked_until = null, failed_attempts = 0 where email = 'owner@aura.test'`);
  });
});

describe("roles", () => {
  it("support can't approve payouts, change commission or change roles", async () => {
    const s = await inviteAdmin(w, "support", "s2@aura.test");
    assert.equal((await s.call("POST", "/v1/a/pricing/commission", { scope: "default", commissionMinor: 1000, reason: "test change" })).status, 403);
    const users = (await w.admin.get("/v1/a/users")).users as any[];
    assert.equal((await s.call("POST", `/v1/a/users/${users[0].id}/role`, { role: "auditor", reason: "test change" })).status, 403);
    assert.equal((await s.call("POST", "/v1/a/kill-switch/engage", { reason: "test change" })).status, 403);
    assert.equal((await s.call("GET", "/v1/a/ledger/accounts")).status, 403);
    assert.equal((await s.call("GET", "/v1/a/payments")).status, 200);
  });

  it("an auditor reads the audit log and changes nothing", async () => {
    const a = await inviteAdmin(w, "auditor", "audit@aura.test");
    const log = await a.get("/v1/a/audit");
    assert.ok(log.items.some((e: any) => e.action === "admin.login_failed"));
    assert.equal((await a.call("POST", "/v1/a/merchants", { businessName: "X", ownerName: "Y", phone: "0700999888" })).status, 403);
    assert.equal((await a.call("PUT", "/v1/a/settings/payout", { value: {} })).status, 403);
  });

  it("finance can't change settings or devices", async () => {
    const f = await inviteAdmin(w, "finance", "f2@aura.test");
    await reauth(f, "another long password here");
    assert.equal((await f.call("PUT", "/v1/a/settings/payout", { value: {} })).status, 403);
    assert.equal((await f.call("POST", `/v1/a/tables/${t1.tableId}/status`, { status: "disabled", reason: "test change" })).status, 403);
  });

  it("the audit log can't be edited by anyone, even the database role", async () => {
    await assert.rejects(db().query(`update audit_log set action = 'x'`), /append-only/);
    await assert.rejects(db().query(`delete from audit_log`), /append-only/);
  });
});

describe("attendants", () => {
  it("see today's games and table status, never money, and are limited on manual unlocks", async () => {
    const staff = await m.owner.post("/v1/m/staff", { name: "Otieno", phone: "0745123987" });
    const token = String(staff.inviteLink).split("/invite/")[1];
    const s = new Client(w.url, "merchant");
    const otp = await s.post("/v1/auth/otp/request", { inviteToken: token, pin: "902172", pinConfirm: "902172" });
    await s.post("/v1/auth/otp/verify", { inviteToken: token, code: otp.otp.testCode, acceptTerms: true });
    await pay(w, t1.tableId, 50);
    await waitFor(async () => (await m.owner.get("/v1/m/dashboard")).today.games >= 1, "a game");
    const home = await s.get("/v1/m/dashboard");
    assert.equal(home.balance, null);
    assert.equal(home.today.earningsMinor, undefined);
    assert.equal(home.recentPayments[0].amountMinor, undefined);
    assert.equal((await s.call("GET", "/v1/m/money")).status, 403);
    assert.equal((await s.call("GET", "/v1/m/stats")).status, 403);
    assert.equal((await s.call("POST", "/v1/m/payouts", { pin: "902172" }, { idem: "staff-try-123" })).status, 403);
    const tbl = await s.get(`/v1/m/tables/${t1.tableId}`);
    assert.equal(tbl.figures.today.earningsMinor, undefined);
    const r = await s.post(`/v1/m/tables/${t1.tableId}/unlock`, { reason: "Customer paid cash", pin: "902172" });
    assert.ok(r.cmdId);
    await w.admin.patch(`/v1/a/merchants/${m.id}`, { manualUnlockDailyLimit: 1 });
    const second = await s.call("POST", `/v1/m/tables/${t1.tableId}/unlock`, { reason: "Customer paid cash", pin: "902172" });
    assert.equal(second.status, 403);
    assert.equal(second.body.error.code, "manual_limit");
    // The owner sees what the attendant did.
    const act = await m.owner.get(`/v1/m/staff/${staff.id}/activity`);
    assert.ok(act.unlocks.length >= 1);
  });
});

describe("impersonation", () => {
  it("gives a read-only view of a merchant, with an audit entry", async () => {
    const imp = await w.admin.post("/v1/a/impersonations", { merchantId: m.id, reason: "Owner asked why a payment is waiting" });
    const home = await w.admin.get(`/v1/a/impersonations/${imp.id}/m/dashboard`);
    assert.equal(home.businessName, "Secure Venue");
    const write = await w.admin.call("POST", `/v1/a/impersonations/${imp.id}/m/payouts`, { pin: "000000" }, { idem: "imp-write-123" });
    assert.equal(write.status, 403);
    const log = await w.admin.get(`/v1/a/audit?action=impersonation`);
    assert.ok(log.items.length >= 1);
  });
});
