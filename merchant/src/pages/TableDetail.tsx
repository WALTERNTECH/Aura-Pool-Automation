import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { PinSheet } from "../components/PinPad";
import { Badge, Empty, ErrorBox, PageSkeleton, Sheet, Stale, Toggle, TopBar, stateTone, toast } from "../components/ui";
import { call, message } from "../lib/api";
import { ksh, parseKsh, weekday, when } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useInterval, useLang, useOnline } from "../lib/hooks";
import { useSession } from "../lib/session";
import { PaymentItem, type PaymentRow } from "./Home";
import { NewDispute } from "./Support";

type Detail = {
  id: string;
  name: string;
  location: string | null;
  status: string;
  statusReason: string | null;
  state: string;
  priceMinor: number;
  unlockSeconds: number;
  bounds: { priceMinMinor: number; priceMaxMinor: number; unlockMinS: number; unlockMaxS: number };
  openingHours: Record<string, [string, string][]> | null;
  startedAt: string | null;
  device: null | { online: boolean; rssi: number | null; lastSeenAt: string | null; firmware: string | null };
  figures: Record<"today" | "week" | "month", { games: number; earningsMinor?: number }>;
  recentPayments: PaymentRow[];
  paymentInstructions: { paybill: string; account: string; payPageUrl: string };
  overrideLog: { at: string }[];
  manualUnlock: { limit: number; usedToday: number; reasons: string[] };
};

const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

function signal(rssi: number | null) {
  if (rssi == null) return "—";
  const bars = rssi > -60 ? "▮▮▮▮" : rssi > -70 ? "▮▮▮▯" : rssi > -80 ? "▮▮▯▯" : "▮▯▯▯";
  return `${bars} ${rssi} dBm`;
}

