import "./env.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pgliteDb, setDb, type Db } from "../src/config/db.js";
import { maskMsisdn, normaliseMsisdn, normaliseTableRef, parseMpesaTime, toMinor } from "../src/lib/kenya.js";
import { checkInvariants, merchantAccount, post, reverse, balance } from "../src/services/ledger.js";
import { migrate } from "../src/migrate.js";
import { commissionAmount } from "../src/services/pricing.js";
import { judgeStatus } from "../src/providers/daraja.js";
import { parseAccountBalance } from "../src/providers/common.js";
import { ownerStatus } from "../src/services/payments.js";

describe("matching rules", () => {
  it("normalises the account numbers customers type", () => {
    for (const s of ["T001", "t1", " T 01 ", "t001", "T0001"]) assert.equal(normaliseTableRef(s), "T001", s);
    assert.equal(normaliseTableRef("T12"), "T012");
    assert.equal(normaliseTableRef("T1234"), "T1234");
    for (const s of ["", "T", "T0", "TABLE1", "1", "X001", null]) assert.equal(normaliseTableRef(s as string), null, String(s));
  });
  it("normalises and masks phone numbers", () => {
    assert.equal(normaliseMsisdn("0712 345 678"), "254712345678");
    assert.equal(normaliseMsisdn("+254712345678"), "254712345678");
    assert.equal(normaliseMsisdn("0112345678"), "254112345678");
    assert.equal(normaliseMsisdn("12345"), null);
    assert.equal(maskMsisdn("254712345678"), "0712***678");
    assert.equal(maskMsisdn("2547 ***** 126"), "07*****126");
  });
  it("reads M-Pesa amounts and times", () => {
    assert.equal(toMinor("50.00"), 5000);
    assert.equal(toMinor(1250), 125000);
    assert.equal(parseMpesaTime("20261025143012")?.toISOString(), "2026-10-25T11:30:12.000Z");
  });
});

describe("amount rules", () => {
  const c = { commissionMinor: 500, commissionPct: 0, source: "default" as const, effectiveFrom: null };
  it("takes a fixed commission per game", () => {
    assert.equal(commissionAmount(c, 1, 5000), 500);
    assert.equal(commissionAmount(c, 3, 5000), 1500);
  });
  it("adds an optional percentage and never takes more than the money", () => {
    assert.equal(commissionAmount({ ...c, commissionPct: 10 }, 2, 5000), 2000);
    assert.equal(commissionAmount({ ...c, commissionMinor: 9000 }, 1, 5000), 5000);
  });
});

describe("provider answers", () => {
  it("judges a Transaction Status result", () => {
    const ok = { Result: { ResultCode: 0, ResultParameters: { ResultParameter: [{ Key: "TransactionStatus", Value: "Completed" }, { Key: "Amount", Value: 50 }, { Key: "CreditPartyName", Value: "600000 - Aura" }] } } };
    assert.equal(judgeStatus(ok, { amountMinor: 5000, shortcode: "600000" }).status, "verified");
    assert.equal(judgeStatus(ok, { amountMinor: 10000, shortcode: "600000" }).status, "mismatch");
    assert.equal(judgeStatus(ok, { amountMinor: 5000, shortcode: "174379" }).status, "mismatch");
    assert.equal(judgeStatus({ Result: { ResultCode: 1, ResultDesc: "Service unavailable" } }, { amountMinor: 5000, shortcode: "600000" }).status, "unavailable");
  });
  it("parses the Account Balance string", () => {
    const b = parseAccountBalance("Working Account|KES|700000.00|700000.00|0.00|0.00&Utility Account|KES|228037.50|228037.50|0.00|0.00");
    assert.equal(b["Working Account"], 70000000);
    assert.equal(b["Utility Account"], 22803750);
  });
  it("labels payments the way owners read them", () => {
    assert.equal(ownerStatus({ status: "credited", problem: null, credits: [{ status: "acked" }] }).label, "Paid, game started");
    assert.equal(ownerStatus({ status: "credited", problem: null, credits: [{ status: "pending" }] }).label, "Paid, waiting for table");
    assert.equal(ownerStatus({ status: "credited", problem: null, credits: [{ status: "expired" }] }).label, "Paid, table did not unlock");
    assert.equal(ownerStatus({ status: "unmatched", problem: null }).label, "Wrong table number");
  });
});

describe("ledger", () => {
  let d: Db;
  const mid = "11111111-1111-4111-8111-111111111111";
  before(async () => {
    d = await pgliteDb();
    setDb(d);
    await migrate(d);
    await d.query(`insert into merchants (id, code, business_name, owner_name, phone) values ($1,'M001','X','Y','254700000001')`, [mid]);
  });
  after(async () => d.close());

  it("posts balanced entries and keeps balances", async () => {
    await d.tx((q) => post(q, { kind: "payment_credit", idempotencyKey: "p1", lines: [{ account: "provider_utility", amount: 5000 }, { account: merchantAccount(mid), amount: -4500 }, { account: "platform_revenue", amount: -500 }] }));
    assert.equal(await balance(d, "provider_utility"), 5000);
    assert.equal(await balance(d, merchantAccount(mid)), -4500);
  });
  it("refuses an unbalanced posting", async () => {
    await assert.rejects(d.tx((q) => post(q, { kind: "bad", lines: [{ account: "provider_utility", amount: 100 }, { account: "suspense", amount: -99 }] })), /does not balance/);
  });
  it("ignores a repeated idempotency key", async () => {
    const a = await d.tx((q) => post(q, { kind: "payment_credit", idempotencyKey: "p1", lines: [{ account: "provider_utility", amount: 5000 }, { account: "suspense", amount: -5000 }] }));
    const b = await d.tx((q) => post(q, { kind: "payment_credit", idempotencyKey: "p1", lines: [{ account: "provider_utility", amount: 5000 }, { account: "suspense", amount: -5000 }] }));
    assert.equal(a, b);
    assert.equal(await balance(d, "provider_utility"), 5000);
  });
  it("reverses exactly, and never edits", async () => {
    const id = await d.tx((q) => post(q, { kind: "x", lines: [{ account: "provider_working", amount: 700 }, { account: "provider_utility", amount: -700 }] }));
    await d.tx((q) => reverse(q, id, "reversal", "test", "undo"));
    assert.equal(await balance(d, "provider_working"), 0);
    await assert.rejects(d.query(`update ledger_entries set amount_minor = 1`), /append-only/);
    await assert.rejects(d.query(`delete from ledger_transactions`), /append-only/);
  });
  it("passes the nightly invariant check", async () => {
    const r = await checkInvariants(d);
    assert.deepEqual(r.problems, []);
  });
});
