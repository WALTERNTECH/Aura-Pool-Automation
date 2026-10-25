import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Icon } from "../components/Icon";
import { PinSheet } from "../components/PinPad";
import { ErrorBox, PageSkeleton, TopBar } from "../components/ui";
import { call, newKey } from "../lib/api";
import { ksh, parseKsh, upcoming, when } from "../lib/format";
import { t } from "../lib/i18n";
import { useApi, useInterval, useLang, useOnline } from "../lib/hooks";

// Withdraw: amount (full balance by default) → fee and what arrives, to the masked number →
// PIN → live status. The idempotency key is made once when the screen opens, so tapping
// twice can never create two withdrawals.

type Quote = {
  availableMinor: number;
  grossMinor: number;
  feeMinor: number;
  netMinor: number;
  feeBorneBy: "merchant" | "platform";
  destinationMasked: string | null;
  minMinor: number;
  dailyRemainingMinor: number;
  needsApproval: boolean;
  approvalReason: string | null;
  heldUntil: string | null;
  killSwitch: { on: boolean };
  blockers: { code: string; message: string }[];
};
type Payout = { id: string; ref: string; amountMinor: number; feeMinor: number; receivedMinor: number; destination: string; stage: { code: string }; note: string | null; receipt: string | null; steps: { step: string; done: boolean; at: string | null }[] };

export default function Withdraw() {
  useLang();
  const online = useOnline();
  const nav = useNavigate();
  const base = useApi<Quote>("/payouts/quote");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<Quote | null>(null);
  const [askPin, setAskPin] = useState(false);
  const [payout, setPayout] = useState<Payout | null>(null);
  const key = useMemo(() => newKey(), []);

  useEffect(() => {
    if (base.data && !amount) {
      setAmount(String(Math.floor(base.data.availableMinor / 100)));
      setQuote(base.data);
    }
  }, [base.data, amount]);

  // Re-price as the amount changes (fee bands), debounced.
  useEffect(() => {
    const minor = parseKsh(amount);
    if (minor == null || !minor) return;
    const id = setTimeout(() => {
      call<Quote>(`/payouts/quote?amountMinor=${minor}`).then(setQuote).catch(() => {});
    }, 250);
    return () => clearTimeout(id);
  }, [amount]);

  useInterval(
    async () => {
      if (!payout) return;
      const p = await call<Payout>(`/payouts/${payout.id}`).catch(() => null);
      if (p) setPayout(p);
    },
    payout && !["received", "failed", "rejected", "cancelled"].includes(payout.stage.code) ? 2500 : null,
  );

  if (base.loading) return <main className="page"><PageSkeleton /></main>;
  if (!base.data) return <main className="page"><TopBar title={t("withdraw.title")} back="/money" />{base.error ? <ErrorBox error={base.error} retry={base.reload} /> : null}</main>;

  if (payout) return <PayoutStatus p={payout} onBack={() => nav("/money")} />;

  const q = quote ?? base.data;
  const minor = parseKsh(amount) ?? 0;
  const blockers = q.blockers.filter((b) => b.code !== "under_minimum" || minor > 0);
  const noNumber = !q.destinationMasked;

  return (
    <main className="page">
      <TopBar title={t("withdraw.title")} back="/money" />
      <div className="stack">
        {!online ? <p className="banner wait"><Icon name="wifiOff" /><span className="sub">{t("withdraw.offline")}</span></p> : null}
        {noNumber ? (
          <Link to="/money/number" className="banner wait"><Icon name="phone" /><b className="grow">{t("withdraw.noNumber")}</b><Icon name="right" /></Link>
        ) : null}
        <section className="card stack">
          <div className="field">
            <label htmlFor="amt">{t("withdraw.amount")}</label>
            <div className="row">
              <span className="muted" style={{ fontSize: 22, fontWeight: 700 }}>KSh</span>
              <input id="amt" className="input big grow" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))} />
            </div>
            <div className="spread">
              <span className="hint">{t("withdraw.limits", { min: ksh(q.minMinor), left: ksh(q.dailyRemainingMinor) })}</span>
              <button type="button" className="link small" onClick={() => setAmount(String(Math.floor(q.availableMinor / 100)))}>{t("withdraw.all")}</button>
            </div>
          </div>
          <dl className="kv">
            <dt>{t("withdraw.fee")}</dt>
            <dd>{q.feeBorneBy === "platform" ? t("withdraw.feePlatform") : ksh(q.feeMinor)}</dd>
            <dt className="total">{t("withdraw.receive")}</dt>
            <dd className="total" style={{ fontSize: 18 }}>{ksh(q.netMinor)}</dd>
            <dt>{t("withdraw.to")}</dt>
            <dd>{q.destinationMasked ?? "—"}</dd>
          </dl>
        </section>
        {q.needsApproval && q.approvalReason ? <p className="banner info"><Icon name="shield" /><span className="sub">{t("withdraw.approval", { reason: q.approvalReason })}</span></p> : null}
        {q.killSwitch.on ? <p className="banner info"><Icon name="clock" /><span className="sub">{t("withdraw.paused")}</span></p> : null}
        {q.heldUntil ? <p className="banner info"><Icon name="clock" /><span className="sub">{t("withdraw.held", { when: upcoming(q.heldUntil) })}</span></p> : null}
        {blockers.map((b) => <ErrorBox key={b.code} text={b.message} />)}
        <button className="btn primary block" disabled={!online || noNumber || blockers.length > 0 || !minor} onClick={() => setAskPin(true)}>
          <Icon name="lock" /> {t("withdraw.confirm")}
        </button>
      </div>
      <PinSheet
        open={askPin}
        onClose={() => setAskPin(false)}
        title={t("withdraw.enterPin")}
        onPin={async (pin) => {
          const p = await call<Payout>("/payouts", { method: "POST", body: { amountMinor: minor, pin }, idem: key });
          setAskPin(false);
          setPayout(p);
        }}
      />
    </main>
  );
}

