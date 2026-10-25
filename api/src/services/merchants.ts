import { env } from "../config/env.js";
import { db, many, one, type Q } from "../config/db.js";
import { hashPin, hashSecret, randomToken, verifyPin } from "../lib/crypto.js";
import { badRequest, conflict, forbidden, locked, notFound } from "../lib/http.js";
import { maskMsisdn, normaliseMsisdn } from "../lib/kenya.js";
import { raise } from "./alerts.js";
import { activity, audit, type AuditWho } from "./audit.js";
import { enqueue } from "./jobs.js";
import { sendSms } from "./messaging.js";
import { notifyMerchant } from "./notify.js";
import { checkOtp, consumeOtp, issueOtp } from "./otp.js";
import { revokeAll } from "./sessions.js";
import { getSetting } from "./settings.js";

// Merchants, their owner and staff accounts, invites, PINs, and the payout number.

export async function nextMerchantCode(q: Q) {
  const r = await one<{ n: number }>(q, `select coalesce(max(substring(code from 2)::int), 0) + 1 as n from merchants`);
  return `M${String(r!.n).padStart(3, "0")}`;
}

export type CreateMerchant = {
  businessName: string;
  ownerName: string;
  phone: string;
  email?: string | null;
  location?: string | null;
  payoutMsisdn?: string | null;
  feePolicy?: "merchant" | "platform" | null;
  priceMinMinor?: number | null;
  priceMaxMinor?: number | null;
  unlockMinS?: number | null;
  unlockMaxS?: number | null;
  payoutMinMinor?: number | null;
  payoutDailyCapMinor?: number | null;
  payoutApprovalThresholdMinor?: number | null;
  manualUnlockDailyLimit?: number | null;
};

export async function createMerchant(input: CreateMerchant, admin: { id: string }, who: AuditWho) {
  const phone = normaliseMsisdn(input.phone);
  if (!phone) throw badRequest("Enter a valid Kenyan phone number for the owner");
  const payout = input.payoutMsisdn ? normaliseMsisdn(input.payoutMsisdn) : phone;
  if (input.payoutMsisdn && !payout) throw badRequest("Enter a valid payout number");
  return db().tx(async (q) => {
    if (await one(q, `select 1 from merchant_users where phone = $1`, [phone])) throw conflict("That phone number already belongs to an account");
    const code = await nextMerchantCode(q);
    const m = await one<{ id: string }>(
      q,
      `insert into merchants (code, business_name, owner_name, phone, email, location, payout_msisdn, fee_policy, price_min_minor, price_max_minor,
                              unlock_min_s, unlock_max_s, payout_min_minor, payout_daily_cap_minor, payout_approval_threshold_minor, manual_unlock_daily_limit, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning id`,
      [code, input.businessName.trim(), input.ownerName.trim(), phone, input.email?.trim().toLowerCase() || null, input.location?.trim() || null, payout, input.feePolicy ?? null, input.priceMinMinor ?? null, input.priceMaxMinor ?? null, input.unlockMinS ?? null, input.unlockMaxS ?? null, input.payoutMinMinor ?? null, input.payoutDailyCapMinor ?? null, input.payoutApprovalThresholdMinor ?? null, input.manualUnlockDailyLimit ?? null, admin.id],
    );
    const u = await one<{ id: string }>(q, `insert into merchant_users (merchant_id, role, name, phone, created_by) values ($1,'owner',$2,$3,$4) returning id`, [m!.id, input.ownerName.trim(), phone, admin.id]);
    const link = await createInvite(q, u!.id, input.businessName.trim(), phone);
    await audit(q, who, "merchant.create", { type: "merchant", id: m!.id }, null, { code, ...input, phone });
    await activity(q, "merchant.new", `New merchant ${input.businessName} (${code})`, { type: "merchant", id: m!.id });
    return { id: m!.id, code, inviteLink: env.otpEcho ? link : undefined };
  });
}

export async function createInvite(q: Q, userId: string, businessName: string, phone: string) {
  const token = randomToken(24);
  await q.query(`update invites set used_at = now() where merchant_user_id = $1 and used_at is null`, [userId]);
  await q.query(`insert into invites (merchant_user_id, token_hash, expires_at) values ($1,$2, now() + interval '7 days')`, [userId, hashSecret(token)]);
  const link = `${env.merchantUrl}/invite/${token}`;
  await enqueue(q, "sms.send", { phone, text: `${businessName} is set up on Aura Pool. Open ${link} to set your PIN and see your tables.` });
  return link;
}

