import { startAuthentication, browserSupportsWebAuthn } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Icon, Logo } from "../components/Icon";
import { PinPad } from "../components/PinPad";
import { call, message } from "../lib/api";
import { prettyPhone } from "../lib/format";
import { t } from "../lib/i18n";
import { useLang } from "../lib/hooks";
import { useSession } from "../lib/session";

const LAST = "aura:last-phone";
export const bioKey = (phone: string) => `aura:bio:${phone.replace(/\D/g, "").replace(/^254/, "0")}`;

export default function Login() {
  useLang();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const { reload, me } = useSession();
  const [phone, setPhone] = useState(() => {
    try {
      return localStorage.getItem(LAST) ?? "";
    } catch {
      return "";
    }
  });
  const [step, setStep] = useState<"phone" | "pin">(phone ? "pin" : "phone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasBio = (() => {
    try {
      return browserSupportsWebAuthn() && Boolean(phone && localStorage.getItem(bioKey(phone)));
    } catch {
      return false;
    }
  })();

  useEffect(() => {
    if (me) nav(loc.state?.from ?? "/", { replace: true });
  }, [me, nav, loc.state]);

  const done = async () => {
    try {
      localStorage.setItem(LAST, phone);
    } catch {
      /* ignore */
    }
    await reload();
    nav(loc.state?.from ?? "/", { replace: true });
  };

  const withPin = async (pin: string) => {
    setBusy(true);
    setError(null);
    try {
      await call("/v1/auth/login", { method: "POST", body: { phone, pin }, auth: false });
      await done();
    } catch (e) {
      setError(message(e, t));
    } finally {
      setBusy(false);
    }
  };

  const withBio = async () => {
    setBusy(true);
    setError(null);
    try {
      const optionsJSON = await call<Parameters<typeof startAuthentication>[0]["optionsJSON"]>("/v1/auth/webauthn/options", { method: "POST", body: { phone }, auth: false });
      const response = await startAuthentication({ optionsJSON });
      await call("/v1/auth/webauthn/verify", { method: "POST", body: { phone, response }, auth: false });
      await done();
    } catch (e) {
      setError((e as Error).name === "NotAllowedError" ? null : message(e, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <div className="brand">
        <Logo /> Aura Pool
      </div>
      <h1>{t("login.title")}</h1>
      {step === "phone" ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (phone.replace(/\D/g, "").length >= 9) setStep("pin");
          }}
        >
          <div className="field">
            <label htmlFor="phone">{t("login.phone")}</label>
            <input id="phone" className="input" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(prettyPhone(e.target.value))} required />
          </div>
          <button className="btn primary block" disabled={phone.replace(/\D/g, "").length < 9}>
            {t("app.continue")}
          </button>
          <p className="hint">{t("login.noInvite")}</p>
        </form>
      ) : (
        <div className="stack">
          <div className="spread">
            <span className="muted">{phone}</span>
            <button className="link" onClick={() => setStep("phone")}>
              {t("app.back")}
            </button>
          </div>
          <div className="card">
            <p className="center label">{t("login.pin")}</p>
            <PinPad busy={busy} error={error} onDone={withPin} />
          </div>
          {hasBio ? (
            <button className="btn block" onClick={withBio} disabled={busy}>
              <Icon name="finger" /> {t("login.biometric")}
            </button>
          ) : null}
          <p className="hint center">{t("login.forgot")}</p>
        </div>
      )}
    </main>
  );
}
