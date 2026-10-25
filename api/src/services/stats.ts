import { many, one, type Q } from "../config/db.js";
import { addDays, nairobiDate, nairobiInstant } from "../lib/kenya.js";

// Statistics, by the definitions in Merchant PRD section 8:
//   game         a paid unlock the table acknowledged (manual unlocks counted separately)
//   collected    gross of payments that were credited
//   earnings     the merchant's share, as recorded in the ledger (refunds taken off)
//   failed rate  failed / (failed + successful); duplicates never reach the table at all
// Days and hours are Africa/Nairobi.

export type Period = "today" | "7d" | "month" | "year" | "all" | "custom";
export type Scope = { merchantId?: string | null; tableId?: string | null };

const TZ = `'Africa/Nairobi'`;

export async function resolveRange(q: Q, period: Period, scope: Scope, from?: string, to?: string) {
  const today = nairobiDate();
  let start = today;
  let end = today;
  if (period === "7d") start = addDays(today, -6);
  else if (period === "month") start = `${today.slice(0, 8)}01`;
  else if (period === "year") start = `${today.slice(0, 5)}01-01`;
  else if (period === "custom") {
    start = from ?? today;
    end = to ?? today;
    if (start > end) [start, end] = [end, start];
  } else if (period === "all") {
    const r = await one<{ d: string | null }>(
      q,
      `select to_char(min(coalesce(t.started_at, t.created_at)) at time zone ${TZ}, 'YYYY-MM-DD') as d from pool_tables t
        where ($1::uuid is null or t.merchant_id = $1) and ($2::text is null or t.id = $2)`,
      [scope.merchantId ?? null, scope.tableId ?? null],
    );
    start = r?.d ?? today;
  }
  const days = Math.max(1, Math.round((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / 86_400_000) + 1);
  return { start, end, startAt: nairobiInstant(start), endAt: nairobiInstant(addDays(end, 1)), days, bucket: days > 62 ? ("month" as const) : ("day" as const) };
}

const scopeSql = (alias: string, first: number) => `($${first}::uuid is null or ${alias}.merchant_id = $${first}) and ($${first + 1}::text is null or ${alias}.table_id = $${first + 1})`;

export async function stats(q: Q, period: Period, scope: Scope, from?: string, to?: string) {
  const r = await resolveRange(q, period, scope, from, to);
  const sp = [scope.merchantId ?? null, scope.tableId ?? null];
  const range = [r.startAt, r.endAt];
  const bucketExpr = (col: string) => (r.bucket === "day" ? `to_char(${col} at time zone ${TZ}, 'YYYY-MM-DD')` : `to_char(${col} at time zone ${TZ}, 'YYYY-MM')`);

  const games = await many<{ b: string; n: number }>(q, `select ${bucketExpr("g.acked_at")} as b, count(*)::int as n from game_credits g where g.status = 'acked' and g.acked_at >= $1 and g.acked_at < $2 and ${scopeSql("g", 3)} group by 1 order by 1`, [...range, ...sp]);
  const money = await many<{ b: string; collected: number; commission: number; payments: number }>(
    q,
    `select ${bucketExpr("p.credited_at")} as b, coalesce(sum(p.amount_minor), 0) as collected, coalesce(sum(p.commission_minor), 0) as commission, count(*)::int as payments
       from payments p where p.credited_at >= $1 and p.credited_at < $2 and ${scopeSql("p", 3)} group by 1 order by 1`,
    [...range, ...sp],
  );
  const hours = await many<{ h: number; n: number }>(q, `select extract(hour from g.acked_at at time zone ${TZ})::int as h, count(*)::int as n from game_credits g where g.status = 'acked' and g.acked_at >= $1 and g.acked_at < $2 and ${scopeSql("g", 3)} group by 1`, [...range, ...sp]);
  const weekdays = await many<{ d: number; n: number }>(q, `select extract(isodow from g.acked_at at time zone ${TZ})::int as d, count(*)::int as n from game_credits g where g.status = 'acked' and g.acked_at >= $1 and g.acked_at < $2 and ${scopeSql("g", 3)} group by 1`, [...range, ...sp]);
  const byDay = await many<{ d: string; n: number }>(q, `select to_char(g.acked_at at time zone ${TZ}, 'YYYY-MM-DD') as d, count(*)::int as n from game_credits g where g.status = 'acked' and g.acked_at >= $1 and g.acked_at < $2 and ${scopeSql("g", 3)} group by 1 order by 2 desc limit 1`, [...range, ...sp]);
  const tables = await many<{ table_id: string; name: string; games: number; earnings: number }>(
    q,
    `select t.id as table_id, t.name,
            (select count(*)::int from game_credits g where g.table_id = t.id and g.status = 'acked' and g.acked_at >= $1 and g.acked_at < $2) as games,
            (select coalesce(sum(p.merchant_share_minor), 0) from payments p where p.table_id = t.id and p.credited_at >= $1 and p.credited_at < $2) as earnings
       from pool_tables t where ($3::uuid is null or t.merchant_id = $3) and ($4::text is null or t.id = $4) order by t.id`,
    [...range, ...sp],
  );
  const manual = await one<{ n: number }>(q, `select count(*)::int as n from unlock_commands u join pool_tables t on t.id = u.table_id where u.source in ('manual_owner','manual_staff','manual_admin') and u.status = 'acked' and u.ack_at >= $1 and u.ack_at < $2 and ($3::uuid is null or t.merchant_id = $3) and ($4::text is null or t.id = $4)`, [...range, ...sp]);
  const outcomes = await many<{ category: string; n: number }>(
    q,
    `select case
              when p.status = 'underpaid' or (p.status in ('refund_pending','refunded') and p.problem = 'underpaid') then 'underpaid'
              when p.status = 'unmatched' then 'unmatched'
              when p.status = 'rejected' then 'rejected'
              when exists (select 1 from game_credits g where g.payment_id = p.id and g.status in ('expired','failed','refunded')) then 'unlock_failed'
              when p.status = 'credited' then 'successful'
              else 'other' end as category,
            count(*)::int as n
       from payments p where p.received_at >= $1 and p.received_at < $2 and ${scopeSql("p", 3)} group by 1`,
    [...range, ...sp],
  );
  // Earnings from the ledger: credits to the merchant's account for games, less refunds.
  const earnings = await earningsSeries(q, r, sp);

  const totalGames = games.reduce((s, g) => s + g.n, 0);
  const collected = money.reduce((s, m) => s + m.collected, 0);
  const commission = money.reduce((s, m) => s + m.commission, 0);
  const totalEarnings = earnings.reduce((s, e) => s + e.e, 0);
  const failedCats = outcomes.filter((o) => !["successful", "other"].includes(o.category));
  const failed = failedCats.reduce((s, o) => s + o.n, 0);
  const ok = outcomes.find((o) => o.category === "successful")?.n ?? 0;
  const busiestHour = [...hours].sort((a, b) => b.n - a.n)[0];
  const elapsedDays = Math.max(1, Math.min(r.days, Math.ceil((Date.now() - r.startAt.getTime()) / 86_400_000)));

  // Every bucket in the range, so charts show quiet days as zero.
  const buckets: string[] = [];
  if (r.bucket === "day") for (let d = r.start; d <= r.end; d = addDays(d, 1)) buckets.push(d);
  else for (let m = r.start.slice(0, 7); m <= r.end.slice(0, 7); m = nextMonth(m)) buckets.push(m);
  const gMap = new Map(games.map((g) => [g.b, g.n]));
  const eMap = new Map(earnings.map((e) => [e.b, e.e]));
  const cMap = new Map(money.map((m) => [m.b, m.collected]));

  return {
    range: { period, start: r.start, end: r.end, days: r.days, bucket: r.bucket },
    kpis: {
      games: totalGames,
      collectedMinor: collected,
      commissionMinor: commission,
      earningsMinor: totalEarnings,
      avgGamesPerDay: Math.round((totalGames / elapsedDays) * 10) / 10,
      busiestDay: byDay[0] ? { date: byDay[0].d, games: byDay[0].n } : null,
      busiestHour: busiestHour ? { hour: busiestHour.h, games: busiestHour.n } : null,
      failedRate: failed + ok ? Math.round((failed / (failed + ok)) * 1000) / 10 : 0,
      failedByCategory: Object.fromEntries(failedCats.map((o) => [o.category, o.n])),
      manualUnlocks: manual?.n ?? 0,
    },
    series: buckets.map((b) => ({ bucket: b, games: gMap.get(b) ?? 0, earningsMinor: eMap.get(b) ?? 0, collectedMinor: cMap.get(b) ?? 0 })),
    byHour: Array.from({ length: 24 }, (_, h) => ({ hour: h, games: hours.find((x) => x.h === h)?.n ?? 0 })),
    byWeekday: Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, games: weekdays.find((x) => x.d === i + 1)?.n ?? 0 })),
    byTable: tables.map((t) => ({ tableId: t.table_id, name: t.name, games: t.games, earningsMinor: t.earnings })),
    monthly: await monthly(q, sp),
    yearOverYear: await yearOverYear(q, sp),
  };
}