export default function TableDetail() {
  useLang();
  const { id = "" } = useParams();
  const { isOwner } = useSession();
  const online = useOnline();
  const d = useApi<Detail>(`/tables/${id}`, { refreshMs: 30_000 });
  const [edit, setEdit] = useState(false);
  const [hours, setHours] = useState(false);
  const [unlock, setUnlock] = useState(false);
  const [report, setReport] = useState(false);

  if (d.loading) return <main className="page"><PageSkeleton /></main>;
  if (!d.data) return <main className="page"><TopBar title={id} back="/tables" />{d.error ? <ErrorBox error={d.error} retry={d.reload} /> : null}</main>;
  const tb = d.data;

  const setMaintenance = async (on: boolean) => {
    try {
      await call(`/tables/${id}/maintenance`, { method: "POST", body: { on } });
      await d.reload();
    } catch (e) {
      toast(message(e, t));
    }
  };

  return (
    <main className="page">
      <TopBar title={`${tb.id} · ${tb.name}`} back="/tables" />
      <div className="stack">
        <div className="row">
          <Badge tone={stateTone(tb.state)}>{t(`state.${tb.state}`)}</Badge>
          {tb.location ? <span className="muted small">{tb.location}</span> : null}
        </div>
        {tb.status === "maintenance" ? <p className="banner wait"><Icon name="tool" /><span className="sub">{t("tables.maintenanceOn")}</span></p> : null}
        {tb.status === "disabled" ? <p className="banner bad"><Icon name="alert" /><span className="sub">{t("tables.disabledNote")}</span></p> : null}

        <section className="card stack-sm">
          <h2>{t("tables.device")}</h2>
          <dl className="kv">
            <dt>{t("tables.lastSeen")}</dt>
            <dd>{tb.device?.lastSeenAt ? when(tb.device.lastSeenAt) : t("tables.never")}</dd>
            <dt>{t("tables.signal")}</dt>
            <dd>{signal(tb.device?.rssi ?? null)}</dd>
            <dt>{t("tables.firmware")}</dt>
            <dd>{tb.device?.firmware ?? "—"}</dd>
          </dl>
        </section>

        <section className="card stack-sm">
          <h2>{t("tables.figures")}</h2>
          <div className="kpis" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
            {(["today", "week", "month"] as const).map((k) => (
              <div className="kpi" key={k}>
                <span className="label">{t(`tables.${k}`)}</span>
                <span className="value">{tb.figures[k].games}</span>
                {tb.figures[k].earningsMinor != null ? <span className="tiny muted num">{ksh(tb.figures[k].earningsMinor)}</span> : null}
              </div>
            ))}
          </div>
        </section>

        <section className="card stack-sm">
          <dl className="kv">
            <dt>{t("tables.price")}</dt>
            <dd>{ksh(tb.priceMinor)}</dd>
            <dt>{t("tables.unlock")}</dt>
            <dd>{t("tables.seconds", { n: tb.unlockSeconds })}</dd>
            <dt>{t("tables.hours")}</dt>
            <dd>{tb.openingHours ? summariseHours(tb.openingHours) : t("tables.hoursNone")}</dd>
          </dl>
          {isOwner ? (
            <div className="row" style={{ flexWrap: "wrap" }}>
              <button className="btn sm" onClick={() => setEdit(true)} disabled={tb.status === "disabled"}>
                {t("tables.editPrice")}
              </button>
              <button className="btn sm" onClick={() => setHours(true)}>
                {t("tables.hoursEdit")}
              </button>
            </div>
          ) : null}
        </section>

        {isOwner && tb.status !== "disabled" ? (
          <section className="card spread">
            <div className="grow">
              <h3>{t("tables.maintenance")}</h3>
              <p className="small muted">{t("tables.maintenanceBody")}</p>
            </div>
            <Toggle checked={tb.status === "maintenance"} onChange={setMaintenance} label={t("tables.maintenance")} disabled={!online} />
          </section>
        ) : null}

        <section className="card stack-sm">
          <h2>{t("tables.manual")}</h2>
          <p className="small muted">{t("tables.manualBody", { used: tb.manualUnlock.usedToday, limit: tb.manualUnlock.limit })}</p>
          <button className="btn block" onClick={() => setUnlock(true)} disabled={!online || tb.manualUnlock.usedToday >= tb.manualUnlock.limit || tb.status === "disabled"}>
            <Icon name="unlock" /> {t("tables.manualSend")}
          </button>
        </section>

        <section className="card stack-sm">
          <h2>{t("tables.instructions")}</h2>
          <dl className="kv">
            <dt>{t("tables.paybill")}</dt>
            <dd className="num" style={{ fontSize: 20, fontWeight: 700 }}>{tb.paymentInstructions.paybill}</dd>
            <dt>{t("tables.account")}</dt>
            <dd className="num" style={{ fontSize: 20, fontWeight: 700 }}>{tb.paymentInstructions.account}</dd>
          </dl>
          {isOwner ? (
            <a
              className="btn sm"
              href={`/v1/m/tables/${tb.id}/sheet`}
              target="_blank"
              rel="noopener"
              onClick={async (e) => {
                // Refresh the session first, so the new tab opens signed in.
                e.preventDefault();
                const w = window.open("about:blank", "_blank");
                await call("/me").catch(() => {});
                if (w) w.location.href = `/v1/m/tables/${tb.id}/sheet`;
              }}
            >
              <Icon name="print" /> {t("tables.sheet")}
            </a>
          ) : null}
        </section>

        <div className="section-title">
          <h2>{t("tables.recent")}</h2>
        </div>
        {tb.recentPayments.length ? (
          <div className="list">{tb.recentPayments.map((p) => <PaymentItem key={p.id} p={p} />)}</div>
        ) : (
          <div className="card"><Empty icon="payments">{t("home.noPayments")}</Empty></div>
        )}

        <div className="section-title">
          <h2>{t("tables.overrides")}</h2>
        </div>
        <div className="card">
          {tb.overrideLog.length ? (
            <ul className="stack-sm" style={{ margin: 0, paddingLeft: 18 }}>
              {tb.overrideLog.map((o, i) => (
                <li key={i} className="small">{when(o.at)}</li>
              ))}
            </ul>
          ) : (
            <p className="muted small">{t("tables.noOverrides")}</p>
          )}
        </div>

        <button className="btn ghost block" onClick={() => setReport(true)}>
          {t("tables.report")}
        </button>
        <Stale savedAt={d.savedAt} stale={d.stale} />
      </div>

      <EditPrice open={edit} onClose={() => setEdit(false)} table={tb} onSaved={d.reload} />
      <EditHours open={hours} onClose={() => setHours(false)} table={tb} onSaved={d.reload} />
      <ManualUnlock open={unlock} onClose={() => setUnlock(false)} table={tb} onDone={d.reload} />
      <Sheet open={report} onClose={() => setReport(false)} title={t("tables.report")}>
        <NewDispute initial={{ kind: "table", tableId: tb.id }} onDone={() => setReport(false)} />
      </Sheet>
    </main>
  );
}

