import express, { type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { db, one } from "../config/db.js";
import { authenticateDevice } from "../devices/devices.js";
import { parseTopic } from "../devices/protocol.js";
import { Api } from "../lib/api.js";
import { hashMsisdn, safeEqual } from "../lib/crypto.js";
import { badRequest, notFound, tooMany, unavailable } from "../lib/http.js";
import { formatKsh, maskMsisdn, normaliseMsisdn, normaliseTableRef } from "../lib/kenya.js";
import { balancesFromResult, completeDarajaResult } from "../providers/daraja.js";
import { provider } from "../providers/index.js";
import { raise } from "../services/alerts.js";
import { recordSnapshot } from "../services/float.js";
import { ingestCollection } from "../services/payments.js";
import { handlePayoutResult, handlePayoutStatus } from "../services/payouts.js";

// Public endpoints: the QR pay page and its API, provider callbacks, and the hooks an
// external MQTT broker calls to authenticate devices.

export const publicApi = new Api("/v1/public", "Public");

async function tableForPay(id: string) {
  const tableId = normaliseTableRef(id);
  if (!tableId) return null;
  return one<{ id: string; name: string; price_minor: number; status: string; m_status: string; block: boolean; online: boolean | null; business_name: string }>(
    db(),
    `select t.id, t.name, t.price_minor, t.status, m.status as m_status, m.block_table_payments as block, d.online, m.business_name
       from pool_tables t join merchants m on m.id = t.merchant_id left join devices d on d.table_id = t.id and d.status = 'provisioned' where t.id = $1`,
    [tableId],
  );
}

const available = (t: NonNullable<Awaited<ReturnType<typeof tableForPay>>>) => t.status === "active" && !t.block && t.m_status !== "closed" && Boolean(t.online);

publicApi.route({ method: "get", path: "/tables/:id", summary: "A table's name, price and whether it can be paid now", auth: "public" }, async ({ params }) => {
  const t = await tableForPay(params.id);
  if (!t) throw notFound("No such table");
  return { id: t.id, name: t.name, venue: t.business_name, priceMinor: t.price_minor, available: available(t), reason: available(t) ? null : "Out of service", paybill: env.paybillNumber, account: t.id, maxGames: 5, turnstileSiteKey: env.turnstileSiteKey || null };
});

async function turnstileOk(token: string | undefined, ip: string) {
  if (!env.turnstileSecret) return true;
  if (!token) return false;
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: new URLSearchParams({ secret: env.turnstileSecret, response: token, remoteip: ip }), signal: AbortSignal.timeout(5000) }).catch(() => null);
  const j = r ? ((await r.json().catch(() => ({}))) as { success?: boolean }) : {};
  return Boolean(j.success);
}

