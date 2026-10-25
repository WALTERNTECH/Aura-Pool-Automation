import { one, type Q } from "../config/db.js";
import { getSetting } from "./settings.js";

// What a game costs on a table, what the platform keeps, and the bounds an owner may set.
// Commission rules carry an effective-from time and apply only to payments after it; the
// most specific rule wins (table, then merchant, then the platform default).

export type Commission = { commissionMinor: number; commissionPct: number; source: "table" | "merchant" | "default"; effectiveFrom: string | null };

export async function commissionFor(q: Q, tableId: string, merchantId: string, at = new Date()): Promise<Commission> {
  const r = await one<{ scope: "table" | "merchant" | "default"; commission_minor: number; commission_pct: number; effective_from: Date }>(
    q,
    `select scope, commission_minor, commission_pct, effective_from from pricing_rules
      where effective_from <= $3
        and ((scope = 'table' and scope_id = $1) or (scope = 'merchant' and scope_id = $2) or scope = 'default')
      order by case scope when 'table' then 0 when 'merchant' then 1 else 2 end, effective_from desc
      limit 1`,
    [tableId, merchantId, at],
  );
  if (r) return { commissionMinor: r.commission_minor, commissionPct: Number(r.commission_pct), source: r.scope, effectiveFrom: new Date(r.effective_from).toISOString() };
  const d = await getSetting("defaults", q);
  return { commissionMinor: d.commission_minor, commissionPct: d.commission_pct, source: "default", effectiveFrom: null };
}

/** Commission on `games` games at `priceMinor`, never more than the money itself. */
export function commissionAmount(c: Commission, games: number, priceMinor: number): number {
  const gross = games * priceMinor;
  const fixed = games * c.commissionMinor;
  const pct = Math.round((gross * c.commissionPct) / 100);
  return Math.min(gross, fixed + pct);
}

export type Bounds = { priceMinMinor: number; priceMaxMinor: number; unlockMinS: number; unlockMaxS: number };

export async function boundsFor(q: Q, table: { price_min_minor: number | null; price_max_minor: number | null; unlock_min_s: number | null; unlock_max_s: number | null }, merchantId: string): Promise<Bounds> {
  const m = await one<{ price_min_minor: number | null; price_max_minor: number | null; unlock_min_s: number | null; unlock_max_s: number | null }>(
    q,
    `select price_min_minor, price_max_minor, unlock_min_s, unlock_max_s from merchants where id = $1`,
    [merchantId],
  );
  const d = await getSetting("defaults", q);
  return {
    priceMinMinor: table.price_min_minor ?? m?.price_min_minor ?? d.price_min_minor,
    priceMaxMinor: table.price_max_minor ?? m?.price_max_minor ?? d.price_max_minor,
    unlockMinS: table.unlock_min_s ?? m?.unlock_min_s ?? d.unlock_min_s,
    unlockMaxS: table.unlock_max_s ?? m?.unlock_max_s ?? d.unlock_max_s,
  };
}

/** Payout limits for a merchant: their overrides, else the platform settings. */
export async function payoutLimits(q: Q, merchantId: string | null) {
  const s = await getSetting("payout", q);
  const m = merchantId
    ? await one<{ payout_min_minor: number | null; payout_daily_cap_minor: number | null; payout_approval_threshold_minor: number | null }>(
        q,
        `select payout_min_minor, payout_daily_cap_minor, payout_approval_threshold_minor from merchants where id = $1`,
        [merchantId],
      )
    : null;
  return {
    minMinor: m?.payout_min_minor ?? s.min_minor,
    dailyCapMinor: m?.payout_daily_cap_minor ?? s.daily_cap_minor,
    approvalThresholdMinor: m?.payout_approval_threshold_minor ?? s.approval_threshold_minor,
    coolingHours: s.cooling_hours,
  };
}
