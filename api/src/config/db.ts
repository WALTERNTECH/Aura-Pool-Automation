import pg from "pg";

// A minimal query interface that node-postgres and PGlite both satisfy, so the same code
// runs against Supabase in production and an in-process Postgres locally and in tests.
//
// Rule: anything that runs inside db().tx(fn) uses the `q` it was handed. PGlite runs one
// transaction at a time, so reaching for db() inside a transaction deadlocks.

export type Row = Record<string, unknown>;
export interface Q {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Multi-statement SQL without parameters (migrations). */
  exec(sql: string): Promise<void>;
}
export interface Db extends Q {
  tx<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: "postgres" | "pglite";
}

/** Aura Pool lives in its own schema inside the shared Fpesa project. */
export const SCHEMA = "aura";

// bigint and numeric arrive as strings; every amount here is integer minor units well
// inside 2^53, so a double is exact.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
// date stays a plain YYYY-MM-DD string so it never shifts across time zones.
pg.types.setTypeParser(1082, (v) => v);

export function pgDb(url: string): Db {
  const pool = new pg.Pool({
    connectionString: url,
    max: 8,
    idleTimeoutMillis: 30_000,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  pool.on("error", (e) => console.error("[db] pool error", e.message));
  // The role's own search_path covers the pooler; this covers a direct connection too.
  pool.on("connect", (c) => {
    c.query(`set search_path to ${SCHEMA}, public; set timezone to 'UTC'`).catch(() => {});
  });
  const wrap = (c: pg.PoolClient): Q => ({
    query: (sql, params) => c.query(sql, params as unknown[]) as never,
    exec: async (sql) => {
      await c.query(sql);
    },
  });
  return {
    kind: "postgres",
    query: (sql, params) => pool.query(sql, params as unknown[]) as never,
    exec: async (sql) => {
      await pool.query(sql);
    },
    async tx(fn) {
      const c = await pool.connect();
      try {
        await c.query("begin");
        await c.query(`set local search_path to ${SCHEMA}, public`);
        const out = await fn(wrap(c));
        await c.query("commit");
        return out;
      } catch (e) {
        await c.query("rollback").catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

/** In-process Postgres for local development and tests. Pass a directory to keep data between runs. */
export async function pgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = new PGlite({
    dataDir,
    parsers: { 1082: (v: string) => v, 1700: (v: string) => Number(v), 20: (v: string) => Number(v) },
  });
  await lite.exec(`create schema if not exists ${SCHEMA}; set search_path to ${SCHEMA}, public; set timezone to 'UTC';`);
  const norm = (r: { rows: unknown[] }) => ({ rows: (r.rows as Row[]).map(fixValues) }) as never;
  return {
    kind: "pglite",
    query: (sql, params) => lite.query(sql, params as unknown[]).then(norm),
    exec: async (sql) => {
      await lite.exec(sql);
    },
    tx: (fn) =>
      lite.transaction((t) =>
        fn({
          query: (sql, params) => t.query(sql, params as unknown[]).then(norm),
          exec: async (sql) => {
            await t.exec(sql);
          },
        }),
      ),
    close: () => lite.close(),
  };
}

function fixValues(r: Row): Row {
  for (const k of Object.keys(r)) {
    const v = r[k];
    if (typeof v === "bigint") r[k] = Number(v);
  }
  return r;
}

export async function one<T extends Row>(q: Q, sql: string, params?: unknown[]): Promise<T | null> {
  const { rows } = await q.query<T>(sql, params);
  return rows[0] ?? null;
}

export async function many<T extends Row>(q: Q, sql: string, params?: unknown[]): Promise<T[]> {
  return (await q.query<T>(sql, params)).rows;
}

let current: Db | null = null;
export function setDb(d: Db | null) {
  current = d;
}
export function db(): Db {
  if (!current) throw new Error("database not initialised");
  return current;
}
