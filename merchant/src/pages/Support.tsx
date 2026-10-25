import { useState } from "react";
import { Icon } from "../components/Icon";
import { Badge, Empty, ErrorBox, Row, Sheet, TopBar, toast } from "../components/ui";
import { call, message } from "../lib/api";
import { when } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useLang } from "../lib/hooks";
import { useSession } from "../lib/session";

type D = { id: string; ref: string; kind: string; subject: string; status: string; updated_at: string; messages: number };

export default function Support() {
  useLang();
  const { me, isOwner } = useSession();
  const d = useApi<{ disputes: D[] }>(isOwner ? "/disputes" : null);
  const [open, setOpen] = useState(false);
  const s = me?.support;
  const wa = s?.whatsapp?.replace(/\D/g, "").replace(/^0/, "254");
  return (
    <main className="page">
      <TopBar title={t("support.title")} back="/more" />
      <div className="stack">
        {s?.hours ? <p className="muted small">{t("support.hours", { hours: s.hours })}</p> : null}
        <div className="list">
          {s?.phone ? <Row lead={<Icon name="phone" />} title={t("support.call")} sub={s.phone} to={undefined} onClick={() => location.assign(`tel:${s.phone}`)} /> : null}
          {wa ? <Row lead={<Icon name="chat" />} title={t("support.whatsapp")} sub={s!.whatsapp} onClick={() => window.open(`https://wa.me/${wa}`, "_blank", "noopener")} /> : null}
          {s?.email ? <Row lead={<Icon name="doc" />} title={t("support.email")} sub={s.email} onClick={() => location.assign(`mailto:${s.email}`)} /> : null}
          <Row lead={<Icon name="plus" />} title={t("support.new")} onClick={() => setOpen(true)} />
        </div>
        {isOwner ? (
          <>
            <div className="section-title"><h2>{t("support.disputes")}</h2></div>
            {d.error && !d.data ? <ErrorBox error={d.error} retry={d.reload} /> : null}
            {d.data ? (
              d.data.disputes.length ? (
                <div className="list">
                  {d.data.disputes.map((x) => (
                    <Row key={x.id} to={`/more/disputes/${x.id}`} title={x.subject} sub={`${x.ref} · ${when(x.updated_at)}`} end={<Badge tone={x.status === "resolved" || x.status === "closed" ? "ok" : x.status === "waiting_merchant" ? "wait" : "info"}>{t(`support.status_${x.status}`)}</Badge>} />
                  ))}
                </div>
              ) : (
                <div className="card"><Empty icon="chat">{t("support.noDisputes")}</Empty></div>
              )
            ) : null}
          </>
        ) : null}
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title={t("support.new")}>
        <NewDispute initial={{ kind: "other" }} onDone={() => { setOpen(false); void d.reload(); }} />
      </Sheet>
    </main>
  );
}

/** Report a problem about a payment, a table, or anything else. */
export function NewDispute({ initial, onDone }: { initial: { kind: "payment" | "table" | "other"; paymentId?: string; tableId?: string; subject?: string }; onDone: () => void }) {
  const [kind, setKind] = useState(initial.kind);
  const [subject, setSubject] = useState(initial.subject ?? "");
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
          await call("/disputes", { method: "POST", body: { kind, paymentId: initial.paymentId, tableId: initial.tableId, subject: subject || t(`support.kind_${kind}`), message: body } });
          toast(t("support.sent"));
          onDone();
        } catch (x) {
          setErr(message(x, t));
        } finally {
          setBusy(false);
        }
      }}
    >
      {!initial.paymentId && !initial.tableId ? (
        <div className="field">
          <label htmlFor="kind">{t("support.kind")}</label>
          <select id="kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="payment">{t("support.kind_payment")}</option>
            <option value="table">{t("support.kind_table")}</option>
            <option value="other">{t("support.kind_other")}</option>
          </select>
        </div>
      ) : null}
      <div className="field">
        <label htmlFor="subj">{t("support.subject")}</label>
        <input id="subj" className="input" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} />
      </div>
      <div className="field">
        <label htmlFor="body">{t("support.describe")}</label>
        <textarea id="body" className="input" value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} />
      </div>
      {err ? <ErrorBox text={err} /> : null}
      <button className="btn primary block" disabled={busy || body.trim().length < 3}>{t("support.send")}</button>
    </form>
  );
}
