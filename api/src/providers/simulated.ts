import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { db, one, type Q } from "../config/db.js";
import { shortRef } from "../lib/crypto.js";
import { badRequest } from "../lib/http.js";
import { mpesaTimestamp } from "../lib/kenya.js";
import { b2cTariff } from "../services/settings.js";
import { callbackUrls, recordHealth } from "./common.js";
import { DarajaProvider, judgeStatus } from "./daraja.js";
import type { Balances, PaymentProvider, PayoutAccepted, StkAccepted, VerifyResult } from "./types.js";

// A stand-in for M-Pesa with its own books (sim_accounts, sim_transactions), so the whole
// pipeline — callbacks, verification, payouts, float and reconciliation — runs end to end
// with no Safaricom account. It speaks Daraja's payload formats and answers through our real
// callback routes over HTTP, so nothing is short-circuited.
//
// Test numbers for payouts: ending 000 fails, ending 999 times out (but the money really
// goes, as with a real timeout; a status query reveals it). STK: ending 000 is cancelled.

let selfUrl = env.publicUrl;
/** Where the simulator delivers its callbacks (the local listener, not the public URL). */
export function setSimulatorTarget(url: string) {
  selfUrl = url.replace(/\/$/, "");
}
const delay = () => Number(process.env.SIM_DELAY_MS ?? 1500);
const later = (fn: () => Promise<void>, ms = delay()) => {
  setTimeout(() => void fn().catch((e) => console.error("[sim] callback failed:", (e as Error).message)), ms).unref?.();
};

