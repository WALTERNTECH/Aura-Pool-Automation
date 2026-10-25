import { Link } from "react-router-dom";
import { TopBar } from "../components/ui";
import { t } from "../lib/i18n";
import { useLang } from "../lib/hooks";

export default function Help() {
  useLang();
  const qs = [1, 2, 3, 4, 5, 6];
  return (
    <main className="page">
      <TopBar title={t("help.title")} back="/more" />
      <div className="stack">
        <section className="card" style={{ paddingTop: 4, paddingBottom: 4 }}>
          {qs.map((n) => (
            <details className="faq" key={n}>
              <summary>{t(`help.q${n}`)}</summary>
              <p>{t(`help.a${n}`)}</p>
            </details>
          ))}
        </section>
        <Link className="btn block" to="/more/support">
          {t("more.support")}
        </Link>
      </div>
    </main>
  );
}
