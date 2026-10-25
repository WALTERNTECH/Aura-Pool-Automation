import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { env, isSandbox } from "../config/env.js";
import { db, many, one } from "../config/db.js";
import { Api, type MerchantActor } from "../lib/api.js";
import { hashSecret, randomToken } from "../lib/crypto.js";
import { badRequest, conflict, forbidden, notFound, unavailable } from "../lib/http.js";
import { maskMsisdn, normaliseMsisdn } from "../lib/kenya.js";
import { can, PERMISSIONS } from "../lib/permissions.js";
import { callbackUrls } from "../providers/common.js";
import { intasendStatus, provider } from "../providers/index.js";
import { simulateC2B, simulatePortalTransfer, simulatorBalances } from "../providers/simulated.js";
import { transition } from "../services/alerts.js";
import { cancelApproval, decideApproval, requestApproval } from "../services/approvals.js";
import { audit } from "../services/audit.js";
import { queueDepth } from "../services/jobs.js";
import { emailConfigured, pushConfigured, sendEmail, sendPush, sendSms, smsConfigured } from "../services/messaging.js";
import { notifyMerchant } from "../services/notify.js";
import { toCsv } from "../services/reports.js";
import { revokeAll } from "../services/sessions.js";
import { allSettings, getSetting, setSetting, SETTINGS, type SettingKey } from "../services/settings.js";
import { adm, adminWho, zPage, zReason } from "./admin-core.js";
import { metrics } from "../middleware/metrics.js";

// /v1/a — Admin API, part 3: settings, provider, alerts, health, audit, users and roles,
// approvals, disputes, impersonation, announcements, and the sandbox simulator.

export const adminOpsApi = new Api("/v1/a", "Admin");
const r = adminOpsApi;
const requester = (req: Request) => ({ id: adm(req).id, label: adm(req).name });

// ------------------------------------------------------------------ settings

// Keys editable directly. Commission, fee policy, single-operator mode and the kill switch go
// through their own controlled routes.
const EDITABLE: SettingKey[] = ["verify_mode", "defaults", "payout", "b2c_tariff", "collection_tariff", "amount_rules", "manual_unlock", "float", "alert_rules", "reconciliation", "platform_payout", "support", "operator_contacts", "reports", "terms_version", "backups"];

r.route({ method: "get", path: "/settings", summary: "Every setting", auth: "admin", perm: "settings.view" }, async () => ({ settings: await allSettings(), editable: EDITABLE }));

r.route({ method: "put", path: "/settings/:key", summary: "Change a setting (audited)", auth: "admin", perm: "settings.manage", reauth: true, body: z.object({ value: z.any() }) }, async ({ req, params, body }) => {
  const key = params.key as SettingKey;
  if (!EDITABLE.includes(key)) throw forbidden("That setting changes through its own controlled action");
  if (key === "defaults") {
    // Commission inside "defaults" is a commission change: it needs a second approver.
    const cur = await getSetting("defaults");
    const next = SETTINGS.defaults.parse(body.value);
    if (next.commission_minor !== cur.commission_minor || next.commission_pct !== cur.commission_pct) throw forbidden("Change commission from Pricing, which asks a second approver");
    if (next.price_min_minor > next.price_max_minor || next.unlock_min_s > next.unlock_max_s) throw badRequest("Minimums must be below maximums");
  }
  if (key === "platform_payout" && body.value?.msisdn) {
    const n = normaliseMsisdn(String(body.value.msisdn));
    if (!n) throw badRequest("Enter a valid M-Pesa number");
    body.value.msisdn = n;
  }
  const parsed = SETTINGS[key].safeParse(body.value);
  if (!parsed.success) throw badRequest(parsed.error.issues[0]?.message ?? "That value isn't valid", "validation", parsed.error.issues);
  const { before, after } = await setSetting(key, parsed.data as never, adm(req).id);
  await audit(db(), adminWho(req), `settings.${key}`, { type: "setting", id: key }, before, after);
  return { key, value: after };
});

r.route({ method: "post", path: "/settings/single-operator", summary: "Turn single-operator mode on (second approver) or off (delayed)", auth: "admin", perm: "users.manage", body: z.object({ on: z.boolean(), delayMinutes: z.number().int().min(30).max(1440).default(30), reason: zReason }) }, async ({ req, body }) => {
  const cur = await getSetting("single_operator");
  if (cur.on === body.on) throw conflict(`Single-operator mode is already ${cur.on ? "on" : "off"}`);
  return db().tx((q) =>
    requestApproval(q, { action: body.on ? "single_operator.on" : "single_operator.off", payload: { delayMinutes: body.delayMinutes }, summary: body.on ? "Turn single-operator mode on" : "Turn single-operator mode off", reason: body.reason }, requester(req), adminWho(req)),
  );
});

