// Every setting the server reads from the environment, in one place. Secrets come from the
// environment only; nothing here has a usable default in production. Business rules
// (prices, commission, limits) are not here: they live in the settings table so the
// operator can change them from the console, with an audit trail.

export type Env = {
  nodeEnv: "development" | "test" | "production";
  port: number;
  /** Public HTTPS origin of this API; provider callbacks and device links are built from it. */
  publicUrl: string;
  /** The merchant app's origin: invite links, WebAuthn relying party, SMS links. */
  merchantUrl: string;
  /** The admin console's origin, for links in alerts and emails. */
  adminUrl: string;
  databaseUrl: string | null;
  pgliteDir: string | null;
  jwtSecret: string;
  /** 32-byte key: encrypts TOTP and device HMAC secrets at rest and peppers PINs. */
  masterKey: Buffer;
  adminSetupToken: string | null;
  /** Secret path segment on every provider callback URL. Daraja signs nothing. */
  callbackSecret: string;
  provider: "daraja" | "simulated";
  daraja: {
    env: "sandbox" | "production";
    consumerKey: string;
    consumerSecret: string;
    shortcode: string;
    passkey: string;
    initiator: string;
    /** Initiator password encrypted with Safaricom's certificate (the Daraja portal generates it). */
    securityCredential: string;
    b2cCommand: "BusinessPayment" | "SalaryPayment" | "PromotionPayment";
    c2bResponseType: "Completed" | "Cancelled";
    /** Source IPs allowed on callbacks; empty list disables the check. */
    ipAllowlist: string[];
    credentialsRotatedAt: string | null;
  };
  /** The Paybill customers pay into, shown on table sheets and the pay page. */
  paybillNumber: string;
  device: {
    /** "embedded" runs the MQTT broker inside this process on /mqtt; "external" connects to MQTT_URL. */
    transport: "embedded" | "external";
    mqttUrl: string;
    mqttUsername: string;
    mqttPassword: string;
    /** Shared secret for an external broker's HTTP auth/ACL hooks. */
    hookSecret: string;
    /** What devices are told to connect to. */
    publicMqttUrl: string;
    /** Run simulated ESP32s in-process for devices marked virtual (sandbox only). */
    virtualDevices: boolean;
  };
  sms: {
    provider: "africastalking" | "celcom" | "log";
    atUsername: string;
    atApiKey: string;
    atSenderId: string;
    celcomApiKey: string;
    celcomPartnerId: string;
    celcomShortcode: string;
  };
  email: { resendApiKey: string; from: string };
  push: { vapidPublic: string; vapidPrivate: string; subject: string };
  /** Test mode only: one-time codes are returned to the screen. Refused against live Daraja. */
  otpEcho: boolean;
  /** Shared with the merchant and admin front-end servers, which pass the visitor's real IP. */
  proxySecret: string;
  turnstileSecret: string;
  turnstileSiteKey: string;
};

function masterKey(raw: string | undefined): Buffer {
  if (raw) {
    const b = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (b.length !== 32) throw new Error("MASTER_KEY must be 32 bytes (64 hex chars or base64)");
    return b;
  }
  // Development only: production refuses to start without it (checked with the others in loadEnv).
  return Buffer.alloc(32, 7);
}

// Safaricom's published callback source addresses. Override with DARAJA_IP_ALLOWLIST, or "off".
const SAFARICOM_IPS = [
  "196.201.214.200", "196.201.214.206", "196.201.213.114", "196.201.214.207", "196.201.214.208",
  "196.201.213.44", "196.201.212.127", "196.201.212.138", "196.201.212.129", "196.201.212.136",
  "196.201.212.74", "196.201.212.69",
];

