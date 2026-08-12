-- Bind every offchain delivery record to the exact canonical escrow milestone
-- commitment. The service derives these values from reconciled database and
-- onchain state; this function locks and independently verifies the database
-- side of that preimage before persistence.

alter table public.delivery_evidence
  add column if not exists uri_hash text
    check (uri_hash is null or uri_hash ~ '^0x[0-9a-f]{64}$'),
  add column if not exists evidence_salt text
    check (evidence_salt is null or evidence_salt ~ '^0x[0-9a-f]{64}$'),
  add column if not exists approval_decision_hash text
    check (approval_decision_hash is null or approval_decision_hash ~ '^0x[0-9a-f]{64}$'),
  add column if not exists approval_salt text
    check (approval_salt is null or approval_salt ~ '^0x[0-9a-f]{64}$'),
  add column if not exists canonical_approval_hash text
    check (canonical_approval_hash is null or canonical_approval_hash ~ '^0x[0-9a-f]{64}$'),
  add column if not exists chain_id bigint
    check (chain_id is null or chain_id > 0),
  add column if not exists escrow_contract_address text
    check (escrow_contract_address is null or escrow_contract_address = public.app_normalize_wallet(escrow_contract_address)),
  add column if not exists onchain_bounty_id text
    check (onchain_bounty_id is null or onchain_bounty_id ~ '^[0-9]+$'),
  add column if not exists milestone_ordinal integer
    check (milestone_ordinal is null or milestone_ordinal >= 0),
  add column if not exists scope_hash text
    check (scope_hash is null or scope_hash ~ '^0x[0-9a-f]{64}$'),
  add column if not exists terms_hash text
    check (terms_hash is null or terms_hash ~ '^0x[0-9a-f]{64}$'),
  add column if not exists provider_wallet text
    check (provider_wallet is null or provider_wallet = public.app_normalize_wallet(provider_wallet)),
  add column if not exists requester_wallet text
    check (requester_wallet is null or requester_wallet = public.app_normalize_wallet(requester_wallet));

create index if not exists delivery_evidence_milestone_revision_desc_idx
  on public.delivery_evidence (milestone_id, revision desc);

create function public.app_submit_canonical_delivery_evidence(
  p_actor_id uuid,
  p_milestone_id uuid,
  p_uri text,
  p_content_hash text,
  p_uri_hash text,
  p_evidence_salt text,
  p_evidence_hash text,
  p_hash_version text,
  p_approval_decision_hash text,
  p_approval_salt text,
  p_canonical_approval_hash text,
  p_expected_current_milestone integer,
  p_chain_id bigint,
  p_escrow_contract_address text,
  p_onchain_bounty_id text,
  p_scope_hash text,
  p_terms_hash text,
  p_provider_wallet text,
  p_requester_wallet text
)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  milestone_row public.milestones;
  bounty_row public.bounties;
  escrow_row public.escrow_records;
  proposal_provider_id uuid;
  expected_provider_wallet text;
  expected_requester_wallet text;
  next_revision integer;
  evidence_row public.delivery_evidence;
