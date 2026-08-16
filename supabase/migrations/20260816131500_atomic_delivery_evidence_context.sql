-- Build the immutable delivery commitment from one database snapshot. The
-- previous API path assembled this context with several independent REST
-- reads after recording the latest chain state. Under load, those reads could
-- observe different snapshots and reject a valid provider submission as
-- stale even though the canonical escrow record was current.

create function public.app_delivery_evidence_context(
  p_actor_id uuid,
  p_milestone_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public as $$
declare
  context jsonb;
begin
  select jsonb_build_object(
    'milestone_id', milestone.id,
    'bounty_id', bounty.id,
    'ordinal', milestone.ordinal,
    'chain_id', bounty.chain_id,
    'contract_address', escrow.contract_address,
    'onchain_bounty_id', escrow.onchain_bounty_id,
    'scope_hash', bounty.scope_hash,
    'terms_hash', escrow.terms_hash,
    'provider_wallet', provider.wallet_address,
    'requester_wallet', requester.wallet_address,
    'recorded_current_milestone', escrow.current_milestone
  )
  into context
  from public.milestones milestone
  join public.bounties bounty on bounty.id = milestone.bounty_id
  join public.escrow_records escrow on escrow.bounty_id = bounty.id
  join public.proposals proposal on proposal.id = bounty.accepted_proposal_id
  join public.wallet_accounts provider on provider.id = proposal.provider_id
  join public.wallet_accounts requester on requester.id = bounty.creator_id
  where milestone.id = p_milestone_id
    and milestone.assigned_provider_id = p_actor_id
    and proposal.provider_id = p_actor_id;

  if context is null then
    raise exception 'ASSIGNED_PROVIDER_REQUIRED' using errcode = '42501';
  end if;
  return context;
end $$;

revoke all on function public.app_delivery_evidence_context(uuid,uuid)
from public, anon, authenticated;
grant execute on function public.app_delivery_evidence_context(uuid,uuid)
to service_role;