export function loadEnv(e: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnv = (e.NODE_ENV === "production" ? "production" : e.NODE_ENV === "test" ? "test" : "development") as Env["nodeEnv"];
  const on = (v: string | undefined, dflt: boolean) => (v == null || v === "" ? dflt : /^(1|true|on|yes)$/i.test(v));
  const trim = (u: string) => u.replace(/\/+$/, "");
  const port = Number(e.PORT ?? 4000);
  const publicUrl = trim(e.PUBLIC_URL ?? e.RENDER_EXTERNAL_URL ?? `http://localhost:${port}`);
  const darajaReady = Boolean(e.DARAJA_CONSUMER_KEY && e.DARAJA_CONSUMER_SECRET);
  const provider = e.PAYMENTS_PROVIDER === "daraja" ? "daraja" : e.PAYMENTS_PROVIDER === "simulated" ? "simulated" : darajaReady ? "daraja" : "simulated";
  const allow = e.DARAJA_IP_ALLOWLIST;

  const env: Env = {
    nodeEnv,
    port,
    publicUrl,
    merchantUrl: trim(e.MERCHANT_APP_URL ?? "http://localhost:5310"),
    adminUrl: trim(e.ADMIN_APP_URL ?? "http://localhost:5320"),
    databaseUrl: e.DATABASE_URL || null,
    pgliteDir: e.PGLITE_DIR || null,
    jwtSecret: e.JWT_SECRET ?? (nodeEnv === "production" ? "" : "dev-only-secret-change-me-dev-only-secret"),
    masterKey: masterKey(e.MASTER_KEY),
    adminSetupToken: e.ADMIN_SETUP_TOKEN || (nodeEnv === "production" ? null : "local-setup"),
    callbackSecret: e.CALLBACK_SECRET ?? (nodeEnv === "production" ? "" : "dev-callback"),
    provider,
    daraja: {
      env: e.DARAJA_ENV === "production" ? "production" : "sandbox",
      consumerKey: e.DARAJA_CONSUMER_KEY ?? "",
      consumerSecret: e.DARAJA_CONSUMER_SECRET ?? "",
      shortcode: e.DARAJA_SHORTCODE ?? "600000",
      passkey: e.DARAJA_PASSKEY ?? "",
      initiator: e.DARAJA_INITIATOR ?? "",
      securityCredential: e.DARAJA_SECURITY_CREDENTIAL ?? "",
      b2cCommand: (e.DARAJA_B2C_COMMAND as Env["daraja"]["b2cCommand"]) || "BusinessPayment",
      c2bResponseType: e.DARAJA_C2B_RESPONSE_TYPE === "Cancelled" ? "Cancelled" : "Completed",
      ipAllowlist: allow === "off" ? [] : allow ? allow.split(",").map((s) => s.trim()).filter(Boolean) : provider === "daraja" && nodeEnv === "production" ? SAFARICOM_IPS : [],
      credentialsRotatedAt: e.DARAJA_CREDENTIALS_ROTATED_AT || null,
    },
    paybillNumber: e.PAYBILL_NUMBER ?? e.DARAJA_SHORTCODE ?? "600000",
    device: {
      transport: e.DEVICE_TRANSPORT === "external" ? "external" : "embedded",
      mqttUrl: e.MQTT_URL ?? "",
      mqttUsername: e.MQTT_USERNAME ?? "aura-server",
      mqttPassword: e.MQTT_PASSWORD ?? "",
      hookSecret: e.MQTT_HOOK_SECRET ?? "",
      publicMqttUrl: e.MQTT_PUBLIC_URL ?? publicUrl.replace(/^http/, "ws") + "/mqtt",
      virtualDevices: on(e.VIRTUAL_DEVICES, provider === "simulated"),
    },
    sms: {
      provider: e.SMS_PROVIDER === "africastalking" || e.SMS_PROVIDER === "celcom" ? e.SMS_PROVIDER : e.AT_API_KEY ? "africastalking" : e.CELCOM_API_KEY ? "celcom" : "log",
      atUsername: e.AT_USERNAME ?? "",
      atApiKey: e.AT_API_KEY ?? "",
      atSenderId: e.AT_SENDER_ID ?? "",
      celcomApiKey: e.CELCOM_API_KEY ?? "",
      celcomPartnerId: e.CELCOM_PARTNER_ID ?? "",
      celcomShortcode: e.CELCOM_SHORTCODE ?? "",
    },
    email: { resendApiKey: e.RESEND_API_KEY ?? "", from: e.EMAIL_FROM ?? "Aura Pool <alerts@aura-pool.local>" },
    push: { vapidPublic: e.VAPID_PUBLIC_KEY ?? "", vapidPrivate: e.VAPID_PRIVATE_KEY ?? "", subject: e.VAPID_SUBJECT ?? "mailto:ops@aura-pool.local" },
    otpEcho: on(e.OTP_ECHO, nodeEnv !== "production"),
    // Cleaned the same way the front-end servers clean it, so a pasted line break or prefix still matches.
    proxySecret: (e.PROXY_SECRET ?? "").trim().replace(/^PROXY_SECRET=/, "").replace(/^(["'])(.*)\1$/, "$2").trim(),
    turnstileSecret: e.TURNSTILE_SECRET ?? "",
    turnstileSiteKey: e.TURNSTILE_SITE_KEY ?? "",
  };

  if (nodeEnv === "production") {
    const missing = [
      !env.databaseUrl && "DATABASE_URL",
      !e.MASTER_KEY && "MASTER_KEY",
      env.jwtSecret.length < 32 && "JWT_SECRET (32+ chars)",
      env.callbackSecret.length < 16 && "CALLBACK_SECRET (16+ chars)",
      env.device.transport === "external" && !env.device.mqttUrl && "MQTT_URL",
    ].filter(Boolean);
    if (missing.length) throw new Error(`Missing production settings: ${missing.join(", ")}. Add them to this service's environment.`);
    if (env.provider === "daraja" && !darajaReady) throw new Error("PAYMENTS_PROVIDER=daraja needs DARAJA_CONSUMER_KEY and DARAJA_CONSUMER_SECRET");
  }
  // Codes on screen are a test convenience. Never against real money.
  if (env.otpEcho && env.provider === "daraja" && env.daraja.env === "production") {
    throw new Error("OTP_ECHO cannot be on while PAYMENTS_PROVIDER=daraja and DARAJA_ENV=production");
  }
  if (env.device.virtualDevices && env.provider === "daraja" && env.daraja.env === "production") {
    env.device.virtualDevices = false;
  }
  return env;
}

export const env = loadEnv();

/** True while no real money can move: the simulated provider, or Daraja's sandbox. */
export const isSandbox = () => env.provider === "simulated" || env.daraja.env === "sandbox";
