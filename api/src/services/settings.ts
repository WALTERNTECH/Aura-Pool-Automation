import { z } from "zod";
import { db, many, type Q } from "../config/db.js";

// Business rules the operator controls, with the defaults from the platform spec. Stored in
// the settings table as JSON; read through a short cache so hot paths don't hit the database.

const band = z.object({ upTo: z.number().int().positive(), fee: z.number().int().nonnegative() });

export const SETTINGS = {
  /** Verification of each collection with the provider (spec 6.4). */
  verify_mode: z.enum(["sync", "async"]).default("sync"),
  defaults: z
    .object({
      price_minor: z.number().int().positive(),
      unlock_seconds: z.number().int().min(5).max(60),
      commission_minor: z.number().int().nonnegative(),
      commission_pct: z.number().min(0).max(99),
      price_min_minor: z.number().int().positive(),
      price_max_minor: z.number().int().positive(),
      unlock_min_s: z.number().int().min(5).max(60),
      unlock_max_s: z.number().int().min(5).max(60),
    })
    .default({ price_minor: 5000, unlock_seconds: 20, commission_minor: 500, commission_pct: 0, price_min_minor: 2000, price_max_minor: 20000, unlock_min_s: 10, unlock_max_s: 30 }),
  /** Who bears the B2C fee and the Paybill collection fee. */
  fee_policy: z.object({ b2c: z.enum(["merchant", "platform"]), collection: z.enum(["platform", "merchant"]) }).default({ b2c: "merchant", collection: "platform" }),
  payout: z
    .object({
      min_minor: z.number().int().positive(),
      daily_cap_minor: z.number().int().positive(),
      approval_threshold_minor: z.number().int().positive(),
      /** Finance can approve payouts up to this; above it a super admin must. */
      finance_approval_limit_minor: z.number().int().positive(),
      cooling_hours: z.number().int().min(0).max(168),
      /** A payout with no result after this many minutes is treated as timed out. */
      result_timeout_min: z.number().int().min(2).max(240),
      /** Shown to owners when a payout waits for float. */
      float_wait_estimate_hours: z.number().min(0).max(72),
    })
    .default({ min_minor: 10000, daily_cap_minor: 5000000, approval_threshold_minor: 2000000, finance_approval_limit_minor: 10000000, cooling_hours: 24, result_timeout_min: 10, float_wait_estimate_hours: 4 }),
  /**
   * Safaricom B2C tariff (Business Payment to a registered customer) the platform pays per
   * payout, by amount band. Confirm against the current Safaricom tariff before going live.
   */
  b2c_tariff: z
    .array(band)
    .default([
      { upTo: 10000, fee: 0 },
      { upTo: 150000, fee: 500 },
      { upTo: 500000, fee: 900 },
      { upTo: 2000000, fee: 1100 },
      { upTo: 25000000, fee: 1300 },
    ]),
  /**
   * What Safaricom deducts from the Utility account per Paybill collection, by band. Empty
   * means none is booked; set it from the Safaricom tariff, or reconciliation will show the gap.
   */
  collection_tariff: z.array(band).default([]),
  amount_rules: z
    .object({
      /** Minutes a part payment or a remainder is held for the same payer before admin review. */
      partial_window_min: z.number().int().min(1).max(1440),
      /** Minutes a game credit keeps retrying while its table is offline. */
      offline_retry_min: z.number().int().min(1).max(240),
      games_cap: z.number().int().min(1).max(50),
    })
    .default({ partial_window_min: 30, offline_retry_min: 15, games_cap: 10 }),
  manual_unlock: z.object({ daily_limit: z.number().int().min(0).max(100), reasons: z.array(z.string().min(2).max(60)).min(1) }).default({
    daily_limit: 10,
    reasons: ["Customer paid cash", "Payment delayed", "Table test after repair", "Coin mechanism jammed", "Other"],
  }),
  float: z
    .object({
      buffer_pct: z.number().min(0).max(200),
      minimum_minor: z.number().int().nonnegative(),
      poll_minutes: z.number().int().min(5).max(240),
      /** Snapshot age (seconds) accepted before a payout without asking the provider again. */
      max_snapshot_age_s: z.number().int().min(0).max(3600),
      /** Recorded transfers above this need a second approver. */
      transfer_approval_threshold_minor: z.number().int().positive(),
    })
    .default({ buffer_pct: 20, minimum_minor: 500000, poll_minutes: 15, max_snapshot_age_s: 120, transfer_approval_threshold_minor: 10000000 }),
  alert_rules: z
    .object({
      offline_minutes: z.number().int().min(1).max(240),
      override_presses_per_hour: z.number().int().min(1).max(200),
      callback_silence_minutes: z.number().int().min(10).max(1440),
      failed_logins: z.number().int().min(3).max(50),
      queue_backlog: z.number().int().min(5).max(10000),
      large_payout_minor: z.number().int().positive(),
    })
    .default({ offline_minutes: 5, override_presses_per_hour: 6, callback_silence_minutes: 120, failed_logins: 5, queue_backlog: 50, large_payout_minor: 2000000 }),
  /** Reconciliation tolerance in minor units (spec: zero). */
  reconciliation: z.object({ tolerance_minor: z.number().int().nonnegative() }).default({ tolerance_minor: 0 }),
  kill_switch: z.object({ on: z.boolean(), reason: z.string().nullable(), by: z.string().nullable(), at: z.string().nullable() }).default({ on: false, reason: null, by: null, at: null }),
  /** Set by a reconciliation mismatch; scheduled payouts wait until someone acknowledges it. */
  auto_payouts_paused: z.object({ on: z.boolean(), reason: z.string().nullable(), run_id: z.string().nullable() }).default({ on: false, reason: null, run_id: null }),
  /** Pilot with one operator: the requester may approve their own request after a delay. */
  single_operator: z.object({ on: z.boolean(), delay_minutes: z.number().int().min(0).max(1440) }).default({ on: true, delay_minutes: 30 }),
  platform_payout: z.object({ msisdn: z.string().nullable() }).default({ msisdn: null }),
  support: z
    .object({ phone: z.string(), whatsapp: z.string(), email: z.string(), hours: z.string() })
    .default({ phone: "", whatsapp: "", email: "", hours: "Every day, 8 am to 10 pm" }),
  /** Where critical alerts and reports go. */
  operator_contacts: z.object({ sms: z.array(z.string()), email: z.array(z.string()) }).default({ sms: [], email: [] }),
  reports: z
    .object({ daily_email: z.boolean(), monthly_email: z.boolean(), recipients: z.array(z.string().email()) })
    .default({ daily_email: true, monthly_email: true, recipients: [] }),
  terms_version: z.string().default("2026-10-25"),
  provider_state: z
    .object({ urls_registered_at: z.string().nullable(), urls_register_result: z.string().nullable(), intasend_enabled: z.boolean() })
    .default({ urls_registered_at: null, urls_register_result: null, intasend_enabled: false }),
  backups: z.object({ note: z.string(), last_verified_at: z.string().nullable() }).default({ note: "Supabase daily backups with point-in-time recovery", last_verified_at: null }),
} as const;