begin
  select * into milestone_row from public.milestones where id = p_milestone_id;
  if not found then raise exception 'ASSIGNED_PROVIDER_REQUIRED' using errcode = '42501'; end if;

  select * into bounty_row from public.bounties where id = milestone_row.bounty_id for update;
  if not found then raise exception 'BOUNTY_NOT_FOUND' using errcode = '22023'; end if;
  select * into escrow_row from public.escrow_records where bounty_id = bounty_row.id for update;
  if not found then raise exception 'ESCROW_OBSERVATION_REQUIRED' using errcode = '22023'; end if;
  select * into milestone_row from public.milestones where id = p_milestone_id for update;
  if not found then raise exception 'MILESTONE_NOT_FOUND' using errcode = '22023'; end if;

  select proposal.provider_id into proposal_provider_id
  from public.proposals proposal where proposal.id = bounty_row.accepted_proposal_id;
  select account.wallet_address into expected_provider_wallet
  from public.wallet_accounts account where account.id = proposal_provider_id;
  select account.wallet_address into expected_requester_wallet
  from public.wallet_accounts account where account.id = bounty_row.creator_id;

  if milestone_row.assigned_provider_id <> p_actor_id
    or proposal_provider_id is distinct from p_actor_id then
    raise exception 'ASSIGNED_PROVIDER_REQUIRED' using errcode = '42501';
  end if;
  if escrow_row.state_checked_at < now() - interval '2 minutes'
    or escrow_row.onchain_state <> 'ProviderAccepted'
    or escrow_row.current_milestone <> p_expected_current_milestone
    or milestone_row.ordinal <> p_expected_current_milestone
    or escrow_row.current_milestone_detail->>'state' <> 'Pending' then
    raise exception 'CURRENT_MILESTONE_RECONCILIATION_REQUIRED' using errcode = '40001';
  end if;
  if milestone_row.status <> 'funded' then
    raise exception 'MILESTONE_NOT_DELIVERABLE' using errcode = '22023';
  end if;

  if p_uri is null or p_uri <> btrim(p_uri) or p_uri !~ '^https://'
    or char_length(p_uri) > 4096 then
    raise exception 'INVALID_EVIDENCE_URI' using errcode = '22023';
  end if;
  if p_content_hash !~ '^0x[0-9a-f]{64}$'
    or p_content_hash <> '0x' || encode(digest(convert_to(p_uri, 'UTF8'), 'sha256'), 'hex') then
    raise exception 'EVIDENCE_CONTENT_HASH_MISMATCH' using errcode = '23514';
  end if;
  if p_uri_hash !~ '^0x[0-9a-f]{64}$'
    or p_evidence_salt !~ '^0x[0-9a-f]{64}$'
    or p_evidence_hash !~ '^0x[0-9a-f]{64}$'
    or p_approval_decision_hash !~ '^0x[0-9a-f]{64}$'
    or p_approval_salt !~ '^0x[0-9a-f]{64}$'
    or p_canonical_approval_hash !~ '^0x[0-9a-f]{64}$'
    or p_hash_version <> 'bounty-evidence-commitment.v1' then
    raise exception 'INVALID_EVIDENCE_COMMITMENT' using errcode = '22023';
  end if;

  if bounty_row.chain_id <> p_chain_id
    or lower(bounty_row.scope_hash) <> lower(p_scope_hash)
    or escrow_row.chain_id <> p_chain_id
    or escrow_row.contract_address is distinct from public.app_normalize_wallet(p_escrow_contract_address)
    or escrow_row.onchain_bounty_id is distinct from p_onchain_bounty_id
    or escrow_row.terms_hash is distinct from lower(p_terms_hash)
    or expected_provider_wallet is distinct from public.app_normalize_wallet(p_provider_wallet)
    or expected_requester_wallet is distinct from public.app_normalize_wallet(p_requester_wallet) then
    raise exception 'EVIDENCE_CONTEXT_MISMATCH' using errcode = '23514';
  end if;

  select coalesce(max(revision), 0) + 1 into next_revision
  from public.delivery_evidence where milestone_id = p_milestone_id;
  insert into public.delivery_evidence (
    milestone_id, provider_id, uri, content_hash, uri_hash, evidence_salt,
    evidence_hash, hash_version, approval_decision_hash, approval_salt,
    canonical_approval_hash, chain_id, escrow_contract_address,
    onchain_bounty_id, milestone_ordinal, scope_hash, terms_hash,
    provider_wallet, requester_wallet, revision
  ) values (
    p_milestone_id, p_actor_id, p_uri, lower(p_content_hash), lower(p_uri_hash), lower(p_evidence_salt),
    lower(p_evidence_hash), p_hash_version, lower(p_approval_decision_hash), lower(p_approval_salt),
    lower(p_canonical_approval_hash), p_chain_id, public.app_normalize_wallet(p_escrow_contract_address),
    p_onchain_bounty_id, p_expected_current_milestone, lower(p_scope_hash), lower(p_terms_hash),
    public.app_normalize_wallet(p_provider_wallet), public.app_normalize_wallet(p_requester_wallet), next_revision
  ) returning * into evidence_row;

  update public.milestones set status = 'delivered' where id = p_milestone_id;
  insert into public.notifications(recipient_id,type,entity_type,entity_id,body,dedupe_key)
  values(bounty_row.creator_id,'delivery','milestone',p_milestone_id,'Delivery evidence submitted','delivery:'||evidence_row.id::text)
  on conflict(dedupe_key) do nothing;
  return to_jsonb(evidence_row);
end $$;

