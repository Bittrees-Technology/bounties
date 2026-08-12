-- Add public activity summaries and bounded public profile discovery without
-- exposing direct table access. ENS names remain live RPC data and are added by
-- the application server rather than persisted as identity authority.

alter function public.app_public_wallet_profile(text)
  rename to app_public_wallet_profile_before_discovery;

create function public.app_public_wallet_profile(p_wallet_address text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when prior.profile is null then null else
    prior.profile || jsonb_build_object(
      'activity_summary', jsonb_build_object(
        'capital_bounties', (
          select count(*)::integer from public.bounties bounty
          where bounty.creator_id = account.id
        ),
        'labor_bounties', (
          select count(*)::integer
          from public.bounties bounty
          join public.proposals proposal on proposal.id = bounty.accepted_proposal_id
          where proposal.provider_id = account.id
        )
      )
    ) end
  from (select public.app_public_wallet_profile_before_discovery(p_wallet_address) as profile) prior
  left join public.wallet_accounts account
    on account.wallet_address = public.app_normalize_wallet(p_wallet_address)
$$;

create function public.app_search_public_wallet_profiles(
  p_query text,
  p_limit integer default 12
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  normalized_query text := lower(btrim(coalesce(p_query, '')));
  escaped_query text;
  result_limit integer := least(greatest(coalesce(p_limit, 12), 1), 20);
  result jsonb;
begin
  if char_length(normalized_query) < 2 or char_length(normalized_query) > 80 then
    return '[]'::jsonb;
  end if;
  escaped_query := replace(replace(replace(normalized_query, '\', '\\'), '%', '\%'), '_', '\_');

  select coalesce(jsonb_agg(match.profile order by match.rank, match.display_sort, match.wallet_sort), '[]'::jsonb)
    into result
  from (
    select
      public.app_public_wallet_profile(account.wallet_address) as profile,
      case
        when account.wallet_address = normalized_query then 0
        when lower(coalesce(account.display_name, '')) = normalized_query then 1
        when normalized_query like '0x%' and account.wallet_address like escaped_query || '%' escape '\' then 2
        else 3
      end as rank,
      lower(coalesce(account.display_name, '')) as display_sort,
      account.wallet_address as wallet_sort
    from public.wallet_accounts account
    where account.profile_moderation_status = 'visible'
      and (
        (normalized_query like '0x%' and account.wallet_address like escaped_query || '%' escape '\')
        or lower(coalesce(account.display_name, '')) like '%' || escaped_query || '%' escape '\'
      )
    order by rank, display_sort, wallet_sort
    limit result_limit
  ) match;

  return result;
end $$;

revoke all on function public.app_public_wallet_profile_before_discovery(text)
from public,anon,authenticated,service_role;
revoke all on function public.app_public_wallet_profile(text)
from public,anon,authenticated;
revoke all on function public.app_search_public_wallet_profiles(text,integer)
from public,anon,authenticated;
grant execute on function public.app_public_wallet_profile(text) to service_role;
grant execute on function public.app_search_public_wallet_profiles(text,integer) to service_role;
