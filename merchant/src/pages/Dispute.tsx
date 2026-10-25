import { useState } from "react";
import { useParams } from "react-router-dom";
import { Badge, ErrorBox, PageSkeleton, TopBar } from "../components/ui";
import { call, message } from "../lib/api";
import { when } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useLang } from "../lib/hooks";

type D = { id: string; ref: string; subject: string; status: string; messages: { id: string; author_type: "merchant" | "admin"; author_label: string; body: string; created_at: string }[] };

export default function Dispute() {
  useLang();
  const { id = "" } = useParams();
  const d = useApi<D>(`/disputes/${id}`, { refreshMs: 30_000 });
  const [body, setBody] = useState("");
  const [err, setErr] = useState<string | null>(null);
  if (d.loading) return <main className="page"><PageSkeleton /></main>;
  if (!d.data) return <main className="page"><TopBar title={t("support.title")} back="/more/support" />{d.error ? <ErrorBox error={d.error} /> : null}</main>;
  return (
    <main className="page">
      <TopBar title={d.data.subject} back="/more/support" />
      <div className="stack">
        <div className="row">
          <span className="muted small">{d.data.ref}</span>
          <Badge tone="info">{t(`support.status_${d.data.status}`)}</Badge>
        </div>
        <div className="stack-sm">
          {d.data.messages.map((m) => (
            <div key={m.id} className={m.author_type === "merchant" ? "msg-me" : "msg-them"}>
              <div className="tiny muted">{m.author_type === "merchant" ? t("support.you") : t("support.team")} · {when(m.created_at)}</div>
              {m.body}
            </div>
          ))}
        </div>
        <form
          className="stack-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              await call(`/disputes/${id}/messages`, { method: "POST", body: { body } });
              setBody("");
              void d.reload();
            } catch (x) {
              setErr(message(x, t));
            }
          }}
        >
          <textarea className="input" value={body} onChange={(e) => setBody(e.target.value)} aria-label={t("support.reply")} />
          {err ? <ErrorBox text={err} /> : null}
          <button className="btn primary block" disabled={!body.trim()}>{t("support.reply")}</button>
        </form>
      </div>
    </main>
  );
}