publicApi.route(
  {
    method: "post",
    path: "/pay",
    summary: "Start an M-Pesa prompt on the customer's phone",
    auth: "public",
    body: z.object({ tableId: z.string().max(10), phone: z.string().min(9).max(16), games: z.number().int().min(1).max(5), website: z.string().max(0).optional(), shownAt: z.number().int().optional(), turnstileToken: z.string().max(4000).optional() }),
  },
  async ({ body, ip }) => {
    // Bots fill the hidden field or submit faster than a person can.
    if (body.website || (body.shownAt && Date.now() - body.shownAt < 1500)) throw badRequest("Please try again", "bot_check");
    if (!(await turnstileOk(body.turnstileToken, ip))) throw badRequest("Please complete the check and try again", "bot_check");
    const phone = normaliseMsisdn(body.phone);
    if (!phone) throw badRequest("Enter a Safaricom number like 0712 345 678");
    const t = await tableForPay(body.tableId);
    if (!t) throw notFound("No such table");
    if (!available(t)) throw unavailable("This table is out of service right now", "out_of_service");
    const ph = hashMsisdn(phone);
    const recent = await one<{ n: number }>(db(), `select count(*)::int as n from stk_requests where phone_hash = $1 and created_at > now() - interval '10 minutes'`, [ph]);
    if ((recent?.n ?? 0) >= 4) throw tooMany("Too many payment requests for this number. Wait a few minutes.");
    // The amount is computed here, never taken from the client.
    const amount = t.price_minor * body.games;
    const row = await one<{ id: string }>(db(), `insert into stk_requests (table_id, phone_hash, phone_masked, games, amount_minor, ip) values ($1,$2,$3,$4,$5,$6) returning id`, [t.id, ph, maskMsisdn(phone), body.games, amount, ip]);
    try {
      const res = await provider().initiateStkPush({ stkRequestId: row!.id, phone, amountMinor: amount, accountRef: t.id, description: `Pool ${t.id}` });
      await db().query(`update stk_requests set merchant_request_id = $2, checkout_request_id = $3, updated_at = now() where id = $1`, [row!.id, res.merchantRequestId, res.checkoutRequestId]);
    } catch (e) {
      await db().query(`update stk_requests set status = 'failed', result_desc = $2, updated_at = now() where id = $1`, [row!.id, (e as Error).message.slice(0, 200)]);
      throw unavailable("M-Pesa didn't accept the request. Pay by Paybill instead, or try again.", "stk_failed");
    }
    return { id: row!.id, amountMinor: amount, message: `Check your phone and enter your M-Pesa PIN to pay ${formatKsh(amount)}.` };
  },
);

publicApi.route({ method: "get", path: "/pay/:id/status", summary: "Whether the prompt was paid", auth: "public" }, async ({ params }) => {
  if (!/^[0-9a-f-]{36}$/.test(params.id)) throw notFound("Not found");
  const s = await one<{ status: string; result_desc: string | null; games: number; table_id: string; payment_id: string | null }>(db(), `select status, result_desc, games, table_id, payment_id from stk_requests where id = $1`, [params.id]);
  if (!s) throw notFound("Not found");
  let played = 0;
  if (s.payment_id) played = (await one<{ n: number }>(db(), `select count(*)::int as n from game_credits where payment_id = $1 and status = 'acked'`, [s.payment_id]))?.n ?? 0;
  const message = s.status === "paid" ? (played ? "Paid. The balls are released, enjoy your game." : "Paid. The table is releasing the balls.") : s.status === "pending" ? "Waiting for you to confirm on your phone." : s.status === "cancelled" ? "The payment was cancelled." : s.status === "expired" ? "The prompt expired. Try again." : (s.result_desc ?? "The payment didn't go through.");
  return { status: s.status, message, games: s.games, gamesStarted: played };
});

// ------------------------------------------------------------------ pay page (/t/{table_id})

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const payPageRouter = express.Router();
payPageRouter.get("/t/assets/pay.css", (_req, res) => res.type("css").set("Cache-Control", "public, max-age=3600").send(PAY_CSS));
payPageRouter.get("/t/assets/pay.js", (_req, res) => res.type("js").set("Cache-Control", "public, max-age=3600").send(PAY_JS));
payPageRouter.get("/t/:id", async (req: Request, res: Response) => {
  const t = await tableForPay(String(req.params.id));
  const ok = t ? available(t) : false;
  const body = !t
    ? `<main class="card"><h1>Table not found</h1><p class="muted">Check the code on the table and scan again.</p></main>`
    : `<main class="card" data-table="${esc(t.id)}" data-price="${t.price_minor}">
  <p class="eyebrow">${esc(t.business_name)}</p>
  <h1>${esc(t.name)}</h1>
  <p class="muted">${formatKsh(t.price_minor)} per game · Table ${esc(t.id)}</p>
  ${ok ? `<form id="pay" autocomplete="on" novalidate>
    <label for="phone">M-Pesa number</label>
    <input id="phone" name="phone" type="tel" inputmode="tel" autocomplete="tel" required maxlength="13">
    <label for="games">Games</label>
    <div class="games" role="radiogroup" aria-label="Number of games">${[1, 2, 3, 4, 5].map((n) => `<button type="button" role="radio" aria-checked="${n === 1}" data-games="${n}">${n}</button>`).join("")}</div>
    <input type="text" name="website" tabindex="-1" autocomplete="off" class="hp" aria-hidden="true">
    <button class="primary" type="submit" id="go">Pay ${formatKsh(t.price_minor)}</button>
    <p id="msg" class="msg" role="status" aria-live="polite"></p>
  </form>` : `<div class="out"><b>Out of service</b><p>This table can't take payments right now.</p></div>`}
  <div class="paybill"><span>Or Paybill <b>${esc(env.paybillNumber)}</b>, account <b>${esc(t.id)}</b></span></div>
</main>`;
  res
    .status(t ? 200 : 404)
    .type("html")
    .set("Cache-Control", "no-store")
    .set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'")
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#ffffff"><title>${t ? esc(t.name) : "Aura Pool"} · Pay</title><link rel="stylesheet" href="/t/assets/pay.css"></head><body>${body}<p class="brand">Aura Pool</p><script src="/t/assets/pay.js" defer></script></body></html>`);
});

