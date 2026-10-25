import { env } from "../config/env.js";
import { type Q } from "../config/db.js";
import { mpesaTimestamp, parseMpesaTime, toMinor } from "../lib/kenya.js";
import { callbackUrls, completeRequest, openRequest, parseAccountBalance, recordHealth, resultParams, waitForRequest } from "./common.js";
import type { Balances, CollectionCallback, PaymentProvider, PayoutAccepted, PayoutResult, StkAccepted, StkResult, VerifyResult } from "./types.js";

// Safaricom Daraja: C2B (with validation), STK push, B2C, Transaction Status and Account
// Balance. Credentials come from the environment and never leave this module. Status,
// balance and B2C answers arrive later on our result URLs.

const base = () => (env.daraja.env === "production" ? "https://api.safaricom.co.ke" : "https://sandbox.safaricom.co.ke");
let token: { value: string; until: number } | null = null;

async function accessToken(): Promise<string> {
  if (token && Date.now() < token.until) return token.value;
  const t0 = Date.now();
  const auth = Buffer.from(`${env.daraja.consumerKey}:${env.daraja.consumerSecret}`).toString("base64");
  const r = await fetch(`${base()}/oauth/v1/generate?grant_type=client_credentials`, { headers: { Authorization: `Basic ${auth}` }, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) {
    await recordHealth("oauth", false, Date.now() - t0, `HTTP ${r.status}`);
    throw new Error(`Daraja OAuth failed (HTTP ${r.status})`);
  }
  const j = (await r.json()) as { access_token: string; expires_in: string | number };
  token = { value: j.access_token, until: Date.now() + (Number(j.expires_in) - 60) * 1000 };
  await recordHealth("oauth", true, Date.now() - t0);
  return token.value;
}

async function call<T>(api: string, path: string, body: unknown): Promise<T> {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base()}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await r.text();
    let j: Record<string, unknown> = {};
    try {
      j = JSON.parse(text);
    } catch {
      j = { raw: text.slice(0, 500) };
    }
    if (!r.ok || (j.ResponseCode != null && String(j.ResponseCode) !== "0")) {
      const msg = String(j.errorMessage ?? j.ResponseDescription ?? `HTTP ${r.status}`);
      await recordHealth(api, false, Date.now() - t0, msg);
      throw Object.assign(new Error(msg), { response: j, httpStatus: r.status });
    }
    await recordHealth(api, true, Date.now() - t0);
    return j as T;
  } catch (e) {
    if (!(e as { response?: unknown }).response) await recordHealth(api, false, Date.now() - t0, (e as Error).message);
    throw e;
  }
}

const str = (v: unknown) => (v == null ? "" : String(v));

export class DarajaProvider implements PaymentProvider {
  readonly name = "daraja" as const;

  parseCollectionCallback(body: unknown): CollectionCallback {
    const b = (body ?? {}) as Record<string, unknown>;
    const id = str(b.TransID).trim();
    if (!/^[A-Z0-9]{6,20}$/i.test(id)) throw new Error("TransID missing or malformed");
    const amount = toMinor(b.TransAmount);
    if (!Number.isFinite(amount) || amount <= 0) throw new Error("TransAmount missing or invalid");
    return {
      providerTxnId: id.toUpperCase(),
      channel: "c2b",
      amountMinor: amount,
      accountRef: str(b.BillRefNumber).slice(0, 40),
      shortcode: str(b.BusinessShortCode),
      msisdn: b.MSISDN ? str(b.MSISDN) : null,
      firstName: b.FirstName ? str(b.FirstName) : null,
      middleName: b.MiddleName ? str(b.MiddleName) : null,
      lastName: b.LastName ? str(b.LastName) : null,
      transTime: parseMpesaTime(b.TransTime),
      orgBalanceMinor: b.OrgAccountBalance != null && b.OrgAccountBalance !== "" ? toMinor(b.OrgAccountBalance) : null,
      raw: body,
    };
  }