// ------------------------------------------------------------------ provider

r.route({ method: "get", path: "/provider", summary: "Provider status, health and callbacks (no secrets)", auth: "admin", perm: "provider.view" }, async () => {
  const urls = callbackUrls();
  const mask = (u: string) => u.replace(env.callbackSecret, "••••••");
  const health = await many(db(), `select api, last_ok_at, last_error_at, last_error, ok_count, error_count, last_ms from provider_health order by api`);
  const lastCallback = await one(db(), `select kind, received_at from callback_log order by received_at desc limit 1`);
  const hourly = await many(db(), `select to_char(date_trunc('hour', received_at), 'YYYY-MM-DD"T"HH24:00:00"Z"') as hour, count(*)::int as n, count(*) filter (where not ok)::int as failed, round(avg(processing_ms))::int as avg_ms from callback_log where received_at > now() - interval '24 hours' group by 1 order by 1`);
  const ps = await getSetting("provider_state");
  return {
    provider: provider().status(),
    callbackUrls: Object.fromEntries(Object.entries(urls).map(([k, v]) => [k, mask(v)])),
    urlRegistration: { at: ps.urls_registered_at, result: ps.urls_register_result },
    verifyMode: await getSetting("verify_mode"),
    health,
    lastCallback,
    callbacksByHour: hourly,
    intasend: intasendStatus(),
    messaging: { sms: { configured: smsConfigured(), provider: env.sms.provider }, email: { configured: emailConfigured() }, push: { configured: pushConfigured() } },
    sandbox: isSandbox(),
  };
});

r.route({ method: "post", path: "/provider/register-urls", summary: "Register the C2B validation and confirmation URLs with Daraja", auth: "admin", perm: "provider.manage", reauth: true }, async ({ req }) => {
  const res = await provider().registerC2BUrls();
  const ps = await getSetting("provider_state");
  await setSetting("provider_state", { ...ps, urls_registered_at: res.ok ? new Date().toISOString() : ps.urls_registered_at, urls_register_result: res.detail }, adm(req).id);
  await audit(db(), adminWho(req), "provider.register_urls", null, null, res);
  return res;
});

r.route({ method: "get", path: "/provider/callbacks", summary: "Recent callbacks", auth: "admin", perm: "provider.view", query: zPage.extend({ kind: z.string().max(40).optional(), failed: z.coerce.boolean().optional() }) }, async ({ query }) => {
  const where = ["true"];
  const params: unknown[] = [];
  if (query.kind) params.push(query.kind), where.push(`kind = $${params.length}`);
  if (query.failed) where.push(`not ok`);
  const rows = await many(db(), `select id, kind, received_at, processing_ms, ok, error, source_ip, payload, replay_of, count(*) over () as total from callback_log where ${where.join(" and ")} order by received_at desc limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`, params);
  return { items: rows.map((x) => ({ ...x, total: undefined })), total: Number(rows[0]?.total ?? 0), page: query.page, pageSize: query.pageSize };
});

r.route({ method: "post", path: "/provider/callbacks/:id/replay", summary: "Replay a stored callback (sandbox only)", auth: "admin", perm: "provider.manage" }, async ({ req, params }) => {
  if (!isSandbox()) throw forbidden("Callbacks can be replayed in the sandbox only");
  const c = await one<{ kind: string; payload: unknown }>(db(), `select kind, payload from callback_log where id = $1`, [params.id]);
  if (!c) throw notFound("Callback not found");
  const urls = callbackUrls(localUrl());
  const target = ({ c2b_validation: urls.c2bValidation, c2b_confirmation: urls.c2bConfirmation, stk: urls.stk, b2c_result: urls.b2cResult, b2c_timeout: urls.b2cTimeout, status_result: urls.statusResult, status_timeout: urls.statusTimeout, balance: urls.balance } as Record<string, string>)[c.kind];
  if (!target) throw badRequest("That callback kind can't be replayed");
  const res = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json", "X-Aura-Replay-Of": params.id }, body: JSON.stringify(c.payload) });
  await audit(db(), adminWho(req), "provider.replay_callback", { type: "callback", id: params.id }, null, { status: res.status });
  return { status: res.status, body: await res.json().catch(() => null) };
});