const PAY_CSS = `*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;min-height:100dvh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px 16px;font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#111412;background:#fbfbfa}
.card{width:100%;max-width:400px;background:#fff;border:1px solid #e3e5e2;border-radius:20px;padding:24px 20px;box-shadow:0 1px 2px rgba(17,20,18,.05)}
.eyebrow{margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#5d6660}h1{margin:4px 0 2px;font-size:26px;letter-spacing:-.01em}.muted{margin:0 0 18px;color:#5d6660}
label{display:block;font-size:14px;font-weight:600;margin:14px 0 6px}input[type=tel]{width:100%;font:inherit;font-size:18px;padding:13px 14px;border:1.5px solid #cfd3cf;border-radius:12px;background:#fff}input:focus{outline:none;border-color:#1f6b48;box-shadow:0 0 0 3px rgba(31,107,72,.15)}
.games{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}.games button{font:inherit;font-weight:700;padding:12px 0;border-radius:12px;border:1.5px solid #cfd3cf;background:#fff;color:#111412}.games button[aria-checked=true]{border-color:#1f6b48;background:#eef5f0;color:#14532f}
.primary{margin-top:20px;width:100%;font:inherit;font-weight:700;font-size:17px;padding:15px;border:0;border-radius:14px;color:#fff;background:linear-gradient(#24784f,#1c6141);box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 1px 0 #134a31;cursor:pointer}.primary:active{transform:translateY(1px)}.primary[disabled]{opacity:.6}
.msg{min-height:22px;margin:12px 0 0;font-size:15px}.msg.bad{color:#b42318}.msg.ok{color:#1c6141;font-weight:600}.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
.out{padding:16px;border-radius:14px;background:#f6f6f5;border:1px solid #e3e5e2}.out b{font-size:18px}.out p{margin:4px 0 0;color:#5d6660}
.paybill{margin-top:18px;padding-top:14px;border-top:1px dashed #d9ddda;font-size:14px;color:#5d6660}.brand{margin:16px 0 0;font-size:12px;color:#8a918c;letter-spacing:.06em;text-transform:uppercase}`;

