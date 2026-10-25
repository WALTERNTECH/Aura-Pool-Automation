import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { Chips, Empty, ErrorBox, PageSkeleton, Stale, TopBar } from "../components/ui";
import { call } from "../lib/api";
import { nairobiDay } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useLang, usePullToRefresh } from "../lib/hooks";
import { useSession } from "../lib/session";
import { PaymentItem, type PaymentRow } from "./Home";

type Range = "today" | "week" | "month" | "custom" | "all";

export default function Payments() {
  useLang();
  const { isOwner } = useSession();
  const [sp, setSp] = useSearchParams();
  const [range, setRange] = useState<Range>((sp.get("range") as Range) ?? (isOwner ? "week" : "today"));
  const [status, setStatus] = useState(sp.get("status") ?? "");
  const [table, setTable] = useState(sp.get("table") ?? "");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState(nairobiDay(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(nairobiDay());
  const [more, setMore] = useState<PaymentRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const tables = useApi<{ tables: { id: string; name: string }[] }>("/tables");

  const query = useMemo(() => {
    const p = new URLSearchParams();
    const today = nairobiDay();
    if (range === "today") p.set("from", today);
    if (range === "week") p.set("from", nairobiDay(new Date(Date.now() - 6 * 86_400_000)));
    if (range === "month") p.set("from", `${today.slice(0, 8)}01`);
    if (range === "custom") {
      p.set("from", from);
      p.set("to", to);
    }
    if (status) p.set("status", status);
    if (table) p.set("table", table);
    if (q.trim().length >= 3) p.set("q", q.trim().toUpperCase());
    p.set("limit", "30");
    return p.toString();
  }, [range, status, table, q, from, to]);

  const d = useApi<{ items: PaymentRow[]; nextCursor: string | null }>(`/payments?${query}`, { refreshMs: 30_000 });
  usePullToRefresh(d.reload);
  useEffect(() => {
    setMore([]);
    setCursor(null);
    const next = new URLSearchParams();
    if (status) next.set("status", status);
    if (table) next.set("table", table);
    setSp(next, { replace: true });
  }, [query, status, table, setSp]);
  const next = cursor === null ? d.data?.nextCursor : cursor;

  const loadMore = async () => {
    if (!next) return;
    const r = await call<{ items: PaymentRow[]; nextCursor: string | null }>(`/payments?${query}&cursor=${encodeURIComponent(next)}`);
    setMore((m) => [...m, ...r.items]);
    setCursor(r.nextCursor ?? "");
  };

  const items = [...(d.data?.items ?? []), ...more];
  const exportUrl = `/v1/m/payments/export?${query.replace(/&?limit=\d+/, "")}`;

  return (
    <main className="page">
      <TopBar
        title={t("payments.title")}
        action={
          isOwner ? (
            <a className="icon-btn" href={exportUrl} aria-label={t("payments.export")} download>
              <Icon name="download" />
            </a>
          ) : null
        }
      />
      <div className="stack">
        <div className="field">
          <label className="sr" htmlFor="q">{t("payments.search")}</label>
          <input id="q" className="input" placeholder={t("payments.search")} value={q} onChange={(e) => setQ(e.target.value)} autoCapitalize="characters" />
        </div>
        {isOwner ? (
          <Chips
            label="Dates"
            value={range}
            onChange={setRange}
            options={[
              { value: "today", label: t("payments.today") },
              { value: "week", label: t("payments.week") },
              { value: "month", label: t("payments.month") },
              { value: "all", label: t("payments.all") },
              { value: "custom", label: t("payments.custom") },
            ]}
          />
        ) : (
          <p className="hint">{t("payments.todayOnly")}</p>
        )}
        {range === "custom" ? (
          <div className="row">
            <div className="field grow">
              <label htmlFor="from">{t("payments.from")}</label>
              <input id="from" type="date" className="input" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="field grow">
              <label htmlFor="to">{t("payments.to")}</label>
              <input id="to" type="date" className="input" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
        ) : null}
        <Chips
          label="Status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "", label: t("payments.all") },
            { value: "attention", label: t("payments.attention") },
            { value: "game_started", label: t("status.game_started") },
            { value: "waiting_table", label: t("status.waiting_table") },
            { value: "unlock_failed", label: t("status.unlock_failed") },
            { value: "underpaid", label: t("status.underpaid") },
            { value: "refund_pending", label: t("status.refund_pending") },
          ]}
        />
        {tables.data && tables.data.tables.length > 1 ? (
          <select className="input" aria-label={t("payments.allTables")} value={table} onChange={(e) => setTable(e.target.value)}>
            <option value="">{t("payments.allTables")}</option>
            {tables.data.tables.map((tb) => (
              <option key={tb.id} value={tb.id}>
                {tb.id} · {tb.name}
              </option>
            ))}
          </select>
        ) : null}

        {d.loading ? <PageSkeleton /> : null}
        {d.error && !d.data ? <ErrorBox error={d.error} retry={d.reload} /> : null}
        {d.data ? (
          items.length ? (
            <div className="list">{items.map((p) => <PaymentItem key={p.id} p={p} />)}</div>
          ) : (
            <div className="card"><Empty icon="payments">{t("payments.none")}</Empty></div>
          )
        ) : null}
        {next ? (
          <button className="btn block" onClick={() => void loadMore()}>
            {t("payments.more")}
          </button>
        ) : null}
        <Stale savedAt={d.savedAt} stale={d.stale} />
      </div>
    </main>
  );
}
