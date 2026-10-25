import { many, one, type Q } from "../config/db.js";

// Double-entry ledger (spec section 7). A debit is positive, a credit negative; each
// transaction sums to zero, enforced by a deferred trigger at commit, and entries are
// append-only. Balances are kept on the account row by trigger and re-checked nightly.
//
// Accounts:
//   provider_utility       asset      money received by C2B
//   provider_working       asset      money available for B2C payouts
//   merchant_payable:{id}  liability  what we owe each merchant
//   platform_revenue       revenue    commission
//   provider_fees_expense  expense    B2C tariffs (less what merchants are charged)
//   payout_in_transit      liability  payouts requested, not yet confirmed
//   refunds_payable        liability  money owed back to customers
//   suspense               liability  unmatched money and held part payments
//   platform_drawings      equity     the operator's own withdrawals of commission

export type AccountCode =
  | "provider_utility"
  | "provider_working"
  | "platform_revenue"
  | "provider_fees_expense"
  | "payout_in_transit"
  | "refunds_payable"
  | "suspense"
  | "platform_drawings"
  | `merchant_payable:${string}`;

export const FIXED_ACCOUNTS: { code: AccountCode; type: string; name: string }[] = [
  { code: "provider_utility", type: "asset", name: "M-Pesa Utility account" },
  { code: "provider_working", type: "asset", name: "M-Pesa Working account" },
  { code: "platform_revenue", type: "revenue", name: "Platform commission" },
  { code: "provider_fees_expense", type: "expense", name: "Provider fees" },
  { code: "payout_in_transit", type: "liability", name: "Payouts in transit" },
  { code: "refunds_payable", type: "liability", name: "Refunds owed to customers" },
  { code: "suspense", type: "liability", name: "Suspense" },
  { code: "platform_drawings", type: "equity", name: "Operator withdrawals" },
];

export const merchantAccount = (merchantId: string): AccountCode => `merchant_payable:${merchantId}`;

function accountMeta(code: AccountCode): { type: string; name: string; merchantId: string | null } {
  const fixed = FIXED_ACCOUNTS.find((a) => a.code === code);
  if (fixed) return { type: fixed.type, name: fixed.name, merchantId: null };
  const m = code.match(/^merchant_payable:([0-9a-f-]{36})$/);
  if (!m) throw new Error(`unknown ledger account ${code}`);
  return { type: "liability", name: "Merchant payable", merchantId: m[1] };
}

export type Line = { account: AccountCode; amount: number };

export type Posting = {
  kind: string;
  refType?: string;
  refId?: string;
  /** A second posting with the same key is ignored and returns the first transaction's id. */
  idempotencyKey?: string;
  memo?: string;
  createdBy?: string;
  reverses?: string;
  lines: Line[];
};

