import { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { ErrorBox, PageSkeleton, Row, Stale, TopBar } from "../components/ui";
import { dayLabel, ksh, nairobiDay, upcoming } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useLang, useOnline, usePullToRefresh } from "../lib/hooks";

type Money = {
  availableMinor: number;
  pendingWithdrawalsMinor: number;
  pendingWithdrawals: number;
  totalEarnedMinor: number;
  totalWithdrawnMinor: number;
  daily: { date: string; games: number; earningsMinor: number }[];
  autoWithdraw: { enabled: boolean; time: string | null; nextRunAt: string | null };
  payoutNumber: { masked: string | null; holdUntil: string | null };
  paused: string | null;
};

export default function MoneyPage() {
  useLang();
  const online = useOnline();
  const d = useApi<Money>("/money", { refreshMs: 30_000 });
  usePullToRefresh(d.reload);
  const [month, setMonth] = useState(nairobiDay().slice(0, 7));
  if (d.loading) return <main className="page"><PageSkeleton /></main>;
  if (!d.data) return <main className="page"><TopBar title={t("money.title")} />{d.error ? <ErrorBox error={d.error} retry={d.reload} /> : null}</main>;
  const m = d.data;
  return (
    <main className="page">
      <TopBar title={t("money.title")} />
      <div className="stack">
        {m.paused ? <p className="banner info"><Icon name="info" /><span className="sub">{m.paused}</span></p> : null}
        {!m.payoutNumber.masked ? (
          <Link to="/money/number" className="banner wait">
            <Icon name="phone" />
            <div className="grow"><b>{t("money.numberMissing")}</b></div>
            <Icon name="right" />
          </Link>
        ) : null}
        <section className="card balance">
          <div>
            <p className="muted small">{t("money.available")}</p>
            <p className="amount">{ksh(m.availableMinor)}</p>
          </div>
          <Link to="/money/withdraw" className="btn primary block" aria-disabled={!online || !m.payoutNumber.masked} onClick={(e) => (!online || !m.payoutNumber.masked) && e.preventDefault()}>
            <Icon name="download" /> {t("money.withdraw")}
          </Link>
          {!online ? <p className="hint">{t("offline.moneyOff")}</p> : null}
          <dl className="kv">
            <dt>{t("money.pending")}</dt>
            <dd>{ksh(m.pendingWithdrawalsMinor)}</dd>
            <dt>{t("money.earned")}</dt>
            <dd>{ksh(m.totalEarnedMinor)}</dd>
            <dt>{t("money.withdrawn")}</dt>
            <dd>{ksh(m.totalWithdrawnMinor)}</dd>
          </dl>
        </section>

        <div className="list">
          <Row to="/money/history" lead={<Icon name="clock" />} title={t("money.history")} sub={m.pendingWithdrawals ? `${m.pendingWithdrawals} · ${ksh(m.pendingWithdrawalsMinor)}` : undefined} />
          <Row to="/money/auto" lead={<Icon name="refresh" />} title={t("money.auto")} sub={m.autoWithdraw.enabled && m.autoWithdraw.nextRunAt ? upcoming(m.autoWithdraw.nextRunAt) : t("home.autoOff")} />
          <Row to="/money/number" lead={<Icon name="phone" />} title={t("money.number")} sub={m.payoutNumber.masked ?? t("number.none")} />
        </div>

        <div className="section-title"><h2>{t("money.daily")}</h2></div>
        <div className="list">
          {m.daily.map((day) => (
            <div className="item" key={day.date}>
              <span className="main">
                <span className="title">{dayLabel(day.date)}</span>
                <span className="sub">{t("money.games", { n: day.games })}</span>
              </span>
              <span className="end num"><b>{ksh(day.earningsMinor)}</b></span>
            </div>
          ))}
        </div>

        <section className="card stack-sm">
          <h2>{t("money.statement")}</h2>
          <div className="row">
            <input type="month" className="input grow" value={month} max={nairobiDay().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} aria-label={t("money.statement")} />
            <a className="btn sm" href={`/v1/m/reports/statement?month=${month}&format=csv`} download>{t("money.downloadCsv")}</a>
            <a className="btn sm" href={`/v1/m/reports/statement?month=${month}&format=pdf`} download>{t("money.downloadPdf")}</a>
          </div>
        </section>
        <Stale savedAt={d.savedAt} stale={d.stale} />
      </div>
    </main>
  );
}
