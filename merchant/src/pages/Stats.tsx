import { useState } from "react";
import { BarChart, HBars, LineChart } from "../components/Charts";
import { Icon } from "../components/Icon";
import { Chips, Empty, ErrorBox, PageSkeleton, Stale, TopBar } from "../components/ui";
import { dateLong, dayLabel, hourLabel, ksh, monthLabel, nairobiDay, weekday } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useLang } from "../lib/hooks";

type Period = "today" | "7d" | "month" | "year" | "all" | "custom";
type Stats = {
  range: { start: string; end: string; days: number; bucket: "day" | "month" };
  kpis: { games: number; collectedMinor: number; earningsMinor: number; avgGamesPerDay: number; busiestDay: { date: string; games: number } | null; busiestHour: { hour: number; games: number } | null; failedRate: number; failedByCategory: Record<string, number>; manualUnlocks: number };
  series: { bucket: string; games: number; earningsMinor: number }[];
  byHour: { hour: number; games: number }[];
  byWeekday: { weekday: number; games: number }[];
  byTable: { tableId: string; name: string; games: number; earningsMinor: number }[];
  monthly: { month: string; games: number; earningsMinor: number }[];
  yearOverYear: { month: number; thisYear: number; lastYear: number }[];
};
type Since = { tables: { tableId: string; name: string; startedAt: string | null; lifetimeGames: number; lifetimeEarningsMinor: number; bestMonth: { month: string; earningsMinor: number } | null; milestones: { games: number; reachedAt: string | null }[]; nextMilestone: number | null }[] };

const short = (minor: number) => (minor >= 100_000_00 ? `${Math.round(minor / 100_000_00)}M` : minor >= 100_000 ? `${Math.round(minor / 100_000)}k` : String(Math.round(minor / 100)));

