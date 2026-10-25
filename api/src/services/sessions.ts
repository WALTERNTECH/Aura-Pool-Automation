import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import { db, one, type Q } from "../config/db.js";
import { hashSecret, randomToken, safeEqual } from "../lib/crypto.js";
import { unauthorized } from "../lib/http.js";

// Sessions: a short-lived access token and a rotating refresh token, both in httpOnly
// cookies on the app's own origin. Presenting a refresh token that was already rotated
// revokes the whole session (it was stolen or replayed). Merchants are signed out after
// 30 days idle; admins after 30 minutes without activity.

export type Kind = "merchant" | "admin";
const COOKIES = {
  merchant: { at: "aura_m_at", rt: "aura_m_rt", accessTtl: 15 * 60, idleS: 30 * 24 * 3600, maxS: 90 * 24 * 3600 },
  admin: { at: "aura_a_at", rt: "aura_a_rt", accessTtl: 5 * 60, idleS: 30 * 60, maxS: 12 * 3600 },
} as const;

export type Claims = { sub: string; sid: string; k: Kind; tv: number };

const secure = () => env.nodeEnv === "production";

function setCookies(res: Response, kind: Kind, access: string, refresh: string) {
  const c = COOKIES[kind];
  res.cookie(c.at, access, { httpOnly: true, secure: secure(), sameSite: "strict", path: "/", maxAge: c.accessTtl * 1000 });
  res.cookie(c.rt, refresh, { httpOnly: true, secure: secure(), sameSite: "strict", path: "/v1/auth", maxAge: c.idleS * 1000 });
}

export function clearCookies(res: Response, kind: Kind) {
  const c = COOKIES[kind];
  res.clearCookie(c.at, { path: "/" });
  res.clearCookie(c.rt, { path: "/v1/auth" });
}

function accessToken(kind: Kind, userId: string, sid: string, tv: number) {
  return jwt.sign({ sid, k: kind, tv }, env.jwtSecret, { subject: userId, audience: `aura-${kind}`, expiresIn: COOKIES[kind].accessTtl });
}

export async function startSession(q: Q, res: Response, req: Request, kind: Kind, userId: string, tokenVersion: number) {
  const secret = randomToken(32);
  const s = await one<{ id: string }>(
    q,
    `insert into sessions (kind, user_id, refresh_hash, user_agent, ip, expires_at) values ($1,$2,$3,$4,$5, now() + ($6 || ' seconds')::interval) returning id`,
    [kind, userId, hashSecret(secret), String(req.headers["user-agent"] ?? "").slice(0, 300), req.ip ?? null, String(COOKIES[kind].maxS)],
  );
  setCookies(res, kind, accessToken(kind, userId, s!.id, tokenVersion), `${s!.id}.${secret}`);
  return s!.id;
}