/** Writes one balanced transaction. Must be called inside the caller's database transaction. */
export async function post(q: Q, p: Posting): Promise<string> {
  const lines = p.lines.filter((l) => l.amount !== 0);
  if (!lines.length) throw new Error(`ledger posting ${p.kind} has no non-zero lines`);
  for (const l of lines) if (!Number.isSafeInteger(l.amount)) throw new Error(`ledger amount must be an integer (got ${l.amount})`);
  const sum = lines.reduce((s, l) => s + l.amount, 0);
  if (sum !== 0) throw new Error(`ledger posting ${p.kind} does not balance (off by ${sum})`);

  if (p.idempotencyKey) {
    const prior = await one<{ id: string }>(q, `select id from ledger_transactions where idempotency_key = $1`, [p.idempotencyKey]);
    if (prior) return prior.id;
  }

  const codes = [...new Set(lines.map((l) => l.account))];
  const metas = codes.map(accountMeta);
  await q.query(
    `insert into ledger_accounts (code, type, name, merchant_id)
     select * from unnest($1::text[], $2::text[], $3::text[], $4::uuid[])
     on conflict (code) do nothing`,
    [codes, metas.map((m) => m.type), metas.map((m) => m.name), metas.map((m) => m.merchantId)],
  );
  const tx = await one<{ id: string }>(
    q,
    `insert into ledger_transactions (kind, ref_type, ref_id, idempotency_key, memo, created_by, reverses)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [p.kind, p.refType ?? null, p.refId ?? null, p.idempotencyKey ?? null, p.memo ?? null, p.createdBy ?? "system", p.reverses ?? null],
  );
  const inserted = await many(
    q,
    `insert into ledger_entries (transaction_id, account_id, amount_minor)
     select $1, a.id, l.amount
       from unnest($2::text[], $3::bigint[]) with ordinality as l(code, amount, ord)
       join ledger_accounts a on a.code = l.code
      order by l.ord
     returning id`,
    [tx!.id, lines.map((l) => l.account), lines.map((l) => l.amount)],
  );
  if (inserted.length !== lines.length) throw new Error("ledger posting lost a line");
  return tx!.id;
}

/** Posts the exact opposite of a transaction. */
export async function reverse(q: Q, transactionId: string, kind: string, createdBy: string, memo: string): Promise<string> {
  const lines = await many<{ code: AccountCode; amount_minor: number }>(
    q,
    `select a.code, e.amount_minor from ledger_entries e join ledger_accounts a on a.id = e.account_id where e.transaction_id = $1 order by e.id`,
    [transactionId],
  );
  if (!lines.length) throw new Error(`ledger transaction ${transactionId} not found`);
  return post(q, { kind, reverses: transactionId, refType: "ledger_transaction", refId: transactionId, idempotencyKey: `reverse:${transactionId}`, memo, createdBy, lines: lines.map((l) => ({ account: l.code, amount: -l.amount_minor })) });
}

/** Signed balance: debit-positive. */
export async function balance(q: Q, code: AccountCode): Promise<number> {
  const r = await one<{ balance_minor: number }>(q, `select balance_minor from ledger_accounts where code = $1`, [code]);
  return r?.balance_minor ?? 0;
}

/** What a merchant can withdraw now: what we owe them, minus payouts already reserved. */
export async function merchantAvailable(q: Q, merchantId: string): Promise<number> {
  return -(await balance(q, merchantAccount(merchantId)));
}

/** What the operator can withdraw: commission less provider fees less earlier withdrawals. */
export async function platformAvailable(q: Q): Promise<number> {
  const r = await one<{ v: number }>(
    q,
    `select coalesce(sum(case code when 'platform_revenue' then -balance_minor when 'provider_fees_expense' then -balance_minor when 'platform_drawings' then -balance_minor end), 0) as v
       from ledger_accounts where code in ('platform_revenue','provider_fees_expense','platform_drawings')`,
  );
  return r?.v ?? 0;
}

export type InvariantReport = { ok: boolean; problems: string[]; checkedAt: string };

/** Nightly: entries sum to zero, cached balances match entries, no merchant is owed a negative amount. */
export async function checkInvariants(q: Q): Promise<InvariantReport> {
  const problems: string[] = [];
  const total = await one<{ s: number }>(q, `select coalesce(sum(amount_minor), 0) as s from ledger_entries`);
  if ((total?.s ?? 0) !== 0) problems.push(`All entries sum to ${total?.s}, not zero`);
  const unbalanced = await many<{ transaction_id: string; s: number }>(q, `select transaction_id, sum(amount_minor) as s from ledger_entries group by transaction_id having sum(amount_minor) <> 0 limit 20`);
  for (const u of unbalanced) problems.push(`Transaction ${u.transaction_id} is off by ${u.s}`);
  const drift = await many<{ code: string; cached: number; actual: number }>(
    q,
    `select a.code, a.balance_minor as cached, coalesce(sum(e.amount_minor), 0) as actual
       from ledger_accounts a left join ledger_entries e on e.account_id = a.id
      group by a.id having a.balance_minor <> coalesce(sum(e.amount_minor), 0)`,
  );
  for (const d of drift) problems.push(`Account ${d.code} shows ${d.cached} but its entries sum to ${d.actual}`);
  const negative = await many<{ code: string; balance_minor: number }>(q, `select code, balance_minor from ledger_accounts where code like 'merchant_payable:%' and balance_minor > 0`);
  for (const n of negative) problems.push(`Merchant account ${n.code} is negative (${-n.balance_minor})`);
  return { ok: problems.length === 0, problems, checkedAt: new Date().toISOString() };
}
