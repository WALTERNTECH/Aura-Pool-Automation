import { getLang, t, tList } from "./i18n";

// Money is minor units (KSh 50 = 5000); times are shown in Africa/Nairobi.

const TZ = "Africa/Nairobi";
const locale = () => (getLang() === "sw" ? "sw-KE" : "en-KE");

export function ksh(minor: number | null | undefined): string {
  if (minor == null || !Number.isFinite(minor)) return "—";
  const sign = minor < 0 ? "-" : "";
  const abs = Math.abs(minor);
  const cents = abs % 100;
  return `${sign}KSh ${Math.floor(abs / 100).toLocaleString("en-KE")}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
}

/** Shillings typed by a person → minor units, or null. */
export function parseKsh(s: string): number | null {
  const n = Number(String(s).replace(/[,\s]/g, "").replace(/^KSh/i, ""));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale(), { timeZone: TZ, ...opts });

export const time = (d: string | Date) => fmt({ hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(d));
export const date = (d: string | Date) => fmt({ weekday: "short", day: "numeric", month: "short" }).format(new Date(d));
export const dateLong = (d: string | Date) => fmt({ day: "numeric", month: "long", year: "numeric" }).format(new Date(d));
export const dateTime = (d: string | Date) => `${date(d)}, ${time(d)}`;

/** YYYY-MM-DD in Nairobi. */
export function nairobiDay(d: Date = new Date()) {
  return new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}

/** "10:42", "yesterday at 21:10", "Sat 25 Oct" for things that happened. */
export function when(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const x = new Date(d);
  const diff = Date.now() - x.getTime();
  if (diff >= 0 && diff < 60_000) return t("time.now");
  if (diff >= 0 && diff < 3600_000) return t("time.min", { n: Math.round(diff / 60_000) });
  const day = nairobiDay(x);
  const today = nairobiDay();
  const yesterday = nairobiDay(new Date(Date.now() - 86_400_000));
  if (day === today) return time(x);
  if (day === yesterday) return t("time.at", { day: t("time.yesterday"), time: time(x) });
  return dateTime(x);
}

/** For things that will happen: "today at 22:00", "tomorrow at 22:00". */
export function upcoming(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const x = new Date(d);
  const day = nairobiDay(x);
  if (day === nairobiDay()) return t("time.at", { day: t("time.today"), time: time(x) });
  if (day === nairobiDay(new Date(Date.now() + 86_400_000))) return t("time.at", { day: t("time.tomorrow"), time: time(x) });
  return dateTime(x);
}

export function weekday(isoDow: number, long = false) {
  return tList(long ? "weekdayLong" : "weekday")[isoDow - 1] ?? String(isoDow);
}

export function hourLabel(h: number) {
  return `${String(h).padStart(2, "0")}:00`;
}

export function monthLabel(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(), { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, 1)));
}

export function dayLabel(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat(locale(), { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** 254712345678 or 0712345678 → 0712 345 678 for display while typing. */
export function prettyPhone(s: string) {
  const d = s.replace(/\D/g, "").replace(/^254/, "0");
  return d.replace(/^(\d{4})(\d{0,3})(\d{0,3}).*/, (_, a, b, c) => [a, b, c].filter(Boolean).join(" "));
}