const PAY_JS = `(function(){var card=document.querySelector('.card');var form=document.getElementById('pay');if(!card||!form)return;var table=card.getAttribute('data-table');var price=+card.getAttribute('data-price');var games=1;var shownAt=Date.now();var phone=document.getElementById('phone');var msg=document.getElementById('msg');var go=document.getElementById('go');
try{var saved=localStorage.getItem('aura_pay_phone');if(saved)phone.value=saved}catch(e){}
function ksh(m){return 'KSh '+(m/100).toLocaleString('en-KE')}
function set(t,c){msg.textContent=t;msg.className='msg'+(c?' '+c:'')}
Array.prototype.forEach.call(document.querySelectorAll('.games button'),function(b){b.addEventListener('click',function(){games=+b.getAttribute('data-games');Array.prototype.forEach.call(document.querySelectorAll('.games button'),function(x){x.setAttribute('aria-checked',String(x===b))});go.textContent='Pay '+ksh(price*games)})});
function poll(id,n){fetch('/v1/public/pay/'+id+'/status').then(function(r){return r.json()}).then(function(s){if(s.status==='pending'&&n<60){set(s.message);setTimeout(function(){poll(id,n+1)},2000);return}set(s.message,s.status==='paid'?'ok':'bad');go.disabled=false}).catch(function(){if(n<60)setTimeout(function(){poll(id,n+1)},3000)})}
form.addEventListener('submit',function(e){e.preventDefault();var p=phone.value.trim();if(p.replace(/\\D/g,'').length<9){set('Enter your M-Pesa number','bad');phone.focus();return}go.disabled=true;set('Sending the M-Pesa prompt…');try{localStorage.setItem('aura_pay_phone',p)}catch(e){}
fetch('/v1/public/pay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tableId:table,phone:p,games:games,website:form.website.value,shownAt:shownAt})}).then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})}).then(function(x){if(!x.ok){set((x.j.error&&x.j.error.message)||'That didn\\'t work. Try again.','bad');go.disabled=false;return}set(x.j.message);poll(x.j.id,0)}).catch(function(){set('No connection. Try again, or pay by Paybill.','bad');go.disabled=false})})})();`;

// ------------------------------------------------------------------ provider callbacks

export const callbackRouter = express.Router();

/** Masks phone numbers inside a raw payload before it is stored: numbers are kept hashed, never in clear. */
function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    // { Name: "PhoneNumber", Value: 2547... } items in STK metadata.
    if (o.Name === "PhoneNumber" && o.Value != null) return { ...o, Value: maskMsisdn(String(o.Value)) };
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = /^(MSISDN|PhoneNumber|PartyA|PartyB)$/i.test(k) && val != null && /^\d{9,13}$/.test(String(val)) ? maskMsisdn(String(val)) : redact(val);
    return out;
  }
  return v;
}

function guard(req: Request, res: Response): boolean {
  if (!env.callbackSecret || !safeEqual(String(req.params.secret ?? ""), env.callbackSecret)) {
    res.status(404).json({ error: { code: "not_found", message: "Not found" } });
    return false;
  }
  if (env.daraja.ipAllowlist.length && !env.daraja.ipAllowlist.includes(req.ip ?? "")) {
    console.warn(`[cb] refused ${req.path.replace(env.callbackSecret, "••••")} from ${req.ip}`);
    res.status(403).json({ ResultCode: 1, ResultDesc: "Forbidden" });
    return false;
  }
  return true;
}

async function logCallback(kind: string, req: Request, t0: number, ok: boolean, error?: string) {
  await db()
    .query(`insert into callback_log (kind, processing_ms, ok, error, source_ip, payload, replay_of) values ($1,$2,$3,$4,$5,$6,$7)`, [kind, Date.now() - t0, ok, error?.slice(0, 500) ?? null, req.ip ?? null, JSON.stringify(redact(req.body ?? {})), req.headers["x-aura-replay-of"] ? Number(req.headers["x-aura-replay-of"]) || null : null])
    .catch(() => {});
}

const c2bShape = z.object({ TransID: z.string().min(6).max(30), TransAmount: z.union([z.string(), z.number()]), BusinessShortCode: z.union([z.string(), z.number()]), BillRefNumber: z.union([z.string(), z.number()]).optional() }).passthrough();
const resultShape = z.object({ Result: z.object({ ResultCode: z.union([z.string(), z.number()]) }).passthrough() }).passthrough();
const stkShape = z.object({ Body: z.object({ stkCallback: z.object({ CheckoutRequestID: z.string(), ResultCode: z.union([z.string(), z.number()]) }).passthrough() }) }).passthrough();

