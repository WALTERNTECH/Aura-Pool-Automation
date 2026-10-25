import { randomUUID } from "node:crypto";
import { db, many, one, type Q } from "../config/db.js";

// A durable job queue in Postgres (instead of Redis/BullMQ): jobs are claimed with
// FOR UPDATE SKIP LOCKED, retried with backoff, and survive restarts. Work that talks to the
// outside world (SMS, push, provider calls) is queued from inside a transaction and run
// after it commits, so a slow network never holds a lock and a rollback sends nothing.

type Handler = (payload: Record<string, unknown>, job: { id: string; attempts: number }) => Promise<void>;
const handlers = new Map<string, Handler>();
const instance = randomUUID();

export function onJob(kind: string, fn: Handler) {
  handlers.set(kind, fn);
}

export async function enqueue(q: Q, kind: string, payload: Record<string, unknown> = {}, opts: { runAt?: Date; dedupeKey?: string; maxAttempts?: number } = {}) {
  await q.query(
    `insert into jobs (kind, payload, run_at, dedupe_key, max_attempts) values ($1,$2,$3,$4,$5)
     on conflict (dedupe_key) where dedupe_key is not null and status in ('queued','running') do nothing`,
    [kind, JSON.stringify(payload), opts.runAt ?? new Date(), opts.dedupeKey ?? null, opts.maxAttempts ?? 5],
  );
  if (!opts.runAt || opts.runAt.getTime() <= Date.now()) kick();
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let stopped = true;
let pendingKick = false;

/** Claims and runs due jobs until none are left. Tests call this directly. */
export async function drainJobs(maxRounds = 50): Promise<number> {
  let ran = 0;
  for (let round = 0; round < maxRounds; round++) {
    const n = await runBatch();
    ran += n;
    if (!n) break;
  }
  return ran;
}

async function runBatch(): Promise<number> {
  const d = db();
  // Jobs whose worker died come back after their lock lapses.
  await d.query(`update jobs set status = 'queued' where status = 'running' and locked_until < now()`);
  const claimed = await many<{ id: string; kind: string; payload: Record<string, unknown>; attempts: number; max_attempts: number }>(
    d,
    `update jobs set status = 'running', attempts = attempts + 1, locked_until = now() + interval '2 minutes'
      where id in (select id from jobs where status = 'queued' and run_at <= now() order by run_at limit 10 for update skip locked)
      returning id, kind, payload, attempts, max_attempts`,
  );
  for (const j of claimed) {
    const fn = handlers.get(j.kind);
    try {
      if (!fn) throw new Error(`no handler for job ${j.kind}`);
      await fn(j.payload, { id: j.id, attempts: j.attempts });
      await d.query(`update jobs set status = 'done', done_at = now(), locked_until = null where id = $1`, [j.id]);
    } catch (e) {
      const msg = (e as Error).message?.slice(0, 500) ?? String(e);
      const final = j.attempts >= j.max_attempts;
      if (final) console.error(`[jobs] ${j.kind} ${j.id} failed for good: ${msg}`);
      await d.query(
        `update jobs set status = $2, last_error = $3, locked_until = null, run_at = now() + ($4 || ' seconds')::interval where id = $1`,
        [j.id, final ? "failed" : "queued", msg, String(Math.min(600, 5 * j.attempts * j.attempts))],
      );
    }
  }
  return claimed.length;
}

export function kick() {
  if (stopped) return;
  if (running) {
    pendingKick = true;
    return;
  }
  setImmediate(loop);
}

async function loop() {
  if (running || stopped) return;
  running = true;
  try {
    do {
      pendingKick = false;
      await drainJobs(20);
    } while (pendingKick && !stopped);
  } catch (e) {
    console.error("[jobs] loop error", (e as Error).message);
  } finally {
    running = false;
  }
}

export function startWorker(intervalMs = 1000) {
  stopped = false;
  timer = setInterval(() => void loop(), intervalMs);
  timer.unref();
}

export function stopWorker() {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

export async function queueDepth(q: Q = db()) {
  return (await one<{ due: number; failed: number; oldest_s: number | null }>(
    q,
    `select count(*) filter (where status = 'queued' and run_at <= now()) as due,
            count(*) filter (where status = 'failed' and created_at > now() - interval '1 day') as failed,
            extract(epoch from now() - min(run_at) filter (where status = 'queued' and run_at <= now()))::int as oldest_s
       from jobs`,
  ))!;
}

// ------------------------------------------------------------------ periodic tasks
type Periodic = { name: string; everyMs: number; fn: () => Promise<void>; last: number; busy: boolean };
const periodic: Periodic[] = [];
let tickTimer: NodeJS.Timeout | null = null;

export function every(name: string, everyMs: number, fn: () => Promise<void>) {
  periodic.push({ name, everyMs, fn, last: 0, busy: false });
}

/** Takes a named lease for `ms`; false if another instance holds it. */
export async function lease(name: string, ms: number, q: Q = db()): Promise<boolean> {
  const r = await one(
    q,
    `insert into leases (name, holder, held_until) values ($1, $2, now() + ($3 || ' milliseconds')::interval)
     on conflict (name) do update set holder = excluded.holder, held_until = excluded.held_until
       where leases.held_until < now() or leases.holder = excluded.holder
     returning name`,
    [name, instance, String(ms)],
  );
  return Boolean(r);
}

export function startScheduler() {
  tickTimer = setInterval(() => {
    const now = Date.now();
    for (const p of periodic) {
      if (p.busy || now - p.last < p.everyMs) continue;
      p.busy = true;
      p.last = now;
      lease(`periodic:${p.name}`, Math.max(p.everyMs - 250, 1000))
        .then((ok) => (ok ? p.fn() : undefined))
        .catch((e) => console.error(`[periodic] ${p.name}:`, (e as Error).message))
        .finally(() => {
          p.busy = false;
        });
    }
  }, 500);
  tickTimer.unref();
}

export function stopScheduler() {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
}

/** Runs every periodic task once, in order. Tests use it to advance the world. */
export async function runPeriodicOnce(names?: string[]) {
  for (const p of periodic) if (!names || names.includes(p.name)) await p.fn();
}
