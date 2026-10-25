import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Badge, ErrorBox, PageSkeleton, Sheet, TopBar } from "../components/ui";
import { dateTime, ksh, when } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useLang } from "../lib/hooks";
import { NewDispute } from "./Support";

type Detail = {
  id: string;
  mpesaCode: string;
  channel: string;
  tableId: string | null;
  payer: string | null;
  payerName: string | null;
  receivedAt: string;
  games: number;
  status: { code: string; tone: "ok" | "wait" | "bad" | "info" };
  reason: string | null;
  timeline: { step: string; at: string | null; done: boolean; state?: string }[];
  split: null | { totalMinor: number; commissionMinor: number; shareMinor: number; heldMinor: number; refundedMinor: number };
  disputes: { id: string; ref: string; status: string; subject: string }[];
};

export default function PaymentDetail() {
  useLang();
  const { id = "" } = useParams();
  const d = useApi<Detail>(`/payments/${id}`, { refreshMs: 15_000 });
  const [report, setReport] = useState(false);
  if (d.loading) return <main className="page"><PageSkeleton /></main>;
  if (!d.data) return <main className="page"><TopBar title={t("payment.title")} back="/payments" />{d.error ? <ErrorBox error={d.error} retry={d.reload} /> : null}</main>;
  const p = d.data;
  const bad = ["unlock_failed", "rejected", "wrong_table", "underpaid"].includes(p.status.code);
  return (
    <main className="page">
      <TopBar title={t("payment.title")} back={true} />
      <div className="stack">
        <section className="card stack-sm">
          <div className="spread">
            <span className="amount num" style={{ fontSize: 28, fontWeight: 750 }}>{p.split ? ksh(p.split.totalMinor) : t("payments.games", { n: p.games })}</span>
            <Badge tone={p.status.tone}>{t(`status.${p.status.code}`)}</Badge>
          </div>
          {p.reason ? <p className={`banner ${bad ? "bad" : "wait"}`}><Icon name={bad ? "alert" : "clock"} /><span className="sub">{p.reason}</span></p> : null}
          <dl className="kv">
            <dt>{t("payment.code")}</dt>
            <dd>{p.mpesaCode}</dd>
            <dt>{t("payment.table")}</dt>
            <dd>{p.tableId ? <Link className="link" to={`/tables/${p.tableId}`}>{p.tableId}</Link> : "—"}</dd>
            <dt>{t("payment.payer")}</dt>
            <dd>{[p.payerName, p.payer].filter(Boolean).join(" · ") || "—"}</dd>
            <dt>{t("payment.received")}</dt>
            <dd>{dateTime(p.receivedAt)}</dd>
          </dl>
        </section>

        <section className="card">
          <h2 style={{ marginBottom: 10 }}>{t("payment.timeline")}</h2>
          <div className="timeline">
            {p.timeline.map((s, i) => {
              const fail = !s.done && bad && i === p.timeline.findIndex((x) => !x.done);
              return (
                <div key={s.step} className={`t${s.done ? " done" : fail ? " fail" : ""}`}>
                  <span className="mark"><Icon name={s.done ? "check" : fail ? "x" : "clock"} /></span>
                  <span>{t(`payment.step_${s.step}`)}</span>
                  <span className="small muted num">{s.at ? when(s.at) : ""}</span>
                </div>
              );
            })}
          </div>
        </section>

        {p.split ? (
          <section className="card">
            <h2 style={{ marginBottom: 10 }}>{t("payment.split")}</h2>
            <dl className="kv">
              <dt>{t("payment.total")}</dt>
              <dd>{ksh(p.split.totalMinor)}</dd>
              <dt>{t("payment.commission")}</dt>
              <dd>−{ksh(p.split.commissionMinor)}</dd>
              {p.split.heldMinor ? (
                <>
                  <dt>{t("payment.held")}</dt>
                  <dd>{ksh(p.split.heldMinor)}</dd>
                </>
              ) : null}
              {p.split.refundedMinor ? (
                <>
                  <dt>{t("payment.refunded")}</dt>
                  <dd>−{ksh(p.split.refundedMinor)}</dd>
                </>
              ) : null}
              <hr />
              <dt className="total">{t("payment.share")}</dt>
              <dd className="total">{ksh(p.split.shareMinor)}</dd>
            </dl>
          </section>
        ) : null}

        {p.disputes.length ? (
          <div className="list">
            {p.disputes.map((x) => (
              <Link key={x.id} className="item" to={`/more/disputes/${x.id}`}>
                <span className="main"><span className="title">{x.subject}</span><span className="sub">{x.ref}</span></span>
                <Badge tone="info">{t(`support.status_${x.status}`)}</Badge>
              </Link>
            ))}
          </div>
        ) : null}
        <button className="btn ghost block" onClick={() => setReport(true)}>{t("payment.report")}</button>
      </div>
      <Sheet open={report} onClose={() => setReport(false)} title={t("payment.report")}>
        <NewDispute initial={{ kind: "payment", paymentId: p.id, subject: `${p.mpesaCode}` }} onDone={() => { setReport(false); void d.reload(); }} />
      </Sheet>
    </main>
  );
}
