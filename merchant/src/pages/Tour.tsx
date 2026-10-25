import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Icon } from "../components/Icon";
import { call } from "../lib/api";
import { t } from "../lib/i18n";
import { useLang } from "../lib/hooks";
import { useSession } from "../lib/session";

// First run: your tables, your money, how to withdraw. Owners then add their payout number.

const STEPS = [
  { icon: "table", title: "tour.t1Title", body: "tour.t1Body" },
  { icon: "money", title: "tour.t2Title", body: "tour.t2Body" },
  { icon: "download", title: "tour.t3Title", body: "tour.t3Body" },
];

export default function Tour() {
  useLang();
  const [i, setI] = useState(0);
  const nav = useNavigate();
  const { reload, me } = useSession();
  const finish = async () => {
    await call("/me/tour-done", { method: "POST" }).catch(() => {});
    const m = await reload();
    const owner = (m ?? me)?.user.role === "owner";
    nav(owner && !(m ?? me)?.payoutNumberVerified ? "/money/number?setup=1" : "/", { replace: true });
  };
  const s = STEPS[i];
  return (
    <main className="auth">
      <div className="tour">
        <span className="eyebrow">{t("tour.step", { n: i + 1 })}</span>
        <div className="art">
          <Icon name={s.icon} />
        </div>
        <h1>{t(s.title)}</h1>
        <p className="muted" style={{ maxWidth: 340 }}>
          {t(s.body)}
        </p>
        <div className="dots" aria-hidden="true">
          {STEPS.map((_, n) => (
            <i key={n} className={n === i ? "on" : ""} />
          ))}
        </div>
      </div>
      <div className="stack-sm">
        <button className="btn primary block" onClick={() => (i < STEPS.length - 1 ? setI(i + 1) : void finish())}>
          {i < STEPS.length - 1 ? t("app.next") : t("tour.start")}
        </button>
        {i < STEPS.length - 1 ? (
          <button className="btn ghost block" onClick={() => void finish()}>
            {t("tour.skip")}
          </button>
        ) : null}
      </div>
    </main>
  );
}