  async verifyCollection(_q: Q, p: { paymentId: string; providerTxnId: string; amountMinor: number; shortcode: string }, budgetMs: number): Promise<VerifyResult> {
    if (!env.daraja.initiator || !env.daraja.securityCredential) return { status: "unavailable", reason: "Transaction Status needs DARAJA_INITIATOR and DARAJA_SECURITY_CREDENTIAL" };
    const urls = callbackUrls();
    let res: { OriginatorConversationID?: string; ConversationID?: string };
    try {
      res = await call("status", "/mpesa/transactionstatus/v1/query", {
        Initiator: env.daraja.initiator,
        SecurityCredential: env.daraja.securityCredential,
        CommandID: "TransactionStatusQuery",
        TransactionID: p.providerTxnId,
        PartyA: env.daraja.shortcode,
        IdentifierType: "4",
        ResultURL: urls.statusResult,
        QueueTimeOutURL: urls.statusTimeout,
        Remarks: "Verify payment",
        Occasion: p.paymentId.slice(0, 20),
      });
    } catch (e) {
      return { status: "unavailable", reason: (e as Error).message };
    }
    const reqId = await openRequest("status", res.OriginatorConversationID ?? null, res.ConversationID ?? null, { type: "payment", id: p.paymentId }, { txn: p.providerTxnId });
    const done = await waitForRequest(reqId, budgetMs);
    if (!done) return { status: "unavailable", reason: "No answer within the verification budget" };
    return judgeStatus(done.result, p);
  }

  async initiateStkPush(r: { stkRequestId: string; phone: string; amountMinor: number; accountRef: string; description: string }): Promise<StkAccepted> {
    const ts = mpesaTimestamp();
    const password = Buffer.from(`${env.daraja.shortcode}${env.daraja.passkey}${ts}`).toString("base64");
    const j = await call<{ MerchantRequestID: string; CheckoutRequestID: string; CustomerMessage: string }>("stk", "/mpesa/stkpush/v1/processrequest", {
      BusinessShortCode: env.daraja.shortcode,
      Password: password,
      Timestamp: ts,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(r.amountMinor / 100),
      PartyA: r.phone,
      PartyB: env.daraja.shortcode,
      PhoneNumber: r.phone,
      CallBackURL: callbackUrls().stk,
      AccountReference: r.accountRef.slice(0, 12),
      TransactionDesc: r.description.slice(0, 13),
    });
    return { merchantRequestId: j.MerchantRequestID, checkoutRequestId: j.CheckoutRequestID, customerMessage: j.CustomerMessage };
  }

  parseStkCallback(body: unknown): StkResult {
    const cb = (body as { Body?: { stkCallback?: Record<string, unknown> } })?.Body?.stkCallback ?? {};
    const items = ((cb.CallbackMetadata as { Item?: { Name: string; Value?: unknown }[] })?.Item ?? []).reduce<Record<string, unknown>>((m, i) => ((m[i.Name] = i.Value), m), {});
    const code = str(cb.ResultCode);
    return {
      checkoutRequestId: str(cb.CheckoutRequestID),
      merchantRequestId: cb.MerchantRequestID ? str(cb.MerchantRequestID) : null,
      success: code === "0",
      resultCode: code,
      resultDesc: str(cb.ResultDesc),
      receipt: items.MpesaReceiptNumber ? str(items.MpesaReceiptNumber) : null,
      amountMinor: items.Amount != null ? toMinor(items.Amount) : null,
      phone: items.PhoneNumber != null ? str(items.PhoneNumber) : null,
      transTime: parseMpesaTime(items.TransactionDate),
      raw: body,
    };
  }

