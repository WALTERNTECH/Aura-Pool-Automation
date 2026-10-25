import { useEffect } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Badge, Empty, ErrorBox, PageSkeleton, Stale, TopBar } from "../components/ui";
import { call } from "../lib/api";
import { when } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useLang, usePullToRefresh } from "../lib/hooks";

type N = { id: string; type: string; title: string; body: string; critical: boolean; data: { url?: string | null }; read_at: string | null; created_at: string };

const ICON: Record<string, string> = { table_offline: "wifiOff", table_online: "wifi", payment_attention: "alert", payout_succeeded: "check", payout_failed: "alert", payout_queued: "clock", auto_withdraw: "refresh", number_change: "shield", override_unusual: "tool", dispute_reply: "chat", announcement: "info" };

export default function Alerts() {
  useLang();
  const d = useApi<{ items: N[]; unread: number }>("/notifications?limit=100", { refreshMs: 30_000 });
  usePullToRefresh(d.reload);
  // Opening the list marks everything read after a moment, so the badge clears.
  useEffect(() => {
    if (!d.data?.unread) return;
    const id = setTimeout(() => void call("/notifications/read", { method: "POST", body: { all: true } }).catch(() => {}), 1500);
    return () => clearTimeout(id);
  }, [d.data?.unread]);
  return (
    <main className="page">
      <TopBar title={t("alerts.title")} back="/" />
      {d.loading ? <PageSkeleton /> : null}
      {d.error && !d.data ? <ErrorBox error={d.error} retry={d.reload} /> : null}
      {d.data ? (
        d.data.items.length ? (
          <div className="list">
            {d.data.items.map((n) => {
              const body = (
                <>
                  <span className="lead" style={n.critical ? { color: "var(--bad)", background: "var(--bad-tint)" } : undefined}>
                    <Icon name={ICON[n.type] ?? "bell"} />
                  </span>
                  <span className="main">
                    <span className="title" style={{ whiteSpace: "normal" }}>
                      {n.title} {!n.read_at ? <Badge tone="info" plain>•</Badge> : null}
                    </span>
                    <span className="sub" style={{ whiteSpace: "normal" }}>{n.body}</span>
                    <span className="tiny faint">{when(n.created_at)}</span>
                  </span>
                </>
              );
              return n.data?.url ? (
                <Link key={n.id} className="item" to={n.data.url} style={{ alignItems: "flex-start" }}>{body}</Link>
              ) : (
                <div key={n.id} className="item" style={{ alignItems: "flex-start" }}>{body}</div>
              );
            })}
          </div>
        ) : (
          <div className="card"><Empty icon="bell">{t("alerts.none")}</Empty></div>
        )
      ) : null}
      <Stale savedAt={d.savedAt} stale={d.stale} />
    </main>
  );
}
