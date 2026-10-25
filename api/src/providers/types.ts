import type { Q } from "../config/db.js";

// One interface for every payment provider (spec section 3). Daraja now, IntaSend later.
// Several Daraja answers arrive later on a result URL; the adapter records a
// provider_requests row and the callback completes it, so callers see plain promises.

export type CollectionCallback = {
  providerTxnId: string;
  channel: "c2b" | "stk";
  amountMinor: number;
  accountRef: string;
  shortcode: string;
  /** May be masked or hashed by Safaricom; never depend on it. */
  msisdn: string | null;
  firstName: string | null;
  middleName: string | null;
  lastName: string | null;
  transTime: Date | null;
  orgBalanceMinor: number | null;
  raw: unknown;
};

export type VerifyResult =
  | { status: "verified"; detail?: unknown }
  | { status: "mismatch"; reason: string; detail?: unknown }
  | { status: "unavailable"; reason: string };

export type PayoutRequest = {
  payoutId: string;
  originatorConversationId: string;
  msisdn: string;
  amountMinor: number;
  remarks: string;
};
export type PayoutAccepted = { accepted: true; conversationId: string | null } | { accepted: false; reason: string; retryable: boolean };

export type PayoutResult = {
  originatorConversationId: string | null;
  conversationId: string | null;
  outcome: "succeeded" | "failed" | "timed_out";
  resultCode: string;
  resultDesc: string;
  receipt: string | null;
  amountMinor: number | null;
  completedAt: Date | null;
  workingBalanceMinor: number | null;
  utilityBalanceMinor: number | null;
  raw: unknown;
};

export type Balances = { utilityMinor: number | null; workingMinor: number | null; accounts: Record<string, number> };

export type StkRequest = { stkRequestId: string; phone: string; amountMinor: number; accountRef: string; description: string };
export type StkAccepted = { merchantRequestId: string; checkoutRequestId: string; customerMessage: string };
export type StkResult = {
  checkoutRequestId: string;
  merchantRequestId: string | null;
  success: boolean;
  resultCode: string;
  resultDesc: string;
  receipt: string | null;
  amountMinor: number | null;
  phone: string | null;
  transTime: Date | null;
  raw: unknown;
};

export type ProviderStatus = {
  name: string;
  environment: string;
  shortcode: string;
  configured: Record<string, boolean>;
  maskedConsumerKey: string | null;
  credentialsRotatedAt: string | null;
};

export interface PaymentProvider {
  readonly name: "daraja" | "simulated" | "intasend";
  parseCollectionCallback(body: unknown): CollectionCallback;
  verifyCollection(q: Q, p: { paymentId: string; providerTxnId: string; amountMinor: number; shortcode: string }, budgetMs: number): Promise<VerifyResult>;
  initiateStkPush(r: StkRequest): Promise<StkAccepted>;
  parseStkCallback(body: unknown): StkResult;
  initiatePayout(r: PayoutRequest): Promise<PayoutAccepted>;
  parsePayoutResult(body: unknown, kind: "result" | "timeout"): PayoutResult;
  /** Asks the provider for a payout's real outcome; the answer arrives on the status result URL. */
  queryPayoutStatus(p: { payoutId: string; originatorConversationId: string; receipt: string | null }): Promise<void>;
  /** Fresh balances, waiting up to `budgetMs` for an asynchronous answer. Null if none arrived in time. */
  getAccountBalance(budgetMs: number): Promise<Balances | null>;
  registerC2BUrls(): Promise<{ ok: boolean; detail: string }>;
  status(): ProviderStatus;
}
