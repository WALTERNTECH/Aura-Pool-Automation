import type { NextFunction, Request, Response } from "express";
import { db, one } from "../config/db.js";
import type { AdminActor, AdminRole, MerchantActor } from "../lib/api.js";
import { forbidden, unauthorized } from "../lib/http.js";
import { readAccess } from "../services/sessions.js";

// Attaches the signed-in merchant user or admin to the request. Every request re-checks the
// session row and token version, so signing a device out takes effect at once.

export function merchantAuth() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const c = readAccess(req, "merchant");
      if (c === "expired") throw unauthorized("Your session needs refreshing", "token_expired");
      if (!c) return next();
      const u = await one<{ id: string; merchant_id: string; role: "owner" | "staff"; name: string; phone: string; status: string; token_version: number; m_status: MerchantActor["merchantStatus"]; revoked: boolean; last_seen_at: Date | null }>(
        db(),
        `select u.id, u.merchant_id, u.role, u.name, u.phone, u.status, u.token_version, m.status as m_status, u.last_seen_at,
                (s.revoked_at is not null or s.expires_at < now()) as revoked
           from merchant_users u join merchants m on m.id = u.merchant_id join sessions s on s.id = $2 and s.user_id = u.id and s.kind = 'merchant'
          where u.id = $1`,
        [c.sub, c.sid],
      );
      if (!u || u.revoked || u.status !== "active" || u.token_version !== c.tv) throw unauthorized("Your session has ended. Sign in again.", "session_ended");
      req.actor = { kind: "merchant", userId: u.id, merchantId: u.merchant_id, role: u.role, name: u.name, phone: u.phone, sessionId: c.sid, merchantStatus: u.m_status };
      if (!u.last_seen_at || Date.now() - new Date(u.last_seen_at).getTime() > 5 * 60_000) {
        db().query(`update merchant_users set last_seen_at = now() where id = $1`, [u.id]).catch(() => {});
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

const ADMIN_IDLE_MS = 30 * 60_000;

export function adminAuth() {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const c = readAccess(req, "admin");
      if (c === "expired") throw unauthorized("Your session needs refreshing", "token_expired");
      if (!c) return next();
      const a = await one<{ id: string; email: string; name: string; role: AdminRole; status: string; token_version: number; ip_allowlist: string[]; revoked: boolean; last_active_at: Date; reauth_at: Date | null }>(
        db(),
        `select a.id, a.email, a.name, a.role, a.status, a.token_version, a.ip_allowlist,
                (s.revoked_at is not null or s.expires_at < now()) as revoked, s.last_active_at, s.reauth_at
           from admin_users a join sessions s on s.id = $2 and s.user_id = a.id and s.kind = 'admin'
          where a.id = $1`,
        [c.sub, c.sid],
      );
      if (!a || a.revoked || a.status !== "active" || a.token_version !== c.tv) throw unauthorized("Your session has ended. Sign in again.", "session_ended");
      if (Date.now() - new Date(a.last_active_at).getTime() > ADMIN_IDLE_MS) {
        await db().query(`update sessions set revoked_at = now(), revoked_reason = 'idle' where id = $1`, [c.sid]);
        throw unauthorized("You were signed out after 30 minutes without activity", "session_ended");
      }
      if (a.ip_allowlist.length && !a.ip_allowlist.includes(req.ip ?? "")) throw forbidden("This account can't be used from this network", "ip_not_allowed");
      // Background refreshes (dashboard auto-refresh) don't count as activity.
      if (!req.headers["x-background"]) db().query(`update sessions set last_active_at = now() where id = $1`, [c.sid]).catch(() => {});
      req.actor = { kind: "admin", id: a.id, email: a.email, name: a.name, role: a.role, sessionId: c.sid, reauthAt: a.reauth_at ? new Date(a.reauth_at) : null } satisfies AdminActor;
      next();
    } catch (e) {
      next(e);
    }
  };
}

/**
 * CSRF: cookies are SameSite=Strict, and every state-changing request must carry the
 * X-Aura-Client header, which a cross-site form can't set and a cross-site script can't
 * send without a CORS preflight we never grant.
 */
export function requireClientHeader(req: Request, _res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  if (!req.headers["x-aura-client"]) return next(forbidden("Missing client header", "csrf"));
  next();
}
