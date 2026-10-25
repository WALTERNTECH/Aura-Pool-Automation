import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Icon } from "../components/Icon";
import { PinSheet } from "../components/PinPad";
import { ErrorBox, PageSkeleton, TopBar, toast } from "../components/ui";
import { call, message } from "../lib/api";
import { prettyPhone, upcoming } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useLang, useOnline } from "../lib/hooks";
import { useSession } from "../lib/session";

type Num = { verified: boolean; masked: string | null; suggestedMasked: string | null; holdUntil: string | null; change: null | { id: string; kind: string; status: string; newMasked: string; oldMasked: string | null; needsOldCode: boolean; holdUntil: string | null }; coolingHours: number };
type Started = { changeId: string; kind: "first" | "change"; newMasked: string; oldMasked: string | null; otpNew: { testCode?: string }; otpOld: { testCode?: string } | null };

export default function PayoutNumber() {
  useLang();
  const [sp] = useSearchParams();
  const setup = sp.get("setup") === "1";
  const nav = useNavigate();
  const online = useOnline();
  const { reload } = useSession();
  const d = useApi<Num>("/payout-number");
  const [mode, setMode] = useState<"view" | "enter" | "codes">("view");
  const [msisdn, setMsisdn] = useState("");
  const [useSuggested, setUseSuggested] = useState(false);
  const [oldGone, setOldGone] = useState(false);
  const [askPin, setAskPin] = useState(false);
  const [started, setStarted] = useState<Started | null>(null);
  const [codeNew, setCodeNew] = useState("");
  const [codeOld, setCodeOld] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (d.loading) return <main className="page"><PageSkeleton /></main>;
  if (!d.data) return <main className="page"><TopBar title={t("number.title")} back="/money" />{d.error ? <ErrorBox error={d.error} retry={d.reload} /> : null}</main>;
  const n = d.data;

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!started) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await call<{ kind: string; holdUntil: string | null }>("/payout-number/verify", { method: "POST", body: { changeId: started.changeId, codeNew, codeOld: started.oldMasked ? codeOld : undefined } });
      toast(r.kind === "first" ? t("number.firstDone") : t("number.changeDone", { when: upcoming(r.holdUntil) }));
      await reload();
      if (setup) nav("/", { replace: true });
      else {
        setMode("view");
        setStarted(null);
        void d.reload();
      }
    } catch (x) {
      setErr(message(x, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page">
      <TopBar title={setup ? t("number.setupTitle") : t("number.title")} back={setup ? undefined : "/money"} />
      <div className="stack">
        {setup ? <p className="muted">{t("number.setupBody")}</p> : null}
        {n.holdUntil ? <p className="banner info"><Icon name="shield" /><span className="sub">{t("number.cooling", { when: upcoming(n.holdUntil) })}</span></p> : null}

        {mode === "view" ? (
          <section className="card stack">
            <p>{n.verified && n.masked ? t("number.current", { number: n.masked }) : t("number.none")}</p>
            {!n.verified && n.suggestedMasked ? (
              <button
                className="btn primary block"
                disabled={!online}
                onClick={() => {
                  setUseSuggested(true);
                  setAskPin(true);
                }}
              >
                {t("number.use", { number: n.suggestedMasked })}
              </button>
            ) : null}
            <button className={`btn block${!n.verified && !n.suggestedMasked ? " primary" : ""}`} disabled={!online} onClick={() => setMode("enter")}>
              {n.verified ? t("number.change") : t("number.add")}
            </button>
            {setup ? <button className="btn ghost block" onClick={() => nav("/", { replace: true })}>{t("tour.skip")}</button> : null}
          </section>
        ) : null}

        {mode === "enter" ? (
          <form
            className="card stack"
            onSubmit={(e) => {
              e.preventDefault();
              setUseSuggested(false);
              setAskPin(true);
            }}
          >
            <div className="field">
              <label htmlFor="msisdn">{t("number.newNumber")}</label>
              <input id="msisdn" className="input" type="tel" inputMode="tel" value={msisdn} onChange={(e) => setMsisdn(prettyPhone(e.target.value))} autoFocus />
            </div>
            {n.verified ? (
              <label className="check">
                <input type="checkbox" checked={oldGone} onChange={(e) => setOldGone(e.target.checked)} />
                <span>{t("number.oldGone")}</span>
              </label>
            ) : null}
            <button className="btn primary block" disabled={msisdn.replace(/\D/g, "").length < 9 || !online}>{t("app.continue")}</button>
            <button type="button" className="btn ghost block" onClick={() => setMode("view")}>{t("app.cancel")}</button>
          </form>
        ) : null}

        {mode === "codes" && started ? (
          <form className="card stack" onSubmit={verify}>
            <div className="field">
              <label htmlFor="cn">{t("number.codeNew", { number: started.newMasked })}</label>
              {started.otpNew.testCode ? <p className="test-code">{t("invite.testCode", { code: started.otpNew.testCode })}</p> : null}
              <input id="cn" className="input code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={codeNew} onChange={(e) => setCodeNew(e.target.value.replace(/\D/g, ""))} autoFocus />
            </div>
            {started.oldMasked ? (
              <div className="field">
                <label htmlFor="co">{t("number.codeOld", { number: started.oldMasked })}</label>
                {started.otpOld?.testCode ? <p className="test-code">{t("invite.testCode", { code: started.otpOld.testCode })}</p> : null}
                <input id="co" className="input code-input" inputMode="numeric" maxLength={6} value={codeOld} onChange={(e) => setCodeOld(e.target.value.replace(/\D/g, ""))} />
              </div>
            ) : null}
            {started.kind === "change" ? <p className="hint">{t("number.cooling", { when: t("time.tomorrow") })}</p> : null}
            {err ? <ErrorBox text={err} /> : null}
            <button className="btn primary block" disabled={busy || codeNew.length !== 6 || (Boolean(started.oldMasked) && codeOld.length !== 6)}>{t("number.verify")}</button>
          </form>
        ) : null}
      </div>
      <PinSheet
        open={askPin}
        onClose={() => setAskPin(false)}
        onPin={async (pin) => {
          const r = await call<Started>("/payout-number", { method: "POST", body: useSuggested ? { useSuggested: true, pin } : { msisdn, pin, oldNumberUnavailable: oldGone } });
          setAskPin(false);
          setStarted(r);
          setCodeNew("");
          setCodeOld("");
          setMode("codes");
        }}
      />
    </main>
  );
}
