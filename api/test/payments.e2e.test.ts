import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { addTable, boot, connectDevice, onboardMerchant, pay, waitFor, type World } from "./helpers.js";
import type { VirtualDevice } from "../src/devices/simulator.js";

// The collection pipeline end to end: simulated Daraja callbacks over HTTP → verification →
// matching → ledger → signed unlock over MQTT → device ack.

let w: World;
let m: Awaited<ReturnType<typeof onboardMerchant>>;
let table: string;
let dev: VirtualDevice;

const payments = async (q = "") => (await m.owner.get(`/v1/m/payments${q}`)).items as any[];
const acc = async (code: string) => ((await w.admin.get("/v1/a/ledger/accounts")).accounts as any[]).find((a) => a.code === code)?.balance_minor ?? 0;

before(async () => {
  w = await boot();
  m = await onboardMerchant(w, { name: "Kamau's Pool Bar" });
  const t = await addTable(w, m.id);
  table = t.tableId;
  await w.admin.patch(`/v1/a/tables/${table}`, { unlockSeconds: 5 });
  dev = await connectDevice(w, t.cred);
});
after(async () => {
  await dev?.close();
  await w?.stop();
});

describe("a paid game", () => {
  it("credits the merchant, keeps the commission, and unlocks the table", async () => {
    await pay(w, " t 1 ", 50); // a customer typing the account loosely
    await waitFor(async () => (await payments())[0]?.status.code === "game_started", "game started");
    assert.equal(dev.unlocks, 1);
    const [p] = await payments();
    assert.equal(p.tableId, table);
    assert.equal(p.payer, "0712***678");
    assert.equal(await acc(`merchant_payable:${m.id}`), -4500);
    assert.equal(await acc("platform_revenue"), -500);
    assert.equal(await acc("provider_utility"), 5000);
    const home = await m.owner.get("/v1/m/dashboard");
    assert.equal(home.today.games, 1);
    assert.equal(home.today.earningsMinor, 4500);
    assert.equal(home.balance.availableMinor, 4500);
    const detail = await m.owner.get(`/v1/m/payments/${p.id}`);
    assert.deepEqual(detail.split, { totalMinor: 5000, commissionMinor: 500, shareMinor: 4500, heldMinor: 0, refundedMinor: 0 });
    assert.ok(detail.timeline.every((s: any) => s.done));
  });

  it("ignores a replayed confirmation: one payment, one ledger entry, one game", async () => {
    const before = dev.unlocks;
    const r = await pay(w, table, 50, { duplicate: true });
    assert.equal(r.duplicate.ResultDesc, "Duplicate ignored");
    await waitFor(async () => dev.unlocks === before + 1, "one unlock");
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(dev.unlocks, before + 1);
    const ps = (await payments()).filter((p) => p.mpesaCode === r.txn);
    assert.equal(ps.length, 1);
    assert.equal(await acc(`merchant_payable:${m.id}`), -9000);
  });
});

describe("account numbers", () => {
  it("rejects an unknown account at validation, so the customer isn't charged", async () => {
    const r = await pay(w, "T999", 50);
    assert.equal(r.validation.ResultCode, "C2B00012");
    assert.equal(r.charged, false);
  });

  it("parks a payment for an unknown account in suspense, alerts, then credits it when assigned", async () => {
    const before = dev.unlocks;
    const r = await pay(w, "TABLE ONE", 50, { skipValidation: true });
    let ex: any;
    await waitFor(async () => (ex = await w.admin.get("/v1/a/exceptions")).unmatched.length === 1, "unmatched");
    assert.equal(await acc("suspense"), -5000);
    assert.equal(dev.unlocks, before);
    const alerts = (await w.admin.get("/v1/a/alerts")).items as any[];
    assert.ok(alerts.some((a) => a.type === "unmatched_payment" && a.severity === "critical"));
    await w.admin.post(`/v1/a/payments/${ex.unmatched[0].id}/assign`, { tableId: table, unlock: true, reason: "Customer showed the M-Pesa SMS" });
    await waitFor(async () => dev.unlocks === before + 1, "unlock after assign");
    assert.equal(await acc("suspense"), 0);
    const detail = await w.admin.get(`/v1/a/payments/${ex.unmatched[0].id}`);
    assert.equal(detail.payment.status, "credited");
    assert.equal(r.charged, true);
  });
});

describe("amount rules", () => {
  it("holds an underpayment and completes it when the same payer tops up", async () => {
    const before = dev.unlocks;
    await pay(w, table, 30, { msisdn: "0722000111" });
    await waitFor(async () => (await payments())[0]?.status.code === "underpaid", "underpaid");
    assert.equal(dev.unlocks, before);
    await pay(w, table, 20, { msisdn: "0722000111" });
    await waitFor(async () => dev.unlocks === before + 1, "unlock after top-up");
    const [top] = await payments();
    assert.equal(top.status.code, "game_started");
  });

  it("gives whole games for an overpayment and holds the rest", async () => {
    const before = dev.unlocks;
    await pay(w, table, 120, { msisdn: "0733000222" });
    await waitFor(async () => dev.unlocks === before + 2, "two games", 15_000);
    const ex = await w.admin.get("/v1/a/exceptions");
    assert.equal(ex.counts.held, 1);
  });
});

describe("table offline", () => {
  it("shows Paid, waiting for table, and plays when the table returns", async () => {
    const before = dev.unlocks;
    dev.crash();
    await waitFor(async () => (await w.admin.get(`/v1/a/tables/${table}`)).device.online === false, "offline");
    await pay(w, table, 50);
    await waitFor(async () => (await payments())[0]?.status.code === "waiting_table", "waiting");
    const t = await addBack();
    await waitFor(async () => t.unlocks === 1, "unlock after reconnect");
    dev = t;
    assert.equal((await payments())[0].status.code, "game_started");
    assert.equal(before >= 0, true);
  });
});

async function addBack() {
  // Same credentials: the device simply reconnects.
  const { VirtualDevice } = await import("../src/devices/simulator.js");
  const d = new VirtualDevice({ ...dev.o, faults: undefined });
  await d.connect();
  return d;
}

describe("verification", () => {
  it("rejects a forged callback, suspends the merchant's payouts, and lets an admin clear it", async () => {
    const r = await pay(w, table, 50, { forged: true });
    let rej: any;
    await waitFor(async () => (rej = await w.admin.get("/v1/a/exceptions")).verificationFailed.length === 1, "verification failed");
    assert.equal(rej.verificationFailed[0].provider_txn_id, r.txn);
    const merchant = await w.admin.get(`/v1/a/merchants/${m.id}`);
    assert.equal(merchant.merchant.payouts_suspended, true);
    const q = await m.owner.get("/v1/m/payouts/quote");
    assert.ok(q.blockers.some((b: any) => b.code === "under_review"));
    const alerts = (await w.admin.get("/v1/a/alerts?severity=critical")).items as any[];
    assert.ok(alerts.some((a) => a.type === "verification_mismatch"));
  });
});
