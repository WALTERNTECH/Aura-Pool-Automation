import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { env } from "../config/env.js";

// Hashing, sealing secrets at rest, one-time codes and TOTP.

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const hmacHex = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const sixDigits = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Human reference without look-alike characters, e.g. WD-7K2M9Q. */
export function shortRef(prefix: string, len = 6): string {
  const abc = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = prefix;
  for (let i = 0; i < len; i++) s += abc[randomInt(0, abc.length)];
  return s;
}

// Passwords (admins) are bcrypt. PINs are only six digits, so they are peppered with a key
// derived from MASTER_KEY before bcrypt: a copy of the database alone can't be brute-forced.
const pinPepper = () => createHmac("sha256", env.masterKey).update("aura-pin-pepper-v1").digest();
export const hashPassword = (pw: string) => bcrypt.hash(pw, 11);
export const verifyPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);
export const hashPin = (pin: string) => bcrypt.hash(hmacHex(pinPepper(), pin), 10);
export const verifyPin = (pin: string, hash: string) => bcrypt.compare(hmacHex(pinPepper(), pin), hash);

/** Codes and tokens at rest: keyed hash, so a leaked table can't be replayed. */
export const hashSecret = (s: string) => hmacHex(env.masterKey, `aura-secret-v1|${s}`);

/** Payer numbers are stored hashed. The key keeps the hash useful for matching repeat payers only to us. */
export const hashMsisdn = (msisdn: string) => hmacHex(env.masterKey, `aura-msisdn-v1|${msisdn.replace(/\D/g, "")}`);

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", env.masterKey, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64")}.${c.getAuthTag().toString("base64")}.${body.toString("base64")}`;
}

export function decrypt(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1") throw new Error("unknown ciphertext version");
  const d = createDecipheriv("aes-256-gcm", env.masterKey, Buffer.from(iv, "base64"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([d.update(Buffer.from(body, "base64")), d.final()]).toString("utf8");
}

// RFC 6238 TOTP, SHA-1, 6 digits, 30 s steps: what every authenticator app speaks.
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function newTotpSecret(): string {
  const bytes = randomBytes(20);
  let bits = "";
  let out = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
function base32Decode(s: string): Buffer {
  let bits = "";
  for (const ch of s.replace(/=+$/, "").toUpperCase()) bits += B32.indexOf(ch).toString(2).padStart(5, "0");
  const out: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totpAt(secret: string, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}
/** Returns the matched time step (to refuse reuse of the same code), or null. */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  const step = Math.floor(now / 30_000);
  const want = code.replace(/\s/g, "");
  for (const d of [-1, 0, 1]) if (safeEqual(totpAt(secret, step + d), want)) return step + d;
  return null;
}
export const totpUri = (secret: string, account: string) =>
  `otpauth://totp/Aura%20Pool%20Admin:${encodeURIComponent(account)}?secret=${secret}&issuer=Aura%20Pool%20Admin&period=30&digits=6`;
