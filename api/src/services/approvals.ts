import { db, many, one, type Q } from "../config/db.js";
import { can, type Permission } from "../lib/permissions.js";
import type { AdminRole } from "../lib/api.js";
import { conflict, forbidden, notFound } from "../lib/http.js";
import { announceToTeam, autoResolve, raise } from "./alerts.js";
import { audit, type AuditWho } from "./audit.js";
import { getSetting } from "./settings.js";

// Four-eyes approvals (Admin PRD 5.13). A sensitive action becomes a request; a second
// authorised person approves it and the server executes it. The requester can never
// approve their own request, except in single-operator mode, and then only after the delay,
// with SMS and email to the team at request time and at approval.

export type ApprovalAction =
  | "payout_number.fast_track"
  | "pricing.commission"
  | "pricing.fee_policy"
  | "ledger.adjustment"
  | "transfer.large"
  | "killswitch.release"
  | "merchant.close"
  | "admin.role_change"
  | "single_operator.off"
  | "single_operator.on";

type Executor = {
  /** Who may approve this kind of request. */
  perm: Permission;
  /** Runs inside the approval's transaction. Returns a short result for the record. */
  run: (q: Q, payload: Record<string, unknown>, ctx: { approvalId: string; requestedBy: string; approvedBy: string | null; who: AuditWho }) => Promise<unknown>;
  /** Executes by itself once the delay has passed, with no approver (making things stricter). */
  autoAfterDelay?: boolean;
};
const EXECUTORS = new Map<ApprovalAction, Executor>();

export function registerApproval(action: ApprovalAction, ex: Executor) {
  EXECUTORS.set(action, ex);
}

export type ApprovalRow = {
  id: string;
  action: ApprovalAction;
  payload: Record<string, unknown>;
  summary: string;
  entity_type: string | null;
  entity_id: string | null;
  requested_by: string;
  requested_at: Date;
  reason: string;
  status: string;
  executable_after: Date | null;
  decided_by: string | null;
};

