import type { NextFunction, Request, Response } from "express";

// In-memory request metrics for the system health page: latency percentiles and error rate
// over the last 15 minutes. Paths are reduced to their route shape so ids don't explode it.

type Sample = { at: number; ms: number; status: number; route: string };
const samples: Sample[] = [];
const MAX = 5000;
const WINDOW = 15 * 60_000;

export function recordRequests(req: Request, res: Response, next: NextFunction) {
  const t0 = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const route = `${req.method} ${(req.baseUrl ?? "") + (req.route?.path ?? req.path.replace(/[0-9a-f-]{36}|T\d{3,}/g, ":id"))}`;
    samples.push({ at: Date.now(), ms, status: res.statusCode, route });
    if (samples.length > MAX) samples.splice(0, samples.length - MAX);
  });
  next();
}

const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : 0);

export const metrics = {
  snapshot() {
    const since = Date.now() - WINDOW;
    const recent = samples.filter((s) => s.at >= since);
    const ms = recent.map((s) => s.ms).sort((a, b) => a - b);
    const errors = recent.filter((s) => s.status >= 500).length;
    const slow = [...recent].sort((a, b) => b.ms - a.ms).slice(0, 5).map((s) => ({ route: s.route, ms: Math.round(s.ms), status: s.status }));
    return {
      windowMinutes: 15,
      requests: recent.length,
      p50Ms: Math.round(pct(ms, 50)),
      p95Ms: Math.round(pct(ms, 95)),
      p99Ms: Math.round(pct(ms, 99)),
      errors5xx: errors,
      errorRatePct: recent.length ? Math.round((errors / recent.length) * 1000) / 10 : 0,
      slowest: slow,
    };
  },
};
