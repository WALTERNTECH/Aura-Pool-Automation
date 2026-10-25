import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { env } from "../config/env.js";
import { db, many, one } from "../config/db.js";
import { badRequest, notFound, unauthorized } from "../lib/http.js";
import { audit } from "./audit.js";

// Device biometrics (fingerprint / face) for owners and attendants, via WebAuthn. The relying
// party is the merchant app's own host. A PIN is still required for money actions.

const rp = () => {
  const u = new URL(env.merchantUrl);
  return { id: u.hostname, origin: u.origin };
};

export async function registrationOptions(userId: string) {
  const u = await one<{ name: string; phone: string }>(db(), `select name, phone from merchant_users where id = $1`, [userId]);
  if (!u) throw notFound("Account not found");
  const existing = await many<{ credential_id: string; transports: string[] }>(db(), `select credential_id, transports from webauthn_credentials where merchant_user_id = $1`, [userId]);
  const opts = await generateRegistrationOptions({
    rpName: "Aura Pool",
    rpID: rp().id,
    userName: u.phone,
    userDisplayName: u.name,
    userID: new TextEncoder().encode(userId),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: c.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required", authenticatorAttachment: "platform" },
    preferredAuthenticatorType: "localDevice",
  });
  await db().query(`insert into webauthn_challenges (merchant_user_id, purpose, challenge, expires_at) values ($1,'register',$2, now() + interval '5 minutes')`, [userId, opts.challenge]);
  return opts;
}

export async function registerCredential(userId: string, response: RegistrationResponseJSON, label: string) {
  const ch = await one<{ id: string; challenge: string }>(db(), `select id, challenge from webauthn_challenges where merchant_user_id = $1 and purpose = 'register' and used_at is null and expires_at > now() order by expires_at desc limit 1`, [userId]);
  if (!ch) throw badRequest("That took too long. Try again.");
  const v = await verifyRegistrationResponse({ response, expectedChallenge: ch.challenge, expectedOrigin: rp().origin, expectedRPID: rp().id, requireUserVerification: true }).catch((e: Error) => {
    throw badRequest(`This device's fingerprint sign-in couldn't be set up (${e.message})`);
  });
  await db().query(`update webauthn_challenges set used_at = now() where id = $1`, [ch.id]);
  if (!v.verified) throw badRequest("This device's fingerprint sign-in couldn't be verified");
  const c = v.registrationInfo.credential;
  await db().query(
    `insert into webauthn_credentials (merchant_user_id, credential_id, public_key, counter, transports, device_label) values ($1,$2,$3,$4,$5,$6) on conflict (credential_id) do nothing`,
    [userId, c.id, Buffer.from(c.publicKey).toString("base64url"), c.counter, c.transports ?? [], label.slice(0, 80)],
  );
  await audit(db(), { type: "merchant", id: userId }, "webauthn.register", { type: "merchant_user", id: userId }, null, { device: label });
}

export async function loginOptions(userId: string) {
  const creds = await many<{ credential_id: string; transports: string[] }>(db(), `select credential_id, transports from webauthn_credentials where merchant_user_id = $1`, [userId]);
  if (!creds.length) throw badRequest("Fingerprint sign-in isn't set up on this account. Use your PIN.", "no_credentials");
  const opts = await generateAuthenticationOptions({
    rpID: rp().id,
    allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: c.transports as AuthenticatorTransport[] })),
    userVerification: "required",
  });
  await db().query(`insert into webauthn_challenges (merchant_user_id, purpose, challenge, expires_at) values ($1,'login',$2, now() + interval '5 minutes')`, [userId, opts.challenge]);
  return opts;
}

export async function verifyLogin(userId: string, response: AuthenticationResponseJSON) {
  const ch = await one<{ id: string; challenge: string }>(db(), `select id, challenge from webauthn_challenges where merchant_user_id = $1 and purpose = 'login' and used_at is null and expires_at > now() order by expires_at desc limit 1`, [userId]);
  if (!ch) throw unauthorized("That took too long. Try again.");
  const cred = await one<{ id: string; credential_id: string; public_key: string; counter: number; transports: string[] }>(db(), `select * from webauthn_credentials where credential_id = $1 and merchant_user_id = $2`, [response.id, userId]);
  if (!cred) throw unauthorized("This device isn't registered for fingerprint sign-in");
  await db().query(`update webauthn_challenges set used_at = now() where id = $1`, [ch.id]);
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge: ch.challenge,
    expectedOrigin: rp().origin,
    expectedRPID: rp().id,
    requireUserVerification: true,
    credential: { id: cred.credential_id, publicKey: new Uint8Array(Buffer.from(cred.public_key, "base64url")), counter: Number(cred.counter), transports: cred.transports as AuthenticatorTransport[] },
  }).catch(() => ({ verified: false, authenticationInfo: { newCounter: 0 } }));
  if (!v.verified) throw unauthorized("Fingerprint sign-in failed. Use your PIN.");
  await db().query(`update webauthn_credentials set counter = $2, last_used_at = now() where id = $1`, [cred.id, v.authenticationInfo.newCounter]);
}

export async function listCredentials(userId: string) {
  return many(db(), `select id, device_label, created_at, last_used_at from webauthn_credentials where merchant_user_id = $1 order by created_at`, [userId]);
}

export async function removeCredential(userId: string, id: string) {
  await db().query(`delete from webauthn_credentials where id = $1 and merchant_user_id = $2`, [id, userId]);
  await audit(db(), { type: "merchant", id: userId }, "webauthn.remove", { type: "merchant_user", id: userId }, null, { credential: id });
}