r.route({ method: "post", path: "/provider/messaging/test", summary: "Send a test SMS, email or push", auth: "admin", perm: "provider.manage", body: z.object({ channel: z.enum(["sms", "email", "push"]), to: z.string().min(3).max(200) }) }, async ({ req, body }) => {
  let res;
  if (body.channel === "sms") {
    const n = normaliseMsisdn(body.to);
    if (!n) throw badRequest("Enter a valid phone number");
    res = await sendSms(n, "Aura Pool test message. If you got this, SMS works.");
  } else if (body.channel === "email") res = await sendEmail([body.to], "Aura Pool test email", "If you got this, email works.");
  else {
    const u = await one<{ id: string }>(db(), `select id from merchant_users where phone = $1`, [normaliseMsisdn(body.to)]);
    if (!u) throw notFound("No merchant user with that number");
    res = await sendPush(db(), u.id, { title: "Aura Pool test", body: "If you got this, push works.", url: "/" });
  }
  await audit(db(), adminWho(req), "provider.test_message", null, null, { channel: body.channel, ok: res.ok });
  return res;
});

// ------------------------------------------------------------------ alerts and health

r.route({ method: "get", path: "/alerts", summary: "Alerts", auth: "admin", perm: "alerts.view", query: zPage.extend({ status: z.enum(["open", "acknowledged", "resolved", "active"]).default("active"), severity: z.enum(["info", "warning", "critical"]).optional(), type: z.string().max(40).optional() }) }, async ({ query }) => {
  const where = [query.status === "active" ? `a.status <> 'resolved'` : `a.status = '${query.status}'`];
  const params: unknown[] = [];
  if (query.severity) params.push(query.severity), where.push(`a.severity = $${params.length}`);
  if (query.type) params.push(query.type), where.push(`a.type = $${params.length}`);
  const rows = await many(
    db(),
    `select a.*, o.name as owner_name, count(*) over () as total from alerts a left join admin_users o on o.id = a.owner_id where ${where.join(" and ")}
      order by case a.severity when 'critical' then 0 when 'warning' then 1 else 2 end, a.last_seen_at desc limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`,
    params,
  );
  return { items: rows.map((x) => ({ ...x, total: undefined })), total: Number(rows[0]?.total ?? 0), page: query.page, pageSize: query.pageSize };
});

r.route({ method: "get", path: "/alerts/:id", summary: "Alert with its history", auth: "admin", perm: "alerts.view" }, async ({ params }) => {
  const a = await one(db(), `select a.*, o.name as owner_name from alerts a left join admin_users o on o.id = a.owner_id where a.id = $1`, [params.id]);
  if (!a) throw notFound("Alert not found");
  return { alert: a, history: await many(db(), `select kind, actor, note, at from alert_events where alert_id = $1 order by at`, [params.id]) };
});

for (const [path, to] of [["ack", "acknowledged"], ["resolve", "resolved"], ["reopen", "open"]] as const) {
  r.route({ method: "post", path: `/alerts/:id/${path}`, summary: `Alert: ${to}`, auth: "admin", perm: "alerts.manage", body: z.object({ note: z.string().max(1000).optional() }) }, async ({ req, params, body }) => {
    const out = await db().tx((q) => transition(q, params.id, to, adm(req).id, adm(req).name, body.note));
    if (!out) throw notFound("Alert not found");
    await audit(db(), adminWho(req), `alert.${path}`, { type: "alert", id: params.id }, { status: out.before }, { status: to, note: body.note ?? null });
    return { ok: true };
  });
}

r.route({ method: "post", path: "/alerts/:id/assign", summary: "Give an alert an owner", auth: "admin", perm: "alerts.manage", body: z.object({ adminId: z.string().uuid().nullable() }) }, async ({ req, params, body }) => {
  await db().query(`update alerts set owner_id = $2 where id = $1`, [params.id, body.adminId]);
  await db().query(`insert into alert_events (alert_id, kind, actor, note) values ($1,'assigned',$2,$3)`, [params.id, adm(req).name, body.adminId]);
  return { ok: true };
});

r.route({ method: "post", path: "/alerts/:id/note", summary: "Add a note to an alert", auth: "admin", perm: "alerts.manage", body: z.object({ note: z.string().min(1).max(1000) }) }, async ({ req, params, body }) => {
  await db().query(`insert into alert_events (alert_id, kind, actor, note) values ($1,'note',$2,$3)`, [params.id, adm(req).name, body.note]);
  return { ok: true };
});

