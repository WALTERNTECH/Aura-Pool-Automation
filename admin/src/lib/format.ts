// Money is minor units (KSh 50 = 5000). The console shows Africa/Nairobi; exports are UTC.

const TZ = "Africa/Nairobi";

export function ksh(minor: number | null | undefined, opts: { sign?: boolean } = {}): string {
  if (minor == null || !Number.isFinite(Number(minor))) return "—";
  const m = Number(minor);
  const sign = m < 0 ? "−" : opts.sign && m > 0 ? "+" : "";
  const abs = Math.abs(m);
  const cents = abs % 100;
  return `${sign}KSh ${Math.floor(abs / 100).toLocaleString("en-KE")}${cents ? `.${String(cents).padStart(2, "0")}` : ""}`;
}

export function parseKsh(s: string): number | null {
  const n = Number(String(s).replace(/[,\s]/g, "").replace(/^KSh/i, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

const f = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-KE", { timeZone: TZ, ...o });
export const dt = (d: string | Date | null | undefined) => (d ? f({ day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(d)) : "—");
export const dtFull = (d: string | Date | null | undefined) => (d ? f({ day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(d)) : "—");
export const day = (d: string | Date | null | undefined) => (d ? f({ day: "2-digit", month: "short", year: "numeric" }).format(new Date(d)) : "—");

export function ago(d: string | Date | null | undefined): string {
  if (!d) return "never";
  const s = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (s < 0) return `in ${until(d)}`;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export function until(d: string | Date): string {
  const s = Math.max(0, Math.round((new Date(d).getTime() - Date.now()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.ceil(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}

export function nairobiDay(d: Date = new Date()) {
  return new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}

export function pct(now: number, prev: number) {
  if (!prev) return now ? "new" : "—";
  const p = Math.round(((now - prev) / prev) * 100);
  return `${p > 0 ? "+" : ""}${p}%`;
}

export const humanize = (s: string | null | undefined) => (s ? s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "—");
