// The console's menu: Dashboard first, then groups that open like dropdowns. Each item names the
// permission it needs; items the signed-in role can't use are left out.

export type NavItem = { to: string; label: string; icon: string; perm?: string; sandbox?: boolean };
export type NavGroup = { id: string; label: string; icon: string; items: NavItem[] };

export const DASHBOARD: NavItem = { to: "/", label: "Dashboard", icon: "dashboard", perm: "dashboard.view" };

export const GROUPS: NavGroup[] = [
  {
    id: "attention",
    label: "Needs attention",
    icon: "bolt",
    items: [
      { to: "/alerts", label: "Alerts", icon: "bell", perm: "alerts.view" },
      { to: "/approvals", label: "Approvals", icon: "approve", perm: "approvals.view" },
      { to: "/exceptions", label: "Payment exceptions", icon: "alert", perm: "payments.view" },
      { to: "/disputes", label: "Disputes", icon: "chat", perm: "disputes.view" },
    ],
  },
  {
    id: "business",
    label: "Merchants & tables",
    icon: "building",
    items: [
      { to: "/merchants", label: "Merchants", icon: "users", perm: "merchants.view" },
      { to: "/tables", label: "Tables & devices", icon: "table", perm: "tables.view" },
      { to: "/payments", label: "Payments", icon: "payments", perm: "payments.view" },
      { to: "/announcements", label: "Announcements", icon: "megaphone", perm: "merchants.view" },
    ],
  },
  {
    id: "payouts",
    label: "Payouts & float",
    icon: "wallet",
    items: [
      { to: "/payouts", label: "Merchant payouts", icon: "download", perm: "payouts.view" },
      { to: "/platform-payouts", label: "Platform payouts", icon: "cash", perm: "payouts.view" },
      { to: "/float", label: "Float", icon: "float", perm: "float.view" },
      { to: "/transfers", label: "Transfers", icon: "exchange", perm: "ledger.view" },
    ],
  },
  {
    id: "finance",
    label: "Finance",
    icon: "ledger",
    items: [
      { to: "/ledger", label: "Ledger", icon: "ledger", perm: "ledger.view" },
      { to: "/reconciliation", label: "Reconciliation", icon: "check", perm: "ledger.view" },
      { to: "/pricing", label: "Pricing", icon: "money", perm: "pricing.view" },
      { to: "/reports", label: "Reports", icon: "report", perm: "reports.view" },
    ],
  },
  {
    id: "system",
    label: "System",
    icon: "settings",
    items: [
      { to: "/provider", label: "M-Pesa provider", icon: "plug", perm: "provider.view" },
      { to: "/health", label: "System health", icon: "heart", perm: "health.view" },
      { to: "/audit", label: "Audit log", icon: "audit", perm: "audit.view" },
      { to: "/users", label: "Users & roles", icon: "shield", perm: "users.view" },
      { to: "/settings", label: "Settings", icon: "settings", perm: "settings.view" },
      { to: "/simulator", label: "Simulator", icon: "flask", perm: "simulator.use", sandbox: true },
    ],
  },
];

export const ACCOUNT: NavItem = { to: "/account", label: "Your account", icon: "user" };

const matches = (to: string, path: string) => (to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`));

/** The menu entry a path belongs to (detail pages belong to their list). */
export function findCurrent(path: string): { item: NavItem; group: NavGroup | null } | null {
  if (matches(DASHBOARD.to, path)) return { item: DASHBOARD, group: null };
  if (matches(ACCOUNT.to, path)) return { item: ACCOUNT, group: null };
  for (const g of GROUPS) for (const i of g.items) if (matches(i.to, path)) return { item: i, group: g };
  return null;
}