r.route({ method: "get", path: "/health/system", summary: "API latency, queue depth, database, broker, errors, backups", auth: "admin", perm: "health.view" }, async () => {
  const t0 = Date.now();
  await db().query(`select 1`);
  const dbMs = Date.now() - t0;
  return {
    api: metrics.snapshot(),
    queue: await queueDepth(),
    database: { ok: true, latencyMs: dbMs, kind: db().kind },
    broker: deviceStatus(),
    devices: await one(db(), `select count(*) filter (where online)::int as online, count(*)::int as provisioned from devices where status = 'provisioned'`),
    lastCallback: await one(db(), `select kind, received_at from callback_log order by received_at desc limit 1`),
    backups: await getSetting("backups"),
    uptimeS: Math.round(process.uptime()),
    version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "dev",
  };
});

// ------------------------------------------------------------------ audit

const zAudit = zPage.extend({ actor: z.string().max(80).optional(), action: z.string().max(80).optional(), entity: z.string().max(80).optional(), entityId: z.string().max(80).optional(), from: z.string().optional(), to: z.string().optional() });
function auditWhere(f: z.infer<typeof zAudit>) {
  const where = ["true"];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replaceAll("?", `$${params.length}`));
  };
  if (f.actor) add(`(actor_id = ? or actor_label ilike '%' || ? || '%')`, f.actor);
  if (f.action) add(`action like ? || '%'`, f.action);
  if (f.entity) add(`entity_type = ?`, f.entity);
  if (f.entityId) add(`entity_id = ?`, f.entityId);
  if (f.from) add(`at >= ?::timestamptz`, f.from);
  if (f.to) add(`at < ?::timestamptz`, f.to);
  return { where: where.join(" and "), params };
}

r.route({ method: "get", path: "/audit", summary: "Audit log (append-only)", auth: "admin", perm: "audit.view", query: zAudit }, async ({ query }) => {
  const { where, params } = auditWhere(query);
  const rows = await many(db(), `select *, count(*) over () as total from audit_log where ${where} order by id desc limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}`, params);
  return { items: rows.map((x) => ({ ...x, total: undefined })), total: Number(rows[0]?.total ?? 0), page: query.page, pageSize: query.pageSize };
});

r.route({ method: "get", path: "/audit/export", summary: "Audit log as CSV", auth: "admin", perm: "audit.view", raw: true, query: zAudit.omit({ page: true, pageSize: true }) }, async ({ req, res, query }) => {
  const { where, params } = auditWhere({ ...query, page: 1, pageSize: 1 });
  const rows = await many(db(), `select id, at, actor_type, actor_id, actor_label, action, entity_type, entity_id, before, after, ip, user_agent from audit_log where ${where} order by id desc limit 100000`, params);
  await audit(db(), adminWho(req), "audit.export", null, null, { rows: rows.length, filter: query });
  res.type("text/csv").attachment(`aura-audit-${new Date().toISOString().slice(0, 10)}.csv`).send(toCsv(rows));
});

// ------------------------------------------------------------------ users and roles

r.route({ method: "get", path: "/users", summary: "Admin users", auth: "admin", perm: "users.view" }, async () => ({
  users: await many(db(), `select id, email, name, role, status, phone, totp_enabled_at, last_login_at, locked_until, ip_allowlist, created_at, jsonb_array_length(recovery_codes) as recovery_codes_left from admin_users order by created_at`),
  roles: Object.fromEntries((["super_admin", "finance", "support", "auditor"] as const).map((role) => [role, Object.keys(PERMISSIONS).filter((p) => can(role, p as never))])),
  pendingRoleChanges: await many(db(), `select id, summary, requested_at, executable_after, entity_id from approvals where action = 'admin.role_change' and status = 'pending'`),
}));

r.route({ method: "post", path: "/users", summary: "Invite an admin", auth: "admin", perm: "users.manage", reauth: true, body: z.object({ email: z.string().email(), name: z.string().min(2).max(80), role: z.enum(["super_admin", "finance", "support", "auditor"]), phone: z.string().min(9).max(16).optional() }) }, async ({ req, body }) => {
  const email = body.email.trim().toLowerCase();
  if (await one(db(), `select 1 from admin_users where email = $1`, [email])) throw conflict("That email already has an account");
  const token = randomToken(24);
  const a = await one<{ id: string }>(db(), `insert into admin_users (email, name, phone, role, status, invite_token_hash, invite_expires_at, created_by) values ($1,$2,$3,$4,'invited',$5, now() + interval '3 days', $6) returning id`, [email, body.name, body.phone ? normaliseMsisdn(body.phone) : null, body.role, hashSecret(token), adm(req).id]);
  const link = `${env.adminUrl}/invite/${token}`;
  await sendEmail([email], "You're invited to the Aura Pool console", `${adm(req).name} invited you as ${body.role.replace("_", " ")}. Set your password and authenticator here (valid 3 days): ${link}`);
  await audit(db(), adminWho(req), "admin.invite", { type: "admin_user", id: a!.id }, null, { email, role: body.role });
  return { id: a!.id, inviteLink: link };
});

