import { useState } from "react";
import { Link } from "react-router-dom";
import { BarChart, Spark } from "../components/Charts";
import { Icon } from "../components/Icon";
import { Banner, Card, ErrorBox, Loading, Status } from "../components/ui";
import { ago, dt, ksh } from "../lib/format";
import { useLive } from "../lib/live";
import { useSession } from "../lib/session";

// The command dashboard, most urgent first: what needs someone now, today's numbers, where the
// money stands, the trend, alerts, the fleet, who's earning, and the longer view.

type Fig = { games: number; grossMinor: number; platformRevenueMinor: number; merchantEarningsMinor: number; payments: number };

const nairobi = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-KE", { timeZone: "Africa/Nairobi", ...o });
const shortDay = (d: string) => nairobi({ day: "numeric", month: "short" }).format(new Date(`${d}T12:00:00+03:00`));
const weekday = (d: string) => nairobi({ weekday: "short", day: "numeric", month: "short" }).format(new Date(`${d}T12:00:00+03:00`));

/** Axis money: KSh 1.2k, KSh 15k, KSh 1.5M. */
function kshShort(minor: number) {
  const v = minor / 100;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(v));
}

function Delta({ now, prev, label }: { now: number; prev: number; label?: string }) {
  if (!prev && !now) return <span className="delta-chip">—</span>;
  if (!prev) return <span className="delta-chip up">New</span>;
  const p = Math.round(((now - prev) / prev) * 100);
  const dir = p > 0 ? "up" : p < 0 ? "down" : "";
  return (
    <>
      <span className={`delta-chip ${dir}`}>
        {dir ? <Icon name={dir === "up" ? "trendUp" : "trendDown"} /> : null}
        {p > 0 ? "+" : ""}
        {p}%
      </span>
      {label ? <span>{label}</span> : null}
    </>
  );
}

