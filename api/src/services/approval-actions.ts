import { one } from "../config/db.js";
import { conflict } from "../lib/http.js";
import { formatKsh } from "../lib/kenya.js";
import { announceToTeam, autoResolve } from "./alerts.js";
import { activity, audit } from "./audit.js";
import { registerApproval } from "./approvals.js";
import { executeTransfer, type TransferInput } from "./float.js";
import { enqueue } from "./jobs.js";
import { merchantAvailable, post, reverse, type AccountCode } from "./ledger.js";
import { fastTrackNumber } from "./merchants.js";
import { revokeAll } from "./sessions.js";
import { setSetting } from "./settings.js";

// What each four-eyes request does once approved. Every one runs inside the approval's own
// transaction, so the approval record and its effect commit together.

registerApproval("payout_number.fast_track", {
  perm: "merchants.manage",
  run: async (q, p, ctx) => fastTrackNumber(q, String(p.merchantId), ctx.approvedBy, ctx.who),
});

registerApproval("pricing.commission", {
  perm: "pricing.manage",
  run: async (q, p, ctx) => {
    const from = new Date(Math.max(Date.now(), new Date(String(p.effectiveFrom ?? new Date().toISOString())).getTime()));
    const r = await one<{ id: string }>(
      q,
      `insert into pricing_rules (scope, scope_id, commission_minor, commission_pct, effective_from, created_by, approval_id) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [p.scope, p.scope === "default" ? null : p.scopeId, p.commissionMinor, p.commissionPct ?? 0, from, ctx.requestedBy, ctx.approvalId],
    );
    await audit(q, ctx.who, "pricing.commission", { type: "pricing_rule", id: r!.id }, null, { ...p, effectiveFrom: from });
    return { ruleId: r!.id, effectiveFrom: from.toISOString() };
  },
});

registerApproval("pricing.fee_policy", {
  perm: "pricing.manage",
  run: async (q, p, ctx) => {
    // One merchant's B2C fee override, or the platform policy.
    if (p.merchantId) {
      const m = await one<{ fee_policy: string | null }>(q, `select fee_policy from merchants where id = $1 for update`, [p.merchantId]);
      await q.query(`update merchants set fee_policy = $2 where id = $1`, [p.merchantId, p.b2c ?? null]);
      await audit(q, ctx.who, "merchant.fee_policy", { type: "merchant", id: String(p.merchantId) }, { feePolicy: m?.fee_policy ?? null }, { feePolicy: p.b2c ?? null });
      return { merchantId: p.merchantId, feePolicy: p.b2c ?? null };
    }
    const { before, after } = await setSetting("fee_policy", { b2c: p.b2c as "merchant" | "platform", collection: p.collection as "merchant" | "platform" }, ctx.approvedBy ?? "system", q);
    await audit(q, ctx.who, "settings.fee_policy", { type: "setting", id: "fee_policy" }, before, after);
    return after;
  },
});

registerApproval("ledger.adjustment", {
  perm: "ledger.adjust",
  run: async (q, p, ctx) => {
    if (p.reverses) {
      const id = await reverse(q, String(p.reverses), "adjustment", ctx.requestedBy, String(p.memo));
      await audit(q, ctx.who, "ledger.reverse", { type: "ledger_transaction", id }, null, { reverses: p.reverses, memo: p.memo });
      return { transactionId: id };
    }
    const lines = (p.lines as { account: AccountCode; amountMinor: number }[]).map((l) => ({ account: l.account, amount: l.amountMinor }));
    const id = await post(q, { kind: "adjustment", refType: "approval", refId: ctx.approvalId, idempotencyKey: `approval:${ctx.approvalId}`, memo: String(p.memo), createdBy: ctx.requestedBy, lines });
    await audit(q, ctx.who, "ledger.adjust", { type: "ledger_transaction", id }, null, { lines, memo: p.memo });
    return { transactionId: id };
  },
});

registerApproval("transfer.large", {
  perm: "transfers.record",
  run: async (q, p, ctx) => ({ transferId: await executeTransfer(q, p.transfer as TransferInput, ctx.requestedBy, ctx.approvedBy, ctx.approvalId, ctx.who) }),
});

registerApproval("killswitch.release", {
  perm: "killswitch.engage",
  run: async (q, _p, ctx) => {
    const { before } = await setSetting("kill_switch", { on: false, reason: null, by: null, at: null }, ctx.approvedBy ?? "system", q);
    await audit(q, ctx.who, "killswitch.release", { type: "setting", id: "kill_switch" }, before, { on: false });
    await autoResolve(q, "kill_switch", "Released");
    await announceToTeam(q, "Payouts resumed", "The payout kill switch was released. Payouts are being sent again.");
    await activity(q, "killswitch.release", "Payout kill switch released");
    await enqueue(q, "payouts.sweep", {});
    return { on: false };
  },
});

registerApproval("merchant.close", {
  perm: "merchants.manage",
  run: async (q, p, ctx) => {
    const id = String(p.merchantId);
    await q.query(`select id from merchants where id = $1 for update`, [id]);
    const bal = await merchantAvailable(q, id);
    if (bal !== 0) throw conflict(`The merchant still has ${formatKsh(bal)} available. Pay it out (or adjust it) before closing.`);
    const inflight = await one(q, `select 1 from payouts where merchant_id = $1 and status in ('requested','pending_approval','held','queued','submitted','timed_out')`, [id]);
    if (inflight) throw conflict("A payout for this merchant is still in progress");
    await q.query(`update merchants set status = 'closed', status_reason = $2, closed_at = now(), auto_withdraw_enabled = false where id = $1`, [id, String(p.reason)]);
    await q.query(`update pool_tables set status = 'disabled', status_reason = 'Merchant closed' where merchant_id = $1`, [id]);
    const users = await q.query<{ id: string }>(`update merchant_users set status = 'revoked', token_version = token_version + 1 where merchant_id = $1 returning id`, [id]);
    for (const u of users.rows) await revokeAll(q, "merchant", u.id, "merchant closed");
    await audit(q, ctx.who, "merchant.close", { type: "merchant", id }, null, { reason: p.reason });
    return { closed: true };
  },
});

registerApproval("admin.role_change", {
  perm: "users.manage",
  run: async (q, p, ctx) => {
    const a = await one<{ role: string }>(q, `select role from admin_users where id = $1 for update`, [p.adminId]);
    if (!a) throw conflict("That admin no longer exists");
    await q.query(`update admin_users set role = $2, token_version = token_version + 1 where id = $1`, [p.adminId, p.role]);
    await revokeAll(q, "admin", String(p.adminId), "role changed");
    await audit(q, ctx.who, "admin.role_change", { type: "admin_user", id: String(p.adminId) }, { role: a.role }, { role: p.role });
    return { role: p.role };
  },
});

registerApproval("single_operator.off", {
  perm: "users.manage",
  autoAfterDelay: true,
  run: async (q, _p, ctx) => {
    const { before, after } = await setSetting("single_operator", { on: false, delay_minutes: 30 }, "delayed approval", q);
    await audit(q, ctx.who, "settings.single_operator_off", { type: "setting", id: "single_operator" }, before, after);
    return after;
  },
});

registerApproval("single_operator.on", {
  perm: "users.manage",
  run: async (q, p, ctx) => {
    const { before, after } = await setSetting("single_operator", { on: true, delay_minutes: Number(p.delayMinutes ?? 30) }, ctx.approvedBy ?? "system", q);
    await audit(q, ctx.who, "settings.single_operator_on", { type: "setting", id: "single_operator" }, before, after);
    return after;
  },
});
