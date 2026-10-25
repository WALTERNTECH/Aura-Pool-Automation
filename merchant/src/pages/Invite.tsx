import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Logo } from "../components/Icon";
import { PinPad } from "../components/PinPad";
import { ErrorBox, PageSkeleton } from "../components/ui";
import { call, message } from "../lib/api";
import { t } from "../lib/i18n";
import { useApi, useLang } from "../lib/hooks";
import { useSession } from "../lib/session";

// Onboarding from the SMS invite: choose a PIN (twice), confirm the phone with a code,
// accept the terms. Then the tour.

type Invite = { businessName: string; name: string; role: "owner" | "staff"; phoneMasked: string; pinSet: boolean };

export default function InvitePage() {
  useLang();
  const { token = "" } = useParams();
  const nav = useNavigate();
  const { reload } = useSession();
  const inv = useApi<Invite>(`/v1/auth/invite/${token}`);
  const [step, setStep] = useState<"pin" | "confirm" | "code">("pin");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [terms, setTerms] = useState(false);
  const [testCode, setTestCode] = useState<string | null>(null);

  if (inv.loading) return <main className="auth"><PageSkeleton /></main>;
  if (inv.error || !inv.data)
    return (
      <main className="auth">
        <div className="brand">
          <Logo /> Aura Pool
        </div>
        <p className="banner bad">{t("invite.expired")}</p>
      </main>
    );

  const sendCode = async (p: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await call<{ otp: { testCode?: string } }>("/v1/auth/otp/request", { method: "POST", body: { inviteToken: token, pin: p, pinConfirm: p }, auth: false });
      setTestCode(r.otp.testCode ?? null);
      setStep("code");
    } catch (e) {
      setError(message(e, t));
      setStep("pin");
      setPin("");
    } finally {
      setBusy(false);
    }
  };

  const finish = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await call("/v1/auth/otp/verify", { method: "POST", body: { inviteToken: token, code, acceptTerms: true }, auth: false });
      await reload();
      nav("/tour", { replace: true });
    } catch (err) {
      setError(message(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <div className="brand">
        <Logo /> Aura Pool
      </div>
      <div className="stack-sm">
        <h1>{t("invite.title")}</h1>
        <p className="muted">{t("invite.intro", { business: inv.data.businessName })}</p>
      </div>

      {step !== "code" ? (
        <div className="card">
          <p className="center label">{step === "pin" ? t("invite.pinTitle") : t("invite.pinConfirm")}</p>
          <PinPad
            key={step}
            busy={busy}
            error={error}
            onDone={(p) => {
              if (step === "pin") {
                setPin(p);
                setError(null);
                setStep("confirm");
              } else if (p !== pin) {
                setError(t("invite.mismatch"));
                setStep("pin");
                setPin("");
              } else void sendCode(p);
            }}
          />
          <p className="hint center" style={{ marginTop: 12 }}>
            {t("invite.pinHint")}
          </p>
        </div>
      ) : (
        <form className="card stack" onSubmit={finish}>
          <h2>{t("invite.codeTitle")}</h2>
          <p className="muted small">{t("invite.codeBody", { phone: inv.data.phoneMasked })}</p>
          {testCode ? <p className="test-code">{t("invite.testCode", { code: testCode })}</p> : null}
          <div className="field">
            <label htmlFor="code">{t("invite.code")}</label>
            <input id="code" className="input code-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} autoFocus />
          </div>
          <label className="check">
            <input type="checkbox" aria-label={t("invite.terms")} checked={terms} onChange={(e) => setTerms(e.target.checked)} />
            <span>
              {t("invite.terms")}.{" "}
              <Link className="link" to="/legal/terms" target="_blank">
                {t("invite.readTerms")}
              </Link>{" "}
              ·{" "}
              <Link className="link" to="/legal/privacy" target="_blank">
                {t("invite.readPrivacy")}
              </Link>
            </span>
          </label>
          {error ? <ErrorBox text={error} /> : null}
          <button className="btn primary block" disabled={busy || code.length !== 6 || !terms}>
            {t("invite.finish")}
          </button>
          <button type="button" className="link" disabled={busy} onClick={() => void sendCode(pin)}>
            {t("invite.resend")}
          </button>
        </form>
      )}
    </main>
  );
}