  async initiatePayout(r: { payoutId: string; originatorConversationId: string; msisdn: string; amountMinor: number; remarks: string }): Promise<PayoutAccepted> {
    if (!env.daraja.initiator || !env.daraja.securityCredential) return { accepted: false, reason: "B2C is not configured (DARAJA_INITIATOR, DARAJA_SECURITY_CREDENTIAL)", retryable: false };
    const urls = callbackUrls();
    try {
      const j = await call<{ ConversationID?: string; OriginatorConversationID?: string }>("b2c", "/mpesa/b2c/v3/paymentrequest", {
        OriginatorConversationID: r.originatorConversationId,
        InitiatorName: env.daraja.initiator,
        SecurityCredential: env.daraja.securityCredential,
        CommandID: env.daraja.b2cCommand,
        Amount: Math.round(r.amountMinor / 100),
        PartyA: env.daraja.shortcode,
        PartyB: r.msisdn,
        Remarks: r.remarks.slice(0, 100),
        QueueTimeOutURL: urls.b2cTimeout,
        ResultURL: urls.b2cResult,
        Occasion: r.payoutId.slice(0, 20),
      });
      return { accepted: true, conversationId: j.ConversationID ?? null };
    } catch (e) {
      // A refused request (HTTP 4xx, ResponseCode non-zero) never reached the queue: safe to retry.
      // A network failure might have; the payout is then left for a status query.
      const http = (e as { httpStatus?: number }).httpStatus;
      return { accepted: false, reason: (e as Error).message, retryable: http != null && http < 500 };
    }
  }

  parsePayoutResult(body: unknown, kind: "result" | "timeout"): PayoutResult {
    const r = ((body as { Result?: Record<string, unknown> })?.Result ?? body ?? {}) as Record<string, unknown>;
    const params = resultParams(r);
    const code = str(r.ResultCode);
    const outcome = kind === "timeout" ? "timed_out" : code === "0" ? "succeeded" : "failed";
    return {
      originatorConversationId: r.OriginatorConversationID ? str(r.OriginatorConversationID) : null,
      conversationId: r.ConversationID ? str(r.ConversationID) : null,
      outcome,
      resultCode: code,
      resultDesc: str(r.ResultDesc) || (kind === "timeout" ? "Request timed out in the provider queue" : ""),
      receipt: params.TransactionReceipt ? str(params.TransactionReceipt) : r.TransactionID ? str(r.TransactionID) : null,
      amountMinor: params.TransactionAmount != null ? toMinor(params.TransactionAmount) : null,
      completedAt: new Date(),
      workingBalanceMinor: params.B2CWorkingAccountAvailableFunds != null ? toMinor(params.B2CWorkingAccountAvailableFunds) : null,
      utilityBalanceMinor: params.B2CUtilityAccountAvailableFunds != null ? toMinor(params.B2CUtilityAccountAvailableFunds) : null,
      raw: body,
    };
  }

  async queryPayoutStatus(p: { payoutId: string; originatorConversationId: string; receipt: string | null }): Promise<void> {
    const urls = callbackUrls();
    const body: Record<string, unknown> = {
      Initiator: env.daraja.initiator,
      SecurityCredential: env.daraja.securityCredential,
      CommandID: "TransactionStatusQuery",
      PartyA: env.daraja.shortcode,
      IdentifierType: "4",
      ResultURL: urls.statusResult,
      QueueTimeOutURL: urls.statusTimeout,
      Remarks: "Payout status",
      Occasion: p.payoutId.slice(0, 20),
    };
    // With a receipt we ask by it; without one, by the id we gave the request.
    if (p.receipt) body.TransactionID = p.receipt;
    else body.OriginalConversationID = p.originatorConversationId;
    const res = await call<{ OriginatorConversationID?: string; ConversationID?: string }>("status", "/mpesa/transactionstatus/v1/query", body);
    await openRequest("payout_status", res.OriginatorConversationID ?? null, res.ConversationID ?? null, { type: "payout", id: p.payoutId }, { originatorConversationId: p.originatorConversationId });
  }

