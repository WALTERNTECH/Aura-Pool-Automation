import express, { type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { db, one } from "../config/db.js";
import { sha256 } from "./crypto.js";
import { badRequest, conflict, forbidden, unauthorized } from "./http.js";
import { can, type Permission } from "./permissions.js";

// Every endpoint is declared through `route()`: its auth, its permission, its body and
// query schemas, and whether it is money-moving (Idempotency-Key required). The same
// declarations generate the OpenAPI document, so the spec cannot drift from the code.

export type AdminRole = "super_admin" | "finance" | "support" | "auditor";
export type MerchantActor = {
  kind: "merchant";
  userId: string;
  merchantId: string;
  role: "owner" | "staff";
  name: string;
  phone: string;
  sessionId: string | null;
  merchantStatus: "invited" | "active" | "suspended" | "closed";
  /** Read-only view opened by an admin (impersonation). No writes of any kind. */
  impersonatedBy?: string;
};
export type AdminActor = {
  kind: "admin";
  id: string;
  email: string;
  name: string;
  role: AdminRole;
  sessionId: string;
  reauthAt: Date | null;
};
export type Actor = MerchantActor | AdminActor;

declare module "express-serve-static-core" {
  interface Request {
    actor?: Actor;
  }
}

/**
 * public: anyone. merchant: owner or staff of a merchant. owner: the owner only.
 * admin: a signed-in admin with `perm`. callback: provider callbacks (checked by the route).
 */
export type Auth = "public" | "merchant" | "owner" | "admin" | "callback" | "internal";
type Method = "get" | "post" | "put" | "patch" | "delete";

export type RouteSpec<B extends z.ZodType, Qy extends z.ZodType> = {
  method: Method;
  path: string;
  summary: string;
  auth: Auth;
  perm?: Permission;
  body?: B;
  query?: Qy;
  /** Money-moving: requires an Idempotency-Key header and replays the first response. */
  idempotent?: boolean;
  /** Needs a fresh re-authentication (admin) in the last 10 minutes. */
  reauth?: boolean;
  /** Writes are refused during a read-only impersonation. Defaults to true for non-GET. */
  writes?: boolean;
  /** The handler writes the response itself (files, redirects, streams). */
  raw?: boolean;
  description?: string;
};

export type Ctx<B, Qy> = {
  req: Request;
  res: Response;
  body: B;
  query: Qy;
  params: Record<string, string>;
  ip: string;
  ua: string;
};

type Registered = { method: Method; path: string; tag: string; spec: RouteSpec<z.ZodType, z.ZodType> };
export const REGISTRY: Registered[] = [];

export class Api {
  readonly router = express.Router({ mergeParams: true });
  constructor(
    readonly base: string,
    readonly tag: string,
  ) {}

  route<B extends z.ZodType = z.ZodUndefined, Qy extends z.ZodType = z.ZodUndefined>(
    spec: RouteSpec<B, Qy>,
    handler: (ctx: Ctx<z.infer<B>, z.infer<Qy>>) => Promise<unknown> | unknown,
  ) {
    REGISTRY.push({ method: spec.method, path: this.base + spec.path, tag: this.tag, spec: spec as never });
    this.router[spec.method](spec.path, async (req: Request, res: Response, next: NextFunction) => {
      try {
        guard(req, spec);
        const body = spec.body ? spec.body.parse(req.body ?? {}) : undefined;
        const query = spec.query ? spec.query.parse(req.query ?? {}) : undefined;
        const ctx: Ctx<z.infer<B>, z.infer<Qy>> = {
          req,
          res,
          body: body as z.infer<B>,
          query: query as z.infer<Qy>,
          params: req.params as Record<string, string>,
          ip: req.ip ?? "",
          ua: String(req.headers["user-agent"] ?? "").slice(0, 300),
        };
        if (spec.idempotent) {
          await idempotent(req, res, () => handler(ctx));
          return;
        }
        const out = await handler(ctx);
        if (!spec.raw && !res.headersSent) res.json(out ?? { ok: true });
      } catch (e) {
        next(e);
      }
    });
    return this;
  }
}

function guard(req: Request, spec: RouteSpec<z.ZodType, z.ZodType>) {
  const a = req.actor;
  switch (spec.auth) {
    case "public":
    case "callback":
    case "internal":
      return;
    case "merchant":
    case "owner": {
      if (!a || a.kind !== "merchant") throw unauthorized();
      if (spec.auth === "owner" && a.role !== "owner") throw forbidden("Only the owner can do this");
      const writes = spec.writes ?? spec.method !== "get";
      if (a.impersonatedBy && writes) throw forbidden("This is a read-only view", "read_only");
      return;
    }
    case "admin": {
      if (!a || a.kind !== "admin") throw unauthorized();
      if (spec.perm && !can(a.role, spec.perm)) throw forbidden("Your role doesn't allow this", "role_forbidden");
      if (spec.reauth && (!a.reauthAt || Date.now() - a.reauthAt.getTime() > 10 * 60_000)) {
        throw forbidden("Confirm it's you to continue", "reauth_required");
      }
      return;
    }
  }
}

/** Replays the first response for a repeated Idempotency-Key; refuses a key reused for a different request. */
async function idempotent(req: Request, res: Response, run: () => Promise<unknown> | unknown) {
  const key = String(req.headers["idempotency-key"] ?? "");
  if (!/^[A-Za-z0-9_\-:.]{8,100}$/.test(key)) throw badRequest("Missing Idempotency-Key header", "idempotency_key_required");
  const a = req.actor;
  const who = a ? (a.kind === "admin" ? `a:${a.id}` : `m:${a.userId}`) : `ip:${req.ip}`;
  const scope = `${who}:${req.method}:${req.baseUrl}${req.route?.path ?? req.path}`;
  const hash = sha256(JSON.stringify({ p: req.params, b: req.body ?? null }));
  const q = db();
  const inserted = await one(q, `insert into idempotency_keys (scope, key, request_hash) values ($1,$2,$3) on conflict do nothing returning key`, [scope, key, hash]);
  if (!inserted) {
    const prior = await one<{ request_hash: string; status_code: number | null; response: unknown }>(q, `select request_hash, status_code, response from idempotency_keys where scope = $1 and key = $2`, [scope, key]);
    if (prior && prior.request_hash !== hash) throw conflict("This request key was already used for a different request", "idempotency_mismatch");
    if (!prior || prior.status_code == null) throw conflict("That request is still being processed", "in_progress");
    res.setHeader("Idempotent-Replay", "true");
    res.status(prior.status_code).json(prior.response);
    return;
  }
  try {
    const out = (await run()) ?? { ok: true };
    await q.query(`update idempotency_keys set status_code = 200, response = $3 where scope = $1 and key = $2`, [scope, key, JSON.stringify(out)]);
    res.json(out);
  } catch (e) {
    // A failed attempt may be retried with the same key.
    await q.query(`delete from idempotency_keys where scope = $1 and key = $2`, [scope, key]).catch(() => {});
    throw e;
  }
}

// ------------------------------------------------------------------ common schemas
export const zMoney = z.number().int().nonnegative();
export const zPin = z.string().regex(/^\d{6}$/, "Enter your 6-digit PIN");
export const zPhone = z.string().min(9).max(16);
export const zUuid = z.string().uuid();
export const zLimit = z.coerce.number().int().min(1).max(200).default(50);
export const zCursor = z.string().max(200).optional();
export const zDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

/** Cursor pagination over (timestamp, id). */
export function encodeCursor(at: Date | string, id: string | number): string {
  return Buffer.from(JSON.stringify([new Date(at).toISOString(), String(id)])).toString("base64url");
}
export function decodeCursor(c: string | undefined): { at: string; id: string } | null {
  if (!c) return null;
  try {
    const [at, id] = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    if (typeof at !== "string" || typeof id !== "string") return null;
    return { at, id };
  } catch {
    return null;
  }
}
export function page<T extends Record<string, unknown>>(rows: T[], limit: number, atKey: keyof T, idKey: keyof T) {
  const more = rows.length > limit;
  const items = more ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return { items, nextCursor: more && last ? encodeCursor(last[atKey] as Date, last[idKey] as string) : null };
}

// ------------------------------------------------------------------ OpenAPI
export function openapi(info: { version: string; serverUrl: string }) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of REGISTRY) {
    const p = r.path.replace(/:([A-Za-z_]+)/g, "{$1}");
    const params: unknown[] = [...r.path.matchAll(/:([A-Za-z_]+)/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
    if (r.spec.query) {
      const js = toJson(r.spec.query) as { properties?: Record<string, unknown>; required?: string[] };
      for (const [name, schema] of Object.entries(js.properties ?? {})) {
        params.push({ name, in: "query", required: (js.required ?? []).includes(name), schema });
      }
    }
    if (r.spec.idempotent) params.push({ name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", minLength: 8 } });
    const security =
      r.spec.auth === "merchant" || r.spec.auth === "owner"
        ? [{ merchantCookie: [] }]
        : r.spec.auth === "admin"
          ? [{ adminCookie: [] }]
          : [];
    (paths[p] ??= {})[r.method] = {
      tags: [r.tag],
      summary: r.spec.summary,
      description: [r.spec.description, r.spec.perm && `Permission: \`${r.spec.perm}\`.`, r.spec.auth === "owner" && "Owner only.", r.spec.reauth && "Requires re-authentication in the last 10 minutes."].filter(Boolean).join(" ") || undefined,
      parameters: params.length ? params : undefined,
      requestBody: r.spec.body ? { required: true, content: { "application/json": { schema: toJson(r.spec.body) } } } : undefined,
      security,
      responses: {
        "200": { description: "OK" },
        default: { description: "Error", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Aura Pool Automation API",
      version: info.version,
      description:
        "REST JSON. Money is integer minor units (KSh 50 = 5000) in KES. Times are ISO 8601 UTC. Money-moving POSTs take an Idempotency-Key header. Lists use cursor pagination (`cursor`, `limit`, `nextCursor`). Every error has the shape { error: { code, message, details? } }.",
    },
    servers: [{ url: info.serverUrl }],
    components: {
      securitySchemes: {
        merchantCookie: { type: "apiKey", in: "cookie", name: "aura_m_at" },
        adminCookie: { type: "apiKey", in: "cookie", name: "aura_a_at" },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, details: {} } } },
        },
      },
    },
    paths,
  };
}

function toJson(s: z.ZodType): unknown {
  try {
    return z.toJSONSchema(s, { io: "input", unrepresentable: "any" });
  } catch {
    return {};
  }
}
