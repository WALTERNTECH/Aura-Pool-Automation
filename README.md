# Aura Pool Automation

Pay-per-game pool tables. A customer pays by M-Pesa (Paybill, with the table ID as the account
number, or STK push from the QR code on the table); the server confirms the payment, splits it in
a double-entry ledger, and sends a signed unlock over MQTT to the ESP32 in the table, which
releases the balls. Owners run their tables from an installable phone app; the operator runs the
platform from a console.

Three separate codebases, each deployed on its own, talking only through the API:

| Folder | What | Render service |
|---|---|---|
| [`api/`](api) | Backend: payments, ledger, payouts, float, devices, alerts, audit, Merchant and Admin APIs, public pay page, provider callbacks, simulators | `aura-pool-api` |
| [`merchant/`](merchant) | Installable web app (PWA) for table owners and attendants | `aura-pool-merchant` |
| [`admin/`](admin) | Operations console | `aura-pool-admin` |
| [`firmware/`](firmware) | ESP32 table controller (not a service; flashed onto each table) | |

The data lives in the shared Supabase project (`mrsxvdxaoogamhkdqejp`, the Fpesa project) in its
own schema, `aura`, owned by the role `aura_api`, which has no rights on any other schema.

## Running it locally

Node 22. The API needs no database to start: without `DATABASE_URL` it runs on an embedded
Postgres kept in `.local/`.

```
cd api && npm ci && PGLITE_DIR=../.local/pglite-dev npm run dev
cd merchant && npm ci && npm run dev        # http://localhost:5310
cd admin && npm ci && npm run dev           # http://localhost:5320
cd api && npx tsx scripts/seed-demo.ts --setup-token local-setup
```

The seed script creates the first admin (credentials and authenticator secret in
`.local/demo-admin.json`), a merchant with an invite link, two tables with virtual devices, and a
few payments. Open the invite link to onboard as the owner.

Tests (55, on an embedded Postgres, with a real MQTT broker and virtual devices):

```
cd api && npm test
```

They cover the PRD acceptance criteria: duplicate and forged callbacks, unknown accounts, under-
and over-payment, offline tables, ack timeouts, double-tap and concurrent withdrawals, float
shortage, B2C failure and timeout, the kill switch, four-eyes approvals, number-change cooling-off,
auto-withdraw, reconciliation, tenant isolation, role permissions, signed and replayed commands,
broker ACLs, CSRF, PIN and admin lockouts, refresh-token reuse, and read-only impersonation.

## Simulators

- **Provider simulator** (`api/scripts/provider-sim.ts`): plays Safaricom against an API running
  with `PAYMENTS_PROVIDER=simulated`: normal, duplicate, out-of-order, invalid-account, unmatched,
  underpaid, overpaid and forged C2B callbacks (`--scenario all`), or replays saved Daraja payloads.
  The simulated provider keeps its own Utility and Working balances, so reconciliation is meaningful.
- **Device simulator** (`api/scripts/device-sim.ts`): a virtual ESP32 over MQTT that behaves like
  the firmware (signature, expiry and duplicate checks, busy, 60 s cap, last will, override button).
- **Console → Simulator** (sandbox only) does the same from the browser.

## Deploying

`render.yaml` describes the three services. Each front end runs a small dependency-free Node
server (`server.mjs`) that serves its built app with a strict CSP and proxies `/v1` to the API, so
session cookies stay httpOnly and first-party on the app's own origin.

Required on the API: `DATABASE_URL`, `JWT_SECRET`, `MASTER_KEY`, `CALLBACK_SECRET`,
`ADMIN_SETUP_TOKEN`, `PROXY_SECRET`, `MERCHANT_APP_URL`, `ADMIN_APP_URL`. On each front end:
`API_URL`, `PROXY_SECRET` (the same value). See `api/.env.example` for everything else.

The first admin is created at `/setup` in the console with the `ADMIN_SETUP_TOKEN`.

## Before real money

The deployment starts in sandbox mode: simulated M-Pesa, and one-time codes shown on screen
(`OTP_ECHO=on`). To go live:

1. **Daraja**: set `PAYMENTS_PROVIDER=daraja`, `DARAJA_ENV=production` and the credentials
   (consumer key/secret, shortcode, passkey, initiator and its security credential). Ask Safaricom
   to enable external validation, Transaction Status and Account Balance, and to whitelist the
   API's outbound IPs for B2C. Then Console → Provider → Register C2B URLs. Confirm whether
   production URLs can be re-registered, and how money moves between Utility and Working.
2. **API on a paid instance** (Render Starter or better). Free instances sleep: Daraja expects the
   validation answer within 2 seconds, auto-withdrawals and retries must run on time, and devices
   need a broker that's always up.
3. **SMS**: Africa's Talking or Celcom keys, then set `OTP_ECHO=off` (the server refuses
   `OTP_ECHO` with live Daraja anyway).
4. **Email** (Resend) for critical alerts and daily reports; **VAPID** keys for web push.
5. **Tariffs**: confirm the Safaricom B2C and Paybill tariffs and set them in Console → Settings.
   Reconciliation will show any difference to the cent.
6. **Legal**: the terms and privacy policy in the merchant app are drafts. Have counsel review
   them, register as a data controller (Kenya Data Protection Act 2019), and get advice on the
   regulatory position of holding merchants' funds.
7. **Swahili**: have a native speaker review `merchant/src/i18n/sw.ts`.

## Choices made where the spec allowed

- Express + TypeScript + `pg` (not NestJS/Fastify): the same stack as the operator's other
  services. Postgres jobs with `FOR UPDATE SKIP LOCKED` replace Redis/BullMQ, and leases keep
  periodic sweeps single-instance; there is no Redis to run.
- MQTT broker: embedded (aedes) and served as MQTT over WebSocket on `/mqtt` of the API's own
  HTTPS port, because Render exposes one port. Per-device credentials and topic ACLs as specified.
  An external EMQX or Mosquitto on 8883 is supported (`DEVICE_TRANSPORT=external`) with HTTP auth
  hooks at `/internal/mqtt/auth` and `/acl`.
- Float: the pre-submit check requires the payout plus its M-Pesa fee to be available after other
  payouts in flight. The buffer percentage sizes the 24-hour requirement and its alerts; applying
  it to every single payout would strand the last shillings in the Working account.
- Customer phone numbers are stored hashed and shown masked; raw callback payloads are stored with
  phone numbers masked.
- A Transaction Status answer saying the provider has no such transaction counts as a verification
  mismatch (critical alert, payouts for that merchant suspended until an admin clears it).
- IntaSend is a placeholder behind the provider interface (Phase 2), as the spec asks.