export async function inviteByToken(q: Q, token: string) {
  const r = await one<{ invite_id: string; user_id: string; role: string; name: string; phone: string; status: string; business_name: string; expires_at: Date; used_at: Date | null; merchant_id: string; pin_hash: string | null }>(
    q,
    `select i.id as invite_id, u.id as user_id, u.role, u.name, u.phone, u.status, m.business_name, i.expires_at, i.used_at, u.merchant_id, u.pin_hash
       from invites i join merchant_users u on u.id = i.merchant_user_id join merchants m on m.id = u.merchant_id
      where i.token_hash = $1`,
    [hashSecret(token)],
  );
  if (!r || r.used_at || new Date(r.expires_at) < new Date()) throw notFound("This invite link has expired or was already used. Ask for a new one.");
  if (r.status === "revoked") throw forbidden("This account was closed");
  return r;
}

/** Step 1: choose a PIN; a code goes to the phone. */
export async function invitePin(token: string, pin: string) {
  return db().tx(async (q) => {
    const inv = await inviteByToken(q, token);
    if (/^(\d)\1{5}$/.test(pin) || ["123456", "654321", "012345", "123123"].includes(pin)) throw badRequest("Pick a PIN that's harder to guess", "weak_pin");
    await q.query(`update merchant_users set pin_hash = $2 where id = $1`, [inv.user_id, await hashPin(pin)]);
    const otp = await issueOtp(q, inv.phone, inv.role === "owner" ? "onboarding" : "staff_onboarding", { inviteId: inv.invite_id });
    return { phoneMasked: maskMsisdn(inv.phone), otp };
  });
}

/** Step 2: the code proves the phone; accepting the terms activates the account. */
export async function inviteVerify(token: string, code: string) {
  const first = await inviteByToken(db(), token);
  if (!first.pin_hash) throw badRequest("Choose your PIN first");
  const otp = await checkOtp(first.phone, first.role === "owner" ? "onboarding" : "staff_onboarding", code);
  return db().tx(async (q) => {
    const inv = await inviteByToken(q, token);
    await consumeOtp(q, otp.id);
    const terms = await getSetting("terms_version", q);
    await q.query(`update merchant_users set status = 'active', phone_verified_at = now(), terms_accepted_at = now(), terms_version = $2, failed_pin_attempts = 0, locked_until = null where id = $1`, [inv.user_id, terms]);
    await q.query(`update invites set used_at = now() where id = $1`, [inv.invite_id]);
    if (inv.role === "owner") await q.query(`update merchants set status = 'active' where id = $1 and status = 'invited'`, [inv.merchant_id]);
    await audit(q, { type: "merchant", id: inv.user_id, label: `${inv.name} (${inv.role})` }, "merchant_user.activate", { type: "merchant_user", id: inv.user_id }, { status: inv.status }, { status: "active", termsVersion: terms });
    const u = await one<{ id: string; token_version: number }>(q, `select id, token_version from merchant_users where id = $1`, [inv.user_id]);
    return u!;
  });
}

/**
 * Checks a PIN. Five wrong tries lock the account for 15 minutes. The attempt is recorded in
 * its own transaction, which commits before any error is raised: a refusal must never roll
 * back the count of wrong tries.
 */
