-- Public profile completion counts must describe terminal, paid or bilaterally
-- settled work. An accepted proposal remains visible as active experience but
-- must not be represented as completed work.

alter function public.app_public_wallet_profile(text)
  rename to app_public_wallet_profile_before_terminal_activity;

create function public.app_public_wallet_profile(p_wallet_address text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when prior.profile is null then null else
    prior.profile || jsonb_build_object(
      'activity_summary', jsonb_build_object(
        'capital_bounties', (
          select count(*)::integer
          from public.bounties bounty
          where bounty.creator_id = account.id
            and bounty.status <> 'draft'
            and bounty.moderation_status = 'visible'
        ),
        'labor_bounties', (
          select count(*)::integer
          from public.bounties bounty
          join public.proposals proposal on proposal.id = bounty.accepted_proposal_id
          join public.escrow_records escrow on escrow.bounty_id = bounty.id
          where proposal.provider_id = account.id
            and bounty.status <> 'draft'
            and bounty.moderation_status = 'visible'
            and escrow.onchain_state in ('Released', 'Settled')
        )
      )
    )
  end
  from (select public.app_public_wallet_profile_before_terminal_activity(p_wallet_address) as profile) prior
  left join public.wallet_accounts account
    on account.wallet_address = public.app_normalize_wallet(p_wallet_address)
$$;

revoke all on function public.app_public_wallet_profile_before_terminal_activity(text)
from public,anon,authenticated,service_role;
revoke all on function public.app_public_wallet_profile(text)
from public,anon,authenticated;
grant execute on function public.app_public_wallet_profile(text) to service_role;
