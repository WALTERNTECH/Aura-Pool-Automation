// Schema migrations, applied in order at boot and recorded in aura.schema_migrations.
// Never edit one that has shipped; add a new one.
//
// Money is integer minor units (KSh 50 = 5000), currency KES, everywhere. Times are
// timestamptz in UTC; the apps display Africa/Nairobi.

export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: "001_core",
    sql: `
-- Settings the operator changes from the console. Typed defaults live in services/settings.ts.
create table settings (
  key text primary key,
  value jsonb not null,
  updated_by text,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- people
create table admin_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  name text not null,
  phone text,
  role text not null check (role in ('super_admin','finance','support','auditor')),
  status text not null default 'invited' check (status in ('invited','active','deactivated')),
  password_hash text,
  totp_secret_enc text,
  totp_enabled_at timestamptz,
  -- A TOTP code is good for one sign-in only.
  last_totp_step bigint,
  recovery_codes jsonb not null default '[]'::jsonb,
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  ip_allowlist text[] not null default '{}',
  invite_token_hash text unique,
  invite_expires_at timestamptz,
  must_reset boolean not null default false,
  token_version integer not null default 0,
  last_login_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table merchants (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  business_name text not null,
  owner_name text not null,
  phone text not null,
  email text,
  location text,
  status text not null default 'invited' check (status in ('invited','active','suspended','closed')),
  status_reason text,
  block_table_payments boolean not null default false,
  payout_msisdn text,
  payout_msisdn_verified_at timestamptz,
  payout_hold_until timestamptz,
  payouts_suspended boolean not null default false,
  payouts_suspended_reason text,
  flagged_for_review boolean not null default false,
  fee_policy text check (fee_policy in ('merchant','platform')),
  price_min_minor integer,
  price_max_minor integer,
  unlock_min_s integer,
  unlock_max_s integer,
  payout_min_minor bigint,
  payout_daily_cap_minor bigint,
  payout_approval_threshold_minor bigint,
  manual_unlock_daily_limit integer,
  auto_withdraw_enabled boolean not null default false,
  auto_withdraw_time text check (auto_withdraw_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  auto_withdraw_min_minor bigint,
  auto_withdraw_last_date date,
  auto_withdraw_last_run jsonb,
  closed_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table merchant_users (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  role text not null check (role in ('owner','staff')),
  name text not null,
  phone text not null unique,
  status text not null default 'invited' check (status in ('invited','active','revoked')),
  pin_hash text,
  failed_pin_attempts integer not null default 0,
  locked_until timestamptz,
  phone_verified_at timestamptz,
  terms_accepted_at timestamptz,
  terms_version text,
  tour_done_at timestamptz,
  prefs jsonb not null default '{}'::jsonb,
  token_version integer not null default 0,
  last_login_at timestamptz,
  last_seen_at timestamptz,
  created_by text,
  created_at timestamptz not null default now()
);
create unique index merchant_users_one_owner on merchant_users(merchant_id) where role = 'owner';

create table invites (
  id uuid primary key default gen_random_uuid(),
  merchant_user_id uuid not null references merchant_users(id),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- One row per signed-in device. The refresh token rotates on every use; presenting an
-- old one revokes the session (token theft).
create table sessions (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('merchant','admin')),
  user_id uuid not null,
  refresh_hash text not null,
  -- The token just replaced stays good for 30 s, so two tabs refreshing at once don't trip
  -- reuse detection.
  prev_refresh_hash text,
  rotated_at timestamptz,
  user_agent text,
  ip text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  reauth_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_reason text
);
create index sessions_user on sessions(kind, user_id) where revoked_at is null;
create index sessions_refresh on sessions(refresh_hash);

create table otp_codes (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  purpose text not null,
  code_hash text not null,
  context jsonb not null default '{}'::jsonb,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index otp_codes_phone on otp_codes(phone, purpose, created_at desc);

create table webauthn_credentials (
  id uuid primary key default gen_random_uuid(),
  merchant_user_id uuid not null references merchant_users(id),
  credential_id text not null unique,
  public_key text not null,
  counter bigint not null default 0,
  transports text[] not null default '{}',
  device_label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table webauthn_challenges (
  id uuid primary key default gen_random_uuid(),
  merchant_user_id uuid not null references merchant_users(id),
  purpose text not null check (purpose in ('register','login')),
  challenge text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

-- ---------------------------------------------------------------- tables and devices
create table pool_tables (
  id text primary key check (id ~ '^T[0-9]{3,}$'),
  seq integer not null unique,
  merchant_id uuid not null references merchants(id),
  name text not null,
  location text,
  status text not null default 'active' check (status in ('active','disabled','maintenance')),
  status_reason text,
  price_minor integer not null check (price_minor > 0),
  unlock_seconds integer not null check (unlock_seconds between 5 and 60),
  price_min_minor integer,
  price_max_minor integer,
  unlock_min_s integer,
  unlock_max_s integer,
  opening_hours jsonb,
  started_at timestamptz,
  created_at timestamptz not null default now()
);
create index pool_tables_merchant on pool_tables(merchant_id);

create table devices (
  id text primary key,
  table_id text unique references pool_tables(id),
  status text not null default 'unprovisioned' check (status in ('unprovisioned','provisioned','revoked','retired')),
  credential_hash text,
  hmac_secret_enc text,
  credential_version integer not null default 0,
  virtual boolean not null default false,
  -- Only for virtual (simulated) devices, which the server itself must sign in as.
  virtual_password_enc text,
  firmware_version text,
  last_seen_at timestamptz,
  rssi integer,
  relay_state text,
  uptime_s bigint,
  ip text,
  online boolean not null default false,
  online_changed_at timestamptz,
  provisioned_at timestamptz,
  created_at timestamptz not null default now()
);

create table device_events (
  id bigserial primary key,
  device_id text,
  table_id text,
  type text not null,
  payload jsonb not null default '{}'::jsonb,
  device_ts timestamptz,
  at timestamptz not null default now()
);
create index device_events_table on device_events(table_id, at desc);

-- ---------------------------------------------------------------- payments
create table payments (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_txn_id text not null,
  channel text not null check (channel in ('c2b','stk')),
  shortcode text,
  account_ref text,
  account_ref_normalised text,
  amount_minor bigint not null check (amount_minor > 0),
  payer_msisdn_hash text,
  payer_msisdn_masked text,
  payer_name_masked text,
  trans_time timestamptz,
  org_balance_minor bigint,
  raw_payload jsonb not null,
  status text not null default 'received' check (status in ('received','verifying','matched','unmatched','underpaid','credited','refund_pending','refunded','rejected')),
  problem text,
  table_id text references pool_tables(id),
  merchant_id uuid references merchants(id),
  price_minor integer,
  games_credited integer not null default 0,
  partial_applied_minor bigint not null default 0,
  remainder_minor bigint not null default 0,
  commission_minor bigint not null default 0,
  merchant_share_minor bigint not null default 0,
  verification_status text not null default 'pending' check (verification_status in ('pending','verified','mismatch','unavailable','skipped')),
  verification_detail jsonb,
  verified_at timestamptz,
  matched_at timestamptz,
  credited_at timestamptz,
  stk_request_id uuid,
  refund_minor bigint not null default 0,
  resolution jsonb,
  resolved_by uuid,
  resolved_at timestamptz,
  received_at timestamptz not null default now(),
  unique (provider, provider_txn_id)
);
create index payments_merchant on payments(merchant_id, received_at desc);
create index payments_table on payments(table_id, received_at desc);
create index payments_status on payments(status, received_at desc);
create index payments_received on payments(received_at desc);

-- Money that did not make a whole game (underpaid) or was left over (remainder), held for
-- the partial-credit window, then sent to admin review.
create table partial_credits (
  id uuid primary key default gen_random_uuid(),
  table_id text references pool_tables(id),
  merchant_id uuid references merchants(id),
  payer_msisdn_hash text,
  amount_minor bigint not null check (amount_minor > 0),
  kind text not null check (kind in ('underpaid','remainder')),
  payment_ids uuid[] not null,
  status text not null default 'open' check (status in ('open','consumed','review','refund_pending','refunded','credited','granted')),
  expires_at timestamptz not null,
  resolution jsonb,
  resolved_by uuid,
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);
create index partial_credits_open on partial_credits(table_id, payer_msisdn_hash) where status = 'open';

-- Money owed back to a customer. Refunds are made by hand in the M-Pesa portal for now and
-- recorded here with the M-Pesa reference.
create table refunds (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  source_type text not null check (source_type in ('payment','partial')),
  source_id uuid not null,
  payment_id uuid references payments(id),
  merchant_id uuid references merchants(id),
  amount_minor bigint not null check (amount_minor > 0),
  msisdn_masked text,
  status text not null default 'pending' check (status in ('pending','paid')),
  reason text not null,
  requested_by uuid,
  mpesa_ref text,
  paid_from text check (paid_from in ('utility','working')),
  paid_by uuid,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);
create index refunds_status on refunds(status, created_at desc);

create table stk_requests (
  id uuid primary key default gen_random_uuid(),
  table_id text not null references pool_tables(id),
  phone_hash text not null,
  phone_masked text not null,
  games integer not null,
  amount_minor bigint not null,
  merchant_request_id text,
  checkout_request_id text unique,
  status text not null default 'pending' check (status in ('pending','paid','failed','cancelled','expired')),
  result_code text,
  result_desc text,
  payment_id uuid,
  ip text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index stk_requests_phone on stk_requests(phone_hash, created_at desc);

create table game_credits (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references payments(id),
  table_id text not null references pool_tables(id),
  merchant_id uuid not null references merchants(id),
  status text not null default 'pending' check (status in ('pending','dispatched','acked','expired','failed','manual','refunded')),
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  acked_at timestamptz,
  expires_at timestamptz not null,
  resolution text
);
create index game_credits_queue on game_credits(table_id, created_at) where status in ('pending','dispatched');
create index game_credits_payment on game_credits(payment_id);
create index game_credits_acked on game_credits(merchant_id, acked_at) where status = 'acked';

create table unlock_commands (
  cmd_id uuid primary key,
  table_id text not null references pool_tables(id),
  device_id text,
  game_credit_id uuid references game_credits(id),
  source text not null check (source in ('payment','manual_owner','manual_staff','manual_admin','test')),
  reason text,
  issued_by text,
  issued_by_label text,
  duration_s integer not null,
  nonce text not null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'queued' check (status in ('queued','sent','acked','rejected','busy','timeout','failed')),
  attempts integer not null default 0,
  sent_at timestamptz,
  ack_at timestamptz,
  ack_result text,
  ack_reason text,
  finishes_at timestamptz
);
create index unlock_commands_table on unlock_commands(table_id, issued_at desc);
create index unlock_commands_inflight on unlock_commands(table_id) where status in ('queued','sent','busy');

-- ---------------------------------------------------------------- ledger
-- Double entry. A debit is a positive amount, a credit negative; every transaction sums
-- to zero (checked at commit) and nothing is ever updated or deleted.
create table ledger_accounts (
  id serial primary key,
  code text not null unique,
  type text not null check (type in ('asset','liability','revenue','expense','equity')),
  merchant_id uuid references merchants(id),
  name text not null,
  balance_minor bigint not null default 0,
  created_at timestamptz not null default now()
);

create table ledger_transactions (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  ref_type text,
  ref_id text,
  idempotency_key text unique,
  memo text,
  reverses uuid references ledger_transactions(id),
  created_by text,
  created_at timestamptz not null default now()
);
create index ledger_transactions_ref on ledger_transactions(ref_type, ref_id);

create table ledger_entries (
  id bigserial primary key,
  transaction_id uuid not null references ledger_transactions(id),
  account_id integer not null references ledger_accounts(id),
  amount_minor bigint not null check (amount_minor <> 0),
  created_at timestamptz not null default now()
);
create index ledger_entries_account on ledger_entries(account_id, id);
create index ledger_entries_tx on ledger_entries(transaction_id);

create function ledger_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'the ledger is append-only (% on %)', tg_op, tg_table_name;
end $$;
create trigger ledger_entries_append_only before update or delete on ledger_entries
  for each row execute function ledger_append_only();
create trigger ledger_transactions_append_only before update or delete on ledger_transactions
  for each row execute function ledger_append_only();

create function ledger_apply_balance() returns trigger language plpgsql as $$
begin
  update ledger_accounts set balance_minor = balance_minor + new.amount_minor where id = new.account_id;
  return null;
end $$;
create trigger ledger_entries_balance after insert on ledger_entries
  for each row execute function ledger_apply_balance();

create function ledger_check_balanced() returns trigger language plpgsql as $$
declare s bigint;
begin
  select coalesce(sum(amount_minor), 0) into s from ledger_entries where transaction_id = new.transaction_id;
  if s <> 0 then
    raise exception 'ledger transaction % does not balance (off by %)', new.transaction_id, s;
  end if;
  return null;
end $$;
create constraint trigger ledger_entries_balanced after insert on ledger_entries
  deferrable initially deferred for each row execute function ledger_check_balanced();

-- ---------------------------------------------------------------- payouts and float
create table payouts (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  kind text not null check (kind in ('merchant','platform')),
  merchant_id uuid references merchants(id),
  gross_minor bigint not null check (gross_minor > 0),
  fee_minor bigint not null default 0,
  net_minor bigint not null check (net_minor > 0),
  tariff_minor bigint not null default 0,
  fee_borne_by text not null check (fee_borne_by in ('merchant','platform')),
  msisdn text not null,
  status text not null check (status in ('requested','pending_approval','held','queued','submitted','succeeded','failed','timed_out','rejected','cancelled')),
  status_reason text,
  trigger text not null check (trigger in ('manual','scheduled','admin')),
  requested_by text not null,
  requested_by_label text,
  approval_required_reason text,
  approved_by uuid,
  approved_at timestamptz,
  decided_by uuid,
  idempotency_key text not null,
  hold_until timestamptz,
  originator_conversation_id text unique,
  conversation_id text,
  mpesa_receipt text,
  failure_reason text,
  provider_result jsonb,
  retry_of uuid references payouts(id),
  attempt integer not null default 1,
  reconciled_at timestamptz,
  requested_at timestamptz not null default now(),
  submitted_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index payouts_idempotency on payouts(coalesce(merchant_id::text, 'platform'), idempotency_key);
create index payouts_merchant on payouts(merchant_id, requested_at desc);
create index payouts_status on payouts(status, requested_at);

create table payout_number_changes (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  old_msisdn text,
  new_msisdn text not null,
  kind text not null check (kind in ('first','change')),
  status text not null check (status in ('otp_pending','cooling','active','cancelled','expired')),
  needs_old_otp boolean not null default false,
  hold_until timestamptz,
  requested_by uuid,
  fast_tracked_by uuid,
  fast_tracked_at timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index payout_number_changes_merchant on payout_number_changes(merchant_id, created_at desc);

create table provider_transfers (
  id uuid primary key default gen_random_uuid(),
  from_account text not null check (from_account in ('utility','working')),
  to_account text not null check (to_account in ('utility','working')),
  amount_minor bigint not null check (amount_minor > 0),
  reference text not null,
  transferred_at timestamptz not null,
  note text,
  recorded_by uuid not null,
  approved_by uuid,
  status text not null check (status in ('pending_approval','recorded','rejected')),
  approval_id uuid,
  ledger_transaction_id uuid,
  created_at timestamptz not null default now(),
  check (from_account <> to_account)
);

create table provider_balance_snapshots (
  id bigserial primary key,
  provider text not null,
  utility_minor bigint,
  working_minor bigint,
  accounts jsonb not null default '{}'::jsonb,
  source text not null,
  taken_at timestamptz not null default now()
);
create index provider_balance_snapshots_at on provider_balance_snapshots(taken_at desc);

-- Requests whose answer arrives later on a result URL (status, balance, B2C).
create table provider_requests (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  originator_conversation_id text unique,
  conversation_id text,
  ref_type text,
  ref_id text,
  status text not null default 'pending' check (status in ('pending','completed','timeout','error')),
  request jsonb,
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index provider_requests_conv on provider_requests(conversation_id);

create table provider_health (
  api text primary key,
  last_ok_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  ok_count bigint not null default 0,
  error_count bigint not null default 0,
  last_ms integer
);

create table callback_log (
  id bigserial primary key,
  kind text not null,
  received_at timestamptz not null default now(),
  processing_ms integer,
  ok boolean not null default true,
  error text,
  source_ip text,
  payload jsonb,
  replay_of bigint
);
create index callback_log_at on callback_log(received_at desc);

-- ---------------------------------------------------------------- controls
create table pricing_rules (
  id uuid primary key default gen_random_uuid(),
  scope text not null check (scope in ('default','merchant','table')),
  scope_id text,
  commission_minor integer not null check (commission_minor >= 0),
  commission_pct numeric(6,3) not null default 0 check (commission_pct >= 0 and commission_pct < 100),
  effective_from timestamptz not null,
  created_by text,
  approval_id uuid,
  created_at timestamptz not null default now()
);
create index pricing_rules_scope on pricing_rules(scope, scope_id, effective_from desc);

-- Four-eyes requests. Executed by the server once approved (and, in single-operator mode,
-- not before executable_after).
create table approvals (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  payload jsonb not null,
  summary text not null,
  entity_type text,
  entity_id text,
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','executed','failed','cancelled')),
  executable_after timestamptz,
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  executed_at timestamptz,
  result jsonb
);
create index approvals_status on approvals(status, requested_at desc);

create table alerts (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  severity text not null check (severity in ('info','warning','critical')),
  dedupe_key text,
  title text not null,
  detail text,
  entity_type text,
  entity_id text,
  data jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','acknowledged','resolved')),
  owner_id uuid,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  occurrences integer not null default 1,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  resolved_by uuid,
  resolved_at timestamptz,
  auto_resolved boolean not null default false
);
create unique index alerts_one_open on alerts(dedupe_key) where status <> 'resolved' and dedupe_key is not null;
create index alerts_status on alerts(status, severity, created_at desc);

create table alert_events (
  id bigserial primary key,
  alert_id uuid not null references alerts(id),
  kind text not null,
  actor text,
  note text,
  at timestamptz not null default now()
);

create table audit_log (
  id bigserial primary key,
  actor_type text not null,
  actor_id text,
  actor_label text,
  action text not null,
  entity_type text,
  entity_id text,
  before jsonb,
  after jsonb,
  ip text,
  user_agent text,
  at timestamptz not null default now()
);
create index audit_log_at on audit_log(at desc);
create index audit_log_entity on audit_log(entity_type, entity_id, at desc);
create index audit_log_actor on audit_log(actor_id, at desc);
create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function ledger_append_only();

create table activity (
  id bigserial primary key,
  type text not null,
  title text not null,
  entity_type text,
  entity_id text,
  data jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index activity_at on activity(at desc);

create table reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  trigger text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running','match','mismatch','error')),
  lines jsonb not null default '[]'::jsonb,
  error text,
  acknowledged_by uuid,
  acknowledged_at timestamptz,
  ack_note text
);

create table daily_reports (
  report_date date primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  emailed_at timestamptz
);

-- ---------------------------------------------------------------- merchant-facing
create table notifications (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  user_id uuid not null references merchant_users(id),
  type text not null,
  title text not null,
  body text not null,
  critical boolean not null default false,
  data jsonb not null default '{}'::jsonb,
  channels text[] not null default '{in_app}',
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user on notifications(user_id, created_at desc);

create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  merchant_user_id uuid not null references merchant_users(id),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  failures integer not null default 0,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);

create table disputes (
  id uuid primary key default gen_random_uuid(),
  ref text not null unique,
  merchant_id uuid not null references merchants(id),
  payment_id uuid references payments(id),
  table_id text references pool_tables(id),
  kind text not null check (kind in ('payment','table','other')),
  subject text not null,
  status text not null default 'open' check (status in ('open','in_progress','waiting_merchant','resolved','closed')),
  assignee_id uuid,
  opened_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index disputes_status on disputes(status, updated_at desc);

create table dispute_messages (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references disputes(id),
  author_type text not null check (author_type in ('merchant','admin')),
  author_id uuid not null,
  author_label text,
  body text not null,
  internal boolean not null default false,
  created_at timestamptz not null default now()
);

create table merchant_notes (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  author_id uuid not null,
  author_label text,
  body text not null,
  created_at timestamptz not null default now()
);

create table merchant_documents (
  id uuid primary key default gen_random_uuid(),
  merchant_id uuid not null references merchants(id),
  kind text not null check (kind in ('id','agreement','other')),
  filename text not null,
  mime text not null,
  bytes bytea not null,
  size integer not null,
  uploaded_by uuid not null,
  created_at timestamptz not null default now()
);

create table announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  audience text not null check (audience in ('all','selected')),
  merchant_ids uuid[] not null default '{}',
  channels text[] not null,
  recipients integer not null default 0,
  sent_by uuid not null,
  created_at timestamptz not null default now()
);

create table impersonations (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid not null references admin_users(id),
  merchant_id uuid not null references merchants(id),
  reason text not null,
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz
);

-- ---------------------------------------------------------------- plumbing
create table jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text,
  status text not null default 'queued' check (status in ('queued','running','done','failed')),
  run_at timestamptz not null default now(),
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index jobs_due on jobs(run_at) where status = 'queued';
create unique index jobs_dedupe on jobs(dedupe_key) where dedupe_key is not null and status in ('queued','running');

-- Periodic tasks take a lease so two instances never run the same sweep at once.
create table leases (
  name text primary key,
  holder text not null,
  held_until timestamptz not null
);

create table idempotency_keys (
  scope text not null,
  key text not null,
  request_hash text not null,
  status_code integer,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (scope, key)
);

-- The simulated provider's own books: what a real M-Pesa would hold, so reconciliation
-- has something independent to compare against in sandbox.
create table sim_accounts (
  account text primary key check (account in ('utility','working')),
  balance_minor bigint not null default 0
);
create table sim_transactions (
  txn_id text primary key,
  kind text not null,
  amount_minor bigint not null,
  shortcode text,
  account_ref text,
  msisdn text,
  created_at timestamptz not null default now()
);
`,
  },
];