/** Rotates the refresh token and issues a new access token. */
export async function refreshSession(req: Request, res: Response, kind: Kind) {
  const raw = String(req.cookies?.[COOKIES[kind].rt] ?? "");
  const [sid, secret] = raw.split(".");
  if (!sid || !secret || !/^[0-9a-f-]{36}$/.test(sid)) throw unauthorized("Your session has ended. Sign in again.", "session_ended");
  const out = await db().tx(async (q) => {
    const s = await one<{ id: string; user_id: string; refresh_hash: string; prev_refresh_hash: string | null; rotated_at: Date | null; revoked_at: Date | null; expires_at: Date; last_used_at: Date; last_active_at: Date }>(
      q,
      `select id, user_id, refresh_hash, prev_refresh_hash, rotated_at, revoked_at, expires_at, last_used_at, last_active_at from sessions where id = $1 and kind = $2 for update`,
      [sid, kind],
    );
    if (!s || s.revoked_at || new Date(s.expires_at) < new Date()) return null;
    const idle = (Date.now() - new Date(kind === "admin" ? s.last_active_at : s.last_used_at).getTime()) / 1000;
    if (idle > COOKIES[kind].idleS) {
      await q.query(`update sessions set revoked_at = now(), revoked_reason = 'idle' where id = $1`, [s.id]);
      return null;
    }
    const h = hashSecret(secret);
    const current = safeEqual(h, s.refresh_hash);
    const justRotated = !current && s.prev_refresh_hash && safeEqual(h, s.prev_refresh_hash) && s.rotated_at && Date.now() - new Date(s.rotated_at).getTime() < 30_000;
    if (!current && !justRotated) {
      await q.query(`update sessions set revoked_at = now(), revoked_reason = 'refresh token reuse' where id = $1`, [s.id]);
      return null;
    }
    const user = kind === "merchant"
      ? await one<{ token_version: number; status: string }>(q, `select token_version, status from merchant_users where id = $1`, [s.user_id])
      : await one<{ token_version: number; status: string }>(q, `select token_version, status from admin_users where id = $1`, [s.user_id]);
    if (!user || user.status !== "active") return null;
    const next = randomToken(32);
    await q.query(
      `update sessions set prev_refresh_hash = case when $3 then refresh_hash else prev_refresh_hash end, refresh_hash = $2,
              rotated_at = case when $3 then now() else rotated_at end, last_used_at = now() where id = $1`,
      [s.id, hashSecret(next), current],
    );
    return { access: accessToken(kind, s.user_id, s.id, user.token_version), refresh: `${s.id}.${next}` };
  });
  if (!out) {
    clearCookies(res, kind);
    throw unauthorized("Your session has ended. Sign in again.", "session_ended");
  }
  setCookies(res, kind, out.access, out.refresh);
}

export function readAccess(req: Request, kind: Kind): Claims | "expired" | null {
  const raw = req.cookies?.[COOKIES[kind].at];
  if (!raw) return null;
  try {
    const c = jwt.verify(raw, env.jwtSecret, { audience: `aura-${kind}` }) as jwt.JwtPayload;
    return { sub: String(c.sub), sid: String(c.sid), k: kind, tv: Number(c.tv) };
  } catch (e) {
    return (e as Error).name === "TokenExpiredError" ? "expired" : null;
  }
}

export async function endSession(req: Request, res: Response, kind: Kind) {
  const c = readAccess(req, kind);
  const raw = String(req.cookies?.[COOKIES[kind].rt] ?? "");
  const sid = c && c !== "expired" ? c.sid : raw.split(".")[0];
  if (sid && /^[0-9a-f-]{36}$/.test(sid)) await db().query(`update sessions set revoked_at = now(), revoked_reason = 'signed out' where id = $1 and revoked_at is null`, [sid]);
  clearCookies(res, kind);
}

export async function revokeAll(q: Q, kind: Kind, userId: string, reason: string, exceptSid?: string) {
  await q.query(`update sessions set revoked_at = now(), revoked_reason = $3 where kind = $1 and user_id = $2 and revoked_at is null and id is distinct from $4`, [kind, userId, reason, exceptSid ?? null]);
}

export async function listSessions(q: Q, kind: Kind, userId: string, currentSid: string | null) {
  const { rows } = await q.query<{ id: string; user_agent: string | null; ip: string | null; created_at: Date; last_used_at: Date }>(
    `select id, user_agent, ip, created_at, last_used_at from sessions where kind = $1 and user_id = $2 and revoked_at is null and expires_at > now() order by last_used_at desc`,
    [kind, userId],
  );
  return rows.map((r) => ({ id: r.id, device: describeAgent(r.user_agent), ip: r.ip, createdAt: r.created_at, lastUsedAt: r.last_used_at, current: r.id === currentSid }));
}

function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad/i.test(ua) ? "iPhone" : /Windows/i.test(ua) ? "Windows" : /Mac OS/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux" : "Device";
  const b = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  return `${b} on ${os}`;
}

export const COOKIE_NAMES = COOKIES;