r.route({ method: "post", path: "/users/:id/role", summary: "Change a role (second approver)", auth: "admin", perm: "users.manage", body: z.object({ role: z.enum(["super_admin", "finance", "support", "auditor"]), reason: zReason }) }, async ({ req, params, body }) => {
  const a = await one<{ email: string; role: string }>(db(), `select email, role from admin_users where id = $1`, [params.id]);
  if (!a) throw notFound("Admin not found");
  if (a.role === body.role) throw conflict("That's already their role");
  return db().tx((q) => requestApproval(q, { action: "admin.role_change", payload: { adminId: params.id, role: body.role }, summary: `${a.email}: ${a.role} → ${body.role}`, reason: body.reason, entity: { type: "admin_user", id: params.id } }, requester(req), adminWho(req)));
});

r.route({ method: "post", path: "/users/:id/deactivate", summary: "Deactivate an admin", auth: "admin", perm: "users.manage", reauth: true, body: z.object({ reason: zReason }) }, async ({ req, params, body }) => {
  if (params.id === adm(req).id) throw forbidden("You can't deactivate yourself");
  await db().tx(async (q) => {
    const supers = await one<{ n: number }>(q, `select count(*)::int as n from admin_users where role = 'super_admin' and status = 'active' and id <> $1`, [params.id]);
    const target = await one<{ role: string; status: string }>(q, `select role, status from admin_users where id = $1 for update`, [params.id]);
    if (!target) throw notFound("Admin not found");
    if (target.role === "super_admin" && (supers?.n ?? 0) === 0) throw conflict("This is the last super admin");
    await q.query(`update admin_users set status = 'deactivated', token_version = token_version + 1 where id = $1`, [params.id]);
    await revokeAll(q, "admin", params.id, "deactivated");
    await audit(q, adminWho(req), "admin.deactivate", { type: "admin_user", id: params.id }, { status: target.status }, { status: "deactivated", reason: body.reason });
  });
  return { ok: true };
});

r.route({ method: "post", path: "/users/:id/reactivate", summary: "Reactivate an admin", auth: "admin", perm: "users.manage", reauth: true }, async ({ req, params }) => {
  await db().query(`update admin_users set status = 'active', failed_attempts = 0, locked_until = null where id = $1 and status = 'deactivated' and totp_enabled_at is not null`, [params.id]);
  await audit(db(), adminWho(req), "admin.reactivate", { type: "admin_user", id: params.id });
  return { ok: true };
});

r.route({ method: "post", path: "/users/:id/reset", summary: "Force a password and authenticator reset", auth: "admin", perm: "users.manage", reauth: true, body: z.object({ reason: zReason }) }, async ({ req, params, body }) => {
  const token = randomToken(24);
  const a = await one<{ email: string }>(
    db(),
    `update admin_users set password_hash = null, totp_secret_enc = null, totp_enabled_at = null, recovery_codes = '[]', must_reset = true, status = 'invited',
            invite_token_hash = $2, invite_expires_at = now() + interval '3 days', token_version = token_version + 1 where id = $1 returning email`,
    [params.id, hashSecret(token)],
  );
  if (!a) throw notFound("Admin not found");
  await revokeAll(db(), "admin", params.id, "forced reset");
  const link = `${env.adminUrl}/invite/${token}`;
  await sendEmail([a.email], "Reset your Aura Pool console access", `Your password and authenticator were reset. Set them again here (valid 3 days): ${link}`);
  await audit(db(), adminWho(req), "admin.force_reset", { type: "admin_user", id: params.id }, null, { reason: body.reason });
  return { ok: true, inviteLink: link };
});

r.route({ method: "put", path: "/users/:id/ip-allowlist", summary: "Limit an admin to certain IP addresses", auth: "admin", perm: "users.manage", reauth: true, body: z.object({ ips: z.array(z.union([z.ipv4(), z.ipv6()])).max(20) }) }, async ({ req, params, body }) => {
  const before = await one<{ ip_allowlist: string[] }>(db(), `select ip_allowlist from admin_users where id = $1`, [params.id]);
  if (!before) throw notFound("Admin not found");
  await db().query(`update admin_users set ip_allowlist = $2 where id = $1`, [params.id, body.ips]);
  await audit(db(), adminWho(req), "admin.ip_allowlist", { type: "admin_user", id: params.id }, before, { ip_allowlist: body.ips });
  return { ok: true };
});

