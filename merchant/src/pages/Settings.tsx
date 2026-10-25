import { browserSupportsWebAuthn, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useState } from "react";
import { InstallHelp } from "../components/InstallPrompt";
import { Icon } from "../components/Icon";
import { PinPad } from "../components/PinPad";
import { ErrorBox, Segmented, Sheet, Toggle, TopBar, toast } from "../components/ui";
import { call, message } from "../lib/api";
import { when } from "../lib/format";
import { setLang, t } from "../lib/i18n";
import { useApi, useLang } from "../lib/hooks";
import { currentSubscription, disablePush, enablePush, pushSupported } from "../lib/push";
import { useSession } from "../lib/session";
import { applyTheme } from "../lib/theme";
import { bioKey } from "./Login";

export default function Settings() {
  const lang = useLang();
  const { me, reload } = useSession();
  const [pushOn, setPushOn] = useState(false);
  const [pushNote, setPushNote] = useState<string | null>(null);
  const [pinOpen, setPinOpen] = useState(false);
  const sessions = useApi<{ sessions: { id: string; device: string; lastUsedAt: string; current: boolean }[] }>("/me/sessions");
  const creds = useApi<{ credentials: { id: string; device_label: string; created_at: string }[] }>("/me/webauthn");

  useEffect(() => {
    currentSubscription().then((s) => setPushOn(Boolean(s))).catch(() => {});
  }, []);
  if (!me) return null;
  const prefs = me.prefs;
  const save = async (patch: Record<string, unknown>) => {
    try {
      await call("/me/prefs", { method: "PATCH", body: patch });
      await reload();
    } catch (e) {
      toast(message(e, t));
    }
  };
  const quiet = prefs.quietHours ?? { on: false, from: "22:00", to: "07:00" };

  return (
    <main className="page">
      <TopBar title={t("settings.title")} back="/more" />
      <div className="stack">
        <section className="card stack-sm">
          <h2>{t("settings.profile")}</h2>
          <dl className="kv">
            <dt>{t("settings.profile")}</dt>
            <dd>{me.merchant.businessName}</dd>
            <dt>{t("settings.owner")}</dt>
            <dd>{me.merchant.ownerName}</dd>
            <dt>{t("settings.phone")}</dt>
            <dd>{me.user.phoneMasked}</dd>
            {me.merchant.location ? (
              <>
                <dt>Location</dt>
                <dd>{me.merchant.location}</dd>
              </>
            ) : null}
          </dl>
          <p className="hint">{t("settings.profileNote")}</p>
        </section>

        <section className="card stack-sm">
          <h2>{t("settings.language")}</h2>
          <Segmented
            label={t("settings.language")}
            value={lang}
            onChange={(l) => {
              setLang(l);
              void save({ language: l });
            }}
            options={[
              { value: "en", label: t("settings.english") },
              { value: "sw", label: t("settings.swahili") },
            ]}
          />
          <h2 style={{ marginTop: 10 }}>{t("settings.theme")}</h2>
          <Segmented
            label={t("settings.theme")}
            value={prefs.theme ?? "light"}
            onChange={(v) => {
              applyTheme(v);
              void save({ theme: v });
            }}
            options={[
              { value: "light", label: t("settings.themeLight") },
              { value: "system", label: t("settings.themeSystem") },
              { value: "dark", label: t("settings.themeDark") },
            ]}
          />
        </section>

        <section className="card stack">
          <h2>{t("settings.notifications")}</h2>
          <div className="spread">
            <span>{t("settings.pushThis")}</span>
            <Toggle
              checked={pushOn}
              label={t("settings.pushThis")}
              disabled={!pushSupported() || !me.push.vapidPublicKey}
              onChange={async (v) => {
                setPushNote(null);
                if (!v) {
                  await disablePush();
                  setPushOn(false);
                  return;
                }
                const r = await enablePush(me.push.vapidPublicKey!).catch(() => "unsupported" as const);
                setPushOn(r === "on");
                if (r === "denied") setPushNote(t("settings.pushBlocked"));
                if (r === "unsupported") setPushNote(t("settings.pushUnavailable"));
              }}
            />
          </div>
          {!pushSupported() || !me.push.vapidPublicKey ? <p className="hint">{t("settings.pushUnavailable")}</p> : null}
          {pushNote ? <p className="hint">{pushNote}</p> : null}
          <h3>{t("settings.perType")}</h3>
          <div className="stack-sm">
            {me.notificationTypes.map((nt) => {
              const on = prefs.notifications?.[nt.type]?.push ?? nt.type !== "payment_received";
              return (
                <div className="spread" key={nt.type}>
                  <span className="grow">
                    {nt.label}
                    {nt.critical ? <span className="tiny muted" style={{ display: "block" }}>{t("settings.critical")}</span> : null}
                  </span>
                  <Toggle checked={on} label={nt.label} onChange={(v) => void save({ notifications: { ...(prefs.notifications ?? {}), [nt.type]: { push: v } } })} />
                </div>
              );
            })}
          </div>
          <div className="spread">
            <div className="grow">
              <h3>{t("settings.quiet")}</h3>
              <p className="hint">{t("settings.quietBody")}</p>
            </div>
            <Toggle checked={quiet.on} label={t("settings.quiet")} onChange={(v) => void save({ quietHours: { ...quiet, on: v } })} />
          </div>
          {quiet.on ? (
            <div className="row">
              <input type="time" className="input grow" value={quiet.from} onChange={(e) => void save({ quietHours: { ...quiet, from: e.target.value } })} aria-label="From" />
              <input type="time" className="input grow" value={quiet.to} onChange={(e) => void save({ quietHours: { ...quiet, to: e.target.value } })} aria-label="To" />
            </div>
          ) : null}
        </section>

        <section className="card stack">
          <h2>{t("settings.security")}</h2>
          <Biometrics creds={creds.data?.credentials ?? []} onChange={creds.reload} />
          <button className="btn block" onClick={() => setPinOpen(true)}>
            <Icon name="lock" /> {t("settings.changePin")}
          </button>
          <h3>{t("settings.devices")}</h3>
          <div className="stack-sm">
            {sessions.data?.sessions.map((s) => (
              <div className="spread" key={s.id}>
                <span className="grow">
                  {s.device}
                  <span className="tiny muted" style={{ display: "block" }}>{s.current ? t("settings.thisDevice") : when(s.lastUsedAt)}</span>
                </span>
                {!s.current ? (
                  <button className="btn sm" onClick={async () => { await call(`/me/sessions/${s.id}`, { method: "DELETE" }); void sessions.reload(); }}>
                    {t("settings.signOutDevice")}
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        <section className="card stack-sm">
          <h2>{t("settings.install")}</h2>
          <InstallHelp />
        </section>
      </div>
      <ChangePin open={pinOpen} onClose={() => setPinOpen(false)} />
    </main>
  );
}

function Biometrics({ creds, onChange }: { creds: { id: string; device_label: string; created_at: string }[]; onChange: () => void }) {
  const { me } = useSession();
  const [err, setErr] = useState<string | null>(null);
  if (!browserSupportsWebAuthn()) return <p className="hint">{t("settings.biometricUnsupported")}</p>;
  let here = false;
  try {
    here = Boolean(localStorage.getItem(bioKey(localStorage.getItem("aura:last-phone") ?? "")));
  } catch {
    here = false;
  }
  return (
    <div className="stack-sm">
      {here ? <p className="small"><Icon name="finger" className="faint" /> {t("settings.biometricOn")}</p> : null}
      {!here ? (
        <button
          className="btn block"
          onClick={async () => {
            setErr(null);
            try {
              const optionsJSON = await call<Parameters<typeof startRegistration>[0]["optionsJSON"]>("/me/webauthn/options", { method: "POST" });
              const response = await startRegistration({ optionsJSON });
              const label = /iphone/i.test(navigator.userAgent) ? "iPhone" : /android/i.test(navigator.userAgent) ? "Android phone" : "This device";
              await call("/me/webauthn", { method: "POST", body: { response, label } });
              const phone = localStorage.getItem("aura:last-phone") ?? me?.user.phoneMasked ?? "";
              localStorage.setItem(bioKey(phone), "1");
              toast(t("settings.biometricOn"));
              onChange();
            } catch (e) {
              if ((e as Error).name !== "NotAllowedError") setErr(message(e, t));
            }
          }}
        >
          <Icon name="finger" /> {t("settings.biometricSet")}
        </button>
      ) : null}
      {creds.length ? <p className="tiny muted">{creds.map((c) => c.device_label).join(", ")}</p> : null}
      {err ? <ErrorBox text={err} /> : null}
    </div>
  );
}

function ChangePin({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState<"current" | "new" | "confirm">("current");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setStep("current");
      setErr(null);
    }
  }, [open]);
  return (
    <Sheet open={open} onClose={onClose} title={t("settings.changePin")}>
      <p className="center label">{step === "current" ? t("settings.currentPin") : step === "new" ? t("settings.newPin") : t("invite.pinConfirm")}</p>
      <PinPad
        key={step}
        busy={busy}
        error={err}
        onDone={async (p) => {
          setErr(null);
          if (step === "current") {
            setCurrent(p);
            setStep("new");
          } else if (step === "new") {
            setNext(p);
            setStep("confirm");
          } else if (p !== next) {
            setErr(t("invite.mismatch"));
            setStep("new");
          } else {
            setBusy(true);
            try {
              await call("/me/pin", { method: "POST", body: { currentPin: current, newPin: p } });
              toast(t("settings.pinChanged"));
              onClose();
            } catch (e) {
              setErr(message(e, t));
              setStep("current");
            } finally {
              setBusy(false);
            }
          }
        }}
      />
    </Sheet>
  );
}
