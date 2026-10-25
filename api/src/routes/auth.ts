import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import QRCode from "qrcode";
import { z } from "zod";
import { env } from "../config/env.js";
import { db, one } from "../config/db.js";
import { Api, zPin } from "../lib/api.js";
import { decrypt, encrypt, hashPassword, hashSecret, newTotpSecret, randomToken, sha256, totpUri, verifyPassword, verifyTotp } from "../lib/crypto.js";
import { badRequest, conflict, forbidden, locked, notFound, unauthorized } from "../lib/http.js";
import { maskMsisdn, normaliseMsisdn } from "../lib/kenya.js";
import { permissionsFor } from "../lib/permissions.js";
import { raise } from "../services/alerts.js";
import { audit } from "../services/audit.js";
import { invitePin, inviteByToken, inviteVerify, login } from "../services/merchants.js";
import { endSession, refreshSession, startSession } from "../services/sessions.js";
import { getSetting } from "../services/settings.js";
import { loginOptions, verifyLogin } from "../services/webauthn.js";

// /v1/auth — signing in. Merchants: invite → PIN → SMS code → terms, then PIN or biometrics.
// Admins: email + password + mandatory TOTP; recovery codes shown once at setup.

export const authApi = new Api("/v1/auth", "Auth");
const r = authApi;

// ------------------------------------------------------------------ merchants

r.route({ method: "get", path: "/invite/:token", summary: "Look up an invite", auth: "public" }, async ({ params }) => {
  const inv = await inviteByToken(db(), params.token);
  return { businessName: inv.business_name, name: inv.name, role: inv.role, phoneMasked: maskMsisdn(inv.phone), pinSet: Boolean(inv.pin_hash), termsVersion: await getSetting("terms_version") };
});

r.route(
  { method: "post", path: "/otp/request", summary: "Choose a PIN and send the phone a code (onboarding)", auth: "public", body: z.object({ inviteToken: z.string().min(10).max(100), pin: zPin, pinConfirm: zPin }) },
  async ({ body }) => {
    if (body.pin !== body.pinConfirm) throw badRequest("The two PINs don't match", "pin_mismatch");
    return invitePin(body.inviteToken, body.pin);
  },
);