export async function requestApproval(
  q: Q,
  input: { action: ApprovalAction; payload: Record<string, unknown>; summary: string; reason: string; entity?: { type: string; id: string } },
  requester: { id: string; label: string },
  who: AuditWho,
): Promise<ApprovalRow> {
  if (!EXECUTORS.has(input.action)) throw new Error(`no executor for ${input.action}`);
  const pending = await one(q, `select 1 from approvals where action = $1 and status = 'pending' and coalesce(entity_id, '') = coalesce($2, '')`, [input.action, input.entity?.id ?? null]);
  if (pending) throw conflict("A request for this is already waiting for approval");
  const so = await getSetting("single_operator", q);
  const ex = EXECUTORS.get(input.action)!;
  const delayed = so.on || ex.autoAfterDelay;
  const after = delayed ? new Date(Date.now() + so.delay_minutes * 60_000) : null;
  const row = await one<ApprovalRow>(
    q,
    `insert into approvals (action, payload, summary, entity_type, entity_id, requested_by, reason, executable_after) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [input.action, JSON.stringify(input.payload), input.summary, input.entity?.type ?? null, input.entity?.id ?? null, requester.id, input.reason, after],
  );
  await audit(q, who, "approval.request", { type: "approval", id: row!.id }, null, { action: input.action, summary: input.summary, reason: input.reason });
  await raise(q, { type: "approval_requested", severity: "info", title: `Approval needed: ${input.summary}`, detail: `Requested by ${requester.label}. ${input.reason}`, dedupeKey: `approval:${row!.id}`, entity: { type: "approval", id: row!.id } });
  if (so.on) await announceToTeam(q, `Approval requested: ${input.summary}`, `${requester.label} requested: ${input.summary}. Reason: ${input.reason}. In single-operator mode it can be approved after ${after!.toISOString()}.`);
  return row!;
}

export async function decideApproval(id: string, approve: boolean, admin: { id: string; role: AdminRole; label: string }, note: string, who: AuditWho) {
  return db().tx(async (q) => {
    const a = await one<ApprovalRow>(q, `select * from approvals where id = $1 for update`, [id]);
    if (!a) throw notFound("Approval request not found");
    if (a.status !== "pending") throw conflict(`This request is already ${a.status}`);
    const ex = EXECUTORS.get(a.action);
    if (!ex) throw conflict("This kind of request can no longer be executed");
    if (!can(admin.role, ex.perm)) throw forbidden("Your role can't approve this kind of request", "role_forbidden");
    if (approve && ex.autoAfterDelay) throw conflict("This takes effect by itself once its delay has passed");
    const so = await getSetting("single_operator", q);
    const own = a.requested_by === admin.id;
    if (approve && own) {
      if (!so.on) throw forbidden("You made this request, so someone else must approve it", "own_request");
      if (a.executable_after && new Date(a.executable_after) > new Date()) {
        const mins = Math.ceil((new Date(a.executable_after).getTime() - Date.now()) / 60_000);
        throw forbidden(`Single-operator mode: you can approve your own request in ${mins} minute${mins > 1 ? "s" : ""}`, "approval_delay");
      }
    }
    if (!approve) {
      await q.query(`update approvals set status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1`, [id, admin.id, note]);
      await audit(q, who, "approval.reject", { type: "approval", id }, { status: "pending" }, { status: "rejected", note });
      await autoResolve(q, `approval:${id}`, "Rejected");
      return { status: "rejected" };
    }
    await q.query(`update approvals set status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1`, [id, admin.id, note]);
    await audit(q, who, "approval.approve", { type: "approval", id }, { status: "pending" }, { status: "approved", note, ownRequest: own });
    const result = await ex.run(q, a.payload, { approvalId: id, requestedBy: a.requested_by, approvedBy: admin.id, who });
    await q.query(`update approvals set status = 'executed', executed_at = now(), result = $2 where id = $1`, [id, JSON.stringify(result ?? {})]);
    await audit(q, who, "approval.execute", { type: "approval", id }, null, { action: a.action, result: result ?? null });
    await autoResolve(q, `approval:${id}`, "Approved and executed");
    if (so.on) await announceToTeam(q, `Approved: ${a.summary}`, `${admin.label} approved: ${a.summary}${own ? " (their own request, after the single-operator delay)" : ""}.`);
    return { status: "executed", result };
  });
}

export async function cancelApproval(id: string, adminId: string, who: AuditWho) {
  await db().tx(async (q) => {
    const a = await one<ApprovalRow>(q, `select * from approvals where id = $1 for update`, [id]);
    if (!a) throw notFound("Approval request not found");
    if (a.status !== "pending") throw conflict(`This request is already ${a.status}`);
    if (a.requested_by !== adminId) throw forbidden("Only the requester can withdraw a request");
    await q.query(`update approvals set status = 'cancelled', decided_by = $2, decided_at = now() where id = $1`, [id, adminId]);
    await audit(q, who, "approval.cancel", { type: "approval", id }, { status: "pending" }, { status: "cancelled" });
    await autoResolve(q, `approval:${id}`, "Withdrawn");
  });
}

/** Every minute: requests that execute themselves once their delay has passed. */
export async function runDelayedApprovals() {
  const due = await many<ApprovalRow>(db(), `select * from approvals where status = 'pending' and executable_after <= now()`);
  for (const a of due) {
    const ex = EXECUTORS.get(a.action);
    if (!ex?.autoAfterDelay) continue;
    await db().tx(async (q) => {
      const again = await one<ApprovalRow>(q, `select * from approvals where id = $1 and status = 'pending' for update`, [a.id]);
      if (!again) return;
      const who: AuditWho = { type: "system", label: "delayed approval" };
      const result = await ex.run(q, a.payload, { approvalId: a.id, requestedBy: a.requested_by, approvedBy: null, who });
      await q.query(`update approvals set status = 'executed', executed_at = now(), result = $2 where id = $1`, [a.id, JSON.stringify(result ?? {})]);
      await audit(q, who, "approval.execute", { type: "approval", id: a.id }, null, { action: a.action, automatic: true });
      await autoResolve(q, `approval:${a.id}`, "Executed after the delay");
      await announceToTeam(q, `Done: ${a.summary}`, `${a.summary} took effect after the required delay.`);
    });
  }
}
