import type { AdminRole } from "./api.js";

// The permission matrix (Admin Console PRD 5.12). The API enforces it on every route;
// the console only uses it to hide what a role can't do.
//
//   super_admin  everything
//   finance      view payments, ledger, payouts, reports; approve payouts within the finance
//                limit; record provider transfers; export reports. No settings or devices.
//   support      view merchants, tables, payments; resolve exceptions; test unlock; disputes.
//                No payout approval, no money settings.
//   auditor      view-only, plus the audit log.

const ALL: AdminRole[] = ["super_admin", "finance", "support", "auditor"];
const SA: AdminRole[] = ["super_admin"];

export const PERMISSIONS = {
  "dashboard.view": ALL,
  "merchants.view": ALL,
  "merchants.manage": SA,
  "merchants.notes": ["super_admin", "support"],
  "merchants.documents": ["super_admin", "support"],
  "tables.view": ALL,
  "tables.manage": SA,
  "tables.test_unlock": ["super_admin", "support"],
  "tables.manual_unlock": ["super_admin", "support"],
  "payments.view": ALL,
  "payments.resolve": ["super_admin", "support"],
  "refunds.record": ["super_admin", "support", "finance"],
  "ledger.view": ["super_admin", "finance", "auditor"],
  "ledger.adjust": ["super_admin", "finance"],
  "transfers.record": ["super_admin", "finance"],
  "reconciliation.run": ["super_admin", "finance"],
  "reconciliation.ack": ["super_admin", "finance"],
  "payouts.view": ["super_admin", "finance", "auditor"],
  "payouts.approve": ["super_admin", "finance"],
  "payouts.retry": ["super_admin", "finance"],
  "payouts.platform": ["super_admin", "finance"],
  "killswitch.engage": SA,
  "float.view": ["super_admin", "finance", "auditor"],
  "pricing.view": ALL,
  "pricing.manage": SA,
  "settings.view": ALL,
  "settings.manage": SA,
  "provider.view": ["super_admin", "finance", "auditor"],
  "provider.manage": SA,
  "alerts.view": ALL,
  "alerts.manage": ["super_admin", "finance", "support"],
  "alerts.rules": SA,
  "health.view": ALL,
  "audit.view": ["super_admin", "auditor"],
  "users.view": ["super_admin", "auditor"],
  "users.manage": SA,
  "approvals.view": ALL,
  "approvals.decide": ["super_admin", "finance"],
  "disputes.view": ["super_admin", "support", "auditor"],
  "disputes.handle": ["super_admin", "support"],
  "impersonate": ["super_admin", "support"],
  "announcements.send": SA,
  "reports.view": ["super_admin", "finance", "auditor"],
  "reports.manage": SA,
  "simulator.use": ["super_admin", "support"],
} as const satisfies Record<string, readonly AdminRole[]>;

export type Permission = keyof typeof PERMISSIONS;

export function can(role: AdminRole, perm: Permission): boolean {
  return (PERMISSIONS[perm] as readonly AdminRole[]).includes(role);
}

export function permissionsFor(role: AdminRole): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}