export type SettingKey = keyof typeof SETTINGS;
export type Setting<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]>;

let cache: { at: number; values: Map<string, unknown> } | null = null;
const TTL = 5_000;

async function load(q: Q): Promise<Map<string, unknown>> {
  if (cache && Date.now() - cache.at < TTL) return cache.values;
  const rows = await many<{ key: string; value: unknown }>(q, `select key, value from settings`);
  const values = new Map(rows.map((r) => [r.key, r.value]));
  cache = { at: Date.now(), values };
  return values;
}

export function invalidateSettings() {
  cache = null;
}

export async function getSetting<K extends SettingKey>(key: K, q: Q = db()): Promise<Setting<K>> {
  const values = await load(q);
  const parsed = SETTINGS[key].safeParse(values.get(key));
  return (parsed.success ? parsed.data : SETTINGS[key].parse(undefined)) as Setting<K>;
}

/** Reads a setting inside a transaction, bypassing the cache (for decisions that must be current). */
export async function getSettingFresh<K extends SettingKey>(key: K, q: Q): Promise<Setting<K>> {
  const rows = await many<{ value: unknown }>(q, `select value from settings where key = $1`, [key]);
  const parsed = SETTINGS[key].safeParse(rows[0]?.value);
  return (parsed.success ? parsed.data : SETTINGS[key].parse(undefined)) as Setting<K>;
}

export async function setSetting<K extends SettingKey>(key: K, value: Setting<K>, by: string, q: Q = db()): Promise<{ before: Setting<K>; after: Setting<K> }> {
  const after = SETTINGS[key].parse(value) as Setting<K>;
  const before = await getSettingFresh(key, q);
  await q.query(
    `insert into settings (key, value, updated_by, updated_at) values ($1, $2, $3, now())
     on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`,
    [key, JSON.stringify(after), by],
  );
  invalidateSettings();
  return { before, after };
}

export async function allSettings(q: Q = db()) {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(SETTINGS) as SettingKey[]) out[k] = await getSetting(k, q);
  return out;
}

function fromBands(bands: { upTo: number; fee: number }[], amountMinor: number): number {
  const sorted = [...bands].sort((a, b) => a.upTo - b.upTo);
  for (const b of sorted) if (amountMinor <= b.upTo) return b.fee;
  return sorted[sorted.length - 1]?.fee ?? 0;
}

/** The B2C tariff for a payout amount. */
export async function b2cTariff(amountMinor: number, q: Q = db()): Promise<number> {
  return fromBands(await getSetting("b2c_tariff", q), amountMinor);
}

/** The Paybill collection charge on a payment. */
export async function collectionTariff(amountMinor: number, q: Q = db()): Promise<number> {
  return fromBands(await getSetting("collection_tariff", q), amountMinor);
}
