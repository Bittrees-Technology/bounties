-- Wallet-first persistence. Browser clients must never receive service-role credentials.
-- The application API sets app.wallet_address and app.session_id with SET LOCAL after
-- resolving an opaque, signed-wallet session. Policies deliberately fail closed without it.

create extension if not exists pgcrypto;

create type public.bounty_status as enum ('draft', 'open', 'accepted', 'funding_pending', 'funded', 'completed', 'cancelled', 'archived');
create type public.proposal_status as enum ('active', 'withdrawn', 'accepted', 'rejected');
create type public.milestone_status as enum ('pending', 'assigned', 'funded', 'delivered', 'accepted', 'released', 'cancelled');
create type public.escrow_status as enum ('pending', 'submitted', 'confirmed', 'finalized', 'reorged', 'failed');

create function public.app_normalize_wallet(value text) returns text
language sql immutable strict parallel safe as $$
  select case when value ~ '^0x[0-9a-fA-F]{40}$' then lower(value) else null end
$$;

create function public.app_current_wallet() returns text
language sql stable parallel safe as $$
  select public.app_normalize_wallet(current_setting('app.wallet_address', true))
$$;

create table public.wallet_accounts (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null unique check (wallet_address = public.app_normalize_wallet(wallet_address)),
  display_name text check (char_length(display_name) between 1 and 80),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create function public.app_current_account_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.wallet_accounts where wallet_address = public.app_current_wallet()
$$;

create table public.account_roles (
  account_id uuid not null references public.wallet_accounts(id) on delete restrict,
  role text not null check (role in ('buyer', 'provider')),
  created_at timestamptz not null default now(),
  primary key (account_id, role)
);

create table public.auth_nonces (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null check (wallet_address = public.app_normalize_wallet(wallet_address)),
  chain_id bigint not null check (chain_id > 0),
  domain text not null check (char_length(domain) between 1 and 255),
  uri text not null check (uri ~ '^https?://'),
  purpose text not null default 'sign-in' check (purpose = 'sign-in'),
  nonce_digest text not null unique check (nonce_digest ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null check (expires_at > issued_at and expires_at <= issued_at + interval '5 minutes'),
  consumed_at timestamptz
);
create index auth_nonces_lookup_idx on public.auth_nonces (wallet_address, nonce_digest, expires_at) where consumed_at is null;

create table public.wallet_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.wallet_accounts(id) on delete restrict,
  token_digest text not null unique check (token_digest ~ '^[0-9a-f]{64}$'),
  csrf_digest text not null check (csrf_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  check (idle_expires_at <= absolute_expires_at),
  check (absolute_expires_at <= created_at + interval '24 hours')
);
create index wallet_sessions_valid_idx on public.wallet_sessions (token_digest, idle_expires_at) where revoked_at is null;

create table public.tokens (
  id uuid primary key default gen_random_uuid(),
  chain_id bigint not null check (chain_id > 0),
  contract_address text not null check (contract_address = public.app_normalize_wallet(contract_address)),
  checksum_address text not null check (checksum_address ~ '^0x[0-9a-fA-F]{40}$'),
  name text, symbol text, decimals integer check (decimals between 0 and 255),
  total_supply numeric(78,0) check (total_supply >= 0),
  bytecode_present boolean not null default false,
  bytecode_hash text check (bytecode_hash is null or bytecode_hash ~ '^0x[0-9a-fA-F]{64}$'),
  proxy_status text not null default 'unknown' check (proxy_status in ('unknown', 'not_proxy', 'proxy_detected', 'inspection_failed')),
  source_verification_status text not null default 'unknown' check (source_verification_status in ('unknown', 'verified', 'unverified', 'unavailable')),
  explorer_url text not null check (explorer_url ~ '^https://'),
  risk_flags jsonb not null default '[]'::jsonb check (jsonb_typeof(risk_flags) = 'array'),
  inspected_at timestamptz,
  created_by uuid references public.wallet_accounts(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (chain_id, contract_address)
);

create table public.bounties (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.wallet_accounts(id) on delete restrict,
  title text not null check (char_length(title) between 3 and 160),
  description text not null check (char_length(description) between 1 and 20000),
  scope_source jsonb not null default '{}'::jsonb,
  scope_hash text not null check (scope_hash ~ '^0x[0-9a-fA-F]{64}$'),
  hash_version text not null default 'pending-contract-v1',
  chain_id bigint not null check (chain_id > 0),
  token_id uuid not null references public.tokens(id) on delete restrict,
  token_decimals integer not null check (token_decimals between 0 and 255),
  budget_base_units numeric(78,0) not null check (budget_base_units > 0 and trunc(budget_base_units) = budget_base_units),
  status public.bounty_status not null default 'draft',
  accepted_proposal_id uuid unique,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check (jsonb_typeof(scope_source) = 'object')
);

create table public.proposals (
  id uuid primary key default gen_random_uuid(),
  bounty_id uuid not null references public.bounties(id) on delete restrict,
  provider_id uuid not null references public.wallet_accounts(id) on delete restrict,
  note text not null check (char_length(note) between 1 and 10000),
  proposed_total_base_units numeric(78,0) not null check (proposed_total_base_units > 0 and trunc(proposed_total_base_units) = proposed_total_base_units),
  proposed_milestones jsonb not null check (jsonb_typeof(proposed_milestones) = 'array'),
  status public.proposal_status not null default 'active',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create unique index active_provider_proposal_idx on public.proposals (bounty_id, provider_id) where status = 'active';
alter table public.bounties add constraint bounties_accepted_proposal_fk foreign key (accepted_proposal_id) references public.proposals(id) on delete restrict;

create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  bounty_id uuid not null references public.bounties(id) on delete restrict,
  ordinal integer not null check (ordinal >= 0),
  title text not null check (char_length(title) between 1 and 160),
  amount_base_units numeric(78,0) not null check (amount_base_units > 0 and trunc(amount_base_units) = amount_base_units),
  scope_source jsonb not null default '{}'::jsonb,
  evidence_requirements jsonb not null default '{}'::jsonb,
  status public.milestone_status not null default 'pending',
  assigned_provider_id uuid references public.wallet_accounts(id) on delete restrict,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (bounty_id, ordinal)
);

create table public.delivery_evidence (
  id uuid primary key default gen_random_uuid(),
  milestone_id uuid not null references public.milestones(id) on delete restrict,
  provider_id uuid not null references public.wallet_accounts(id) on delete restrict,
  uri text not null check (uri ~ '^https://'),
  content_hash text not null check (content_hash ~ '^0x[0-9a-fA-F]{64}$'),
  evidence_hash text not null check (evidence_hash ~ '^0x[0-9a-fA-F]{64}$'),
  hash_version text not null default 'pending-contract-v1',
  revision integer not null default 1 check (revision > 0),
  submitted_at timestamptz not null default now(),
  unique (milestone_id, revision)
);

create table public.escrow_records (
  id uuid primary key default gen_random_uuid(),
  bounty_id uuid not null unique references public.bounties(id) on delete restrict,
  chain_id bigint not null check (chain_id > 0),
  token_id uuid not null references public.tokens(id) on delete restrict,
  contract_address text check (contract_address is null or contract_address = public.app_normalize_wallet(contract_address)),
  interface_version text not null default 'pending-contract-v1',
  onchain_bounty_id text,
  requested_base_units numeric(78,0) not null check (requested_base_units > 0 and trunc(requested_base_units) = requested_base_units),
  received_base_units numeric(78,0) not null default 0 check (received_base_units >= 0 and trunc(received_base_units) = received_base_units),
  released_base_units numeric(78,0) not null default 0 check (released_base_units >= 0 and trunc(released_base_units) = released_base_units),
  status public.escrow_status not null default 'pending',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.wallet_accounts(id) on delete restrict,
  type text not null check (char_length(type) between 1 and 80),
  entity_type text not null check (char_length(entity_type) between 1 and 80),
  entity_id uuid not null,
  body text not null check (char_length(body) between 1 and 500),
  dedupe_key text not null unique,
  read_at timestamptz, created_at timestamptz not null default now()
);

create function public.app_touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create trigger bounties_touch before update on public.bounties for each row execute function public.app_touch_updated_at();
create trigger proposals_touch before update on public.proposals for each row execute function public.app_touch_updated_at();
create trigger milestones_touch before update on public.milestones for each row execute function public.app_touch_updated_at();
create trigger escrow_records_touch before update on public.escrow_records for each row execute function public.app_touch_updated_at();

-- A custom milestone set and any accepted proposal are reconciled in the database,
-- not in JavaScript. The deferred check supports inserting a bounty and its rows together.
create function public.app_validate_bounty_amounts() returns trigger language plpgsql as $$
declare b public.bounties; milestone_total numeric(78,0); proposal_total numeric(78,0); proposal_bounty uuid;
begin
  if TG_TABLE_NAME = 'bounties' then
    select * into b from public.bounties where id = coalesce(new.id, old.id);
  else
    select * into b from public.bounties where id = coalesce(new.bounty_id, old.bounty_id);
  end if;
  if not found then return null; end if;
  select coalesce(sum(amount_base_units), 0) into milestone_total from public.milestones where bounty_id = b.id;
  if milestone_total <> 0 and milestone_total <> b.budget_base_units then
    raise exception 'MILESTONE_TOTAL_MISMATCH: expected %, got %', b.budget_base_units, milestone_total using errcode = '23514';
  end if;
  if b.accepted_proposal_id is not null then
    select bounty_id, proposed_total_base_units into proposal_bounty, proposal_total from public.proposals where id = b.accepted_proposal_id;
    if proposal_bounty is distinct from b.id or proposal_total <> b.budget_base_units then
      raise exception 'PROPOSAL_BUDGET_MISMATCH' using errcode = '23514';
    end if;
  end if;
  return null;
end $$;
create constraint trigger bounties_validate_amounts after insert or update of budget_base_units, accepted_proposal_id on public.bounties deferrable initially deferred for each row execute function public.app_validate_bounty_amounts();
create constraint trigger milestones_validate_amounts after insert or update or delete on public.milestones deferrable initially deferred for each row execute function public.app_validate_bounty_amounts();
create constraint trigger proposals_validate_amounts after insert or update of proposed_total_base_units, bounty_id or delete on public.proposals deferrable initially deferred for each row execute function public.app_validate_bounty_amounts();

alter table public.wallet_accounts enable row level security; alter table public.wallet_accounts force row level security;
alter table public.account_roles enable row level security; alter table public.account_roles force row level security;
alter table public.auth_nonces enable row level security; alter table public.auth_nonces force row level security;
alter table public.wallet_sessions enable row level security; alter table public.wallet_sessions force row level security;
alter table public.tokens enable row level security; alter table public.tokens force row level security;
alter table public.bounties enable row level security; alter table public.bounties force row level security;
alter table public.proposals enable row level security; alter table public.proposals force row level security;
alter table public.milestones enable row level security; alter table public.milestones force row level security;
alter table public.delivery_evidence enable row level security; alter table public.delivery_evidence force row level security;
alter table public.escrow_records enable row level security; alter table public.escrow_records force row level security;
alter table public.notifications enable row level security; alter table public.notifications force row level security;

create policy wallet_accounts_self on public.wallet_accounts for select using (id = public.app_current_account_id());
create policy account_roles_self on public.account_roles for select using (account_id = public.app_current_account_id());
create policy account_roles_self_insert on public.account_roles for insert with check (account_id = public.app_current_account_id());
create policy sessions_self on public.wallet_sessions for select using (account_id = public.app_current_account_id());
create policy tokens_read on public.tokens for select using (true);
create policy bounties_read on public.bounties for select using (status <> 'draft' or creator_id = public.app_current_account_id());
create policy bounties_create on public.bounties for insert with check (creator_id = public.app_current_account_id());
create policy bounties_owner_edit on public.bounties for update using (creator_id = public.app_current_account_id() and status in ('draft', 'open')) with check (creator_id = public.app_current_account_id());
create policy proposals_read on public.proposals for select using (true);
create policy proposals_create on public.proposals for insert with check (provider_id = public.app_current_account_id() and provider_id <> (select creator_id from public.bounties where id = bounty_id));
create policy proposals_provider_edit on public.proposals for update using (provider_id = public.app_current_account_id() and status = 'active') with check (provider_id = public.app_current_account_id());
create policy milestones_read on public.milestones for select using (true);
create policy milestone_owner_edit on public.milestones for all using ((select creator_id from public.bounties where id = bounty_id) = public.app_current_account_id()) with check ((select creator_id from public.bounties where id = bounty_id) = public.app_current_account_id());
create policy evidence_read on public.delivery_evidence for select using (true);
create policy evidence_provider_insert on public.delivery_evidence for insert with check (provider_id = public.app_current_account_id() and provider_id = (select assigned_provider_id from public.milestones where id = milestone_id));
create policy escrow_read on public.escrow_records for select using (true);
create policy notifications_self on public.notifications for select using (recipient_id = public.app_current_account_id());
create policy notifications_self_update on public.notifications for update using (recipient_id = public.app_current_account_id()) with check (recipient_id = public.app_current_account_id());

revoke all on public.auth_nonces, public.wallet_sessions from anon, authenticated;
revoke all on public.tokens from anon, authenticated;
-- Auth endpoint only: nonces and sessions enter as digests; raw credentials are never persisted.
create function public.app_issue_auth_nonce(p_wallet_address text, p_chain_id bigint, p_domain text, p_uri text, p_nonce_digest text, p_issued_at timestamptz, p_expires_at timestamptz)
returns uuid language plpgsql security definer set search_path = public as $$
declare nonce_id uuid;
begin
  if public.app_normalize_wallet(p_wallet_address) is null then raise exception 'invalid wallet'; end if;
  if p_issued_at < now() - interval '30 seconds' or p_issued_at > now() + interval '30 seconds' or p_expires_at <> p_issued_at + interval '5 minutes' then raise exception 'invalid nonce lifetime'; end if;
  insert into auth_nonces (wallet_address, chain_id, domain, uri, nonce_digest, issued_at, expires_at)
  values (public.app_normalize_wallet(p_wallet_address), p_chain_id, p_domain, p_uri, p_nonce_digest, p_issued_at, p_expires_at) returning id into nonce_id;
  return nonce_id;
end $$;
create function public.app_consume_auth_nonce(p_nonce_id uuid, p_nonce_digest text, p_wallet_address text, p_chain_id bigint, p_domain text, p_uri text, p_issued_at timestamptz, p_expires_at timestamptz)
returns uuid language plpgsql security definer set search_path = public as $$
declare account_id uuid;
begin
  update auth_nonces set consumed_at = now() where id = p_nonce_id and nonce_digest = p_nonce_digest and wallet_address = public.app_normalize_wallet(p_wallet_address) and chain_id = p_chain_id and domain = p_domain and uri = p_uri and issued_at = p_issued_at and expires_at = p_expires_at and consumed_at is null and expires_at > now();
  if not found then raise exception 'NONCE_INVALID_OR_EXPIRED' using errcode = '28000'; end if;
  insert into wallet_accounts (wallet_address) values (public.app_normalize_wallet(p_wallet_address)) on conflict (wallet_address) do update set last_seen_at = now() returning id into account_id;
  return account_id;
end $$;
create function public.app_create_wallet_session(p_account_id uuid, p_token_digest text, p_csrf_digest text)
returns uuid language sql security definer set search_path = public as $$
  insert into wallet_sessions (account_id, token_digest, csrf_digest, idle_expires_at, absolute_expires_at)
  values (p_account_id, p_token_digest, p_csrf_digest, now() + interval '30 minutes', now() + interval '24 hours') returning id
$$;
revoke all on function public.app_issue_auth_nonce(text,bigint,text,text,text,timestamptz,timestamptz), public.app_consume_auth_nonce(uuid,text,text,bigint,text,text,timestamptz,timestamptz), public.app_create_wallet_session(uuid,text,text) from public;
grant execute on function public.app_issue_auth_nonce(text,bigint,text,text,text,timestamptz,timestamptz), public.app_consume_auth_nonce(uuid,text,text,bigint,text,text,timestamptz,timestamptz), public.app_create_wallet_session(uuid,text,text) to service_role;
