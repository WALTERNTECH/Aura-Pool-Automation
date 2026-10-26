// Production server for the admin console. No dependencies: serves the built app with strict
// security headers and proxies /v1 to the API, so session cookies stay httpOnly on this
// app's own origin (a cookie set by another onrender.com host would be third-party, and
// phones block those).
//
//   API_URL       the API's origin, e.g. https://aura-pool-api.onrender.com
//   PROXY_SECRET  shared with the API so it trusts the visitor IP this server passes on
//   TRUST_HOPS    proxies in front of this server (Render: Cloudflare + its own = 3)

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");
const port = Number(process.env.PORT ?? 5320);
const api = new URL(process.env.API_URL ?? "http://localhost:4000");
const proxySecret = headerSecret(process.env.PROXY_SECRET);
const hops = Number(process.env.TRUST_HOPS ?? (process.env.RENDER ? 3 : 0));
const production = process.env.NODE_ENV === "production";

// A pasted value can bring a line break, quotes or its "PROXY_SECRET=" prefix along. A header
// can't carry the first, so clean it up, and if it still isn't header-safe, run without it
// (the API then sees this server's IP) instead of failing every request.
function headerSecret(raw) {
  const v = String(raw ?? "").trim().replace(/^PROXY_SECRET=/, "").replace(/^(["'])(.*)\1$/, "$2").trim();
  if (v && !/^[\x21-\x7e]+$/.test(v)) {
    console.error("[admin] PROXY_SECRET has characters a header can't carry (a pasted line break?); ignoring it. Re-enter it as one line.");
    return "";
  }
  return v;
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const SECURITY = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  ...(production ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
};

// Built files, read once, with gzip and brotli versions of text files.
const files = new Map();
function load(dir) {
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      load(full);
      continue;
    }
    const rel = "/" + path.relative(root, full).split(path.sep).join("/");
    const ext = path.extname(name);
    const body = fs.readFileSync(full);
    const text = /^(text|application\/(json|manifest)|image\/svg)/.test(TYPES[ext] ?? "");
    files.set(rel, {
      type: TYPES[ext] ?? "application/octet-stream",
      body,
      br: text && body.length > 1024 ? zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }) : null,
      gz: text && body.length > 1024 ? zlib.gzipSync(body, { level: 9 }) : null,
      cache: rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : rel === "/sw.js" || rel.endsWith(".html") ? "no-cache" : "public, max-age=86400",
    });
  }
}
load(root);

function send(req, res, f, status = 200) {
  const enc = String(req.headers["accept-encoding"] ?? "");
  const headers = { ...SECURITY, "Content-Type": f.type, "Cache-Control": f.cache, Vary: "Accept-Encoding" };
  let body = f.body;
  if (f.br && /\bbr\b/.test(enc)) {
    body = f.br;
    headers["Content-Encoding"] = "br";
  } else if (f.gz && /\bgzip\b/.test(enc)) {
    body = f.gz;
    headers["Content-Encoding"] = "gzip";
  }
  headers["Content-Length"] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === "HEAD" ? undefined : body);
}

function clientIp(req) {
  const chain = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // Socket peer counts as one hop; the visitor is `hops` steps back from it.
  return hops > 0 ? (chain[chain.length - (hops - 1) - 1] ?? chain[0] ?? req.socket.remoteAddress) : req.socket.remoteAddress;
}

function proxy(req, res) {
  const lib = api.protocol === "https:" ? https : http;
  const headers = { ...req.headers, host: api.host, "x-forwarded-host": req.headers.host ?? "", "x-forwarded-proto": "https" };
  delete headers["x-forwarded-for"];
  delete headers["x-aura-proxy-secret"];
  delete headers["x-aura-client-ip"];
  if (proxySecret) {
    headers["x-aura-proxy-secret"] = proxySecret;
    headers["x-aura-client-ip"] = clientIp(req) ?? "";
  }
  const unreachable = () => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { ...SECURITY, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { code: "api_unreachable", message: "The service is waking up or unreachable. Try again in a moment." } }));
  };
  let out;
  try {
    out = lib.request({ protocol: api.protocol, hostname: api.hostname, port: api.port || undefined, path: req.url, method: req.method, headers, timeout: 75_000 }, (pres) => {
      // The API sets its own CSP (JSON gets none-at-all; printable sheets allow their inline styles).
      const h = { ...pres.headers };
      res.writeHead(pres.statusCode ?? 502, { ...SECURITY, ...h, "Cache-Control": h["cache-control"] ?? "no-store" });
      pres.pipe(res);
    });
  } catch (e) {
    // A header the request can't carry throws here, before any event; one bad request must not stop the server.
    console.error(`[admin] proxy ${req.method} ${req.url?.split("?")[0]}: ${e.code ?? e.message}`);
    return unreachable();
  }
  out.on("timeout", () => out.destroy(new Error("timeout")));
  out.on("error", unreachable);
  req.pipe(out);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("ok");
    }
    if (url.pathname.startsWith("/v1/")) return proxy(req, res);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, SECURITY);
      return res.end();
    }
    const f = files.get(url.pathname) ?? (url.pathname.endsWith("/") ? files.get(url.pathname + "index.html") : null);
    if (f) return send(req, res, f);
    if (url.pathname.startsWith("/assets/") || path.extname(url.pathname)) {
      res.writeHead(404, { ...SECURITY, "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    // Every app route gets the app shell.
    const index = files.get("/index.html");
    if (!index) {
      res.writeHead(503, { "Content-Type": "text/plain" });
      return res.end("The app has not been built. Run npm run build.");
    }
    send(req, res, index);
  })
  .listen(port, () => console.log(`[admin] on :${port}, API ${api.origin}${proxySecret ? "" : " (no PROXY_SECRET: the API will see this server's IP)"}`));