function nextMonth(m: string) {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
}

async function earningsSeries(q: Q, r: { startAt: Date; endAt: Date; bucket: "day" | "month" }, sp: (string | null)[]) {
  const fmt = r.bucket === "day" ? "YYYY-MM-DD" : "YYYY-MM";
  return many<{ b: string; e: number }>(
    q,
    `select to_char(e.created_at at time zone ${TZ}, '${fmt}') as b, -coalesce(sum(e.amount_minor), 0) as e
       from ledger_entries e
       join ledger_accounts a on a.id = e.account_id
       join ledger_transactions t on t.id = e.transaction_id
      where a.code like 'merchant_payable:%'
        and ($3::uuid is null or a.merchant_id = $3)
        and t.kind in ('payment_credit','partial_credit_merchant','partial_grant_game','refund_marked','reversal','collection_fee')
        and e.created_at >= $1 and e.created_at < $2
        and ($4::text is null or exists (
              select 1 from payments p where p.table_id = $4 and (
                (t.ref_type = 'payment' and p.id::text = t.ref_id) or
                (t.ref_type = 'ledger_transaction' and exists (select 1 from ledger_transactions o where o.id::text = t.ref_id and o.ref_type = 'payment' and o.ref_id = p.id::text))))
            or exists (select 1 from partial_credits pc where pc.table_id = $4 and t.ref_type = 'partial_credit' and pc.id::text = t.ref_id))
      group by 1 order by 1`,
    [r.startAt, r.endAt, ...sp],
  );
}

