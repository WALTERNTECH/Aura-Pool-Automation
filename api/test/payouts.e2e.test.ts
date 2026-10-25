import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { addTable, boot, Client, connectDevice, inviteAdmin, key, onboardMerchant, pay, reauth, runPeriodicOnce, waitFor, type World } from "./helpers.js";
import type { VirtualDevice } from "../src/devices/simulator.js";
import { runAutoWithdrawals } from "../src/services/payouts.js";
import { nairobiDate, nairobiInstant } from "../src/lib/kenya.js";

// Withdrawals: reservation, idempotency, float, B2C outcomes, kill switch, approvals,
// number changes, auto-withdraw, reconciliation, and tenant isolation.

let w: World;
let m: Awaited<ReturnType<typeof onboardMerchant>>;
let table: string;
let dev: VirtualDevice;

const payoutNumber = async (owner: Client, pin: string, msisdn: string) => {
  const start = await owner.post("/v1/m/payout-number", { msisdn, pin });
  return owner.post("/v1/m/payout-number/verify", { changeId: start.changeId, codeNew: start.otpNew.testCode, codeOld: start.otpOld?.testCode });
};
const history = async (c = m.owner) => (await c.get("/v1/m/payouts")).items as any[];
// What the operator does: move everything collected in Utility over to Working, then record it.
const fund = async () => {
  const amountMinor = (await w.admin.get("/v1/a/sim")).balances.utilityMinor;
  if (!amountMinor) return;
  const t = await w.admin.post("/v1/a/sim/transfer", { from: "utility", to: "working", amountMinor });
  return w.admin.post("/v1/a/transfers", { from: "utility", to: "working", amountMinor, reference: t.reference, transferredAt: new Date().toISOString() });
};

before(async () => {
  w = await boot();
  m = await onboardMerchant(w, { name: "Mama Njeri Pool" });
  const t = await addTable(w, m.id);
  table = t.tableId;
  await w.admin.patch(`/v1/a/tables/${table}`, { unlockSeconds: 5, priceMinor: 100000 });
  dev = await connectDevice(w, t.cred);
  // KSh 1,000 a game for these tests, so balances are big enough to withdraw.
  for (let i = 0; i < 3; i++) await pay(w, table, 1000, { msisdn: `07220000${10 + i}` });
  await waitFor(async () => (await m.owner.get("/v1/m/money")).availableMinor === 3 * 99500, "three games credited", 30_000);
});
after(async () => {
  await dev?.close();
  await w?.stop();
});

describe("payout number", () => {
  it("must be verified by OTP before any withdrawal", async () => {
    const q = await m.owner.get("/v1/m/payouts/quote");
    assert.ok(q.blockers.some((b: any) => b.code === "no_number"));
    const r = await payoutNumber(m.owner, m.pin, m.phone);
    assert.equal(r.kind, "first");
    assert.equal(r.holdUntil, null);
  });
});

