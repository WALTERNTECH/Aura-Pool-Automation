import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Badge, Empty, ErrorBox, PageSkeleton, Row, Stale, stateTone } from "../components/ui";
import { ksh, upcoming, when } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useLang, useOnline, usePullToRefresh } from "../lib/hooks";
import { useSession } from "../lib/session";

export type PaymentRow = { id: string; receivedAt: string; tableId: string | null; amountMinor?: number; payer: string | null; mpesaCode: string; games: number; gamesPlayed: number; status: { code: string; label: string; tone: "ok" | "wait" | "bad" | "info" } };
type Dashboard = {
  businessName: string;
  name: string;
  role: "owner" | "staff";
  today: { games: number; collectedMinor?: number; earningsMinor?: number; needsAttention: number };
  balance: null | { availableMinor: number; autoWithdraw: { enabled: boolean; time: string | null; nextRunAt: string | null } };
  tables: { id: string; name: string; state: string; lastSeenAt: string | null; lastGameAt: string | null; gamesToday: number; waiting: number }[];
  alerts: { kind: string; tone: "bad" | "wait" | "info"; title: string; body: string; url: string }[];
  recentPayments: PaymentRow[];
};

export function PaymentItem({ p }: { p: PaymentRow }) {
  return (
    <Row
      to={`/payments/${p.id}`}
      title={
        <>
          {p.amountMinor != null ? ksh(p.amountMinor) : t("payments.games", { n: p.games })} <span className="muted small">· {p.tableId ?? "—"}</span>
        </>
      }
      sub={`${when(p.receivedAt)} · ${p.payer ?? ""}`}
      end={<Badge tone={p.status.tone}>{t(`status.${p.status.code}`)}</Badge>}
      chevron={false}
    />
  );
}

export default function Home() {
  useLang();
  const { me } = useSession();
  const online = useOnline();
  const d = useApi<Dashboard>("/dashboard", { refreshMs: 30_000 });
  const { pull } = usePullToRefresh(d.reload);
  const first = (me?.user.name ?? d.data?.name ?? "").split(" ")[0];

  return (
    <main className="page">
      <div className="pull" style={{ height: pull }} aria-hidden="true">
        {pull ? <Icon name="refresh" /> : null}
      </div>
      <header className="topbar">
        <div className="grow">
          <p className="muted small">{me?.merchant.businessName ?? d.data?.businessName}</p>
          <h1>{t("home.hello", { name: first })}</h1>
        </div>
        <Link className="icon-btn" to="/alerts" aria-label={t("nav.alerts")}>
          <Icon name="bell" />
        </Link>
      </header>
      {d.loading ? <PageSkeleton /> : null}
      {d.error && !d.data ? <ErrorBox error={d.error} retry={d.reload} /> : null}
      {d.data ? (
        <div className="stack">
          {d.data.alerts.map((a) => (
            <Link key={a.kind + a.title} to={a.url} className={`banner ${a.tone}`}>
              <Icon name={a.tone === "info" ? "info" : "alert"} />
              <div className="grow">
                <b>{a.title}</b>
                <span className="sub">{a.body}</span>
              </div>
            </Link>
          ))}

          <div className="section-title">
            <h2>{t("home.today")}</h2>
          </div>
          <div className="kpis">
            <div className="kpi">
              <span className="label">{t("home.games")}</span>
              <span className="value">{d.data.today.games}</span>
            </div>
            {d.data.today.collectedMinor != null ? (
              <div className="kpi">
                <span className="label">{t("home.collected")}</span>
                <span className="value">{ksh(d.data.today.collectedMinor)}</span>
              </div>
            ) : null}
            {d.data.today.earningsMinor != null ? (
              <div className="kpi">
                <span className="label">{t("home.earnings")}</span>
                <span className="value">{ksh(d.data.today.earningsMinor)}</span>
              </div>
            ) : null}
            <Link to="/payments?status=attention" className={`kpi${d.data.today.needsAttention ? " warn" : ""}`}>
              <span className="label">{t("home.attention")}</span>
              <span className="value">{d.data.today.needsAttention}</span>
            </Link>
          </div>

          {d.data.balance ? (
            <section className="card balance" aria-label={t("home.balance")}>
              <div>
                <p className="muted small">{t("home.balance")}</p>
                <p className="amount">{ksh(d.data.balance.availableMinor)}</p>
              </div>
              <Link to="/money/withdraw" className={`btn primary block${online ? "" : " disabled"}`} aria-disabled={!online} onClick={(e) => !online && e.preventDefault()}>
                <Icon name="download" /> {t("home.withdraw")}
              </Link>
              <p className="small muted">
                <Icon name="clock" className="faint" />{" "}
                {d.data.balance.autoWithdraw.enabled && d.data.balance.autoWithdraw.nextRunAt ? t("home.nextAuto", { when: upcoming(d.data.balance.autoWithdraw.nextRunAt) }) : <Link to="/money/auto">{t("home.autoOff")}</Link>}
              </p>
            </section>
          ) : null}

          <div className="section-title">
            <h2>{t("home.tables")}</h2>
            <Link to="/tables">{t("app.seeAll")}</Link>
          </div>
          {d.data.tables.length ? (
            <div className="list">
              {d.data.tables.map((tb) => (
                <Row
                  key={tb.id}
                  to={`/tables/${tb.id}`}
                  lead={<Icon name="table" />}
                  title={`${tb.id} · ${tb.name}`}
                  sub={tb.lastGameAt ? t("home.lastGame", { when: when(tb.lastGameAt) }) : t("home.neverPlayed")}
                  end={
                    <>
                      <Badge tone={stateTone(tb.state)}>{t(`state.${tb.state}`)}</Badge>
                      <span className="tiny muted">{tb.waiting ? t("home.waiting", { n: tb.waiting }) : t("home.gamesToday", { n: tb.gamesToday })}</span>
                    </>
                  }
                />
              ))}
            </div>
          ) : (
            <div className="card">
              <Empty icon="table">{t("home.noTables")}</Empty>
            </div>
          )}

          <div className="section-title">
            <h2>{t("home.recent")}</h2>
            <Link to="/payments">{t("app.seeAll")}</Link>
          </div>
          {d.data.recentPayments.length ? (
            <div className="list">
              {d.data.recentPayments.map((p) => (
                <PaymentItem key={p.id} p={p} />
              ))}
            </div>
          ) : (
            <div className="card">
              <Empty icon="payments">{t("home.noPayments")}</Empty>
            </div>
          )}
          <Stale savedAt={d.savedAt} stale={d.stale} />
        </div>
      ) : null}
    </main>
  );
}
