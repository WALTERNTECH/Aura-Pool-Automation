import cookieParser from "cookie-parser";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { ZodError } from "zod";
import { env, isSandbox } from "./config/env.js";
import { openapi } from "./lib/api.js";
import { HttpError } from "./lib/http.js";
import { adminAuth, merchantAuth, requireClientHeader } from "./middleware/auth.js";
import { recordRequests } from "./middleware/metrics.js";
import { adminCoreApi } from "./routes/admin-core.js";
import { adminMoneyApi } from "./routes/admin-money.js";
import { adminOpsApi, impersonationGate } from "./routes/admin-ops.js";
import { authApi } from "./routes/auth.js";
import { merchantApi } from "./routes/merchant.js";
import { callbackRouter, internalRouter, payPageRouter, publicApi } from "./routes/public.js";

export function createApp() {
  const app = express();
  // Render puts Cloudflare and its own proxy in front: the visitor is three hops back.
  app.set("trust proxy", env.nodeEnv === "test" ? false : 3);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"], formAction: ["'none'"] } },
      crossOriginResourcePolicy: { policy: "same-site" },
    }),
  );
  app.use(recordRequests);

  app.get("/health", (_req, res) => res.json({ status: "ok", provider: env.provider, sandbox: isSandbox() }));
  app.get("/v1/meta", (_req, res) => res.json({ name: "Aura Pool Automation", provider: env.provider, sandbox: isSandbox(), paybill: env.paybillNumber, currency: "KES", timeZone: "Africa/Nairobi", version: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? "dev" }));
  app.get("/v1/openapi.json", (_req, res) => res.json(openapi({ version: "1.0.0", serverUrl: env.publicUrl })));

  // Provider callbacks and broker hooks have their own body limits and checks.
  app.use(callbackRouter);
  app.use(internalRouter);
  app.use(payPageRouter);

  app.use(cookieParser());
  // Document uploads are the only large bodies.
  app.use("/v1/a/merchants/:id/documents", express.json({ limit: "8mb" }));
  app.use(express.json({ limit: "256kb" }));

  const limit = (windowMin: number, max: number, message: string) =>
    rateLimit({ windowMs: windowMin * 60_000, limit: env.nodeEnv === "test" ? 100_000 : max, standardHeaders: "draft-8", legacyHeaders: false, message: { error: { code: "rate_limited", message } } });
  app.use(["/v1/auth/login", "/v1/auth/login/admin", "/v1/auth/login/admin/totp", "/v1/auth/webauthn", "/v1/auth/admin/setup"], limit(15, 30, "Too many sign-in attempts. Wait 15 minutes."));
  app.use("/v1/auth/otp", limit(15, 20, "Too many attempts. Wait 15 minutes."));
  app.use("/v1/public/pay", limit(10, 20, "Too many payment requests. Wait a few minutes."));
  app.use("/v1", limit(15, 1500, "Too many requests. Slow down for a minute."));

  app.use(["/v1/auth", "/v1/m", "/v1/a"], requireClientHeader);
  app.use(publicApi.base, publicApi.router);
  app.use(authApi.base, authApi.router);
  app.use(merchantApi.base, merchantAuth(), merchantApi.router);
  app.use("/v1/a", adminAuth());
  // Read-only view as a merchant: the merchant API, mounted behind the impersonation gate.
  app.use("/v1/a/impersonations/:impId/m", impersonationGate(), merchantApi.router);
  app.use(adminCoreApi.base, adminCoreApi.router);
  app.use(adminMoneyApi.base, adminMoneyApi.router);
  app.use(adminOpsApi.base, adminOpsApi.router);

  app.use((req, res) => res.status(404).json({ error: { code: "not_found", message: `No route for ${req.method} ${req.path.replace(env.callbackSecret || "\u0000", "••••")}` } }));
  app.use(errorHandler);
  return app;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    res.status(400).json({ error: { code: "validation", message: details[0]?.message ?? "Check the highlighted fields", details } });
    return;
  }
  const t = (err as { type?: string })?.type;
  if (t === "entity.parse.failed") {
    res.status(400).json({ error: { code: "bad_json", message: "The request body is not valid JSON" } });
    return;
  }
  if (t === "entity.too.large") {
    res.status(413).json({ error: { code: "too_large", message: "That request is too large" } });
    return;
  }
  console.error(`[error] ${req.method} ${req.path}`, err);
  res.status(500).json({ error: { code: "internal", message: "Something went wrong on our side. Try again in a moment." } });
}