function handler(kind: string, shape: z.ZodType, fn: (req: Request) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    const t0 = Date.now();
    if (!guard(req, res)) return;
    const parsed = shape.safeParse(req.body);
    if (!parsed.success) {
      await logCallback(kind, req, t0, false, `schema: ${parsed.error.issues[0]?.message}`);
      res.status(400).json({ ResultCode: 1, ResultDesc: "Bad request" });
      return;
    }
    try {
      const out = await fn(req);
      await logCallback(kind, req, t0, true);
      res.json(out ?? { ResultCode: 0, ResultDesc: "Accepted" });
    } catch (e) {
      await logCallback(kind, req, t0, false, (e as Error).message);
      console.error(`[cb] ${kind}:`, (e as Error).message);
      await raise(db(), { type: "webhook_failure", severity: "warning", title: `A ${kind.replace("_", " ")} callback failed to process`, detail: (e as Error).message, dedupeKey: `webhook:${kind}` }).catch(() => {});
      // Daraja retries on non-200s; a confirmation we've already stored is idempotent anyway.
      res.status(500).json({ ResultCode: 1, ResultDesc: "Temporary error" });
    }
  };
}

callbackRouter.use("/cb", express.json({ limit: "64kb" }));

// Validation: answer inside 2 seconds. Reject (customer not charged) unless the account is a table taking payments.
callbackRouter.post(
  "/cb/daraja/c2b/:secret/validation",
  handler("c2b_validation", c2bShape, async (req) => {
    const t = await tableForPay(String(req.body.BillRefNumber ?? ""));
    const takes = t && t.status === "active" && !t.block && t.m_status !== "closed";
    return takes ? { ResultCode: "0", ResultDesc: "Accepted" } : { ResultCode: "C2B00012", ResultDesc: "Rejected" };
  }),
);

callbackRouter.post(
  "/cb/daraja/c2b/:secret/confirmation",
  handler("c2b_confirmation", c2bShape, async (req) => {
    const cb = provider().parseCollectionCallback(req.body);
    cb.raw = redact(req.body);
    const { duplicate } = await ingestCollection(cb);
    return { ResultCode: 0, ResultDesc: duplicate ? "Duplicate ignored" : "Accepted" };
  }),
);

callbackRouter.post(
  "/cb/daraja/stk/:secret",
  handler("stk", stkShape, async (req) => {
    const r = provider().parseStkCallback(req.body);
    const s = await one<{ id: string; table_id: string; amount_minor: number; status: string }>(db(), `select id, table_id, amount_minor, status from stk_requests where checkout_request_id = $1`, [r.checkoutRequestId]);
    if (!s) return { ResultCode: 0, ResultDesc: "Unknown request" };
    if (!r.success || !r.receipt) {
      await db().query(`update stk_requests set status = $2, result_code = $3, result_desc = $4, updated_at = now() where id = $1 and status = 'pending'`, [s.id, r.resultCode === "1032" ? "cancelled" : "failed", r.resultCode, r.resultDesc.slice(0, 200)]);
      return { ResultCode: 0, ResultDesc: "Accepted" };
    }
    const { paymentId } = await ingestCollection(
      { providerTxnId: r.receipt.toUpperCase(), channel: "stk", amountMinor: r.amountMinor ?? s.amount_minor, accountRef: s.table_id, shortcode: env.daraja.shortcode, msisdn: r.phone, firstName: null, middleName: null, lastName: null, transTime: r.transTime, orgBalanceMinor: null, raw: redact(req.body) },
      { stkRequestId: s.id },
    );
    await db().query(`update stk_requests set status = 'paid', result_code = $2, result_desc = $3, payment_id = $4, updated_at = now() where id = $1`, [s.id, r.resultCode, r.resultDesc.slice(0, 200), paymentId]);
    return { ResultCode: 0, ResultDesc: "Accepted" };
  }),
);