export async function requirePin(userId: string, pin: string | undefined) {
  if (!pin) throw badRequest("Enter your PIN to confirm", "pin_required");
  const err = await db().tx(async (q) => {
    const u = await one<{ pin_hash: string | null; failed_pin_attempts: number; locked_until: Date | null; status: string }>(q, `select pin_hash, failed_pin_attempts, locked_until, status from merchant_users where id = $1 for update`, [userId]);
    if (!u || !u.pin_hash || u.status !== "active") return forbidden("This account isn't active");
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60_000);
      return locked(`Too many wrong PINs. Try again in ${mins} minute${mins > 1 ? "s" : ""}.`, { lockedUntil: u.locked_until });
    }
    if (await verifyPin(pin, u.pin_hash)) {
      if (u.failed_pin_attempts) await q.query(`update merchant_users set failed_pin_attempts = 0, locked_until = null where id = $1`, [userId]);
      return null;
    }
    const n = u.failed_pin_attempts + 1;
    const lock = n >= 5;
    await q.query(`update merchant_users set failed_pin_attempts = case when $2 then 0 else $3 end, locked_until = case when $2 then now() + interval '15 minutes' else locked_until end where id = $1`, [userId, lock, n]);
    if (lock) {
      await audit(q, { type: "system" }, "merchant_user.locked", { type: "merchant_user", id: userId }, null, { minutes: 15 });
      return locked("Too many wrong PINs. Your account is locked for 15 minutes.");
    }
    return badRequest(`Wrong PIN. ${5 - n} ${5 - n === 1 ? "try" : "tries"} left before a 15-minute lock.`, "wrong_pin");
  });
  if (err) throw err;
}

export async function login(phoneInput: string, pin: string) {
  const phone = normaliseMsisdn(phoneInput);
  if (!phone) throw badRequest("Enter the phone number you were invited with");
  const u = await one<{ id: string; token_version: number; status: string }>(db(), `select id, token_version, status from merchant_users where phone = $1`, [phone]);
  // Same message for unknown numbers, so the form doesn't reveal who has an account.
  if (!u || u.status !== "active") throw badRequest("That phone number and PIN don't match an account", "bad_login");
  await requirePin(u.id, pin);
  await db().query(`update merchant_users set last_login_at = now() where id = $1`, [u.id]);
  return u;
}

export async function changePin(userId: string, current: string, next: string, keepSid: string | null) {
  await requirePin(userId, current);
  if (/^(\d)\1{5}$/.test(next) || ["123456", "654321", "012345"].includes(next)) throw badRequest("Pick a PIN that's harder to guess", "weak_pin");
  await db().tx(async (q) => {
    await q.query(`update merchant_users set pin_hash = $2 where id = $1`, [userId, await hashPin(next)]);
    await revokeAll(q, "merchant", userId, "PIN changed", keepSid ?? undefined);
    await audit(q, { type: "merchant", id: userId }, "merchant_user.pin_change", { type: "merchant_user", id: userId });
  });
}

// ------------------------------------------------------------------ payout number

/** Starts adding (first time) or changing the payout number; codes go to the new number and, for a change, the old one. */
export async function startNumberChange(merchantId: string, userId: string, input: string, oldUnavailable: boolean) {
  const msisdn = normaliseMsisdn(input);
  if (!msisdn) throw badRequest("Enter a valid Safaricom number, like 0712 345 678");
  return db().tx(async (q) => {
    const m = await one<{ payout_msisdn: string | null; payout_msisdn_verified_at: Date | null; status: string }>(q, `select payout_msisdn, payout_msisdn_verified_at, status from merchants where id = $1 for update`, [merchantId]);
    if (!m) throw notFound("Merchant not found");
    if (m.status === "suspended" || m.status === "closed") throw forbidden("Your account is suspended. Contact support to change your number.");
    const first = !m.payout_msisdn_verified_at;
    if (!first && m.payout_msisdn === msisdn) throw badRequest("That's already your payout number");
    await q.query(`update payout_number_changes set status = 'cancelled' where merchant_id = $1 and status = 'otp_pending'`, [merchantId]);
    const needsOld = !first && !oldUnavailable;
    const c = await one<{ id: string }>(
      q,
      `insert into payout_number_changes (merchant_id, old_msisdn, new_msisdn, kind, status, needs_old_otp, requested_by) values ($1,$2,$3,$4,'otp_pending',$5,$6) returning id`,
      [merchantId, first ? null : m.payout_msisdn, msisdn, first ? "first" : "change", needsOld, userId],
    );
    const otpNew = await issueOtp(q, msisdn, "payout_number_new", { changeId: c!.id });
    const otpOld = needsOld ? await issueOtp(q, m.payout_msisdn!, "payout_number_old", { changeId: c!.id }) : null;
    await audit(q, { type: "merchant", id: userId }, "payout_number.start", { type: "merchant", id: merchantId }, { number: m.payout_msisdn ? maskMsisdn(m.payout_msisdn) : null }, { number: maskMsisdn(msisdn), first, oldUnavailable });
    return { changeId: c!.id, kind: first ? "first" : "change", newMasked: maskMsisdn(msisdn), oldMasked: needsOld ? maskMsisdn(m.payout_msisdn!) : null, otpNew, otpOld };
  });
}

