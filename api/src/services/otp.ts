import { env } from "../config/env.js";
import { db, one, type Q } from "../config/db.js";
import { hashSecret, safeEqual, sixDigits } from "../lib/crypto.js";
import { badRequest, tooMany } from "../lib/http.js";
import { enqueue, onJob } from "./jobs.js";
import { sendSms } from "./messaging.js";

// One-time codes by SMS: phone verification at sign-up, payout-number changes, and the old
// number's confirmation. Five a phone per hour per purpose; five tries per code; ten minutes.

export type OtpPurpose = "onboarding" | "payout_number_new" | "payout_number_old" | "staff_onboarding";

const TEXT: Record<OtpPurpose, (c: string) => string> = {
  onboarding: (c) => `Your Aura Pool code is ${c}. It expires in 10 minutes. Don't share it.`,
  staff_onboarding: (c) => `Your Aura Pool code is ${c}. It expires in 10 minutes. Don't share it.`,
  payout_number_new: (c) => `Aura Pool: ${c} confirms this number for your withdrawals. If you didn't ask for this, ignore it.`,
  payout_number_old: (c) => `Aura Pool: ${c} approves moving your withdrawals away from this number. Only share it if you asked for the change.`,
};

export async function issueOtp(q: Q, phone: string, purpose: OtpPurpose, context: Record<string, unknown> = {}) {
  const recent = await one<{ n: number }>(q, `select count(*)::int as n from otp_codes where phone = $1 and purpose = $2 and created_at > now() - interval '1 hour'`, [phone, purpose]);
  if ((recent?.n ?? 0) >= 5) throw tooMany("Too many codes requested. Try again in an hour.");
  const code = sixDigits();
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  await q.query(`update otp_codes set used_at = now() where phone = $1 and purpose = $2 and used_at is null`, [phone, purpose]);
  await q.query(`insert into otp_codes (phone, purpose, code_hash, context, expires_at) values ($1,$2,$3,$4,$5)`, [phone, purpose, hashSecret(code), JSON.stringify(context), expiresAt]);
  await enqueue(q, "otp.send", { phone, text: TEXT[purpose](code) });
  return { expiresAt: expiresAt.toISOString(), ...(env.otpEcho ? { testCode: code } : {}) };
}

onJob("otp.send", async (p) => {
  await sendSms(String(p.phone), String(p.text));
});

/**
 * Checks a code in its own committed transaction, so a wrong guess is always counted, and
 * returns its id and context. It is consumed with consumeOtp once the action it unlocks is done.
 */
export async function checkOtp(phone: string, purpose: OtpPurpose, code: string): Promise<{ id: string; context: Record<string, unknown> }> {
  const out = await db().tx(async (q) => {
    const row = await one<{ id: string; code_hash: string; attempts: number; expires_at: Date; context: Record<string, unknown> }>(
      q,
      `select id, code_hash, attempts, expires_at, context from otp_codes where phone = $1 and purpose = $2 and used_at is null order by created_at desc limit 1 for update`,
      [phone, purpose],
    );
    if (!row || new Date(row.expires_at) < new Date()) return { error: badRequest("That code has expired. Ask for a new one.", "otp_expired") };
    if (row.attempts >= 5) return { error: tooMany("Too many wrong codes. Ask for a new one.") };
    if (!safeEqual(hashSecret(String(code).trim()), row.code_hash)) {
      await q.query(`update otp_codes set attempts = attempts + 1 where id = $1`, [row.id]);
      return { error: badRequest(`That code isn't right. ${4 - row.attempts} ${4 - row.attempts === 1 ? "try" : "tries"} left.`, "otp_wrong") };
    }
    return { ok: { id: row.id, context: row.context ?? {} } };
  });
  if ("error" in out) throw out.error;
  return out.ok!;
}

/** Marks a checked code used, inside the transaction of the action it authorised. */
export async function consumeOtp(q: Q, id: string) {
  const r = await one(q, `update otp_codes set used_at = now() where id = $1 and used_at is null returning id`, [id]);
  if (!r) throw badRequest("That code was already used. Ask for a new one.", "otp_used");
}
