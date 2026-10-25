import { useState } from "react";
import { PinSheet } from "../components/PinPad";
import { Badge, Empty, ErrorBox, PageSkeleton, Stale, TopBar, toast } from "../components/ui";
import { call } from "../lib/api";
import { dateTime, ksh } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useLang, usePullToRefresh } from "../lib/hooks";

type P = { id: string; ref: string; amountMinor: number; feeMinor: number; receivedMinor: number; destination: string; trigger: string; stage: { code: string; tone: "ok" | "wait" | "bad" | "info" }; note: string | null; receipt: string | null; requestedAt: string; cancellable: boolean };

export default function History() {
  useLang();
  const d = useApi<{ items: P[]; nextCursor: string | null }>("/payouts?limit=50", { refreshMs: 20_000 });
  usePullToRefresh(d.reload);
  const [cancel, setCancel] = useState<P | null>(null);
  return (
    <main className="page">
      <TopBar title={t("history.title")} back="/money" />
      {d.loading ? <PageSkeleton /> : null}
      {d.error && !d.data ? <ErrorBox error={d.error} retry={d.reload} /> : null}
      {d.data ? (
        d.data.items.length ? (
          <div className="list">
            {d.data.items.map((p) => (
              <div className="item" key={p.id} style={{ alignItems: "flex-start" }}>
                <span className="main">
                  <span className="title num">{ksh(p.amountMinor)}</span>
                  <span className="sub">
                    {dateTime(p.requestedAt)} · {p.destination}
                    {p.trigger === "scheduled" ? ` · ${t("history.automatic")}` : ""}
                  </span>
                  <span className="sub">
                    {t("history.fee", { fee: ksh(p.feeMinor) })}
                    {p.receipt ? ` · ${t("history.receipt", { code: p.receipt })}` : ""}
                  </span>
                  {p.note && ["failed", "rejected", "queued", "needs_approval", "held"].includes(p.stage.code) ? <span className={`small ${p.stage.code === "failed" ? "err" : "muted"}`}>{p.note}</span> : null}
                  {p.cancellable ? (
                    <button className="link small" style={{ justifySelf: "start", marginTop: 4 }} onClick={() => setCancel(p)}>
                      {t("history.cancel")}
                    </button>
                  ) : null}
                </span>
                <span className="end">
                  <Badge tone={p.stage.tone as never}>{t(`stage.${p.stage.code}`)}</Badge>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="card"><Empty icon="clock">{t("history.none")}</Empty></div>
        )
      ) : null}
      <Stale savedAt={d.savedAt} stale={d.stale} />
      <PinSheet
        open={Boolean(cancel)}
        onClose={() => setCancel(null)}
        title={t("history.cancel")}
        onPin={async (pin) => {
          await call(`/payouts/${cancel!.id}/cancel`, { method: "POST", body: { pin } });
          setCancel(null);
          toast(t("app.done"));
          void d.reload();
        }}
      />
    </main>
  );
}