  async getAccountBalance(budgetMs: number): Promise<Balances | null> {
    if (!env.daraja.initiator || !env.daraja.securityCredential) return null;
    const urls = callbackUrls();
    const res = await call<{ OriginatorConversationID?: string; ConversationID?: string }>("balance", "/mpesa/accountbalance/v1/query", {
      Initiator: env.daraja.initiator,
      SecurityCredential: env.daraja.securityCredential,
      CommandID: "AccountBalance",
      PartyA: env.daraja.shortcode,
      IdentifierType: "4",
      Remarks: "Float check",
      QueueTimeOutURL: urls.balance,
      ResultURL: urls.balance,
    });
    const id = await openRequest("balance", res.OriginatorConversationID ?? null, res.ConversationID ?? null, null, {});
    const done = await waitForRequest(id, budgetMs);
    if (!done || done.status !== "completed") return null;
    return balancesFromResult(done.result);
  }

  async registerC2BUrls() {
    const urls = callbackUrls();
    try {
      const j = await call<{ ResponseDescription?: string }>("register", "/mpesa/c2b/v2/registerurl", {
        ShortCode: env.daraja.shortcode,
        ResponseType: env.daraja.c2bResponseType,
        ConfirmationURL: urls.c2bConfirmation,
        ValidationURL: urls.c2bValidation,
      });
      return { ok: true, detail: j.ResponseDescription ?? "Registered" };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  status() {
    const k = env.daraja.consumerKey;
    return {
      name: "Safaricom Daraja",
      environment: env.daraja.env,
      shortcode: env.daraja.shortcode,
      configured: {
        oauth: Boolean(env.daraja.consumerKey && env.daraja.consumerSecret),
        stk: Boolean(env.daraja.passkey),
        initiator: Boolean(env.daraja.initiator && env.daraja.securityCredential),
        callbackSecret: env.callbackSecret.length >= 16,
        ipAllowlist: env.daraja.ipAllowlist.length > 0,
      },
      maskedConsumerKey: k ? `${k.slice(0, 4)}••••${k.slice(-4)}` : null,
      credentialsRotatedAt: env.daraja.credentialsRotatedAt,
    };
  }
}

/** Compares a Transaction Status answer with what the callback claimed. */
export function judgeStatus(result: unknown, p: { amountMinor: number; shortcode: string }): VerifyResult {
  const r = ((result as { Result?: Record<string, unknown> })?.Result ?? result ?? {}) as Record<string, unknown>;
  const code = str(r.ResultCode);
  if (code !== "0") {
    const desc = str(r.ResultDesc);
    if (/invalid|not found|does not exist/i.test(desc)) return { status: "mismatch", reason: `Provider has no such transaction (${desc})`, detail: r };
    return { status: "unavailable", reason: desc || `Result code ${code}` };
  }
  const params = resultParams(r);
  const amount = params.Amount != null ? toMinor(params.Amount) : null;
  const credit = str(params.CreditPartyName);
  const status = str(params.TransactionStatus);
  if (status && !/completed/i.test(status)) return { status: "mismatch", reason: `Transaction status is ${status}`, detail: params };
  if (amount != null && amount !== p.amountMinor) return { status: "mismatch", reason: `Amount is ${amount / 100}, callback said ${p.amountMinor / 100}`, detail: params };
  if (credit && p.shortcode && !credit.startsWith(p.shortcode)) return { status: "mismatch", reason: `Paid to ${credit.split(" ")[0]}, not ${p.shortcode}`, detail: params };
  return { status: "verified", detail: params };
}

export function balancesFromResult(result: unknown): Balances {
  const r = ((result as { Result?: Record<string, unknown> })?.Result ?? result ?? {}) as Record<string, unknown>;
  const accounts = parseAccountBalance(resultParams(r).AccountBalance);
  return { utilityMinor: accounts["Utility Account"] ?? null, workingMinor: accounts["Working Account"] ?? null, accounts };
}

/** Called from the status/balance result callbacks. */
export async function completeDarajaResult(q: Q, kind: "status" | "balance", body: unknown, timedOut: boolean) {
  const r = ((body as { Result?: Record<string, unknown> })?.Result ?? body ?? {}) as Record<string, unknown>;
  return completeRequest(q, { originatorConversationId: r.OriginatorConversationID ? str(r.OriginatorConversationID) : null, conversationId: r.ConversationID ? str(r.ConversationID) : null }, timedOut ? "timeout" : "completed", body);
}
