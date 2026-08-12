-- Correct the canonical evidence boundary: content_hash is supplied by the
-- provider as the SHA-256 digest of the exact delivered bytes. It is distinct
-- from uri_hash and must never be derived from the evidence URI.

create or replace function public.app_submit_canonical_delivery_evidence(
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
    or p_content_hash = ('0x' || repeat('0', 64)) then
    raise exception 'INVALID_DELIVERED_CONTENT_HASH' using errcode = '23514';
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

comment on column public.delivery_evidence.content_hash is
  'Provider-supplied SHA-256 digest of exact delivered file or canonical bundle bytes; never derived from uri.';
