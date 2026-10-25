import { Link } from "react-router-dom";
import { Banner, Card, ErrorBox, Loading, Money, PageHead, Stat, Status } from "../components/ui";
import { ago, dt, ksh, pct } from "../lib/format";
import { useApi } from "../lib/hooks";
import { useSession } from "../lib/session";

type Fig = { games: number; grossMinor: number; platformRevenueMinor: number; merchantEarningsMinor: number; payments: number };

export default function Dashboard() {
  const { me } = useSession();
  const d = useApi<any>("/dashboard", { refreshMs: 30_000 });
  if (d.loading) return <Loading h={400} />;
  if (!d.data) return <ErrorBox error={d.error} />;
  const x = d.data;
  const a = x.attention;
  const money = x.money;
  const block = (title: string, f: Fig & { previous?: Fig }) => (
    <Card title={title}>
      <div className="grid4">
        <Stat label="Games played" value={f.games.toLocaleString("en-KE")} delta={f.previous ? `${pct(f.games, f.previous.games)} vs previous` : undefined} />
        <Stat label="Gross collected" value={ksh(f.grossMinor)} delta={f.previous ? pct(f.grossMinor, f.previous.grossMinor) : undefined} />
        <Stat label="Platform revenue" value={ksh(f.platformRevenueMinor)} delta={f.previous ? pct(f.platformRevenueMinor, f.previous.platformRevenueMinor) : undefined} />
        <Stat label="Merchant earnings" value={ksh(f.merchantEarningsMinor)} delta={f.previous ? pct(f.merchantEarningsMinor, f.previous.merchantEarningsMinor) : undefined} />
      </div>
    </Card>
  );
  const attention = (a.unmatched ?? 0) + (a.underpaid ?? 0) + (a.overpaid ?? 0) + (a.unlock_failed ?? 0) + (a.verification_failed ?? 0) + (a.refund_pending ?? 0);
  return (
    <div className="stack">
      <PageHead
        title={`Good ${new Date().getUTCHours() + 3 < 12 ? "morning" : new Date().getUTCHours() + 3 < 17 ? "afternoon" : "evening"}, ${me?.name.split(" ")[0]}`}
        sub={`Updated ${dt(x.updatedAt)} · refreshes every 30 seconds`}
        actions={
          <button className="btn sm" onClick={() => void d.reload()}>
            Refresh
          </button>
        }
      />
      {money.killSwitch.on ? <Banner tone="bad" icon="power" title="Payout kill switch is on">{money.killSwitch.reason} — {money.killSwitch.by}, {dt(money.killSwitch.at)}</Banner> : null}
      {money.autoPayoutsPaused.on ? (
        <Banner tone="bad" icon="alert" title="Automatic payouts are paused after a reconciliation difference">
          {money.autoPayoutsPaused.reason} <Link className="link" to="/reconciliation">Review and acknowledge</Link>
        </Banner>
      ) : null}
      {money.float.status === "warning" || money.float.status === "critical" ? (
        <Banner tone={money.float.status === "critical" ? "bad" : "wait"} icon="float" title="Transfer needed">
          Working float is short of the next 24 hours of payouts. Suggested transfer from Utility: <b>{ksh(money.float.suggestedTransferMinor)}</b>. <Link className="link" to="/transfers">Record a transfer</Link>
        </Banner>
      ) : null}

      <div className="grid4">
        <Stat label="Payments needing attention" value={attention} to="/exceptions" tone={attention ? "bad" : undefined} />
        <Stat label="Tables online" value={`${x.fleet.online} / ${x.fleet.total}`} to="/tables" tone={x.fleet.offline ? "wait" : undefined} delta={`${x.fleet.offline} offline · ${x.fleet.maintenance} maintenance`} />
        <Stat label="Payouts awaiting approval" value={money.pendingApproval.count} delta={ksh(money.pendingApproval.amountMinor)} to="/payouts?status=pending_approval" tone={money.pendingApproval.count ? "wait" : undefined} />
        <Stat label="Open alerts" value={Object.values(x.alerts.counts as Record<string, number>).reduce((s, n) => s + n, 0)} delta={`${x.alerts.counts.critical ?? 0} critical`} to="/alerts" tone={x.alerts.counts.critical ? "bad" : undefined} />
      </div>

      {block("Today", x.today)}
      <div className="grid2">
        {block("This month", x.month)}
        {block("All time", x.allTime)}
      </div>

      <div className="grid2">
        <Card title="Money health" actions={<Link className="link small" to="/float">Float →</Link>}>
          <div className="grid2">
            <Stat label="Utility account" value={<Money v={money.utilityMinor} />} delta={money.balancesAt ? `as of ${ago(money.balancesAt)}` : "not read yet"} />
            <Stat label="Working account" value={<Money v={money.workingMinor} />} delta={`needs ${ksh(money.float.requiredMinor)} (24 h + buffer)`} tone={money.float.status === "critical" ? "bad" : money.float.status === "warning" ? "wait" : undefined} />
            <Stat label="Owed to merchants" value={<Money v={money.owedToMerchantsMinor} />} />
            <Stat
              label="Reconciliation"
              value={money.reconciliation ? <Status s={money.reconciliation.status} /> : "Not run yet"}
              delta={money.reconciliation ? dt(money.reconciliation.at) : undefined}
              to="/reconciliation"
            />
          </div>
        </Card>
        <Card title="Open alerts" actions={<Link className="link small" to="/alerts">All alerts →</Link>}>
          {x.alerts.open.length ? (
            <div className="stack-sm">
              {x.alerts.open.map((al: any) => (
                <Link key={al.id} to={`/alerts/${al.id}`} className="spread" style={{ padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                  <span className="grow">
                    <span className={`sev-${al.severity}`} style={{ fontWeight: 650 }}>● </span>
                    {al.title}
                    {al.occurrences > 1 ? <span className="faint small"> ×{al.occurrences}</span> : null}
                  </span>
                  <span className="small faint">{ago(al.last_seen_at)}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="muted">No open alerts.</p>
          )}
        </Card>
      </div>

      <Card title="Fleet" actions={<Link className="link small" to="/tables">Tables →</Link>}>
        {x.fleet.tables.length ? (
          <div className="fleet">
            {x.fleet.tables.map((t: any) => (
              <Link key={t.id} to={`/tables/${t.id}`}>
                <span className="spread">
                  <b>{t.id}</b>
                  <Status s={t.state} />
                </span>
                <span className="ellipsis">{t.name}</span>
                <span className="faint ellipsis">{t.merchant}</span>
                <span className="faint">{t.gamesToday} today · last game {ago(t.lastGameAt)}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="muted">No tables yet. <Link className="link" to="/tables?new=1">Create one</Link>.</p>
        )}
      </Card>

      <Card title="Activity">
        {x.activity.length ? (
          <div className="stack-sm">
            {x.activity.map((ev: any) => (
              <div key={ev.id} className="spread small" style={{ borderBottom: "1px solid var(--line)", padding: "4px 0" }}>
                <span>{ev.title}</span>
                <span className="faint">{dt(ev.at)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Nothing yet.</p>
        )}
      </Card>
    </div>
  );
}