// ------------------------------------------------------------------ approvals

r.route({ method: "get", path: "/approvals", summary: "Four-eyes requests", auth: "admin", perm: "approvals.view", query: z.object({ status: z.enum(["pending", "approved", "rejected", "executed", "failed", "cancelled", "all"]).default("pending") }) }, async ({ query }) => ({
  items: await many(
    db(),
    `select a.*, rq.name as requested_by_name, dc.name as decided_by_name from approvals a left join admin_users rq on rq.id = a.requested_by left join admin_users dc on dc.id = a.decided_by
      ${query.status === "all" ? "" : "where a.status = $1"} order by a.requested_at desc limit 300`,
    query.status === "all" ? [] : [query.status],
  ),
  singleOperator: await getSetting("single_operator"),
}));

r.route({ method: "post", path: "/approvals/:id/approve", summary: "Approve and execute", auth: "admin", perm: "approvals.view", reauth: true, body: z.object({ note: z.string().max(500).default("") }) }, async ({ req, params, body }) =>
  decideApproval(params.id, true, { id: adm(req).id, role: adm(req).role, label: adm(req).name }, body.note, adminWho(req)),
);
r.route({ method: "post", path: "/approvals/:id/reject", summary: "Reject", auth: "admin", perm: "approvals.view", body: z.object({ note: zReason }) }, async ({ req, params, body }) =>
  decideApproval(params.id, false, { id: adm(req).id, role: adm(req).role, label: adm(req).name }, body.note, adminWho(req)),
);
r.route({ method: "post", path: "/approvals/:id/cancel", summary: "Withdraw your own request", auth: "admin", perm: "approvals.view" }, async ({ req, params }) => {
  await cancelApproval(params.id, adm(req).id, adminWho(req));
  return { ok: true };
});

// ------------------------------------------------------------------ disputes

r.route({ method: "get", path: "/disputes", summary: "Disputes inbox", auth: "admin", perm: "disputes.view", query: z.object({ status: z.string().max(40).optional(), mine: z.coerce.boolean().optional() }) }, async ({ req, query }) => {
  const where = ["true"];
  const params: unknown[] = [];
  if (query.status) params.push(query.status.split(",")), where.push(`d.status = any($${params.length}::text[])`);
  if (query.mine) params.push(adm(req).id), where.push(`d.assignee_id = $${params.length}`);
  return {
    items: await many(
      db(),
      `select d.*, m.business_name as merchant, a.name as assignee, (select count(*)::int from dispute_messages x where x.dispute_id = d.id) as messages,
              (select author_type from dispute_messages x where x.dispute_id = d.id order by created_at desc limit 1) as last_author
         from disputes d join merchants m on m.id = d.merchant_id left join admin_users a on a.id = d.assignee_id where ${where.join(" and ")} order by d.updated_at desc limit 300`,
      params,
    ),
  };
});

r.route({ method: "get", path: "/disputes/:id", summary: "Dispute with messages and notes", auth: "admin", perm: "disputes.view" }, async ({ params }) => {
  const d = await one(db(), `select d.*, m.business_name as merchant from disputes d join merchants m on m.id = d.merchant_id where d.id = $1`, [params.id]);
  if (!d) throw notFound("Not found");
  return { dispute: d, messages: await many(db(), `select * from dispute_messages where dispute_id = $1 order by created_at`, [params.id]) };
});

r.route({ method: "post", path: "/disputes/:id/messages", summary: "Reply to the merchant, or add an internal note", auth: "admin", perm: "disputes.handle", body: z.object({ body: z.string().min(1).max(4000), internal: z.boolean().default(false) }) }, async ({ req, params, body }) => {
  const d = await one<{ merchant_id: string; ref: string; opened_by: string }>(db(), `select merchant_id, ref, opened_by from disputes where id = $1`, [params.id]);
  if (!d) throw notFound("Not found");
  await db().query(`insert into dispute_messages (dispute_id, author_type, author_id, author_label, body, internal) values ($1,'admin',$2,$3,$4,$5)`, [params.id, adm(req).id, "Aura Pool support", body.body, body.internal]);
  await db().query(`update disputes set updated_at = now(), status = case when $2 then status when status = 'open' then 'waiting_merchant' else status end where id = $1`, [params.id, body.internal]);
  if (!body.internal) await notifyMerchant(db(), d.merchant_id, { type: "dispute_reply", title: `Support replied on ${d.ref}`, body: body.body.slice(0, 140), url: `/more/disputes/${params.id}`, onlyUserId: d.opened_by });
  await audit(db(), adminWho(req), body.internal ? "dispute.note" : "dispute.reply", { type: "dispute", id: params.id });
  return { ok: true };
});

