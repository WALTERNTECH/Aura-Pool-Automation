// Sets up a sandbox to click through, using only the public HTTP API (simulated provider):
// the first super admin (if none), a merchant with an invite link, a table with a virtual
// device, and a few customer payments. Prints what you need to sign in.
//
//   npx tsx scripts/seed-demo.ts --api http://localhost:4000 --setup-token local-setup
//
// The admin's authenticator secret is saved to .local/demo-admin.json so a script can sign in again.

import fs from "node:fs";
import path from "node:path";
import { totpAt } from "../src/lib/crypto.js";

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > -1 ? process.argv[i + 1] : d;
};
const api = (arg("api", "http://localhost:4000") as string).replace(/\/$/, "");
const setupToken = arg("setup-token", process.env.ADMIN_SETUP_TOKEN ?? "local-setup") as string;
const store = path.resolve(arg("store", "../.local/demo-admin.json") as string);
const jar = new Map<string, string>();

async function req<T = any>(method: string, p: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const r = await fetch(api + p, {
    method,
    headers: { "Content-Type": "application/json", "X-Aura-Client": "admin", Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of r.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : (null as T);
}
const step = () => Math.floor(Date.now() / 30_000);

async function main() {
  const setup = await req<{ needed: boolean }>("GET", "/v1/auth/admin/setup");
  let saved: { email: string; password: string; secret: string } | null = fs.existsSync(store) ? JSON.parse(fs.readFileSync(store, "utf8")) : null;
  if (setup.needed) {
    const email = "operator@aura-pool.local";
    const password = `demo-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const s = await req<{ secret: string }>("POST", "/v1/auth/admin/setup", { setupToken, email, name: "Pilot Operator", password, phone: "0711000000" });
    await req("POST", "/v1/auth/admin/setup/confirm", { code: totpAt(s.secret, step()) });
    saved = { email, password, secret: s.secret };
    fs.mkdirSync(path.dirname(store), { recursive: true });
    fs.writeFileSync(store, JSON.stringify(saved, null, 2));
  } else {
    if (!saved) throw new Error(`An admin exists but ${store} is missing; sign in by hand.`);
    await req("POST", "/v1/auth/login/admin", { email: saved.email, password: saved.password });
    await req("POST", "/v1/auth/login/admin/totp", { code: totpAt(saved.secret, step() + 1) });
  }
  await req("POST", "/v1/a/me/reauth", { password: saved!.password });

  const m = await req<{ id: string; code: string; inviteLink?: string }>("POST", "/v1/a/merchants", { businessName: "Kamau's Pool Bar", ownerName: "Peter Kamau", phone: `07${String(Date.now()).slice(-8)}`, location: "Kasarani, Nairobi" });
  const t1 = await req<{ id: string }>("POST", "/v1/a/tables", { merchantId: m.id, name: "Front table", location: "By the entrance" });
  const t2 = await req<{ id: string }>("POST", "/v1/a/tables", { merchantId: m.id, name: "Back table", location: "Upstairs" });
  for (const t of [t1, t2]) {
    await req("PATCH", `/v1/a/tables/${t.id}`, { unlockSeconds: 10 });
    await req("POST", `/v1/a/tables/${t.id}/provision`, { virtual: true });
  }
  await new Promise((r) => setTimeout(r, 2500));
  const payers = ["0712345678", "0722111222", "0733444555", "0700999888"];
  for (let i = 0; i < 6; i++) {
    await req("POST", "/v1/a/sim/payment", { accountRef: i % 2 ? t2.id : t1.id, amountMinor: 5000 * (i === 4 ? 2 : 1), msisdn: payers[i % payers.length] });
  }
  await req("POST", "/v1/a/sim/payment", { accountRef: "T1O", amountMinor: 5000, skipValidation: true });
  await req("PUT", "/v1/a/settings/support", { value: { phone: "0711000000", whatsapp: "0711000000", email: "support@aura-pool.local", hours: "Every day, 8 am to 10 pm" } });

  console.log("\nSandbox ready.");
  console.log(`  Admin:     ${saved!.email} / password and authenticator secret in ${store}`);
  console.log(`  Merchant:  ${m.code} Kamau's Pool Bar, tables ${t1.id} and ${t2.id} (virtual devices)`);
  console.log(`  Invite:    ${m.inviteLink ?? "(sent by SMS; OTP_ECHO is off)"}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
