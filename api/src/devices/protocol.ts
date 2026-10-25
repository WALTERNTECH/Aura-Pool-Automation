import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// The device protocol (spec section 9), shared by the server, the device simulator and the
// firmware. Topics, per table:
//
//   pool/{table_id}/cmd     server → device   unlock commands (QoS 1)
//   pool/{table_id}/ack     device → server   one ack per command
//   pool/{table_id}/status  device → server   heartbeat every 30 s, retained; last will {"online":false}
//   pool/{table_id}/event   device → server   override button presses and errors
//
// Command signature: HMAC-SHA256 over "cmd_id|action|duration_s|issued_at|expires_at|nonce",
// keyed with the device's secret (its ASCII bytes), hex encoded. Times are Unix seconds.

export const topics = (tableId: string) => ({
  cmd: `pool/${tableId}/cmd`,
  ack: `pool/${tableId}/ack`,
  status: `pool/${tableId}/status`,
  event: `pool/${tableId}/event`,
});

export type Command = {
  cmd_id: string;
  action: "unlock";
  duration_s: number;
  issued_at: number;
  expires_at: number;
  nonce: string;
  sig: string;
};

export type Ack = { cmd_id: string; result: "ok" | "rejected" | "busy"; reason?: string; ts?: number };
export type Status = { online?: boolean; fw?: string; rssi?: number; uptime_s?: number; relay?: "on" | "off"; ip?: string; ts?: number };
export type DeviceEvent = { type: "manual_override" | "error" | "boot" | string; ts?: number; detail?: string; duration_s?: number };

/** The longest a relay may stay on, whatever a command says. */
export const MAX_ON_SECONDS = 60;
/** A command older than this is refused by the device. */
export const COMMAND_TTL_SECONDS = 60;

export function canonical(c: Omit<Command, "sig">): string {
  return `${c.cmd_id}|${c.action}|${c.duration_s}|${c.issued_at}|${c.expires_at}|${c.nonce}`;
}

export function sign(c: Omit<Command, "sig">, secret: string): string {
  return createHmac("sha256", Buffer.from(secret, "utf8")).update(canonical(c)).digest("hex");
}

export function buildCommand(cmdId: string, durationS: number, issuedAt: Date, expiresAt: Date, secret: string, nonce = randomBytes(8).toString("hex")): Command {
  const base = {
    cmd_id: cmdId,
    action: "unlock" as const,
    duration_s: Math.min(MAX_ON_SECONDS, Math.max(1, Math.round(durationS))),
    issued_at: Math.floor(issuedAt.getTime() / 1000),
    expires_at: Math.floor(expiresAt.getTime() / 1000),
    nonce,
  };
  return { ...base, sig: sign(base, secret) };
}

export type Verdict = { ok: true } | { ok: false; reason: "bad_signature" | "expired" | "duplicate" | "malformed" | "too_long" };

/** The checks a device makes before switching the relay (the firmware does the same in C). */
export function checkCommand(c: Partial<Command>, secret: string, nowS: number, recent: string[]): Verdict {
  if (!c || typeof c.cmd_id !== "string" || c.action !== "unlock" || typeof c.duration_s !== "number" || typeof c.issued_at !== "number" || typeof c.expires_at !== "number" || typeof c.nonce !== "string" || typeof c.sig !== "string") {
    return { ok: false, reason: "malformed" };
  }
  const want = Buffer.from(sign(c as Command, secret), "hex");
  const got = Buffer.from(c.sig, "hex");
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, reason: "bad_signature" };
  if (nowS > c.expires_at || nowS - c.issued_at > COMMAND_TTL_SECONDS) return { ok: false, reason: "expired" };
  if (recent.includes(c.cmd_id)) return { ok: false, reason: "duplicate" };
  if (c.duration_s > MAX_ON_SECONDS) return { ok: false, reason: "too_long" };
  return { ok: true };
}

export function parseTopic(topic: string): { tableId: string; kind: "cmd" | "ack" | "status" | "event" } | null {
  const m = topic.match(/^pool\/(T\d{3,})\/(cmd|ack|status|event)$/);
  return m ? { tableId: m[1], kind: m[2] as "cmd" | "ack" | "status" | "event" } : null;
}