describe("withdrawing", () => {
  it("shows the fee and what arrives, before confirming", async () => {
    const q = await m.owner.get("/v1/m/payouts/quote?amountMinor=100000");
    assert.equal(q.grossMinor, 100000);
    assert.equal(q.feeMinor, 500);
    assert.equal(q.netMinor, 99500);
    assert.equal(q.destinationMasked.includes("***"), true);
    assert.deepEqual(q.blockers, []);
  });

  it("refuses more than the balance, with a clear message", async () => {
    const r = await m.owner.call("POST", "/v1/m/payouts", { amountMinor: 9_000_000, pin: m.pin }, { idem: key() });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /more than your available balance/);
  });

  it("asks for the PIN and counts wrong ones", async () => {
    const r = await m.owner.call("POST", "/v1/m/payouts", { amountMinor: 10000, pin: "000000" }, { idem: key() });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "wrong_pin");
  });

  it("creates one withdrawal when Withdraw is tapped twice", async () => {
    const k = key();
    const [a, b] = await Promise.all([
      m.owner.call("POST", "/v1/m/payouts", { amountMinor: 100000, pin: m.pin }, { idem: k }),
      m.owner.call("POST", "/v1/m/payouts", { amountMinor: 100000, pin: m.pin }, { idem: k }),
    ]);
    const ok = [a, b].filter((x) => x.status === 200);
    assert.ok(ok.length >= 1);
    const again = await m.owner.call("POST", "/v1/m/payouts", { amountMinor: 100000, pin: m.pin }, { idem: k });
    assert.equal(again.status, 200);
    assert.equal(again.headers.get("idempotent-replay"), "true");
    assert.equal((await history()).length, 1);
  });

  it("never lets two withdrawals spend the same shillings", async () => {
    const money = await m.owner.get("/v1/m/money");
    const half = money.availableMinor;
    const rs = await Promise.all([1, 2].map(() => m.owner.call("POST", "/v1/m/payouts", { amountMinor: half, pin: m.pin }, { idem: key() })));
    assert.equal(rs.filter((x) => x.status === 200).length, 1);
    assert.equal((await m.owner.get("/v1/m/money")).availableMinor, 0);
  });

  it("queues withdrawals while Working float is short, then sends them after a recorded transfer", async () => {
    await waitFor(async () => (await history()).every((p) => p.stage.code === "queued"), "queued for float");
    const alerts = (await w.admin.get("/v1/a/alerts")).items as any[];
    assert.ok(alerts.some((a) => a.type === "float_low"));
    const panel = await w.admin.get("/v1/a/float");
    assert.equal(panel.transferNeeded, true);
    await fund();
    await waitFor(async () => (await history()).every((p) => p.stage.code === "received"), "received", 20_000);
    const [p] = await history();
    assert.ok(p.receipt);
    const notes = (await m.owner.get("/v1/m/notifications")).items as any[];
    assert.ok(notes.some((n) => n.type === "payout_succeeded"));
  });
});

describe("outcomes", () => {
  let m2: Awaited<ReturnType<typeof onboardMerchant>>;
  before(async () => {
    // A merchant whose payout number fails at M-Pesa (ending 000), funded by games on a second table.
    m2 = await onboardMerchant(w, { name: "Test Fail Venue" });
    const t2 = await addTable(w, m2.id, "Back table");
    await w.admin.patch(`/v1/a/tables/${t2.tableId}`, { unlockSeconds: 5, priceMinor: 100000 });
    const d2 = await connectDevice(w, t2.cred);
    await pay(w, t2.tableId, 1000);
    await pay(w, t2.tableId, 1000, { msisdn: "0799111222" });
    await waitFor(async () => (await m2.owner.get("/v1/m/money")).availableMinor === 199000, "credited", 30_000);
    await d2.close();
    await fund();
  });

  it("restores the balance and says why when a withdrawal fails", async () => {
    await payoutNumber(m2.owner, m2.pin, "0700111000");
    await m2.owner.post("/v1/m/payouts", { amountMinor: 50000, pin: m2.pin }, 200, key());
    await waitFor(async () => (await history(m2.owner))[0]?.stage.code === "failed", "failed");
    const [p] = await history(m2.owner);
    assert.match(p.note, /back in your balance/);
    assert.equal((await m2.owner.get("/v1/m/money")).availableMinor, 199000);
  });

  it("holds a timed-out withdrawal, refuses a retry, and settles it from a status query", async () => {
    // Switch to a number that times out (ending 999). This is a change, so it cools off; fast-track it with approval.
    const start = await m2.owner.post("/v1/m/payout-number", { msisdn: "0700111999", pin: m2.pin, oldNumberUnavailable: true });
    await m2.owner.post("/v1/m/payout-number/verify", { changeId: start.changeId, codeNew: start.otpNew.testCode });
    const fin = await inviteAdmin(w, "finance", "finance@aura.test");
    const ap = await w.admin.post(`/v1/a/merchants/${m2.id}/payout-number/fast-track`, { reason: "Owner called and confirmed" });
    await reauth(fin, "another long password here");
    // Finance lacks merchants.manage, so it can't approve this kind; the super admin requested it.
    const denied = await fin.call("POST", `/v1/a/approvals/${ap.id}/approve`, { note: "ok" });
    assert.equal(denied.status, 403);
    const sup = await inviteAdmin(w, "super_admin", "second@aura.test");
    await reauth(sup, "another long password here");
    await sup.post(`/v1/a/approvals/${ap.id}/approve`, { note: "Verified by phone" });
    await m2.owner.post("/v1/m/payouts", { amountMinor: 50000, pin: m2.pin }, 200, key());
    let p: any;
    await waitFor(async () => (p = (await w.admin.get(`/v1/a/payouts?merchant=${m2.id}&status=timed_out`)).items[0]) != null, "timed out");
    const retry = await w.admin.call("POST", `/v1/a/payouts/${p.id}/retry`, {});
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error.code, "outcome_unknown");
    await w.admin.post(`/v1/a/payouts/${p.id}/query`, {});
    await waitFor(async () => (await w.admin.get(`/v1/a/payouts/${p.id}`)).payout.status === "succeeded", "settled by status query");
  });
});

