-- Persist point-in-time ERC20 compatibility evidence and reject deterministically
-- unsafe token references for new bounty listings. Exact transfer accounting is
-- still enforced by the escrow contract and by the wallet preflight simulation.

alter table public.tokens
  add column compatibility_status text not null default 'inconclusive'
    check (compatibility_status in ('compatible', 'incompatible', 'inconclusive', 'implementation_changed')),
  add column compatibility_reason_codes jsonb not null default '[]'::jsonb
    check (jsonb_typeof(compatibility_reason_codes) = 'array'),
  add column compatibility_checked_at timestamptz,
  add column compatibility_checked_block numeric(78,0),
  add column compatibility_checked_block_hash text
    check (compatibility_checked_block_hash is null or compatibility_checked_block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  add column compatibility_fingerprint text
    check (compatibility_fingerprint is null or compatibility_fingerprint ~ '^0x[0-9a-fA-F]{64}$'),
  add column inspection_version text not null default 'erc20-compatibility.v1',
  add column proxy_kind text not null default 'unknown'
    check (proxy_kind in ('none', 'eip1967', 'eip1167', 'beacon', 'unknown')),
  add column implementation_address text
    check (implementation_address is null or implementation_address = public.app_normalize_wallet(implementation_address)),
  add column implementation_bytecode_hash text
    check (implementation_bytecode_hash is null or implementation_bytecode_hash ~ '^0x[0-9a-fA-F]{64}$'),
  add column transfer_validation_status text not null default 'not_run'
    check (transfer_validation_status in ('not_run', 'preflight_passed', 'funding_verified'));

create table public.token_compatibility_checks (
  id uuid primary key default gen_random_uuid(),
  token_id uuid not null references public.tokens(id) on delete restrict,
  actor_id uuid references public.wallet_accounts(id) on delete restrict,
  status text not null check (status in ('compatible', 'incompatible', 'inconclusive', 'implementation_changed')),
  reason_codes jsonb not null default '[]'::jsonb check (jsonb_typeof(reason_codes) = 'array'),
  checked_block numeric(78,0),
  checked_block_hash text check (checked_block_hash is null or checked_block_hash ~ '^0x[0-9a-fA-F]{64}$'),
  fingerprint text not null check (fingerprint ~ '^0x[0-9a-fA-F]{64}$'),
  inspection_version text not null,
  snapshot jsonb not null default '{}'::jsonb check (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz not null default now()
);
create index token_compatibility_checks_token_created_idx
  on public.token_compatibility_checks (token_id, created_at desc);

alter table public.token_compatibility_checks enable row level security;
revoke all on public.token_compatibility_checks from anon, authenticated;

create function public.app_reject_token_compatibility_check_mutation()
returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'TOKEN_COMPATIBILITY_HISTORY_IMMUTABLE' using errcode = '55000';
end $$;

create trigger token_compatibility_checks_immutable
before update or delete on public.token_compatibility_checks
for each row execute function public.app_reject_token_compatibility_check_mutation();
revoke all on function public.app_reject_token_compatibility_check_mutation() from public, anon, authenticated;

-- Retire the legacy writer so every future inspection must persist a
-- compatibility snapshot and append its audit record through v2.
revoke execute on function public.app_upsert_inspected_token(
  uuid,bigint,text,text,text,text,integer,text,boolean,text,text,text,text,jsonb
) from service_role;

create function public.app_upsert_inspected_token_v2(
  p_actor_id uuid,
  p_chain_id bigint,
  p_contract_address text,
  p_checksum_address text,
  p_name text,
  p_symbol text,
  p_decimals integer,
  p_total_supply text,
  p_bytecode_present boolean,
  p_bytecode_hash text,
  p_proxy_status text,
  p_proxy_kind text,
  p_implementation_address text,
  p_implementation_bytecode_hash text,
  p_source_verification_status text,
  p_explorer_url text,
  p_risk_flags jsonb,
  p_compatibility_status text,
  p_compatibility_reason_codes jsonb,
  p_compatibility_checked_block text,
  p_compatibility_checked_block_hash text,
  p_compatibility_fingerprint text,
  p_inspection_version text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  token_row public.tokens;
  normalized text := public.app_normalize_wallet(p_contract_address);
  implementation_normalized text := public.app_normalize_wallet(p_implementation_address);
  supply numeric(78,0);
  checked_block numeric(78,0);
begin
  if p_actor_id is null or not exists (select 1 from public.wallet_accounts where id = p_actor_id) then
    raise exception 'ACCOUNT_REQUIRED' using errcode = '42501';
  end if;
  if normalized is null or public.app_normalize_wallet(p_checksum_address) is distinct from normalized then
    raise exception 'INVALID_TOKEN_ADDRESS' using errcode = '22023';
  end if;
  if p_chain_id < 1 or p_explorer_url !~ '^https://' then
    raise exception 'INVALID_TOKEN_IDENTITY' using errcode = '22023';
  end if;
  if p_decimals is null or p_decimals < 0 or p_decimals > 255 then
    raise exception 'INVALID_TOKEN_DECIMALS' using errcode = '22023';
  end if;
  if p_total_supply is not null then supply := p_total_supply::numeric(78,0); end if;
  if p_compatibility_checked_block is not null then checked_block := p_compatibility_checked_block::numeric(78,0); end if;
  if p_compatibility_status not in ('compatible', 'incompatible', 'inconclusive', 'implementation_changed')
    or p_proxy_status not in ('unknown', 'not_proxy', 'proxy_detected', 'inspection_failed')
    or p_proxy_kind not in ('none', 'eip1967', 'eip1167', 'beacon', 'unknown')
    or p_source_verification_status not in ('unknown', 'verified', 'unverified', 'unavailable')
    or coalesce(p_compatibility_fingerprint, '') !~ '^0x[0-9a-fA-F]{64}$'
    or jsonb_typeof(coalesce(p_compatibility_reason_codes, 'null'::jsonb)) <> 'array' then
    raise exception 'INVALID_TOKEN_COMPATIBILITY_RESULT' using errcode = '22023';
  end if;

  insert into public.tokens (
    chain_id, contract_address, checksum_address, name, symbol, decimals, total_supply,
    bytecode_present, bytecode_hash, proxy_status, proxy_kind, implementation_address,
    implementation_bytecode_hash, source_verification_status, explorer_url, risk_flags,
    inspected_at, created_by, compatibility_status, compatibility_reason_codes,
    compatibility_checked_at, compatibility_checked_block, compatibility_checked_block_hash,
    compatibility_fingerprint, inspection_version
  ) values (
    p_chain_id, normalized, p_checksum_address, nullif(p_name, ''), nullif(p_symbol, ''), p_decimals, supply,
    p_bytecode_present, p_bytecode_hash, p_proxy_status, p_proxy_kind, implementation_normalized,
    p_implementation_bytecode_hash, p_source_verification_status, p_explorer_url, coalesce(p_risk_flags, '[]'::jsonb),
    now(), p_actor_id, p_compatibility_status, coalesce(p_compatibility_reason_codes, '[]'::jsonb),
    now(), checked_block, p_compatibility_checked_block_hash, p_compatibility_fingerprint,
    coalesce(nullif(p_inspection_version, ''), 'erc20-compatibility.v1')
  )
  on conflict (chain_id, contract_address) do update set
    checksum_address = excluded.checksum_address,
    name = excluded.name,
    symbol = excluded.symbol,
    decimals = excluded.decimals,
    total_supply = excluded.total_supply,
    bytecode_present = excluded.bytecode_present,
    bytecode_hash = excluded.bytecode_hash,
    proxy_status = excluded.proxy_status,
    proxy_kind = excluded.proxy_kind,
    implementation_address = excluded.implementation_address,
    implementation_bytecode_hash = excluded.implementation_bytecode_hash,
    source_verification_status = excluded.source_verification_status,
    explorer_url = excluded.explorer_url,
    risk_flags = excluded.risk_flags,
    inspected_at = now(),
    compatibility_status = excluded.compatibility_status,
    compatibility_reason_codes = excluded.compatibility_reason_codes,
    compatibility_checked_at = now(),
    compatibility_checked_block = excluded.compatibility_checked_block,
    compatibility_checked_block_hash = excluded.compatibility_checked_block_hash,
    compatibility_fingerprint = excluded.compatibility_fingerprint,
    inspection_version = excluded.inspection_version
  returning * into token_row;

  insert into public.token_compatibility_checks (
    token_id, actor_id, status, reason_codes, checked_block, checked_block_hash,
    fingerprint, inspection_version, snapshot
  ) values (
    token_row.id, p_actor_id, token_row.compatibility_status, token_row.compatibility_reason_codes,
    token_row.compatibility_checked_block, token_row.compatibility_checked_block_hash,
    token_row.compatibility_fingerprint, token_row.inspection_version,
    jsonb_build_object(
      'bytecode_hash', token_row.bytecode_hash,
      'proxy_status', token_row.proxy_status,
      'proxy_kind', token_row.proxy_kind,
      'implementation_address', token_row.implementation_address,
      'implementation_bytecode_hash', token_row.implementation_bytecode_hash,
      'source_verification_status', token_row.source_verification_status,
      'risk_flags', token_row.risk_flags
    )
  );

  return to_jsonb(token_row) || jsonb_build_object(
    'total_supply', case when token_row.total_supply is null then null else token_row.total_supply::text end,
    'compatibility_checked_block', case when token_row.compatibility_checked_block is null then null else token_row.compatibility_checked_block::text end
  );
end $$;

revoke all on function public.app_upsert_inspected_token_v2(
  uuid,bigint,text,text,text,text,integer,text,boolean,text,text,text,text,text,text,text,jsonb,text,jsonb,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.app_upsert_inspected_token_v2(
  uuid,bigint,text,text,text,text,integer,text,boolean,text,text,text,text,text,text,text,jsonb,text,jsonb,text,text,text,text
) to service_role;

create function public.app_reject_incompatible_bounty_token()
returns trigger
language plpgsql set search_path = public as $$
declare token_status text;
begin
  select compatibility_status into token_status from public.tokens where id = new.token_id;
  if token_status in ('incompatible', 'implementation_changed') then
    raise exception 'TOKEN_COMPATIBILITY_BLOCKED' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger bounties_reject_incompatible_token
before insert or update of token_id, accepted_proposal_id on public.bounties
for each row execute function public.app_reject_incompatible_bounty_token();