export default function StatsPage() {
  useLang();
  const [period, setPeriod] = useState<Period>("7d");
  const [table, setTable] = useState("");
  const [from, setFrom] = useState(nairobiDay(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(nairobiDay());
  const [month, setMonth] = useState(nairobiDay().slice(0, 7));
  const qs = new URLSearchParams({ period, ...(table ? { table } : {}), ...(period === "custom" ? { from, to } : {}) }).toString();
  const s = useApi<Stats>(`/stats?${qs}`);
  const since = useApi<Since>("/stats/since-started");
  const tables = useApi<{ tables: { id: string; name: string }[] }>("/tables");

  return (
    <main className="page">
      <TopBar title={t("stats.title")} />
      <div className="stack">
        <Chips
          label={t("stats.title")}
          value={period}
          onChange={setPeriod}
          options={[
            { value: "today", label: t("stats.today") },
            { value: "7d", label: t("stats.d7") },
            { value: "month", label: t("stats.month") },
            { value: "year", label: t("stats.year") },
            { value: "all", label: t("stats.all") },
            { value: "custom", label: t("stats.custom") },
          ]}
        />
        {period === "custom" ? (
          <div className="row">
            <input type="date" className="input grow" value={from} max={to} onChange={(e) => setFrom(e.target.value)} aria-label={t("payments.from")} />
            <input type="date" className="input grow" value={to} min={from} onChange={(e) => setTo(e.target.value)} aria-label={t("payments.to")} />
          </div>
        ) : null}
        {tables.data && tables.data.tables.length > 1 ? (
          <select className="input" value={table} onChange={(e) => setTable(e.target.value)} aria-label={t("stats.allTables")}>
            <option value="">{t("stats.allTables")}</option>
            {tables.data.tables.map((tb) => <option key={tb.id} value={tb.id}>{tb.id} · {tb.name}</option>)}
          </select>
        ) : null}

        {s.loading ? <PageSkeleton /> : null}
        {s.error && !s.data ? <ErrorBox error={s.error} retry={s.reload} /> : null}
        {s.data ? <Body s={s.data} /> : null}

        {since.data?.tables.length ? (
          <>
            <div className="section-title"><h2>{t("stats.sinceTitle")}</h2></div>
            {since.data.tables.map((tb) => (
              <section key={tb.tableId} className="card stack-sm">
                <div className="spread">
                  <h3>{tb.tableId} · {tb.name}</h3>
                  <span className="small muted">{tb.startedAt ? t("stats.started", { date: dateLong(tb.startedAt) }) : t("stats.notStarted")}</span>
                </div>
                <dl className="kv">
                  <dt>{t("stats.lifetimeGames")}</dt>
                  <dd>{tb.lifetimeGames.toLocaleString("en-KE")}</dd>
                  <dt>{t("stats.lifetimeEarnings")}</dt>
                  <dd>{ksh(tb.lifetimeEarningsMinor)}</dd>
                  <dt>{t("stats.bestMonth")}</dt>
                  <dd>{tb.bestMonth ? `${monthLabel(tb.bestMonth.month)} · ${ksh(tb.bestMonth.earningsMinor)}` : "—"}</dd>
                </dl>
                <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
                  {tb.milestones.map((m) => (
                    <span key={m.games} className="badge ok plain" title={m.reachedAt ? dateLong(m.reachedAt) : undefined}>
                      <Icon name="trophy" /> {t("stats.milestone", { n: m.games.toLocaleString("en-KE") })}
                    </span>
                  ))}
                  {tb.nextMilestone ? <span className="badge plain">{t("stats.nextMilestone", { n: tb.nextMilestone.toLocaleString("en-KE") })}</span> : null}
                </div>
              </section>
            ))}
          </>
        ) : null}

        <section className="card stack-sm">
          <h2>{t("stats.statement")}</h2>
          <div className="row">
            <input type="month" className="input grow" value={month} max={nairobiDay().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} aria-label={t("stats.statement")} />
            <a className="btn sm" href={`/v1/m/reports/statement?month=${month}&format=csv`} download>CSV</a>
            <a className="btn sm" href={`/v1/m/reports/statement?month=${month}&format=pdf`} download>PDF</a>
          </div>
        </section>
        <Stale savedAt={s.savedAt} stale={s.stale} />
      </div>
    </main>
  );
}

function Body({ s }: { s: Stats }) {
  const k = s.kpis;
  const label = (b: string) => (s.range.bucket === "day" ? dayLabel(b) : monthLabel(b));
  const every = Math.max(1, Math.ceil(s.series.length / 6));
  const bestBucket = s.series.reduce((b, x) => (x.games > (b?.games ?? -1) ? x : b), s.series[0]);
  const topHour = [...s.byHour].sort((a, b) => b.games - a.games)[0];
  const topDay = [...s.byWeekday].sort((a, b) => b.games - a.games)[0];
  const topTable = [...s.byTable].sort((a, b) => b.games - a.games)[0];
  const thisYearTotal = s.yearOverYear.reduce((n, m) => n + m.thisYear, 0);
  const lastYearTotal = s.yearOverYear.slice(0, new Date().getMonth() + 1).reduce((n, m) => n + m.lastYear, 0);
  const failedCats = Object.entries(k.failedByCategory);

  return (
    <>
      <div className="kpis">
        <div className="kpi"><span className="label">{t("stats.games")}</span><span className="value">{k.games.toLocaleString("en-KE")}</span></div>
        <div className="kpi"><span className="label">{t("stats.collected")}</span><span className="value">{ksh(k.collectedMinor)}</span></div>
        <div className="kpi"><span className="label">{t("stats.earnings")}</span><span className="value">{ksh(k.earningsMinor)}</span></div>
        <div className="kpi"><span className="label">{t("stats.avg")}</span><span className="value">{k.avgGamesPerDay}</span></div>
        <div className="kpi"><span className="label">{t("stats.busiestDay")}</span><span className="value" style={{ fontSize: 17 }}>{k.busiestDay ? `${dayLabel(k.busiestDay.date)} · ${k.busiestDay.games}` : "—"}</span></div>
        <div className="kpi"><span className="label">{t("stats.busiestHour")}</span><span className="value" style={{ fontSize: 17 }}>{k.busiestHour ? `${hourLabel(k.busiestHour.hour)} · ${k.busiestHour.games}` : "—"}</span></div>
        <div className={`kpi${k.failedRate > 5 ? " warn" : ""}`}>
          <span className="label">{t("stats.failedRate")}</span>
          <span className="value">{k.failedRate}%</span>
          {failedCats.length ? <span className="tiny muted">{failedCats.map(([c, n]) => `${t(`stats.failed_${c}`)} ${n}`).join(" · ")}</span> : null}
        </div>
        <div className="kpi"><span className="label">{t("stats.manual")}</span><span className="value">{k.manualUnlocks}</span></div>
      </div>

      {k.games === 0 ? (
        <div className="card"><Empty icon="stats">{t("stats.noData")}</Empty></div>
      ) : (
        <>
          <section className="card">
            <h2>{t("stats.gamesOver")}</h2>
            <BarChart ariaLabel={t("stats.gamesOver")} data={s.series.map((x) => ({ label: label(x.bucket), value: x.games }))} labelEvery={every} />
            <p className="summary">{t("stats.summaryGames", { total: k.games, from: dayLabel(s.range.start), to: dayLabel(s.range.end), bucket: s.range.bucket === "day" ? "day" : "month", best: bestBucket ? label(bestBucket.bucket) : "—", n: bestBucket?.games ?? 0 })}</p>
          </section>
          <section className="card">
            <h2>{t("stats.earningsOver")}</h2>
            <LineChart ariaLabel={t("stats.earningsOver")} data={s.series.map((x) => ({ label: label(x.bucket), value: x.earningsMinor }))} labelEvery={every} format={short} />
            <p className="summary">{t("stats.summaryEarnings", { total: ksh(k.earningsMinor) })}</p>
          </section>
          <section className="card">
            <h2>{t("stats.byHour")}</h2>
            <BarChart ariaLabel={t("stats.byHour")} data={s.byHour.map((h) => ({ label: String(h.hour).padStart(2, "0"), value: h.games }))} labelEvery={4} />
            {topHour?.games ? <p className="summary">{t("stats.summaryHour", { hour: hourLabel(topHour.hour) })}</p> : null}
          </section>
          <section className="card">
            <h2>{t("stats.byWeekday")}</h2>
            <BarChart ariaLabel={t("stats.byWeekday")} data={s.byWeekday.map((w) => ({ label: weekday(w.weekday), value: w.games }))} />
            {topDay?.games ? <p className="summary">{t("stats.summaryWeekday", { day: weekday(topDay.weekday, true) })}</p> : null}
          </section>
          {s.byTable.length > 1 ? (
            <section className="card stack-sm">
              <h2>{t("stats.byTable")}</h2>
              <HBars rows={s.byTable.map((x) => ({ label: `${x.tableId} · ${x.name}`, value: x.games, note: ksh(x.earningsMinor) }))} />
              {topTable ? <p className="summary">{t("stats.summaryTables", { table: `${topTable.tableId} ${topTable.name}`, n: topTable.games })}</p> : null}
            </section>
          ) : null}
        </>
      )}
      {s.monthly.length ? (
        <section className="card">
          <h2>{t("stats.monthly")}</h2>
          <BarChart ariaLabel={t("stats.monthly")} data={s.monthly.map((m) => ({ label: monthLabel(m.month).split(" ")[0], value: m.games }))} labelEvery={Math.max(1, Math.ceil(s.monthly.length / 6))} />
          <p className="summary">{s.monthly.map((m) => `${monthLabel(m.month)}: ${m.games}`).slice(-3).join(" · ")}</p>
        </section>
      ) : null}
      {thisYearTotal + lastYearTotal > 0 ? (
        <section className="card">
          <h2>{t("stats.yoy")}</h2>
          <div className="legend" style={{ margin: "6px 0" }}>
            <span><i style={{ background: "var(--line-2)" }} />{t("stats.lastYear")}</span>
            <span><i style={{ background: "var(--accent)" }} />{t("stats.thisYear")}</span>
          </div>
          <BarChart ariaLabel={t("stats.yoy")} data={s.yearOverYear.map((m) => ({ label: monthLabel(`2026-${String(m.month).padStart(2, "0")}`).split(" ")[0].slice(0, 1), value: m.thisYear, alt: m.lastYear }))} />
          <p className="summary">{t("stats.summaryYoy", { this: thisYearTotal, last: lastYearTotal })}</p>
        </section>
      ) : null}
    </>
  );
}