describe("controls", () => {
  it("kill switch: nothing is submitted until a second person releases it", async () => {
    await pay(w, table, 1000, { msisdn: "0744000333" });
    await waitFor(async () => (await m.owner.get("/v1/m/money")).availableMinor >= 99500, "credited", 20_000);
    await fund();
    await w.admin.post("/v1/a/kill-switch/engage", { reason: "Investigating a provider issue" });
    const r = await m.owner.post("/v1/m/payouts", { amountMinor: 50000, pin: m.pin }, 200, key());
    await runPeriodicOnce(["payouts"]);
    assert.equal((await m.owner.get(`/v1/m/payouts/${r.id}`)).stage.code, "requested");
    const ap = await w.admin.post("/v1/a/kill-switch/release", { reason: "Provider confirmed fixed" });
    await reauth(w.admin, w.adminPassword);
    const own = await w.admin.call("POST", `/v1/a/approvals/${ap.id}/approve`, { note: "" });
    assert.equal(own.status, 403);
    assert.equal(own.body.error.code, "approval_delay");
    const sup = await inviteAdmin(w, "super_admin", "third@aura.test");
    await reauth(sup, "another long password here");
    await sup.post(`/v1/a/approvals/${ap.id}/approve`, { note: "Released" });
    await waitFor(async () => (await m.owner.get(`/v1/m/payouts/${r.id}`)).stage.code === "received", "sent after release", 20_000);
  });

  it("large withdrawals wait for approval, and support can't approve them", async () => {
    await w.admin.put("/v1/a/settings/payout", { value: { ...(await w.admin.get("/v1/a/settings")).settings.payout, approval_threshold_minor: 30000 } }).catch(async () => {
      await reauth(w.admin, w.adminPassword);
      await w.admin.put("/v1/a/settings/payout", { value: { ...(await w.admin.get("/v1/a/settings")).settings.payout, approval_threshold_minor: 30000 } });
    });
    const r = await m.owner.post("/v1/m/payouts", { amountMinor: 40000, pin: m.pin }, 200, key());
    assert.equal(r.stage.code, "needs_approval");
    const sup = await inviteAdmin(w, "support", "support@aura.test");
    const denied = await sup.call("POST", `/v1/a/payouts/${r.id}/approve`, {});
    assert.equal(denied.status, 403);
    await w.admin.post(`/v1/a/payouts/${r.id}/approve`, {});
    await waitFor(async () => (await m.owner.get(`/v1/m/payouts/${r.id}`)).stage.code === "received", "approved and sent", 20_000);
    await reauth(w.admin, w.adminPassword);
    await w.admin.put("/v1/a/settings/payout", { value: { ...(await w.admin.get("/v1/a/settings")).settings.payout, approval_threshold_minor: 2000000 } });
  });
});