for (const kind of ["result", "timeout"] as const) {
  callbackRouter.post(
    `/cb/daraja/b2c/:secret/${kind}`,
    handler(`b2c_${kind}`, resultShape, async (req) => {
      await handlePayoutResult(provider().parsePayoutResult(req.body, kind));
      return { ResultCode: 0, ResultDesc: "Accepted" };
    }),
  );
  callbackRouter.post(
    `/cb/daraja/status/:secret/${kind}`,
    handler(`status_${kind}`, resultShape, async (req) => {
      const reqRow = await completeDarajaResult(db(), "status", req.body, kind === "timeout");
      if (reqRow?.kind === "payout_status" && reqRow.ref_id && kind === "result") await handlePayoutStatus(reqRow.ref_id, req.body);
      return { ResultCode: 0, ResultDesc: "Accepted" };
    }),
  );
}

callbackRouter.post(
  "/cb/daraja/balance/:secret",
  handler("balance", resultShape, async (req) => {
    const done = await completeDarajaResult(db(), "balance", req.body, String(req.body?.Result?.ResultCode) !== "0");
    if (String(req.body?.Result?.ResultCode) === "0") {
      const b = balancesFromResult(req.body);
      if (b.workingMinor != null || b.utilityMinor != null) await recordSnapshot(b, done ? "balance_result" : "balance_unsolicited");
    }
    return { ResultCode: 0, ResultDesc: "Accepted" };
  }),
);

// The provider simulator's entry point (scripts/provider-sim.ts): simulated provider only, behind the callback secret.
callbackRouter.post("/cb/sim/:secret/c2b", async (req, res) => {
  if (env.provider !== "simulated" || !env.callbackSecret || !safeEqual(String(req.params.secret ?? ""), env.callbackSecret)) {
    res.status(404).json({ error: { code: "not_found", message: "Not found" } });
    return;
  }
  const b = z
    .object({ accountRef: z.string().max(20), amountMinor: z.number().int().positive().max(25_000_000), msisdn: z.string().max(16).optional(), duplicate: z.boolean().optional(), skipValidation: z.boolean().optional(), forged: z.boolean().optional(), outOfOrder: z.boolean().optional() })
    .safeParse(req.body);
  if (!b.success) {
    res.status(400).json({ error: { code: "validation", message: b.error.issues[0]?.message } });
    return;
  }
  const { simulateC2B } = await import("../providers/simulated.js");
  res.json(await simulateC2B({ ...b.data, msisdn: b.data.msisdn ? normaliseMsisdn(b.data.msisdn) ?? undefined : undefined }));
});

// ------------------------------------------------------------------ external broker hooks

export const internalRouter = express.Router();
internalRouter.use("/internal", express.json({ limit: "8kb" }));
internalRouter.use("/internal", (req, res, next) => {
  if (!env.device.hookSecret || !safeEqual(String(req.headers["x-hook-secret"] ?? ""), env.device.hookSecret)) {
    res.status(404).end();
    return;
  }
  next();
});

// EMQX HTTP authentication: {result: allow|deny, is_superuser}.
internalRouter.post("/internal/mqtt/auth", async (req, res) => {
  const { username, password, clientid } = req.body ?? {};
  if (username === env.device.mqttUsername && env.device.mqttPassword && safeEqual(String(password ?? ""), env.device.mqttPassword)) {
    res.json({ result: "allow", is_superuser: true });
    return;
  }
  const id = await authenticateDevice(String(username ?? ""), String(password ?? ""));
  res.json({ result: id && clientid === username ? "allow" : "deny", is_superuser: false });
});

// EMQX HTTP authorization: a device may publish ack/status/event and subscribe to cmd, all for its own table.
internalRouter.post("/internal/mqtt/acl", async (req, res) => {
  const { username, topic, action } = req.body ?? {};
  if (username === env.device.mqttUsername) {
    res.json({ result: "allow" });
    return;
  }
  const d = await one<{ table_id: string | null; status: string }>(db(), `select table_id, status from devices where id = $1`, [String(username ?? "")]);
  const t = parseTopic(String(topic ?? ""));
  const own = d && d.status === "provisioned" && t && t.tableId === d.table_id;
  const ok = own && ((action === "subscribe" && t!.kind === "cmd") || (action === "publish" && t!.kind !== "cmd"));
  res.json({ result: ok ? "allow" : "deny" });
});