r.route({ method: "post", path: "/disputes/:id/status", summary: "Change status or assignee", auth: "admin", perm: "disputes.handle", body: z.object({ status: z.enum(["open", "in_progress", "waiting_merchant", "resolved", "closed"]).optional(), assigneeId: z.string().uuid().nullable().optional() }) }, async ({ req, params, body }) => {
  const before = await one(db(), `select status, assignee_id from disputes where id = $1`, [params.id]);
  if (!before) throw notFound("Not found");
  if (body.status) await db().query(`update disputes set status = $2, updated_at = now() where id = $1`, [params.id, body.status]);
  if (body.assigneeId !== undefined) await db().query(`update disputes set assignee_id = $2, updated_at = now() where id = $1`, [params.id, body.assigneeId]);
  await audit(db(), adminWho(req), "dispute.update", { type: "dispute", id: params.id }, before, body);
  return { ok: true };
});

// ------------------------------------------------------------------ impersonation (read-only)

r.route({ method: "post", path: "/impersonations", summary: "Open a 15-minute read-only view as a merchant", auth: "admin", perm: "impersonate", body: z.object({ merchantId: z.string().uuid(), reason: zReason }) }, async ({ req, body }) => {
  const m = await one<{ business_name: string }>(db(), `select business_name from merchants where id = $1`, [body.merchantId]);
  if (!m) throw notFound("Merchant not found");
  const i = await one<{ id: string; expires_at: Date }>(db(), `insert into impersonations (admin_id, merchant_id, reason, expires_at) values ($1,$2,$3, now() + interval '15 minutes') returning id, expires_at`, [adm(req).id, body.merchantId, body.reason]);
  await audit(db(), adminWho(req), "impersonation.start", { type: "merchant", id: body.merchantId }, null, { reason: body.reason, impersonation: i!.id });
  return { id: i!.id, expiresAt: i!.expires_at, businessName: m.business_name };
});

r.route({ method: "post", path: "/impersonations/:id/end", summary: "End a read-only view", auth: "admin", perm: "impersonate" }, async ({ req, params }) => {
  await db().query(`update impersonations set ended_at = now() where id = $1 and admin_id = $2 and ended_at is null`, [params.id, adm(req).id]);
  await audit(db(), adminWho(req), "impersonation.end", { type: "impersonation", id: params.id });
  return { ok: true };
});

/**
 * Mounted at /v1/a/impersonations/:id/m: becomes the merchant's owner for GET requests only.
 * Writes are refused by the route guard; nothing about money can move.
 */
export function impersonationGate() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const a = req.actor;
      if (!a || a.kind !== "admin" || !can(a.role, "impersonate")) throw forbidden();
      if (req.method !== "GET") throw forbidden("This is a read-only view", "read_only");
      const i = await one<{ merchant_id: string; expires_at: Date; ended_at: Date | null; admin_id: string }>(db(), `select merchant_id, expires_at, ended_at, admin_id from impersonations where id = $1`, [req.params.impId]);
      if (!i || i.admin_id !== a.id || i.ended_at || new Date(i.expires_at) < new Date()) throw forbidden("This view has ended", "impersonation_ended");
      const o = await one<{ id: string; name: string; phone: string; m_status: MerchantActor["merchantStatus"] }>(db(), `select u.id, u.name, u.phone, m.status as m_status from merchant_users u join merchants m on m.id = u.merchant_id where u.merchant_id = $1 and u.role = 'owner'`, [i.merchant_id]);
      if (!o) throw notFound("This merchant has no owner account");
      req.actor = { kind: "merchant", userId: o.id, merchantId: i.merchant_id, role: "owner", name: o.name, phone: o.phone, sessionId: null, merchantStatus: o.m_status, impersonatedBy: a.id };
      next();
    } catch (e) {
      next(e);
    }
  };
}

// ------------------------------------------------------------------ announcements

r.route({ method: "get", path: "/announcements", summary: "Announcements sent", auth: "admin", perm: "merchants.view" }, async () => ({ items: await many(db(), `select a.*, u.name as sent_by_name from announcements a left join admin_users u on u.id = a.sent_by order by a.created_at desc limit 200`) }));