create or replace function public.app_accept_delivery(
  p_actor_id uuid,
  p_milestone_id uuid,
  p_expected_current_milestone integer
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  milestone_row public.milestones;
  bounty_row public.bounties;
  escrow_row public.escrow_records;
  evidence_row public.delivery_evidence;
  provider uuid;
begin
  select * into milestone_row from public.milestones where id = p_milestone_id;
  if not found then raise exception 'MILESTONE_NOT_FOUND' using errcode = '22023'; end if;
  select * into bounty_row from public.bounties where id = milestone_row.bounty_id for update;
  if bounty_row.creator_id <> p_actor_id then raise exception 'BOUNTY_OWNER_REQUIRED' using errcode = '42501'; end if;
  select * into escrow_row from public.escrow_records where bounty_id = milestone_row.bounty_id for update;
  if not found then raise exception 'ESCROW_OBSERVATION_REQUIRED' using errcode = '22023'; end if;
  select * into milestone_row from public.milestones where id = p_milestone_id for update;
  select * into evidence_row from public.delivery_evidence evidence
    where evidence.milestone_id = p_milestone_id
    order by evidence.revision desc limit 1 for update;

  if milestone_row.ordinal <> p_expected_current_milestone
    or escrow_row.state_checked_at < now() - interval '2 minutes'
    or escrow_row.onchain_state <> 'BuyerApproved'
    or escrow_row.current_milestone <> p_expected_current_milestone
    or escrow_row.current_milestone_detail->>'state' <> 'Approved' then
    raise exception 'CURRENT_MILESTONE_RECONCILIATION_REQUIRED' using errcode = '40001';
  end if;
  if evidence_row.id is null then
    raise exception 'EVIDENCE_COMMITMENT_REQUIRED' using errcode = '40001';
  end if;
  if evidence_row.milestone_ordinal is distinct from milestone_row.ordinal
    or evidence_row.chain_id is distinct from bounty_row.chain_id
    or evidence_row.escrow_contract_address is distinct from escrow_row.contract_address
    or evidence_row.onchain_bounty_id is distinct from escrow_row.onchain_bounty_id
    or evidence_row.scope_hash is distinct from lower(bounty_row.scope_hash)
    or evidence_row.terms_hash is distinct from escrow_row.terms_hash then
    raise exception 'EVIDENCE_CONTEXT_MISMATCH' using errcode = '40001';
  end if;
  if evidence_row.evidence_hash is distinct from lower(escrow_row.current_milestone_detail->>'evidence_hash') then
    raise exception 'EVIDENCE_COMMITMENT_MISMATCH' using errcode = '40001';
  end if;
  if evidence_row.canonical_approval_hash is distinct from lower(escrow_row.current_milestone_detail->>'approval_hash') then
    raise exception 'APPROVAL_COMMITMENT_MISMATCH' using errcode = '40001';
  end if;
  if milestone_row.status not in ('delivered','accepted') then
    raise exception 'MILESTONE_NOT_DELIVERED' using errcode = '22023';
  end if;

  provider := milestone_row.assigned_provider_id;
  update public.milestones set status = 'accepted' where id = p_milestone_id;
  if provider is not null then
    insert into public.notifications(recipient_id,type,entity_type,entity_id,body,dedupe_key)
    values(provider,'delivery_accepted','milestone',p_milestone_id,'Delivery accepted','delivery-accepted:'||p_milestone_id::text)
    on conflict(dedupe_key) do nothing;
  end if;
  return public.app_bounty_json(bounty_row.id,p_actor_id);
end $$;

-- Retire both client-shaped evidence RPCs. Only the canonical, server-derived
-- RPC remains executable by the service role.
revoke execute on function public.app_submit_delivery_evidence(uuid,uuid,text,text,text,text) from service_role;
revoke execute on function public.app_submit_delivery_evidence(uuid,uuid,text,text,text,text,integer) from service_role;
revoke all on function public.app_submit_canonical_delivery_evidence(
  uuid,uuid,text,text,text,text,text,text,text,text,text,integer,bigint,text,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.app_submit_canonical_delivery_evidence(
  uuid,uuid,text,text,text,text,text,text,text,text,text,integer,bigint,text,text,text,text,text,text
) to service_role;

-- This is additive because the public-profile migration may already have been
-- recorded in a production migration ledger. Preserve its implementation and
-- extend the response contract without rewriting applied history.
alter function public.app_public_wallet_profile(text)
  rename to app_public_wallet_profile_before_evidence_integrity;

create function public.app_public_wallet_profile(p_wallet_address text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when prior.profile is null then null else
    prior.profile || jsonb_build_object('profile_updated_at', account.profile_updated_at)
  end
  from (select public.app_public_wallet_profile_before_evidence_integrity(p_wallet_address) as profile) prior
  left join public.wallet_accounts account
    on account.wallet_address = public.app_normalize_wallet(p_wallet_address)
$$;

revoke all on function public.app_public_wallet_profile_before_evidence_integrity(text)
from public,anon,authenticated,service_role;
revoke all on function public.app_public_wallet_profile(text)
from public,anon,authenticated;
grant execute on function public.app_public_wallet_profile(text) to service_role;
