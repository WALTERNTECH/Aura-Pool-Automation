import { useEffect, useState } from "react";
import { PinSheet } from "../components/PinPad";
import { ErrorBox, PageSkeleton, Toggle, TopBar, toast } from "../components/ui";
import { call } from "../lib/api";
import { ksh, parseKsh, upcoming, when } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useLang, useOnline } from "../lib/hooks";

type Auto = { enabled: boolean; time: string; minMinor: number; platformMinMinor: number; presets: string[]; nextRunAt: string | null; lastRun: null | { at: string; outcome: string; amountMinor?: number; note?: string } };

export default function AutoWithdraw() {
  useLang();
  const online = useOnline();
  const d = useApi<Auto>("/auto-withdraw");
  const [enabled, setEnabled] = useState(false);
  const [time, setTime] = useState("22:00");
  const [min, setMin] = useState("");
  const [askPin, setAskPin] = useState(false);
  useEffect(() => {
    if (d.data) {
      setEnabled(d.data.enabled);
      setTime(d.data.time);
      setMin(String(d.data.minMinor / 100));
    }
  }, [d.data]);
  if (d.loading) return <main className="page"><PageSkeleton /></main>;
  if (!d.data) return <main className="page"><TopBar title={t("auto.title")} back="/money" />{d.error ? <ErrorBox error={d.error} retry={d.reload} /> : null}</main>;
  const a = d.data;
  const changed = enabled !== a.enabled || time !== a.time || parseKsh(min) !== a.minMinor;
  const minMinor = parseKsh(min) ?? 0;
  return (
    <main className="page">
      <TopBar title={t("auto.title")} back="/money" />
      <div className="stack">
        <p className="muted">{t("auto.body")}</p>
        <section className="card stack">
          <div className="spread">
            <h3>{t("auto.on")}</h3>
            <Toggle checked={enabled} onChange={setEnabled} label={t("auto.on")} />
          </div>
          <div className="field">
            <label htmlFor="time">{t("auto.time")}</label>
            <input id="time" type="time" className="input" value={time} onChange={(e) => setTime(e.target.value)} disabled={!enabled} />
          </div>
          <div className="chips" role="group" aria-label={t("auto.presets")}>
            {[
              ["20:00", t("auto.p20")],
              ["22:00", t("auto.p22")],
              ["00:00", t("auto.p00")],
            ].map(([v, l]) => (
              <button key={v} type="button" className="chip" aria-pressed={time === v} onClick={() => setTime(v)} disabled={!enabled}>
                {l}
              </button>
            ))}
          </div>
          <div className="field">
            <label htmlFor="min">{t("auto.min")}</label>
            <input id="min" className="input" inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value.replace(/[^\d]/g, ""))} disabled={!enabled} />
            <span className="hint">{t("auto.minHint", { min: ksh(a.platformMinMinor) })}</span>
          </div>
          {a.enabled && a.nextRunAt ? <p className="small">{t("auto.next", { when: upcoming(a.nextRunAt) })}</p> : null}
          {a.lastRun ? (
            <p className="small muted">
              {t("auto.last", { when: when(a.lastRun.at), outcome: t(`auto.outcome_${a.lastRun.outcome}`, { amount: ksh(a.lastRun.amountMinor ?? 0) }) })}
            </p>
          ) : null}
          <p className="hint">{t("auto.retries")}</p>
        </section>
        <button className="btn primary block" disabled={!changed || !online || (enabled && minMinor < a.platformMinMinor)} onClick={() => setAskPin(true)}>
          {t("auto.save")}
        </button>
      </div>
      <PinSheet
        open={askPin}
        onClose={() => setAskPin(false)}
        onPin={async (pin) => {
          await call("/auto-withdraw", { method: "PUT", body: { enabled, time, minMinor: Math.max(minMinor, a.platformMinMinor), pin } });
          setAskPin(false);
          toast(t("app.saved"));
          void d.reload();
        }}
      />
    </main>
  );
}