async function monthly(q: Q, sp: (string | null)[]) {
  const since = nairobiInstant(`${addDays(nairobiDate(), -365).slice(0, 7)}-01`);
  const rows = await many<{ m: string; games: number }>(q, `select to_char(g.acked_at at time zone ${TZ}, 'YYYY-MM') as m, count(*)::int as games from game_credits g where g.status = 'acked' and g.acked_at >= $1 and ${scopeSql("g", 2)} group by 1 order by 1`, [since, ...sp]);
  const earn = await earningsSeries(q, { startAt: since, endAt: new Date(Date.now() + 86_400_000), bucket: "month" }, sp);
  const months = [...new Set([...rows.map((r) => r.m), ...earn.map((e) => e.b)])].sort();
  return months.map((m) => ({ month: m, games: rows.find((r) => r.m === m)?.games ?? 0, earningsMinor: earn.find((e) => e.b === m)?.e ?? 0 }));
}

async function yearOverYear(q: Q, sp: (string | null)[]) {
  const y = Number(nairobiDate().slice(0, 4));
  const rows = await many<{ y: number; m: number; games: number }>(
    q,
    `select extract(year from g.acked_at at time zone ${TZ})::int as y, extract(month from g.acked_at at time zone ${TZ})::int as m, count(*)::int as games
       from game_credits g where g.status = 'acked' and g.acked_at >= $1 and ${scopeSql("g", 2)} group by 1, 2`,
    [nairobiInstant(`${y - 1}-01-01`), ...sp],
  );
  return Array.from({ length: 12 }, (_, i) => ({ month: i + 1, thisYear: rows.find((r) => r.y === y && r.m === i + 1)?.games ?? 0, lastYear: rows.find((r) => r.y === y - 1 && r.m === i + 1)?.games ?? 0 }));
}