function summariseHours(h: Record<string, [string, string][]>) {
  const first = Object.values(h)[0]?.[0];
  const same = first && DAYS.every((d) => h[d]?.[0]?.[0] === first[0] && h[d]?.[0]?.[1] === first[1]);
  return same ? `${first[0]}–${first[1]}` : DAYS.filter((d) => h[d]?.length).map((d) => `${d.slice(0, 2)} ${h[d][0][0]}–${h[d][0][1]}`).join(", ");
}

function EditPrice({ open, onClose, table, onSaved }: { open: boolean; onClose: () => void; table: Detail; onSaved: () => void }) {
  const [price, setPrice] = useState(String(table.priceMinor / 100));
  const [secs, setSecs] = useState(table.unlockSeconds);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setPrice(String(table.priceMinor / 100));
      setSecs(table.unlockSeconds);
      setErr(null);
    }
  }, [open, table]);
  const b = table.bounds;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = parseKsh(price);
    if (p == null) return setErr(t("errors.generic"));
    setBusy(true);
    try {
      await call(`/tables/${table.id}`, { method: "PATCH", body: { priceMinor: p, unlockSeconds: secs } });
      toast(t("app.saved"));
      onSaved();
      onClose();
    } catch (x) {
      setErr(message(x, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title={t("tables.editPrice")}>
      <form className="stack" onSubmit={save}>
        <div className="field">
          <label htmlFor="price">{t("tables.price")} (KSh)</label>
          <input id="price" className="input big" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/[^\d]/g, ""))} />
          <span className="hint">{t("tables.limits", { min: ksh(b.priceMinMinor), max: ksh(b.priceMaxMinor) })}</span>
        </div>
        <div className="field">
          <label htmlFor="secs">{t("tables.unlock")}: {t("tables.seconds", { n: secs })}</label>
          <input id="secs" type="range" min={b.unlockMinS} max={b.unlockMaxS} value={secs} onChange={(e) => setSecs(Number(e.target.value))} />
          <span className="hint">{t("tables.limits", { min: t("tables.seconds", { n: b.unlockMinS }), max: t("tables.seconds", { n: b.unlockMaxS }) })}</span>
        </div>
        <p className="hint">{t("tables.priceNote")}</p>
        {err ? <ErrorBox text={err} /> : null}
        <button className="btn primary block" disabled={busy}>{t("app.save")}</button>
      </form>
    </Sheet>
  );
}