export default function Dashboard() {
  const { me } = useSession();
  const { dash } = useLive();
  const [metric, setMetric] = useState<"gross" | "games">("gross");
  const [moreActivity, setMoreActivity] = useState(false);
  if (dash.loading || (!dash.data && !dash.error)) return <DashSkeleton />;
  if (!dash.data) return <ErrorBox error={dash.error} />;
  const x = dash.data;
  const a = x.attention ?? {};
  const money = x.money;
  const fleet = x.fleet;
  const today: Fig & { previous: Fig } = x.today;
  const month: Fig & { previous: Fig } = x.month;
  const allTime: Fig = x.allTime;
  const trend: { date: string; grossMinor: number; platformRevenueMinor: number; games: number }[] = x.trend ?? [];
  const counts = (x.alerts?.counts ?? {}) as Record<string, number>;
  const alertTotal = Object.values(counts).reduce((s, n) => s + n, 0);

  const hour = Number(nairobi({ hour: "numeric", hour12: false }).format(new Date()));
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const exceptions = (a.unmatched ?? 0) + (a.underpaid ?? 0) + (a.overpaid ?? 0) + (a.unlock_failed ?? 0) + (a.verification_failed ?? 0) + (a.refund_pending ?? 0);

  // Queues that need a person, most serious first; only the ones with something in them.
  const attention = [
    { show: money.reconciliation?.status === "mismatch" && !money.reconciliation?.acknowledged, n: "!", label: "Reconciliation difference", to: "/reconciliation", icon: "check", tone: "bad" },
    { show: (counts.critical ?? 0) > 0, n: counts.critical, label: "Critical alerts", to: "/alerts", icon: "bell", tone: "bad" },
    { show: exceptions > 0, n: exceptions, label: "Payment exceptions", to: "/exceptions", icon: "alert", tone: "bad" },
    { show: money.pendingApproval.count > 0, n: money.pendingApproval.count, label: `Payouts to approve · ${ksh(money.pendingApproval.amountMinor)}`, to: "/payouts?status=pending_approval", icon: "download", tone: "wait" },
    { show: fleet.offline > 0, n: fleet.offline, label: fleet.offline === 1 ? "Table offline" : "Tables offline", to: "/tables", icon: "wifiOff", tone: "wait" },
    { show: (x.disputesOpen ?? 0) > 0, n: x.disputesOpen, label: x.disputesOpen === 1 ? "Open dispute" : "Open disputes", to: "/disputes", icon: "chat", tone: "wait" },
    { show: alertTotal - (counts.critical ?? 0) > 0, n: alertTotal - (counts.critical ?? 0), label: "Other alerts", to: "/alerts", icon: "bell", tone: "wait" },
  ].filter((t) => t.show);

  const floatTone = money.float.status === "critical" ? "bad" : money.float.status === "warning" ? "wait" : "";
  // Working must cover the next 24 h of payouts and never sit below its minimum; the meter shows the larger.
  const floatMin = money.float.minimumMinor ?? 0;
  const floatTarget = Math.max(money.float.requiredMinor ?? 0, floatMin);
  const belowMin = money.workingMinor != null && money.workingMinor < floatMin;
  const floatPct = floatTarget ? Math.min(100, Math.round(((money.workingMinor ?? 0) / floatTarget) * 100)) : 100;
  const onlinePct = fleet.total ? Math.round((fleet.online / fleet.total) * 100) : 0;
  const order = { offline: 0, maintenance: 1, disabled: 2, online: 3 } as Record<string, number>;
  const tables = [...fleet.tables].sort((p: any, q: any) => (order[p.state] ?? 9) - (order[q.state] ?? 9) || q.gamesToday - p.gamesToday);
  const top: { id: string; code: string; name: string; grossMinor: number; games: number }[] = x.topMerchants ?? [];
  const topMax = Math.max(1, ...top.map((m) => m.grossMinor));
  const peakHour = [...(x.byHour ?? [])].sort((p: any, q: any) => q.games - p.games)[0];
  const nowHour = hour;
  const lastDay = trend[trend.length - 1]?.date;

  return (
    <div className="stack">
      <div className="dash-head">
        <div>
          <h1>
            {greeting}, {me?.name.split(" ")[0]}
          </h1>
          <p>
            <span className="live-dot" />
            {nairobi({ weekday: "long", day: "numeric", month: "long" }).format(new Date())} · updated {nairobi({ hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(x.updatedAt))}
          </p>
        </div>
        <button className="btn sm" onClick={() => void dash.reload()} aria-label="Refresh">
          <Icon name="refresh" /> <span className="t">Refresh</span>
        </button>
      </div>

      {floatTone ? (
        <Banner tone={floatTone === "bad" ? "bad" : "wait"} icon="float" title={belowMin ? `Working float is below its ${ksh(floatMin)} minimum` : "Working float is short of the next 24 hours of payouts"}>
          Move <b>{ksh(money.float.suggestedTransferMinor)}</b> from Utility to Working, then <Link className="link" to="/transfers">record the transfer</Link>.
        </Banner>
      ) : null}

      {/* 1. Needs attention */}
      <div className="section-label">Needs attention</div>
      {attention.length ? (
        <div className="attn">
          {attention.map((t) => (
            <Link key={t.label} to={t.to} className={t.tone}>
              <span className="ic">
                <Icon name={t.icon} />
              </span>
              <b>{t.n}</b>
              <span className="l">{t.label}</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="all-clear">
          <span className="ic">
            <Icon name="check" />
          </span>
          <span>
            <b>All clear.</b> No exceptions, approvals, disputes, offline tables or open alerts.
          </span>
        </div>
      )}

      {/* 2. Today */}
      <div className="section-label">Today</div>
      <div className="kpis">
        <div className="kpi hero">
          <span className="k">
            <Icon name="cash" /> Collected today
          </span>
          <span className="v">{ksh(today.grossMinor)}</span>
          <span className="d">
            <Delta now={today.grossMinor} prev={today.previous.grossMinor} label={`vs ${ksh(today.previous.grossMinor)} yesterday`} />
          </span>
          <Spark values={trend.map((t) => t.grossMinor)} />
        </div>
        <div className="kpi">
          <span className="k">
            <Icon name="table" /> Games played
          </span>
          <span className="v">{today.games.toLocaleString("en-KE")}</span>
          <span className="d">
            <Delta now={today.games} prev={today.previous.games} label="vs yesterday" />
          </span>
        </div>
        <div className="kpi">
          <span className="k">
            <Icon name="money" /> Platform revenue
          </span>
          <span className="v">{ksh(today.platformRevenueMinor)}</span>
          <span className="d">
            <Delta now={today.platformRevenueMinor} prev={today.previous.platformRevenueMinor} label="vs yesterday" />
          </span>
        </div>
        <Link to="/tables" className="kpi fleet-kpi">
          <span className="k">
            <Icon name="wifi" /> Tables online
          </span>
          <span className="v">
            {fleet.online}
            <span className="faint" style={{ fontSize: "0.6em", fontWeight: 600 }}>
              {" "}
              / {fleet.total}
            </span>
          </span>
          <div className="meter" aria-label={`${onlinePct}% online`}>
            <i style={{ width: `${onlinePct}%` }} />
          </div>
          <span className="d">
            {fleet.offline} offline · {fleet.maintenance} in maintenance
          </span>
        </Link>
      </div>

      {/* 3. Money and trend, alerts and fleet */}
      <div className="dash-grid">
        <div className="stack">
          <Card
            className="o-trend"
            title={
              <>
                Last 14 days
                <span className="sub">{metric === "gross" ? `${ksh(trend.reduce((s, t) => s + t.grossMinor, 0))} collected` : `${trend.reduce((s, t) => s + t.games, 0).toLocaleString("en-KE")} games`}</span>
              </>
            }
            actions={
              <div className="seg" role="group" aria-label="Chart">
                <button aria-pressed={metric === "gross"} onClick={() => setMetric("gross")}>
                  Collected
                </button>
                <button aria-pressed={metric === "games"} onClick={() => setMetric("games")}>
                  Games
                </button>
              </div>
            }
          >
            <BarChart
              ariaLabel={metric === "gross" ? "Money collected per day for the last 14 days" : "Games played per day for the last 14 days"}
              format={metric === "gross" ? kshShort : (v) => String(Math.round(v))}
              data={trend.map((t) => ({
                key: t.date,
                label: shortDay(t.date),
                value: metric === "gross" ? t.grossMinor : t.games,
                line: metric === "gross" ? t.platformRevenueMinor : undefined,
                highlight: t.date === lastDay,
                tip: (
                  <>
                    <b>{weekday(t.date)}</b>
                    {ksh(t.grossMinor)} <span>collected</span>
                    <br />
                    {ksh(t.platformRevenueMinor)} <span>platform</span> · {t.games} <span>games</span>
                  </>
                ),
              }))}
            />
            {metric === "gross" ? (
              <div className="legend" style={{ marginTop: 8 }}>
                <span>
                  <i style={{ background: "var(--accent)" }} />
                  Collected
                </span>
                <span>
                  <i style={{ background: "var(--wait)" }} />
                  Platform revenue
                </span>
              </div>
            ) : null}
          </Card>

          <Card className="o-fleet" title="Fleet" actions={<Link className="link small" to="/tables">All tables →</Link>}>
            {fleet.tables.length ? (
              <>
                <div className="fleet-sum">
                  <span>
                    <b>{fleet.online}</b> online
                  </span>
                  <span>
                    <b>{fleet.offline}</b> offline
                  </span>
                  <span>
                    <b>{fleet.maintenance}</b> maintenance
                  </span>
                  {fleet.disabled ? (
                    <span>
                      <b>{fleet.disabled}</b> disabled
                    </span>
                  ) : null}
                </div>
                <div className="fleet">
                  {tables.slice(0, 12).map((t: any) => (
                    <Link key={t.id} to={`/tables/${t.id}`} className={t.state}>
                      <span className="spread">
                        <b>{t.id}</b>
                        <Status s={t.state} />
                      </span>
                      <span className="ellipsis">{t.name}</span>
                      <span className="faint ellipsis">{t.merchant}</span>
                      <span className="faint">
                        {t.gamesToday} today · {t.state === "offline" ? `seen ${ago(t.lastSeenAt)}` : `last game ${ago(t.lastGameAt)}`}
                      </span>
                    </Link>
                  ))}
                </div>
                {tables.length > 12 ? (
                  <p className="small muted" style={{ marginTop: 10 }}>
                    And {tables.length - 12} more. <Link className="link" to="/tables">See all</Link>
                  </p>
                ) : null}
              </>
            ) : (
              <p className="muted">
                No tables yet. <Link className="link" to="/tables?new=1">Create one</Link>.
              </p>
            )}
          </Card>

          <Card
            className="o-hours"
            title={
              <>
                Games by hour, today
                <span className="sub">{peakHour?.games ? `Busiest so far: ${String(peakHour.hour).padStart(2, "0")}:00 with ${peakHour.games} games` : "No games yet today"}</span>
              </>
            }
          >
            <BarChart
              height={160}
              ariaLabel="Games per hour today"
              format={(v) => String(Math.round(v))}
              data={(x.byHour ?? []).map((h: any) => ({
                key: String(h.hour),
                label: `${String(h.hour).padStart(2, "0")}`,
                value: h.games,
                highlight: h.hour === nowHour,
                tip: (
                  <>
                    <b>
                      {String(h.hour).padStart(2, "0")}:00–{String(h.hour).padStart(2, "0")}:59
                    </b>
                    {h.games} <span>games</span>
                  </>
                ),
              }))}
            />
          </Card>
        </div>

        <div className="stack">
          <Card className="o-money" title="Money position" actions={<Link className="link small" to="/float">Float →</Link>}>
            <div className="money-rows">
              <Link to="/float" className="money-row">
                <span className="l">Working account (pays out)</span>
                <span className={`v${floatTone ? ` sev-${floatTone === "bad" ? "critical" : "warning"}` : ""}`}>{ksh(money.workingMinor)}</span>
                <div className="meter">
                  <i className={floatTone || undefined} style={{ width: `${floatPct}%` }} />
                </div>
                <span className="s">
                  {money.float.requiredMinor > floatMin
                    ? `${floatPct}% of the ${ksh(money.float.requiredMinor)} needed for the next 24 h`
                    : `${floatPct}% of the ${ksh(floatMin)} minimum balance${money.float.requiredMinor ? ` · next 24 h needs ${ksh(money.float.requiredMinor)}` : ""}`}
                </span>
              </Link>
              <div className="money-row">
                <span className="l">Utility account (collects)</span>
                <span className="v">{ksh(money.utilityMinor)}</span>
                <span className="s">{money.balancesAt ? `Balances read ${ago(money.balancesAt)}` : "Balances not read yet"}</span>
              </div>
              <div className="money-row">
                <span className="l">Owed to merchants</span>
                <span className="v">{ksh(money.owedToMerchantsMinor)}</span>
              </div>
              <Link to="/payouts?status=pending_approval" className="money-row">
                <span className="l">Payouts awaiting approval</span>
                <span className="v">{money.pendingApproval.count ? ksh(money.pendingApproval.amountMinor) : "None"}</span>
                {money.pendingApproval.count ? <span className="s">{money.pendingApproval.count} waiting for a second person</span> : null}
              </Link>
              <Link to="/reconciliation" className="money-row">
                <span className="l">Reconciliation</span>
                <span className="v">{money.reconciliation ? <Status s={money.reconciliation.status} /> : <span className="faint small">Not run yet</span>}</span>
                {money.reconciliation ? <span className="s">Last run {dt(money.reconciliation.at)}</span> : null}
              </Link>
            </div>
          </Card>

          <Card className="o-alerts" title="Open alerts" actions={<Link className="link small" to="/alerts">All →</Link>}>
            {x.alerts.open.length ? (
              <div>
                {x.alerts.open.slice(0, 6).map((al: any) => (
                  <Link key={al.id} to={`/alerts/${al.id}`} className="list-row">
                    <span className={`sev-dot ${al.severity}`} />
                    <span className="grow">
                      <b>{al.title}</b>
                      <small>
                        {al.severity} · {ago(al.last_seen_at)}
                        {al.occurrences > 1 ? ` · ×${al.occurrences}` : ""}
                      </small>
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="muted small">No open alerts.</p>
            )}
          </Card>

          <Card
            className="o-top"
            title={
              <>
                Top merchants
                <span className="sub">This month, by money collected</span>
              </>
            }
            actions={<Link className="link small" to="/merchants">All →</Link>}
          >
            {top.length ? (
              <div>
                {top.map((m, i) => (
                  <Link key={m.id} to={`/merchants/${m.id}`} className="list-row">
                    <span className="rank">{i + 1}</span>
                    <span className="grow">
                      <b>{m.name}</b>
                      <small>
                        {m.code} · {m.games.toLocaleString("en-KE")} games
                      </small>
                      <div className="share">
                        <i style={{ width: `${Math.round((m.grossMinor / topMax) * 100)}%` }} />
                      </div>
                    </span>
                    <span className="amt">{ksh(m.grossMinor)}</span>
                  </Link>
                ))}
              </div>
            ) : (
              <p className="muted small">No payments this month yet.</p>
            )}
          </Card>
        </div>
      </div>

      {/* 4. The longer view */}
      <Card
        title={
          <>
            This month
            <span className="sub">Compared with the same days last month</span>
          </>
        }
        actions={<Link className="link small" to="/reports">Reports →</Link>}
      >
        <div className="period-grid">
          {(
            [
              ["Games played", month.games.toLocaleString("en-KE"), month.games, month.previous.games],
              ["Collected", ksh(month.grossMinor), month.grossMinor, month.previous.grossMinor],
              ["Platform revenue", ksh(month.platformRevenueMinor), month.platformRevenueMinor, month.previous.platformRevenueMinor],
              ["Merchant earnings", ksh(month.merchantEarningsMinor), month.merchantEarningsMinor, month.previous.merchantEarningsMinor],
            ] as const
          ).map(([l, v, now, prev]) => (
            <div key={l}>
              <div className="l">{l}</div>
              <div className="v">{v}</div>
              <div className="d">
                <Delta now={now} prev={prev} />
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card title={<>All time<span className="sub">Since the first table started</span></>}>
        <div className="period-grid">
          {(
            [
              ["Games played", allTime.games.toLocaleString("en-KE")],
              ["Collected", ksh(allTime.grossMinor)],
              ["Platform revenue", ksh(allTime.platformRevenueMinor)],
              ["Merchant earnings", ksh(allTime.merchantEarningsMinor)],
            ] as const
          ).map(([l, v]) => (
            <div key={l}>
              <div className="l">{l}</div>
              <div className="v">{v}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Recent activity">
        {x.activity.length ? (
          <>
            <div className="feed">
              {x.activity.slice(0, moreActivity ? 30 : 8).map((ev: any) => (
                <div key={ev.id} className="feed-row">
                  <span>{ev.title}</span>
                  <time>{dt(ev.at)}</time>
                </div>
              ))}
            </div>
            {x.activity.length > 8 ? (
              <button className="link small" style={{ marginTop: 8 }} onClick={() => setMoreActivity(!moreActivity)}>
                {moreActivity ? "Show less" : `Show ${Math.min(30, x.activity.length) - 8} more`}
              </button>
            ) : null}
          </>
        ) : (
          <p className="muted small">Nothing yet.</p>
        )}
      </Card>
    </div>
  );
}

function DashSkeleton() {
  return (
    <div className="stack" aria-busy="true">
      <Loading h={54} />
      <div className="attn">
        {[0, 1, 2].map((i) => (
          <Loading key={i} h={64} />
        ))}
      </div>
      <div className="kpis">
        {[0, 1, 2, 3].map((i) => (
          <Loading key={i} h={130} />
        ))}
      </div>
      <div className="dash-grid">
        <Loading h={300} />
        <Loading h={300} />
      </div>
    </div>
  );
}