function PayoutStatus({ p, onBack }: { p: Payout; onBack: () => void }) {
  const code = p.stage.code;
  const failed = ["failed", "rejected"].includes(code);
  const title = code === "received" ? t("withdraw.receivedTitle", { amount: ksh(p.receivedMinor) }) : failed ? t("withdraw.failedTitle") : t("withdraw.doneTitle", { amount: ksh(p.receivedMinor) });
  return (
    <main className="page">
      <TopBar title={t("withdraw.title")} back="/money" />
      <div className="stack">
        <section className="card stack">
          <div className="center stack-sm">
            <div className="tour" style={{ gap: 10 }}>
              <div className="art" style={{ width: 84, height: 84, borderRadius: 24, color: failed ? "var(--bad)" : code === "received" ? "var(--ok)" : "var(--wait)" }}>
                <Icon name={failed ? "x" : code === "received" ? "check" : "clock"} />
              </div>
            </div>
            <h2 style={{ fontSize: 20 }}>{title}</h2>
            <p className="muted small">{p.ref} · {p.destination}</p>
          </div>
          <div className="timeline">
            {p.steps.map((s) => (
              <div key={s.step} className={`t${s.done ? (s.step === "failed" ? " fail" : " done") : ""}`}>
                <span className="mark"><Icon name={s.done ? (s.step === "failed" ? "x" : "check") : "clock"} /></span>
                <span>{t(`withdraw.${s.step}`)}</span>
                <span className="small muted">{s.at ? when(s.at) : ""}</span>
              </div>
            ))}
          </div>
          {["needs_approval", "queued", "held"].includes(code) ? <p className="banner info"><Icon name="info" /><span className="sub">{t(`stage.${code}`)}{p.note ? `: ${p.note}` : ""}</span></p> : null}
          {failed && p.note ? <p className="banner bad"><Icon name="alert" /><span className="sub">{p.note}</span></p> : null}
          {p.receipt ? <p className="small muted center">{t("history.receipt", { code: p.receipt })}</p> : null}
          {!failed && code !== "received" ? <p className="hint center">{t("withdraw.waiting")}</p> : null}
        </section>
        <button className="btn block" onClick={onBack}>{t("withdraw.backToMoney")}</button>
      </div>
    </main>
  );
}
