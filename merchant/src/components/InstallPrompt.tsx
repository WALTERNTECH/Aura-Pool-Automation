import { useEffect, useState } from "react";
import { canPrompt, isIos, isStandalone, onInstallChange, promptInstall, snooze, snoozed } from "../lib/install";
import { t } from "../lib/i18n";
import { Icon, Logo } from "./Icon";
import { Sheet } from "./ui";

// Shown when the app is opened in a browser rather than from the home screen: an Install
// button where the browser offers one (Android Chrome, Edge), or the steps for iPhone Safari.
// "Not now" hides it for three days.

export function InstallPrompt() {
  const [open, setOpen] = useState(false);
  const [, force] = useState(0);
  useEffect(() => onInstallChange(() => force((n) => n + 1)), []);
  useEffect(() => {
    if (isStandalone() || snoozed()) return;
    // Give the page a moment to settle, and the browser time to fire beforeinstallprompt.
    const id = setTimeout(() => {
      if (!isStandalone() && (canPrompt() || isIos())) setOpen(true);
    }, 1800);
    const late = onInstallChange(() => {
      if (!isStandalone() && canPrompt() && !snoozed()) setOpen(true);
    });
    return () => {
      clearTimeout(id);
      late();
    };
  }, []);
  const close = () => {
    snooze();
    setOpen(false);
  };
  const ios = isIos() && !canPrompt();
  return (
    <Sheet open={open} onClose={close} label={ios ? t("install.iosTitle") : t("install.title")}>
      <div className="stack">
        <div className="row">
          <Logo size={48} />
          <div className="grow">
            <h2 style={{ marginBottom: 2 }}>{ios ? t("install.iosTitle") : t("install.title")}</h2>
          </div>
        </div>
        <p className="muted">{t("install.body")}</p>
        {ios ? (
          <ol className="stack-sm" style={{ margin: 0, paddingLeft: 20 }}>
            <li>
              {t("install.iosStep1")} <Icon name="share" className="faint" />
            </li>
            <li>{t("install.iosStep2")}</li>
            <li>{t("install.iosStep3")}</li>
          </ol>
        ) : null}
        <div className="stack-sm">
          {!ios ? (
            <button
              className="btn primary block"
              onClick={async () => {
                const ok = await promptInstall();
                if (ok) setOpen(false);
                else close();
              }}
            >
              <Icon name="install" /> {t("install.action")}
            </button>
          ) : null}
          <button className="btn block" onClick={close}>
            {ios ? t("app.close") : t("install.later")}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/** For Settings: the right instructions for this phone. */
export function InstallHelp() {
  const [, force] = useState(0);
  useEffect(() => onInstallChange(() => force((n) => n + 1)), []);
  if (isStandalone()) return <p className="muted small">{t("install.installed")}</p>;
  if (canPrompt())
    return (
      <button className="btn sm" onClick={() => void promptInstall()}>
        <Icon name="install" /> {t("install.action")}
      </button>
    );
  if (isIos())
    return (
      <ol className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
        <li>{t("install.iosStep1")}</li>
        <li>{t("install.iosStep2")}</li>
        <li>{t("install.iosStep3")}</li>
      </ol>
    );
  return <p className="muted small">{t("install.androidSteps")}</p>;
}
