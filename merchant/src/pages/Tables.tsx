import { Icon } from "../components/Icon";
import { Badge, Empty, ErrorBox, PageSkeleton, Row, Stale, TopBar, stateTone } from "../components/ui";
import { when } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useLang, usePullToRefresh } from "../lib/hooks";

type T = { id: string; name: string; state: string; lastSeenAt: string | null; lastGameAt: string | null; gamesToday: number; waiting: number; rssi: number | null };

export default function Tables() {
  useLang();
  const d = useApi<{ tables: T[] }>("/tables", { refreshMs: 30_000 });
  usePullToRefresh(d.reload);
  return (
    <main className="page">
      <TopBar title={t("tables.title")} back="/" />
      {d.loading ? <PageSkeleton /> : null}
      {d.error && !d.data ? <ErrorBox error={d.error} retry={d.reload} /> : null}
      {d.data ? (
        d.data.tables.length ? (
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
                    <span className="tiny muted">{t("home.gamesToday", { n: tb.gamesToday })}</span>
                  </>
                }
              />
            ))}
          </div>
        ) : (
          <div className="card">
            <Empty icon="table">{t("home.noTables")}</Empty>
          </div>
        )
      ) : null}
      <Stale savedAt={d.savedAt} stale={d.stale} />
    </main>
  );
}