async function deliver(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function simBalance(q: Q, account: "utility" | "working") {
  return (await one<{ balance_minor: number }>(q, `select balance_minor from sim_accounts where account = $1`, [account]))?.balance_minor ?? 0;
}
async function simMove(q: Q, account: "utility" | "working", delta: number) {
  await q.query(`insert into sim_accounts (account, balance_minor) values ($1,$2) on conflict (account) do update set balance_minor = sim_accounts.balance_minor + excluded.balance_minor`, [account, delta]);
}

export class SimulatedProvider implements PaymentProvider {
  readonly name = "simulated" as const;
  private daraja = new DarajaProvider();

  parseCollectionCallback(body: unknown) {
    return this.daraja.parseCollectionCallback(body);
  }
  parseStkCallback(body: unknown) {
    return this.daraja.parseStkCallback(body);
  }
  parsePayoutResult(body: unknown, kind: "result" | "timeout") {
    return this.daraja.parsePayoutResult(body, kind);
  }

  async verifyCollection(q: Q, p: { paymentId: string; providerTxnId: string; amountMinor: number; shortcode: string }): Promise<VerifyResult> {
    const t0 = Date.now();
    const t = await one<{ amount_minor: number; shortcode: string; kind: string }>(q, `select amount_minor, shortcode, kind from sim_transactions where txn_id = $1`, [p.providerTxnId]);
    await recordHealth("status", true, Date.now() - t0);
    if (!t || (t.kind !== "c2b" && t.kind !== "stk")) return judgeStatus({ ResultCode: "2001", ResultDesc: "The transaction ID is invalid" }, p);
    return judgeStatus(
      {
        ResultCode: "0",
        ResultDesc: "The service request is processed successfully.",
        ResultParameters: {
          ResultParameter: [
            { Key: "TransactionStatus", Value: "Completed" },
            { Key: "Amount", Value: t.amount_minor / 100 },
            { Key: "CreditPartyName", Value: `${t.shortcode} - Aura Pool` },
            { Key: "ReceiptNo", Value: p.providerTxnId },
          ],
        },
      },
      p,
    );
  }

  async initiateStkPush(r: { stkRequestId: string; phone: string; amountMinor: number; accountRef: string }): Promise<StkAccepted> {
    const merchantRequestId = `SIM-${randomUUID().slice(0, 8)}`;
    const checkoutRequestId = `ws_CO_SIM_${Date.now()}_${randomUUID().slice(0, 6)}`;
    await recordHealth("stk", true, 5);
    later(async () => {
      const cancelled = r.phone.endsWith("000");
      const receipt = shortRef("S", 9);
      if (!cancelled) {
        await db().tx(async (q) => {
          await q.query(`insert into sim_transactions (txn_id, kind, amount_minor, shortcode, account_ref, msisdn) values ($1,'stk',$2,$3,$4,$5)`, [receipt, r.amountMinor, env.daraja.shortcode, r.accountRef, r.phone]);
          await simMove(q, "utility", r.amountMinor);
        });
      }
      await deliver(callbackUrls(selfUrl).stk, {
        Body: {
          stkCallback: {
            MerchantRequestID: merchantRequestId,
            CheckoutRequestID: checkoutRequestId,
            ResultCode: cancelled ? 1032 : 0,
            ResultDesc: cancelled ? "Request cancelled by user" : "The service request is processed successfully.",
            ...(cancelled
              ? {}
              : {
                  CallbackMetadata: {
                    Item: [
                      { Name: "Amount", Value: r.amountMinor / 100 },
                      { Name: "MpesaReceiptNumber", Value: receipt },
                      { Name: "TransactionDate", Value: Number(mpesaTimestamp()) },
                      { Name: "PhoneNumber", Value: Number(r.phone) },
                    ],
                  },
                }),
          },
        },
      });
    });
    return { merchantRequestId, checkoutRequestId, customerMessage: "Success. Request accepted for processing" };
  }

  async initiatePayout(r: { payoutId: string; originatorConversationId: string; msisdn: string; amountMinor: number; remarks: string }): Promise<PayoutAccepted> {
    const conversationId = `AG_SIM_${randomUUID().slice(0, 12)}`;
    await recordHealth("b2c", true, 5);
    later(async () => {
      const tariff = await b2cTariff(r.amountMinor);
      const willFail = r.msisdn.endsWith("000");
      const willTimeOut = r.msisdn.endsWith("999");
      const short = (await simBalance(db(), "working")) < r.amountMinor + tariff;
      const receipt = shortRef("B", 9);
      if (!willFail && !short) {
        await db().tx(async (q) => {
          await simMove(q, "working", -(r.amountMinor + tariff));
          await q.query(`insert into sim_transactions (txn_id, kind, amount_minor, shortcode, account_ref, msisdn) values ($1,'b2c',$2,$3,$4,$5)`, [receipt, r.amountMinor, env.daraja.shortcode, r.originatorConversationId, r.msisdn]);
        });
      }
      const urls = callbackUrls(selfUrl);
      if (willTimeOut && !willFail && !short) {
        await deliver(urls.b2cTimeout, { Result: { ResultType: 1, ResultCode: "SVC0403", ResultDesc: "Request timed out", OriginatorConversationID: r.originatorConversationId, ConversationID: conversationId } });
        return;
      }
      const working = await simBalance(db(), "working");
      const utility = await simBalance(db(), "utility");
      await deliver(urls.b2cResult, {
        Result: {
          ResultType: 0,
          ResultCode: willFail ? 2001 : short ? 1 : 0,
          ResultDesc: willFail ? "The initiator information is invalid." : short ? "The balance is insufficient for the transaction." : "The service request is processed successfully.",
          OriginatorConversationID: r.originatorConversationId,
          ConversationID: conversationId,
          TransactionID: willFail || short ? "" : receipt,
          ResultParameters: willFail || short
            ? undefined
            : {
                ResultParameter: [
                  { Key: "TransactionAmount", Value: r.amountMinor / 100 },
                  { Key: "TransactionReceipt", Value: receipt },
                  { Key: "ReceiverPartyPublicName", Value: `${r.msisdn} - Merchant` },
                  { Key: "B2CWorkingAccountAvailableFunds", Value: working / 100 },
                  { Key: "B2CUtilityAccountAvailableFunds", Value: utility / 100 },
                ],
              },
        },
      });
    });
    return { accepted: true, conversationId };
  }

  async queryPayoutStatus(p: { payoutId: string; originatorConversationId: string }) {
    const t = await one<{ txn_id: string; amount_minor: number }>(db(), `select txn_id, amount_minor from sim_transactions where kind = 'b2c' and account_ref = $1`, [p.originatorConversationId]);
    const reqConv = `AG_SIMQ_${randomUUID().slice(0, 10)}`;
    await db().query(`insert into provider_requests (kind, originator_conversation_id, conversation_id, ref_type, ref_id, request) values ('payout_status', $1, $2, 'payout', $3, '{}')`, [reqConv, reqConv, p.payoutId]);
    later(async () => {
      await deliver(callbackUrls(selfUrl).statusResult, {
        Result: t
          ? {
              ResultType: 0,
              ResultCode: 0,
              ResultDesc: "The service request is processed successfully.",
              OriginatorConversationID: reqConv,
              ConversationID: reqConv,
              ResultParameters: {
                ResultParameter: [
                  { Key: "TransactionStatus", Value: "Completed" },
                  { Key: "ReceiptNo", Value: t.txn_id },
                  { Key: "Amount", Value: t.amount_minor / 100 },
                ],
              },
            }
          : { ResultType: 0, ResultCode: 2001, ResultDesc: "The transaction ID is invalid", OriginatorConversationID: reqConv, ConversationID: reqConv },
      });
    }, Math.min(delay(), 500));
  }

  async getAccountBalance(): Promise<Balances> {
    const t0 = Date.now();
    const utility = await simBalance(db(), "utility");
    const working = await simBalance(db(), "working");
    await recordHealth("balance", true, Date.now() - t0);
    return { utilityMinor: utility, workingMinor: working, accounts: { "Utility Account": utility, "Working Account": working } };
  }

  async registerC2BUrls() {
    return { ok: true, detail: "Simulated provider: no registration needed" };
  }

  status() {
    return {
      name: "Simulated M-Pesa",
      environment: "simulated",
      shortcode: env.daraja.shortcode,
      configured: { oauth: true, stk: true, initiator: true, callbackSecret: true, ipAllowlist: false },
      maskedConsumerKey: null,
      credentialsRotatedAt: null,
    };
  }
}

// ------------------------------------------------------------------ the provider simulator

export type SimPayment = {
  accountRef: string;
  amountMinor: number;
  msisdn?: string;
  firstName?: string;
  /** Deliver the confirmation twice. */
  duplicate?: boolean;
  /** Skip validation and send the confirmation first, as Safaricom sometimes does. */
  skipValidation?: boolean;
  /** A callback the provider never issued (to test forged callbacks). */
  forged?: boolean;
  /** Deliver the confirmation before the validation, as an out-of-order network might. */
  outOfOrder?: boolean;
};

/** A customer pays the Paybill: validation, then (if accepted) confirmation. */
export async function simulateC2B(p: SimPayment) {
  const urls = callbackUrls(selfUrl);
  const txn = shortRef("S", 9);
  const msisdn = p.msisdn ?? "254712345678";
  const payload = {
    TransactionType: "Pay Bill",
    TransID: txn,
    TransTime: mpesaTimestamp(),
    TransAmount: (p.amountMinor / 100).toFixed(2),
    BusinessShortCode: env.daraja.shortcode,
    BillRefNumber: p.accountRef,
    InvoiceNumber: "",
    OrgAccountBalance: "",
    ThirdPartyTransID: "",
    MSISDN: msisdn,
    FirstName: p.firstName ?? "Test",
    MiddleName: "",
    LastName: "Customer",
  };
  if (!p.skipValidation && !p.outOfOrder) {
    const v = await deliver(urls.c2bValidation, payload);
    const code = String((v.body as { ResultCode?: unknown })?.ResultCode ?? "");
    if (code !== "0") return { txn, validation: v.body, charged: false };
  }
  if (!p.forged) {
    await db().tx(async (q) => {
      await q.query(`insert into sim_transactions (txn_id, kind, amount_minor, shortcode, account_ref, msisdn) values ($1,'c2b',$2,$3,$4,$5)`, [txn, p.amountMinor, env.daraja.shortcode, p.accountRef, msisdn]);
      await simMove(q, "utility", p.amountMinor);
    });
  }
  const c = await deliver(urls.c2bConfirmation, payload);
  const late = p.outOfOrder ? await deliver(urls.c2bValidation, payload) : null;
  const again = p.duplicate ? await deliver(urls.c2bConfirmation, payload) : null;
  return { txn, confirmation: c.body, lateValidation: late?.body ?? null, duplicate: again?.body ?? null, charged: true };
}

/** What the operator would do in the M-Pesa portal: move money between Utility and Working. */
export async function simulatePortalTransfer(from: "utility" | "working", to: "utility" | "working", amountMinor: number) {
  const ref = shortRef("T", 9);
  await db().tx(async (q) => {
    const have = await simBalance(q, from);
    if (have < amountMinor) throw badRequest(`The simulated ${from} account only has KSh ${(have / 100).toLocaleString("en-KE")}`);
    await simMove(q, from, -amountMinor);
    await simMove(q, to, amountMinor);
    await q.query(`insert into sim_transactions (txn_id, kind, amount_minor, shortcode, account_ref) values ($1,'transfer',$2,$3,$4)`, [ref, amountMinor, env.daraja.shortcode, `${from}->${to}`]);
  });
  return { reference: ref };
}

export async function simulatorBalances() {
  return { utilityMinor: await simBalance(db(), "utility"), workingMinor: await simBalance(db(), "working") };
}