function EditHours({ open, onClose, table, onSaved }: { open: boolean; onClose: () => void; table: Detail; onSaved: () => void }) {
  const first = table.openingHours ? Object.values(table.openingHours)[0]?.[0] : null;
  const [from, setFrom] = useState(first?.[0] ?? "10:00");
  const [to, setTo] = useState(first?.[1] ?? "23:00");
  const [days, setDays] = useState<Set<string>>(new Set(table.openingHours ? Object.keys(table.openingHours) : DAYS));
  const [busy, setBusy] = useState(false);
  const save = async (clear = false) => {
    setBusy(true);
    try {
      const openingHours = clear ? null : Object.fromEntries([...days].map((d) => [d, [[from, to]]]));
      await call(`/tables/${table.id}/hours`, { method: "PUT", body: { openingHours } });
      toast(t("app.saved"));
      onSaved();
      onClose();
    } catch (x) {
      toast(message(x, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title={t("tables.hoursEdit")}>
      <div className="stack">
        <div className="row">
          <div className="field grow">
            <label htmlFor="from">{t("tables.hoursFrom")}</label>
            <input id="from" type="time" className="input" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field grow">
            <label htmlFor="to">{t("tables.hoursTo")}</label>
            <input id="to" type="time" className="input" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <div className="chips" role="group">
          {DAYS.map((d, i) => (
            <button key={d} type="button" className="chip" aria-pressed={days.has(d)} onClick={() => setDays((s) => { const n = new Set(s); n.has(d) ? n.delete(d) : n.add(d); return n; })}>
              {weekday(i + 1)}
            </button>
          ))}
        </div>
        <button className="btn primary block" disabled={busy || !days.size} onClick={() => void save()}>{t("app.save")}</button>
        {table.openingHours ? <button className="btn ghost block" disabled={busy} onClick={() => void save(true)}>{t("tables.hoursClear")}</button> : null}
      </div>
    </Sheet>
  );
}

function ManualUnlock({ open, onClose, table, onDone }: { open: boolean; onClose: () => void; table: Detail; onDone: () => void }) {
  const [reason, setReason] = useState(table.manualUnlock.reasons[0] ?? "");
  const [askPin, setAskPin] = useState(false);
  const [cmd, setCmd] = useState<string | null>(null);
  const [state, setState] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setCmd(null);
      setState(null);
    }
  }, [open]);
  useInterval(
    async () => {
      if (!cmd) return;
      const c = await call<{ status: string }>(`/tables/${table.id}/commands/${cmd}`).catch(() => null);
      if (c) setState(c.status);
      if (c && ["acked", "failed", "timeout", "rejected"].includes(c.status)) {
        setCmd(null);
        onDone();
      }
    },
    cmd ? 1500 : null,
  );
  return (
    <>
      <Sheet open={open && !askPin} onClose={onClose} title={t("tables.manual")}>
        <div className="stack">
          {state ? (
            <p className={`banner ${state === "acked" ? "info" : ["failed", "timeout", "rejected"].includes(state) ? "bad" : "wait"}`}>
              <Icon name={state === "acked" ? "check" : "clock"} />
              <span className="sub">{state === "acked" ? t("tables.manualAcked") : ["failed", "timeout", "rejected"].includes(state) ? t("tables.manualFailed") : t("tables.manualSent")}</span>
            </p>
          ) : (
            <>
              <p className="small muted">{t("tables.manualBody", { used: table.manualUnlock.usedToday, limit: table.manualUnlock.limit })}</p>
              <div className="field">
                <label htmlFor="reason">{t("tables.manualReason")}</label>
                <select id="reason" className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
                  {table.manualUnlock.reasons.map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </div>
              <button className="btn primary block" onClick={() => setAskPin(true)}>
                <Icon name="unlock" /> {t("tables.manualSend")}
              </button>
            </>
          )}
          {state ? <button className="btn block" onClick={onClose}>{t("app.done")}</button> : null}
        </div>
      </Sheet>
      <PinSheet
        open={askPin}
        onClose={() => setAskPin(false)}
        onPin={async (pin) => {
          const r = await call<{ cmdId: string }>(`/tables/${table.id}/unlock`, { method: "POST", body: { reason, pin } });
          setAskPin(false);
          setCmd(r.cmdId);
          setState("queued");
        }}
      />
    </>
  );
}
