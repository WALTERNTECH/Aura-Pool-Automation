import { NavLink, Outlet } from "react-router-dom";
import { useApi } from "../lib/hooks";
import { useSession } from "../lib/session";
import { Icon, Logo } from "./Icon";
import { ReauthDialog } from "./Reauth";
import { Toaster } from "./ui";

// The console frame: a sidebar filtered by what the signed-in role may see, live counts for
// what needs attention, and the environment strip (sandbox, kill switch).

type Item = { to: string; label: string; icon: string; perm?: string; count?: number; alert?: boolean };

export function Layout() {
  const { me, can, signOut } = useSession();
  const d = useApi<any>(me && can("dashboard.view") ? "/dashboard" : null, { refreshMs: 30_000 });
  const ap = useApi<any>(me ? "/approvals?status=pending" : null, { refreshMs: 60_000 });
  const att = d.data?.attention ?? {};
  const exceptions = (att.unmatched ?? 0) + (att.underpaid ?? 0) + (att.overpaid ?? 0) + (att.unlock_failed ?? 0) + (att.verification_failed ?? 0) + (att.refund_pending ?? 0);
  const openAlerts = Object.values((d.data?.alerts?.counts ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
  const critical = d.data?.alerts?.counts?.critical ?? 0;
  const ks = d.data?.money?.killSwitch?.on;

  const groups: { name: string; items: Item[] }[] = [
    {
      name: "Operate",
      items: [
        { to: "/", label: "Dashboard", icon: "dashboard", perm: "dashboard.view" },
        { to: "/alerts", label: "Alerts", icon: "bell", perm: "alerts.view", count: openAlerts, alert: critical > 0 },
        { to: "/exceptions", label: "Exceptions", icon: "alert", perm: "payments.view", count: exceptions, alert: exceptions > 0 },
        { to: "/approvals", label: "Approvals", icon: "approve", perm: "approvals.view", count: ap.data?.items?.length ?? 0, alert: (ap.data?.items?.length ?? 0) > 0 },
        { to: "/disputes", label: "Disputes", icon: "chat", perm: "disputes.view" },
      ],
    },
    {
      name: "Business",
      items: [
        { to: "/merchants", label: "Merchants", icon: "users", perm: "merchants.view" },
        { to: "/tables", label: "Tables & devices", icon: "table", perm: "tables.view" },
        { to: "/payments", label: "Payments", icon: "payments", perm: "payments.view" },
        { to: "/announcements", label: "Announcements", icon: "megaphone", perm: "merchants.view" },
      ],
    },
    {
      name: "Money",
      items: [
        { to: "/payouts", label: "Payouts", icon: "download", perm: "payouts.view", count: d.data?.money?.pendingApproval?.count ?? 0 },
        { to: "/float", label: "Float", icon: "float", perm: "float.view", alert: d.data?.money?.float?.status === "critical" },
        { to: "/ledger", label: "Ledger", icon: "ledger", perm: "ledger.view" },
        { to: "/reconciliation", label: "Reconciliation", icon: "check", perm: "ledger.view", alert: d.data?.money?.reconciliation?.status === "mismatch" },
        { to: "/transfers", label: "Transfers", icon: "exchange", perm: "ledger.view" },
        { to: "/pricing", label: "Pricing", icon: "money", perm: "pricing.view" },
        { to: "/reports", label: "Reports", icon: "report", perm: "reports.view" },
      ],
    },
    {
      name: "System",
      items: [
        { to: "/provider", label: "Provider", icon: "plug", perm: "provider.view" },
        { to: "/health", label: "System health", icon: "heart", perm: "health.view" },
        { to: "/audit", label: "Audit log", icon: "audit", perm: "audit.view" },
        { to: "/users", label: "Users & roles", icon: "shield", perm: "users.view" },
        { to: "/settings", label: "Settings", icon: "settings", perm: "settings.view" },
        ...(me?.environment.provider === "simulated" ? [{ to: "/simulator", label: "Simulator", icon: "flask", perm: "simulator.use" }] : []),
      ],
    },
  ];

  return (
    <>
      {ks ? <div className="env ks">Payout kill switch is ON. No payouts are being sent. <NavLink to="/payouts" style={{ textDecoration: "underline" }}>Manage</NavLink></div> : null}
      {me?.environment.sandbox ? <div className="env">Sandbox: {me.environment.provider === "simulated" ? "simulated M-Pesa, no real money moves" : "Daraja sandbox"}{me.environment.otpOnScreen ? " · one-time codes are shown on screen" : ""}</div> : null}
      <div className="shell">
        <aside className="side" aria-label="Console">
          <div className="brand">
            <Logo size={30} />
            <div>
              Aura Pool<small>Operations console</small>
            </div>
          </div>
          {groups.map((g) => {
            const items = g.items.filter((i) => !i.perm || can(i.perm));
            if (!items.length) return null;
            return (
              <div key={g.name} style={{ display: "contents" }}>
                <div className="group">{g.name}</div>
                {items.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
                    <Icon name={i.icon} />
                    {i.label}
                    {i.count ? <span className={`count${i.alert ? " alert" : ""}`}>{i.count}</span> : i.alert ? <span className="count alert">!</span> : null}
                  </NavLink>
                ))}
              </div>
            );
          })}
          <div className="foot">
            <NavLink to="/account" style={{ padding: 0 }}>
              <div>
                <b>{me?.name}</b>
                <div className="tiny muted">{me?.role.replace("_", " ")}</div>
              </div>
            </NavLink>
            <button className="link small" style={{ marginTop: 8 }} onClick={() => void signOut()}>
              Sign out
            </button>
          </div>
        </aside>
        <main className="main">
          <Outlet />
        </main>
      </div>
      <ReauthDialog />
      <Toaster />
    </>
  );
}
