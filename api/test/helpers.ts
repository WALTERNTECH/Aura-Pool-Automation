import "./env.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { pgliteDb } from "../src/config/db.js";
import { start, type Running } from "../src/boot.js";
import { VirtualDevice } from "../src/devices/simulator.js";
import { totpAt } from "../src/lib/crypto.js";
import { drainJobs, runPeriodicOnce } from "../src/services/jobs.js";
import { invalidateSettings } from "../src/services/settings.js";

export { drainJobs, runPeriodicOnce };

/** A browser: keeps its own cookies, sends the client header. */
export class Client {
  cookies = new Map<string, string>();
  constructor(
    readonly base: string,
    readonly kind: "merchant" | "admin" | "public" = "public",
  ) {}

  async call<T = any>(method: string, path: string, body?: unknown, opts: { idem?: string; expect?: number; raw?: boolean } = {}): Promise<{ status: number; body: T; text: string; headers: Headers }> {
    const headers: Record<string, string> = { "X-Aura-Client": this.kind };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idem) headers["Idempotency-Key"] = opts.idem;
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /Expires=Thu, 01 Jan 1970/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON */
    }
    if (opts.expect != null) assert.equal(res.status, opts.expect, `${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    return { status: res.status, body: parsed as T, text, headers: res.headers };
  }
  get<T = any>(p: string, expect = 200) {
    return this.call<T>("GET", p, undefined, { expect }).then((r) => r.body);
  }
  post<T = any>(p: string, body: unknown = {}, expect = 200, idem?: string) {
    return this.call<T>("POST", p, body, { expect, idem }).then((r) => r.body);
  }
  put<T = any>(p: string, body: unknown, expect = 200) {
    return this.call<T>("PUT", p, body, { expect }).then((r) => r.body);
  }
  patch<T = any>(p: string, body: unknown, expect = 200) {
    return this.call<T>("PATCH", p, body, { expect }).then((r) => r.body);
  }
}

export type World = Running & { admin: Client; adminSecret: string; adminPassword: string };

export async function boot(): Promise<World> {
  invalidateSettings();
  const db = await pgliteDb();
  const r = await start({ port: 0, db, periodic: false, log: () => {} });
  const admin = new Client(r.url, "admin");
  const password = "correct horse battery staple";
  const setup = await admin.post("/v1/auth/admin/setup", { setupToken: "test-setup-token", email: "owner@aura.test", name: "Pilot Operator", password, phone: "0711000001" });
  const step = Math.floor(Date.now() / 30_000);
  await admin.post("/v1/auth/admin/setup/confirm", { code: totpAt(setup.secret, step) });
  return { ...r, admin, adminSecret: setup.secret, adminPassword: password };
}

/** Re-authenticates with the password (TOTP codes can't be reused within their 30 s). */
export async function reauth(c: Client, password: string) {
  await c.post("/v1/a/me/reauth", { password });
}

export async function inviteAdmin(w: World, role: string, email: string) {
  await reauth(w.admin, w.adminPassword);
  const inv = await w.admin.post("/v1/a/users", { email, name: role, role });
  const token = String(inv.inviteLink).split("/invite/")[1];
  const c = new Client(w.url, "admin");
  const enrol = await c.post(`/v1/auth/admin/invite/${token}`, { password: "another long password here" });
  await c.post("/v1/auth/admin/setup/confirm", { code: totpAt(enrol.secret, Math.floor(Date.now() / 30_000)) });
  return c;
}

let phoneSeq = 200;
export const nextPhone = () => `07${String(10000000 + phoneSeq++).slice(-8)}`;

export async function onboardMerchant(w: World, opts: { name?: string; payoutMsisdn?: string; pin?: string } = {}) {
  const phone = nextPhone();
  const m = await w.admin.post("/v1/a/merchants", { businessName: opts.name ?? `Venue ${phone.slice(-3)}`, ownerName: "Owner " + phone.slice(-3), phone, payoutMsisdn: opts.payoutMsisdn ?? phone });
  const token = String(m.inviteLink).split("/invite/")[1];
  const owner = new Client(w.url, "merchant");
  const pin = opts.pin ?? "481516";
  const otp = await owner.post("/v1/auth/otp/request", { inviteToken: token, pin, pinConfirm: pin });
  await owner.post("/v1/auth/otp/verify", { inviteToken: token, code: otp.otp.testCode, acceptTerms: true });
  return { id: m.id as string, code: m.code as string, owner, pin, phone };
}

export async function addTable(w: World, merchantId: string, name = "Front table") {
  const t = await w.admin.post("/v1/a/tables", { merchantId, name });
  await reauth(w.admin, w.adminPassword);
  const cred = await w.admin.post(`/v1/a/tables/${t.id}/provision`, { virtual: false });
  return { tableId: t.id as string, cred };
}

export async function connectDevice(w: World, cred: any, faults?: ConstructorParameters<typeof VirtualDevice>[0]["faults"]) {
  const d = new VirtualDevice({ url: `${w.url.replace("http", "ws")}/mqtt`, deviceId: cred.deviceId, password: cred.mqtt.password, tableId: cred.tableId, secret: cred.hmacSecret, heartbeatMs: 60_000, faults });
  await d.connect();
  await waitFor(async () => (await w.admin.get(`/v1/a/tables/${cred.tableId}`)).device?.online === true, "device online");
  return d;
}

export async function pay(w: World, accountRef: string, amountKsh: number, extra: Record<string, unknown> = {}) {
  return w.admin.post("/v1/a/sim/payment", { accountRef, amountMinor: amountKsh * 100, msisdn: "0712345678", ...extra });
}

export async function waitFor(fn: () => Promise<boolean>, what: string, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    await drainJobs();
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 60));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const key = () => randomUUID();