const MILESTONES = [100, 500, 1000, 5000, 10000, 25000, 50000, 100000];

/** "Since the table started" cards, with milestone badges. */
export async function sinceStarted(q: Q, scope: Scope) {
  const tables = await many<{ id: string; name: string; started_at: Date | null; created_at: Date }>(q, `select id, name, started_at, created_at from pool_tables where ($1::uuid is null or merchant_id = $1) and ($2::text is null or id = $2) order by id`, [scope.merchantId ?? null, scope.tableId ?? null]);
  const out = [];
  for (const t of tables) {
    const since = t.started_at ?? t.created_at;
    const totals = await one<{ games: number; earnings: number }>(
      q,
      `select (select count(*)::int from game_credits g where g.table_id = $1 and g.status = 'acked' and g.acked_at >= $2) as games,
              (select coalesce(sum(p.merchant_share_minor), 0) from payments p where p.table_id = $1 and p.credited_at >= $2) as earnings`,
      [t.id, since],
    );
    const best = await one<{ m: string; e: number }>(q, `select to_char(p.credited_at at time zone ${TZ}, 'YYYY-MM') as m, sum(p.merchant_share_minor) as e from payments p where p.table_id = $1 and p.credited_at >= $2 group by 1 order by 2 desc limit 1`, [t.id, since]);
    const reached = MILESTONES.filter((n) => (totals?.games ?? 0) >= n);
    const dates = reached.length
      ? await many<{ n: number; at: Date }>(
          q,
          `select rn as n, acked_at as at from (select acked_at, row_number() over (order by acked_at) as rn from game_credits where table_id = $1 and status = 'acked' and acked_at >= $2) x where rn = any($3::int[])`,
          [t.id, since, reached],
        )
      : [];
    out.push({
      tableId: t.id,
      name: t.name,
      startedAt: t.started_at,
      lifetimeGames: totals?.games ?? 0,
      lifetimeEarningsMinor: totals?.earnings ?? 0,
      bestMonth: best ? { month: best.m, earningsMinor: best.e } : null,
      milestones: reached.map((n) => ({ games: n, reachedAt: dates.find((d) => Number(d.n) === n)?.at ?? null })),
      nextMilestone: MILESTONES.find((n) => n > (totals?.games ?? 0)) ?? null,
    });
  }
  return out;
}

/** Today's cards for an owner's Home (and an attendant's, without money). */
export async function today(q: Q, merchantId: string) {
  const start = nairobiInstant(nairobiDate());
  const r = await one<{ games: number; collected: number; earnings: number; attention: number }>(
    q,
    `select (select count(*)::int from game_credits g where g.merchant_id = $1 and g.status = 'acked' and g.acked_at >= $2) as games,
            (select coalesce(sum(amount_minor), 0) from payments where merchant_id = $1 and credited_at >= $2) as collected,
            (select coalesce(sum(merchant_share_minor), 0) from payments where merchant_id = $1 and credited_at >= $2) as earnings,
            (select count(*)::int from payments p where p.merchant_id = $1 and p.received_at >= $2 - interval '2 days' and (
                p.status in ('underpaid','refund_pending') or exists (select 1 from game_credits g where g.payment_id = p.id and g.status in ('expired','failed','pending','dispatched')))) as attention`,
    [merchantId, start],
  );
  return { games: r?.games ?? 0, collectedMinor: r?.collected ?? 0, earningsMinor: r?.earnings ?? 0, needsAttention: r?.attention ?? 0 };
}