export async function verifyNumberChange(merchantId: string, userId: string, changeId: string, codeNew: string, codeOld?: string) {
  // Check both codes first (each guess is counted), consume them only when the change applies.
  const pending = await one<{ status: string; old_msisdn: string | null; new_msisdn: string; needs_old_otp: boolean }>(db(), `select status, old_msisdn, new_msisdn, needs_old_otp from payout_number_changes where id = $1 and merchant_id = $2`, [changeId, merchantId]);
  if (!pending || pending.status !== "otp_pending") throw notFound("This change has expired. Start again.");
  if (pending.needs_old_otp && !codeOld) throw badRequest("Enter the code sent to your current number", "old_code_required");
  const otpNew = await checkOtp(pending.new_msisdn, "payout_number_new", codeNew);
  if (otpNew.context.changeId !== changeId) throw badRequest("That code is for a different request");
  const otpOld = pending.needs_old_otp ? await checkOtp(pending.old_msisdn!, "payout_number_old", codeOld!) : null;
  if (otpOld && otpOld.context.changeId !== changeId) throw badRequest("That code is for a different request");
  const out = await db().tx(async (q) => {
    const c = await one<{ id: string; status: string; kind: string; old_msisdn: string | null; new_msisdn: string; needs_old_otp: boolean }>(q, `select * from payout_number_changes where id = $1 and merchant_id = $2 for update`, [changeId, merchantId]);
    if (!c || c.status !== "otp_pending") throw notFound("This change has expired. Start again.");
    await consumeOtp(q, otpNew.id);
    if (otpOld) await consumeOtp(q, otpOld.id);
    if (c.kind === "first") {
      await q.query(`update payout_number_changes set status = 'active', completed_at = now() where id = $1`, [changeId]);
      await q.query(`update merchants set payout_msisdn = $2, payout_msisdn_verified_at = now(), payout_hold_until = null where id = $1`, [merchantId, c.new_msisdn]);
      await audit(q, { type: "merchant", id: userId }, "payout_number.verify", { type: "merchant", id: merchantId }, null, { number: maskMsisdn(c.new_msisdn) });
      return { kind: "first" as const, holdUntil: null, c };
    }
    const hours = (await getSetting("payout", q)).cooling_hours;
    const holdUntil = new Date(Date.now() + hours * 3600_000);
    await q.query(`update payout_number_changes set status = 'cooling', hold_until = $2 where id = $1`, [changeId, holdUntil]);
    await q.query(`update merchants set payout_msisdn = $2, payout_msisdn_verified_at = now(), payout_hold_until = $3 where id = $1`, [merchantId, c.new_msisdn, holdUntil]);
    await audit(q, { type: "merchant", id: userId }, "payout_number.change", { type: "merchant", id: merchantId }, { number: maskMsisdn(c.old_msisdn) }, { number: maskMsisdn(c.new_msisdn), holdUntil });
    await raise(q, { type: "number_change", severity: "info", title: `Payout number changed for a merchant`, detail: `${maskMsisdn(c.old_msisdn)} → ${maskMsisdn(c.new_msisdn)}. Withdrawals are held until ${holdUntil.toISOString()}.`, dedupeKey: `number_change:${changeId}`, entity: { type: "merchant", id: merchantId } });
    return { kind: "change" as const, holdUntil, c };
  });
  if (out.kind === "change") {
    if (out.c.old_msisdn) await sendSms(out.c.old_msisdn, `Aura Pool: your payout number was changed to ${maskMsisdn(out.c.new_msisdn)}. Withdrawals are held for 24 hours. If this wasn't you, call support now.`);
    await notifyMerchant(db(), merchantId, {
      type: "number_change",
      title: "Payout number changed",
      body: `Withdrawals now go to ${maskMsisdn(out.c.new_msisdn)}. For your safety they are held for 24 hours.`,
      sms: `Your Aura Pool payout number is now ${maskMsisdn(out.c.new_msisdn)}. Withdrawals are held for 24 hours.`,
      url: "/money/number",
    });
  }
  return { kind: out.kind, holdUntil: out.holdUntil?.toISOString() ?? null };
}

