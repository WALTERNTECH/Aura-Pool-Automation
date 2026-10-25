// Kenyan phone numbers, money and Africa/Nairobi time.

/** Accepts 07XX, 01XX, 7XX, +2547XX, 2547XX; returns 2547XXXXXXXX / 2541XXXXXXXX or null. */
export function normaliseMsisdn(input: string): string | null {
  const d = String(input ?? "").replace(/[\s\-()]/g, "").replace(/^\+/, "");
  let m: RegExpMatchArray | null;
  if ((m = d.match(/^0([17]\d{8})$/))) return `254${m[1]}`;
  if ((m = d.match(/^([17]\d{8})$/))) return `254${m[1]}`;
  if ((m = d.match(/^254([17]\d{8})$/))) return `254${m[1]}`;
  return null;
}

/** 254712345678 → 0712***678. Already-masked provider values pass through tidied. */
export function maskMsisdn(msisdn: string | null | undefined): string {
  if (!msisdn) return "—";
  const n = normaliseMsisdn(msisdn);
  if (!n) {
    const s = String(msisdn).replace(/\s/g, "");
    if (/\*/.test(s)) return s.replace(/^254/, "0");
    return s.length > 6 ? `${s.slice(0, 4)}***${s.slice(-3)}` : "***";
  }
  const local = `0${n.slice(3)}`;
  return `${local.slice(0, 4)}***${local.slice(-3)}`;
}

/** "JOHN KAMAU DOE" → "John K." — enough for an owner to recognise a regular, no more. */
export function maskName(first?: string | null, middle?: string | null, last?: string | null): string | null {
  const parts = [first, middle, last].map((p) => String(p ?? "").trim()).filter(Boolean);
  if (!parts.length) return null;
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  return parts.length === 1 ? cap(parts[0]) : `${cap(parts[0])} ${parts[parts.length - 1].charAt(0).toUpperCase()}.`;
}

/** 125000 → "KSh 1,250". Minor units in, shillings out; cents shown only when present. */
export function formatKsh(minor: number): string {
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  return `${sign}KSh ${whole.toLocaleString("en-KE")}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
}

/** Parses an M-Pesa amount ("50", "50.00", 50) into minor units. */
export function toMinor(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/,/g, ""));
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}

// Kenya has no daylight saving: Nairobi is UTC+3 all year.
export const NAIROBI_OFFSET_MS = 3 * 3600_000;
export const TZ = "Africa/Nairobi";

/** YYYY-MM-DD of the given instant in Nairobi. */
export function nairobiDate(at: Date = new Date()): string {
  return new Date(at.getTime() + NAIROBI_OFFSET_MS).toISOString().slice(0, 10);
}

/** HH:MM of the given instant in Nairobi. */
export function nairobiTime(at: Date = new Date()): string {
  return new Date(at.getTime() + NAIROBI_OFFSET_MS).toISOString().slice(11, 16);
}

/** The UTC instant of a Nairobi wall-clock date and time. */
export function nairobiInstant(date: string, time = "00:00"): Date {
  return new Date(new Date(`${date}T${time}:00Z`).getTime() - NAIROBI_OFFSET_MS);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** M-Pesa TransTime "20261025143012" (Nairobi) → Date. */
export function parseMpesaTime(s: unknown): Date | null {
  const m = String(s ?? "").match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - NAIROBI_OFFSET_MS);
}

/** Date → "20261025143012" in Nairobi, as Daraja wants for STK timestamps. */
export function mpesaTimestamp(at: Date = new Date()): string {
  return new Date(at.getTime() + NAIROBI_OFFSET_MS).toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/**
 * Account numbers customers type: " t 1 ", "T01", "t001" → "T001". Returns null for
 * anything that isn't a table number.
 */
export function normaliseTableRef(input: string | null | undefined): string | null {
  const s = String(input ?? "").replace(/\s+/g, "").toUpperCase();
  const m = s.match(/^T0*(\d{1,6})$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!n) return null;
  return tableId(n);
}

export const tableId = (seq: number) => `T${String(seq).padStart(3, "0")}`;