describe("number change", () => {
  it("holds withdrawals for 24 hours and texts the old number", async () => {
    const start = await m.owner.post("/v1/m/payout-number", { msisdn: "0755123456", pin: m.pin });
    assert.ok(start.otpOld, "a code goes to the old number too");
    const v = await m.owner.post("/v1/m/payout-number/verify", { changeId: start.changeId, codeNew: start.otpNew.testCode, codeOld: start.otpOld.testCode });
    assert.equal(v.kind, "change");
    assert.ok(new Date(v.holdUntil).getTime() - Date.now() > 23 * 3600_000);
    const q = await m.owner.get("/v1/m/payouts/quote?amountMinor=20000");
    assert.ok(q.heldUntil);
  });
});

describe("auto-withdraw", () => {
  it("withdraws the balance at the chosen time and records the run", async () => {
    const m3 = await onboardMerchant(w, { name: "Auto Venue" });
    const t3 = await addTable(w, m3.id, "Corner table");
    await w.admin.patch(`/v1/a/tables/${t3.tableId}`, { unlockSeconds: 5, priceMinor: 100000 });
    const d3 = await connectDevice(w, t3.cred);
    await pay(w, t3.tableId, 1000);
    await waitFor(async () => (await m3.owner.get("/v1/m/money")).availableMinor === 99500, "credited", 20_000);
    await fund();
    await d3.close();
    await payoutNumber(m3.owner, m3.pin, m3.phone);
    await m3.owner.put("/v1/m/auto-withdraw", { enabled: true, time: "22:00", minMinor: 10000, pin: m3.pin });
    const at = new Date(nairobiInstant(nairobiDate(), "22:00").getTime() + 60_000);
    assert.equal(await runAutoWithdrawals(at), 1);
    await waitFor(async () => (await history(m3.owner))[0]?.stage.code === "received", "auto withdrawal received", 20_000);
    const aw = await m3.owner.get("/v1/m/auto-withdraw");
    assert.equal(aw.lastRun.outcome, "paid");
    assert.equal(await runAutoWithdrawals(at), 0, "once a day");
  });
});

describe("reconciliation", () => {
  it("matches the simulated M-Pesa books, then catches an unrecorded portal transfer and pauses auto payouts", async () => {
    await waitFor(async () => (await w.admin.get("/v1/a/payouts?status=submitted,requested,queued")).items.length === 0, "nothing in flight", 20_000);
    const ok = await w.admin.post("/v1/a/reconciliation/run", {});
    assert.equal(ok.status, "match", JSON.stringify(ok.lines));
    await w.admin.post("/v1/a/sim/transfer", { from: "working", to: "utility", amountMinor: 1000 });
    const bad = await w.admin.post("/v1/a/reconciliation/run", {});
    assert.equal(bad.status, "mismatch");
    assert.equal((await w.admin.get("/v1/a/reconciliation")).autoPayoutsPaused.on, true);
    await reauth(w.admin, w.adminPassword);
    await w.admin.post(`/v1/a/reconciliation/${bad.id}/acknowledge`, { note: "Portal transfer made during testing; recording it now" });
    assert.equal((await w.admin.get("/v1/a/reconciliation")).autoPayoutsPaused.on, false);
  });
});

describe("tenant isolation", () => {
  it("one merchant can't see another's tables, payments or withdrawals", async () => {
    const other = await onboardMerchant(w, { name: "Someone Else" });
    assert.equal((await other.owner.get("/v1/m/tables")).tables.length, 0);
    await other.owner.get(`/v1/m/tables/${table}`, 404);
    const p = (await m.owner.get("/v1/m/payments")).items[0];
    await other.owner.get(`/v1/m/payments/${p.id}`, 404);
    const po = (await history())[0];
    await other.owner.get(`/v1/m/payouts/${po.id}`, 404);
    assert.equal((await other.owner.get("/v1/m/payments")).items.length, 0);
    assert.equal((await other.owner.get("/v1/m/money")).availableMinor, 0);
  });
});