r.route(
  { method: "post", path: "/announcements", summary: "Send a message to all or selected merchants", auth: "admin", perm: "announcements.send", body: z.object({ title: z.string().min(3).max(80), body: z.string().min(3).max(500), audience: z.enum(["all", "selected"]), merchantIds: z.array(z.string().uuid()).max(500).default([]), channels: z.array(z.enum(["in_app", "push", "sms"])).min(1) }) },
  async ({ req, body }) => {
    if (body.audience === "selected" && !body.merchantIds.length) throw badRequest("Pick at least one merchant");
    const merchants = await many<{ id: string; phone: string }>(db(), `select id, phone from merchants where status in ('active','suspended') ${body.audience === "selected" ? "and id = any($1::uuid[])" : ""}`, body.audience === "selected" ? [body.merchantIds] : []);
    for (const m of merchants) {
      await notifyMerchant(db(), m.id, { type: "announcement", title: body.title, body: body.body, url: "/alerts" });
      if (body.channels.includes("sms")) await sendSms(m.phone, `Aura Pool: ${body.title}. ${body.body}`.slice(0, 300));
    }
    const a = await one(db(), `insert into announcements (title, body, audience, merchant_ids, channels, recipients, sent_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`, [body.title, body.body, body.audience, body.merchantIds, body.channels, merchants.length, adm(req).id]);
    await audit(db(), adminWho(req), "announcement.send", { type: "announcement", id: String(a!.id) }, null, { title: body.title, recipients: merchants.length, channels: body.channels });
    return { id: a!.id, recipients: merchants.length };
  },
);

// ------------------------------------------------------------------ simulator (sandbox only)

function sandboxOnly() {
  if (env.provider !== "simulated") throw unavailable("The simulator runs only with the simulated provider", "not_sandbox");
}

r.route({ method: "get", path: "/sim", summary: "Simulated M-Pesa balances and virtual devices", auth: "admin", perm: "simulator.use" }, async () => {
  sandboxOnly();
  return { balances: await simulatorBalances(), devices: virtualDevices(), testNumbers: { payoutFails: "ending 000", payoutTimesOut: "ending 999", stkCancelled: "ending 000" } };
});

r.route(
  { method: "post", path: "/sim/payment", summary: "A customer pays the Paybill (validation then confirmation)", auth: "admin", perm: "simulator.use", body: z.object({ accountRef: z.string().max(20), amountMinor: z.number().int().positive().max(25_000_000), msisdn: z.string().max(16).optional(), duplicate: z.boolean().default(false), skipValidation: z.boolean().default(false), forged: z.boolean().default(false) }) },
  async ({ req, body }) => {
    sandboxOnly();
    const msisdn = body.msisdn ? normaliseMsisdn(body.msisdn) ?? undefined : undefined;
    const out = await simulateC2B({ ...body, msisdn });
    await audit(db(), adminWho(req), "sim.payment", null, null, { ...body, msisdn: msisdn ? maskMsisdn(msisdn) : null, txn: out.txn });
    return out;
  },
);

r.route({ method: "post", path: "/sim/transfer", summary: "Move money in the simulated M-Pesa portal (then record it)", auth: "admin", perm: "simulator.use", body: z.object({ from: z.enum(["utility", "working"]), to: z.enum(["utility", "working"]), amountMinor: z.number().int().positive() }) }, async ({ req, body }) => {
  sandboxOnly();
  if (body.from === body.to) throw badRequest("Pick two different accounts");
  const out = await simulatePortalTransfer(body.from, body.to, body.amountMinor);
  await audit(db(), adminWho(req), "sim.portal_transfer", null, null, { ...body, ...out });
  return out;
});

r.route({ method: "post", path: "/sim/device/:tableId/:action", summary: "Virtual device: press override, go offline, come back", auth: "admin", perm: "simulator.use" }, async ({ params }) => {
  sandboxOnly();
  const ok = await virtualAction(params.tableId, params.action as "override" | "offline" | "online");
  if (!ok) throw notFound("No virtual device on that table");
  return { ok: true };
});

// Wired by the server.
let deviceStatus: () => unknown = () => null;
let virtualDevices: () => unknown[] = () => [];
let virtualAction: (tableId: string, action: "override" | "offline" | "online") => Promise<boolean> = async () => false;
let localUrl: () => string = () => env.publicUrl;
export function wireOps(h: { deviceStatus: () => unknown; virtualDevices: () => unknown[]; virtualAction: typeof virtualAction; localUrl: () => string }) {
  deviceStatus = h.deviceStatus;
  virtualDevices = h.virtualDevices;
  virtualAction = h.virtualAction;
  localUrl = h.localUrl;
}
