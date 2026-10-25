import { NavLink, Outlet } from "react-router-dom";
import { useApi, useLang } from "../lib/hooks";
import { t } from "../lib/i18n";
import { useSession } from "../lib/session";
import { Icon } from "./Icon";
import { InstallPrompt } from "./InstallPrompt";
import { OfflineBar, Toaster } from "./ui";

// Bottom tab bar: Home, Payments, Money, Stats, More. Attendants don't see money, so they get
// Home, Payments and More.

export function Shell() {
  useLang();
  const { isOwner, me } = useSession();
  const unread = useApi<{ unread: number }>(me ? "/notifications/unread" : null, { refreshMs: 60_000 });
  const tabs = [
    { to: "/", icon: "home", label: t("nav.home"), end: true },
    { to: "/payments", icon: "payments", label: t("nav.payments") },
    ...(isOwner
      ? [
          { to: "/money", icon: "money", label: t("nav.money") },
          { to: "/stats", icon: "stats", label: t("nav.stats") },
        ]
      : []),
    { to: "/more", icon: "more", label: t("nav.more"), dot: unread.data?.unread },
  ];
  return (
    <>
      <OfflineBar />
      <Outlet />
      <div className="tabs">
        <nav aria-label="Main">
          {tabs.map((tb) => (
            <NavLink key={tb.to} to={tb.to} end={tb.end} className={({ isActive }) => (isActive ? "active" : "")}>
              <Icon name={tb.icon} />
              <span>{tb.label}</span>
              {"dot" in tb && tb.dot ? <span className="dot">{tb.dot > 9 ? "9+" : tb.dot}</span> : null}
            </NavLink>
          ))}
        </nav>
      </div>
      <InstallPrompt />
      <Toaster />
    </>
  );
}