r.route(
  { method: "post", path: "/otp/verify", summary: "Confirm the code, accept the terms, sign in", auth: "public", body: z.object({ inviteToken: z.string().min(10).max(100), code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code"), acceptTerms: z.literal(true, { message: "Accept the terms and privacy policy to continue" }) }) },
  async ({ body, req, res }) => {
    const u = await inviteVerify(body.inviteToken, body.code);
    await startSession(db(), res, req, "merchant", u.id, u.token_version);
    return { ok: true };
  },
);

r.route({ method: "post", path: "/login", summary: "Sign in with phone and PIN", auth: "public", body: z.object({ phone: z.string().min(9).max(16), pin: zPin }) }, async ({ body, req, res }) => {
  const u = await login(body.phone, body.pin);
  await startSession(db(), res, req, "merchant", u.id, u.token_version);
  await audit(db(), { type: "merchant", id: u.id, ip: req.ip, ua: String(req.headers["user-agent"] ?? "") }, "merchant_user.login", { type: "merchant_user", id: u.id });
  return { ok: true };
});

r.route({ method: "post", path: "/webauthn/options", summary: "Start a fingerprint sign-in", auth: "public", body: z.object({ phone: z.string().min(9).max(16) }) }, async ({ body }) => {
  const phone = normaliseMsisdn(body.phone);
  const u = phone ? await one<{ id: string; status: string }>(db(), `select id, status from merchant_users where phone = $1`, [phone]) : null;
  if (!u || u.status !== "active") throw badRequest("Fingerprint sign-in isn't set up for that number. Use your PIN.", "no_credentials");
  return loginOptions(u.id);
});

r.route({ method: "post", path: "/webauthn/verify", summary: "Finish a fingerprint sign-in", auth: "public", body: z.object({ phone: z.string().min(9).max(16), response: z.any() }) }, async ({ body, req, res }) => {
  const phone = normaliseMsisdn(body.phone);
  const u = phone ? await one<{ id: string; status: string; token_version: number; locked_until: Date | null }>(db(), `select id, status, token_version, locked_until from merchant_users where phone = $1`, [phone]) : null;
  if (!u || u.status !== "active") throw unauthorized("Use your PIN to sign in");
  if (u.locked_until && new Date(u.locked_until) > new Date()) throw locked("This account is locked for a few minutes after too many wrong PINs.");
  await verifyLogin(u.id, body.response);
  await startSession(db(), res, req, "merchant", u.id, u.token_version);
  await audit(db(), { type: "merchant", id: u.id, ip: req.ip }, "merchant_user.login", { type: "merchant_user", id: u.id }, null, { method: "webauthn" });
  return { ok: true };
});

r.route({ method: "post", path: "/refresh", summary: "Rotate the merchant session", auth: "public" }, async ({ req, res }) => {
  await refreshSession(req, res, "merchant");
  return { ok: true };
});

r.route({ method: "post", path: "/logout", summary: "Sign out this device", auth: "public" }, async ({ req, res }) => {
  await endSession(req, res, "merchant");
  return { ok: true };
});

// ------------------------------------------------------------------ admins

const MFA_COOKIE = "aura_a_mfa";
type Pending = { sub: string; stage: "totp" | "setup" };

function setPending(res: Response, p: Pending) {
  const token = jwt.sign({ stage: p.stage }, env.jwtSecret, { subject: p.sub, audience: "aura-admin-mfa", expiresIn: 600 });
  res.cookie(MFA_COOKIE, token, { httpOnly: true, secure: env.nodeEnv === "production", sameSite: "strict", path: "/v1/auth/admin", maxAge: 600_000 });
}
function readPending(req: Request, stage: Pending["stage"]): string {
  try {
    const c = jwt.verify(String(req.cookies?.[MFA_COOKIE] ?? ""), env.jwtSecret, { audience: "aura-admin-mfa" }) as jwt.JwtPayload;
    if (c.stage !== stage) throw new Error("stage");
    return String(c.sub);
  } catch {
    throw unauthorized("That step expired. Start signing in again.", "mfa_expired");
  }
}

type AdminRow = { id: string; email: string; name: string; role: string; status: string; password_hash: string | null; totp_secret_enc: string | null; totp_enabled_at: Date | null; last_totp_step: number | null; recovery_codes: string[]; failed_attempts: number; locked_until: Date | null; ip_allowlist: string[]; token_version: number };

async function recordFailure(a: AdminRow, req: Request, why: string) {
  const rules = await getSetting("alert_rules");
  const n = a.failed_attempts + 1;
  const lock = n >= rules.failed_logins;
  await db().query(`update admin_users set failed_attempts = case when $2 then 0 else $3 end, locked_until = case when $2 then now() + interval '15 minutes' else locked_until end where id = $1`, [a.id, lock, n]);
  await audit(db(), { type: "admin", id: a.id, label: a.email, ip: req.ip, ua: String(req.headers["user-agent"] ?? "") }, "admin.login_failed", { type: "admin_user", id: a.id }, null, { why, attempt: n });
  if (lock) {
    await raise(db(), { type: "failed_logins", severity: "warning", title: `Admin account ${a.email} locked after ${n} failed sign-ins`, detail: `Last attempt from ${req.ip}.`, dedupeKey: `failed_logins:${a.id}` });
  }
}

r.route({ method: "get", path: "/admin/setup", summary: "Whether the first admin still needs creating", auth: "public" }, async () => {
  const any = await one(db(), `select 1 from admin_users where status = 'active' limit 1`);
  return { needed: !any, setupEnabled: Boolean(env.adminSetupToken) };
});

async function totpEnrolment(a: { id: string; email: string }, res: Response) {
  const secret = newTotpSecret();
  await db().query(`update admin_users set totp_secret_enc = $2, totp_enabled_at = null where id = $1`, [a.id, encrypt(secret)]);
  setPending(res, { sub: a.id, stage: "setup" });
  const uri = totpUri(secret, a.email);
  return { secret, otpauthUri: uri, qrSvg: await QRCode.toString(uri, { type: "svg", margin: 1, width: 220 }) };
}

r.route(
  {
    method: "post",
    path: "/admin/setup",
    summary: "Create the first super admin (needs ADMIN_SETUP_TOKEN)",
    auth: "public",
    body: z.object({ setupToken: z.string().min(8), email: z.string().email(), name: z.string().min(2).max(80), phone: z.string().min(9).max(16).optional(), password: z.string().min(12, "Use at least 12 characters").max(200) }),
  },
  async ({ body, res, req }) => {
    if (!env.adminSetupToken || hashSecret(body.setupToken) !== hashSecret(env.adminSetupToken)) throw forbidden("That setup key isn't right");
    if (await one(db(), `select 1 from admin_users where status = 'active' limit 1`)) throw conflict("The first admin already exists. Ask them for an invite.");
    const email = body.email.trim().toLowerCase();
    const phone = body.phone ? normaliseMsisdn(body.phone) : null;
    await db().query(`delete from admin_users where status = 'invited' and email = $1`, [email]);
    const a = await one<{ id: string; email: string }>(db(), `insert into admin_users (email, name, phone, role, status, password_hash) values ($1,$2,$3,'super_admin','invited',$4) returning id, email`, [email, body.name.trim(), phone, await hashPassword(body.password)]);
    await audit(db(), { type: "admin", id: a!.id, label: email, ip: req.ip }, "admin.setup_started", { type: "admin_user", id: a!.id });
    return totpEnrolment(a!, res);
  },
);

r.route({ method: "get", path: "/admin/invite/:token", summary: "Look up an admin invite", auth: "public" }, async ({ params }) => {
  const a = await one<{ email: string; name: string; role: string; invite_expires_at: Date }>(db(), `select email, name, role, invite_expires_at from admin_users where invite_token_hash = $1`, [hashSecret(params.token)]);
  if (!a || new Date(a.invite_expires_at) < new Date()) throw notFound("This invite has expired. Ask for a new one.");
  return { email: a.email, name: a.name, role: a.role };
});

r.route(
  { method: "post", path: "/admin/invite/:token", summary: "Accept an admin invite: set a password, then the authenticator", auth: "public", body: z.object({ password: z.string().min(12, "Use at least 12 characters").max(200) }) },
  async ({ params, body, res }) => {
    const a = await one<{ id: string; email: string; invite_expires_at: Date; status: string }>(db(), `select id, email, invite_expires_at, status from admin_users where invite_token_hash = $1`, [hashSecret(params.token)]);
    if (!a || new Date(a.invite_expires_at) < new Date() || a.status === "deactivated") throw notFound("This invite has expired. Ask for a new one.");
    await db().query(`update admin_users set password_hash = $2, must_reset = false where id = $1`, [a.id, await hashPassword(body.password)]);
    return totpEnrolment(a, res);
  },
);

r.route({ method: "post", path: "/admin/setup/confirm", summary: "Confirm the authenticator; returns recovery codes once", auth: "public", body: z.object({ code: z.string().regex(/^\d{6}$/) }) }, async ({ body, req, res }) => {
  const id = readPending(req, "setup");
  const a = await one<AdminRow>(db(), `select * from admin_users where id = $1`, [id]);
  if (!a?.totp_secret_enc) throw unauthorized("Start again");
  const step = verifyTotp(decrypt(a.totp_secret_enc), body.code);
  if (step == null) throw badRequest("That code isn't right. Check the time on your phone and try the newest code.", "totp_wrong");
  const codes = Array.from({ length: 10 }, () => randomToken(6).replace(/[-_]/g, "x").slice(0, 10).toUpperCase());
  await db().query(
    `update admin_users set status = 'active', totp_enabled_at = now(), last_totp_step = $2, recovery_codes = $3, invite_token_hash = null, invite_expires_at = null, failed_attempts = 0, locked_until = null, token_version = token_version + 1, last_login_at = now() where id = $1`,
    [id, step, JSON.stringify(codes.map((c) => sha256(c)))],
  );
  res.clearCookie(MFA_COOKIE, { path: "/v1/auth/admin" });
  const fresh = await one<{ token_version: number }>(db(), `select token_version from admin_users where id = $1`, [id]);
  await startSession(db(), res, req, "admin", id, fresh!.token_version);
  await audit(db(), { type: "admin", id, label: a.email, ip: req.ip }, "admin.mfa_enrolled", { type: "admin_user", id });
  return { recoveryCodes: codes };
});

r.route({ method: "post", path: "/login/admin", summary: "Admin sign-in, step 1: email and password", auth: "public", body: z.object({ email: z.string().email(), password: z.string().min(1).max(200) }) }, async ({ body, req, res }) => {
  const a = await one<AdminRow>(db(), `select * from admin_users where email = $1`, [body.email.trim().toLowerCase()]);
  const fail = () => badRequest("That email and password don't match an account", "bad_login");
  if (!a || !a.password_hash) {
    await verifyPassword(body.password, "$2a$11$C6UzMDM.H6dfI/f/IKcEeO5H3vX2c2q3b8w7o3yQ1Gk7JXq7Gk7JX").catch(() => false);
    throw fail();
  }
  if (a.status === "deactivated") throw forbidden("This account is deactivated");
  if (a.locked_until && new Date(a.locked_until) > new Date()) throw locked("Too many failed attempts. Try again in 15 minutes.");
  if (a.ip_allowlist.length && !a.ip_allowlist.includes(req.ip ?? "")) {
    await recordFailure(a, req, "ip not allowed");
    throw forbidden("This account can't sign in from this network", "ip_not_allowed");
  }
  if (!(await verifyPassword(body.password, a.password_hash))) {
    await recordFailure(a, req, "password");
    throw fail();
  }
  if (a.status !== "active" || !a.totp_enabled_at) throw forbidden("Finish setting up this account from your invite link first", "setup_incomplete");
  setPending(res, { sub: a.id, stage: "totp" });
  return { next: "totp" };
});

r.route(
  { method: "post", path: "/login/admin/totp", summary: "Admin sign-in, step 2: authenticator or recovery code", auth: "public", body: z.object({ code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().min(6).max(20).optional() }) },
  async ({ body, req, res }) => {
    const id = readPending(req, "totp");
    const a = await one<AdminRow>(db(), `select * from admin_users where id = $1`, [id]);
    if (!a || a.status !== "active" || !a.totp_secret_enc) throw unauthorized("Start signing in again");
    if (a.locked_until && new Date(a.locked_until) > new Date()) throw locked("Too many failed attempts. Try again in 15 minutes.");
    let method = "totp";
    if (body.code) {
      const step = verifyTotp(decrypt(a.totp_secret_enc), body.code);
      if (step == null || (a.last_totp_step != null && step <= Number(a.last_totp_step))) {
        await recordFailure(a, req, "totp");
        throw badRequest("That code isn't right", "totp_wrong");
      }
      await db().query(`update admin_users set last_totp_step = $2 where id = $1`, [id, step]);
    } else if (body.recoveryCode) {
      const h = sha256(body.recoveryCode.trim().toUpperCase());
      if (!a.recovery_codes.includes(h)) {
        await recordFailure(a, req, "recovery code");
        throw badRequest("That recovery code isn't right", "recovery_wrong");
      }
      await db().query(`update admin_users set recovery_codes = $2 where id = $1`, [id, JSON.stringify(a.recovery_codes.filter((c) => c !== h))]);
      method = "recovery_code";
    } else throw badRequest("Enter the code from your authenticator app");
    await db().query(`update admin_users set failed_attempts = 0, locked_until = null, last_login_at = now() where id = $1`, [id]);
    res.clearCookie(MFA_COOKIE, { path: "/v1/auth/admin" });
    await startSession(db(), res, req, "admin", id, a.token_version);
    await audit(db(), { type: "admin", id, label: a.email, ip: req.ip, ua: String(req.headers["user-agent"] ?? "") }, "admin.login", { type: "admin_user", id }, null, { method, recoveryCodesLeft: method === "recovery_code" ? a.recovery_codes.length - 1 : a.recovery_codes.length });
    return { ok: true, recoveryCodesLeft: method === "recovery_code" ? a.recovery_codes.length - 1 : undefined, permissions: permissionsFor(a.role as never) };
  },
);

r.route({ method: "post", path: "/admin/refresh", summary: "Rotate the admin session", auth: "public" }, async ({ req, res }) => {
  await refreshSession(req, res, "admin");
  return { ok: true };
});

r.route({ method: "post", path: "/admin/logout", summary: "Sign out of the console", auth: "public" }, async ({ req, res }) => {
  await endSession(req, res, "admin");
  return { ok: true };
});