export async function resendNumberCode(merchantId: string, changeId: string, which: "new" | "old") {
  return db().tx(async (q) => {
    const c = await one<{ status: string; old_msisdn: string | null; new_msisdn: string; needs_old_otp: boolean }>(q, `select * from payout_number_changes where id = $1 and merchant_id = $2`, [changeId, merchantId]);
    if (!c || c.status !== "otp_pending") throw notFound("This change has expired. Start again.");
    if (which === "old" && !c.needs_old_otp) throw badRequest("No code is needed from the old number");
    return issueOtp(q, which === "new" ? c.new_msisdn : c.old_msisdn!, which === "new" ? "payout_number_new" : "payout_number_old", { changeId });
  });
}

/** Ends cooling-off periods that have passed. */
export async function completeCooling() {
  const done = await many<{ id: string; merchant_id: string }>(db(), `update payout_number_changes set status = 'active', completed_at = now() where status = 'cooling' and hold_until <= now() returning id, merchant_id`);
  for (const d of done) await db().query(`update merchants set payout_hold_until = null where id = $1 and payout_hold_until <= now()`, [d.merchant_id]);
  return done.length;
}

/** Fast-track (after four-eyes approval): the cooling-off ends now. */
export async function fastTrackNumber(q: Q, merchantId: string, adminId: string | null, who: AuditWho) {
  const c = await one<{ id: string }>(q, `update payout_number_changes set status = 'active', fast_tracked_by = $2, fast_tracked_at = now(), completed_at = now(), hold_until = now() where merchant_id = $1 and status = 'cooling' returning id`, [merchantId, adminId]);
  if (!c) throw conflict("There is no number change in its cooling-off period");
  await q.query(`update merchants set payout_hold_until = null where id = $1`, [merchantId]);
  await q.query(`update payouts set hold_until = now() where merchant_id = $1 and status = 'held'`, [merchantId]);
  await audit(q, who, "payout_number.fast_track", { type: "merchant", id: merchantId }, { cooling: true }, { cooling: false });
  await enqueue(q, "payouts.sweep", {});
  return { changeId: c.id };
}

// ------------------------------------------------------------------ staff (attendants)

export async function addStaff(merchantId: string, owner: { id: string; label: string }, name: string, phoneInput: string) {
  const phone = normaliseMsisdn(phoneInput);
  if (!phone) throw badRequest("Enter a valid phone number");
  return db().tx(async (q) => {
    if (await one(q, `select 1 from merchant_users where phone = $1`, [phone])) throw conflict("That number already has an Aura Pool account");
    const m = await one<{ business_name: string }>(q, `select business_name from merchants where id = $1`, [merchantId]);
    const u = await one<{ id: string }>(q, `insert into merchant_users (merchant_id, role, name, phone, created_by) values ($1,'staff',$2,$3,$4) returning id`, [merchantId, name.trim(), phone, owner.id]);
    const link = await createInvite(q, u!.id, m!.business_name, phone);
    await audit(q, { type: "merchant", id: owner.id, label: owner.label }, "staff.add", { type: "merchant_user", id: u!.id }, null, { name, phone: maskMsisdn(phone) });
    return { id: u!.id, inviteLink: env.otpEcho ? link : undefined };
  });
}

export async function revokeStaff(merchantId: string, owner: { id: string; label: string }, staffId: string) {
  await db().tx(async (q) => {
    const s = await one<{ id: string; status: string }>(q, `select id, status from merchant_users where id = $1 and merchant_id = $2 and role = 'staff' for update`, [staffId, merchantId]);
    if (!s) throw notFound("Staff member not found");
    await q.query(`update merchant_users set status = 'revoked', token_version = token_version + 1 where id = $1`, [staffId]);
    await revokeAll(q, "merchant", staffId, "access revoked by owner");
    await q.query(`update invites set used_at = now() where merchant_user_id = $1 and used_at is null`, [staffId]);
    await audit(q, { type: "merchant", id: owner.id, label: owner.label }, "staff.revoke", { type: "merchant_user", id: staffId }, { status: s.status }, { status: "revoked" });
  });
}
