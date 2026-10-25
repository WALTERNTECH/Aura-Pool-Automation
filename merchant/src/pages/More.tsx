import { useState } from "react";
import { Icon } from "../components/Icon";
import { Row, Sheet, TopBar } from "../components/ui";
import { call } from "../lib/api";
import { t } from "../lib/i18n";
import { useApi, useLang } from "../lib/hooks";
import { useSession } from "../lib/session";

export default function More() {
  useLang();
  const { me, isOwner, signOut } = useSession();
  const unread = useApi<{ unread: number }>("/notifications/unread");
  const [confirm, setConfirm] = useState(false);
  return (
    <main className="page">
      <TopBar title={t("more.title")} />
      <div className="stack">
        <section className="card row">
          <span className="lead" style={{ width: 44, height: 44, borderRadius: 12, display: "grid", placeItems: "center", background: "var(--surface-2)" }}>
            <Icon name="user" />
          </span>
          <div className="grow">
            <b>{me?.user.name}</b>
            <p className="small muted">
              {me?.merchant.businessName} · {me?.user.phoneMasked}
            </p>
          </div>
        </section>
        <div className="list">
          <Row to="/alerts" lead={<Icon name="bell" />} title={t("nav.alerts")} end={unread.data?.unread ? <span className="badge bad plain">{unread.data.unread}</span> : undefined} />
          <Row to="/tables" lead={<Icon name="table" />} title={t("nav.tables")} />
          {isOwner ? <Row to="/more/staff" lead={<Icon name="users" />} title={t("more.staff")} /> : null}
          <Row to="/more/settings" lead={<Icon name="settings" />} title={t("more.settings")} />
        </div>
        <div className="list">
          <Row to="/more/help" lead={<Icon name="help" />} title={t("more.help")} />
          <Row to="/more/support" lead={<Icon name="chat" />} title={t("more.support")} />
          <Row to="/legal/terms" lead={<Icon name="doc" />} title={t("more.terms")} />
          <Row to="/legal/privacy" lead={<Icon name="shield" />} title={t("more.privacy")} />
        </div>
        <div className="list">
          <Row onClick={() => void signOut()} lead={<Icon name="logout" />} title={t("more.signOut")} chevron={false} />
          <Row onClick={() => setConfirm(true)} lead={<Icon name="lock" />} title={t("more.signOutAll")} chevron={false} />
        </div>
        <p className="tiny faint center">{t("more.version")}</p>
      </div>
      <Sheet open={confirm} onClose={() => setConfirm(false)} title={t("more.signOutAll")}>
        <div className="stack">
          <p className="muted">{t("more.signOutAllBody")}</p>
          <button
            className="btn danger block"
            onClick={async () => {
              await call("/me/sessions/revoke-all", { method: "POST" }).catch(() => {});
              await signOut();
            }}
          >
            {t("more.signOutAll")}
          </button>
          <button className="btn block" onClick={() => setConfirm(false)}>{t("app.cancel")}</button>
        </div>
      </Sheet>
    </main>
  );
}
