-- Authenticated profile browsing for the Profiles dashboard. The directory is
-- bounded, excludes moderated or empty accounts, and remains available only
-- through the server-owned service-role boundary.

create function public.app_browse_public_wallet_profiles(
  p_actor_id uuid,
  p_limit integer default 18
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  result_limit integer := least(greatest(coalesce(p_limit, 18), 1), 24);
  result jsonb;
begin
  if p_actor_id is null or not exists (
    select 1 from public.wallet_accounts account where account.id = p_actor_id
  ) then
    raise exception 'ACCOUNT_REQUIRED' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(directory.profile order by directory.activity_score desc, directory.profile_updated_at desc, directory.wallet_address), '[]'::jsonb)
    into result
  from (
    select
      public.app_public_wallet_profile(account.wallet_address) as profile,
      account.wallet_address,
      account.profile_updated_at,
      (
        (select count(*) from public.bounties bounty where bounty.creator_id = account.id)
        +
        (select count(*) from public.proposals proposal where proposal.provider_id = account.id and proposal.status = 'accepted')
        +
        (select count(*) from public.participant_reviews review where review.subject_id = account.id and review.moderation_status = 'visible')
      )::integer as activity_score
    from public.wallet_accounts account
    where account.profile_moderation_status = 'visible'
      and (
        nullif(btrim(coalesce(account.display_name, '')), '') is not null
        or nullif(btrim(coalesce(account.profile_bio, '')), '') is not null
        or nullif(btrim(coalesce(account.profile_url, '')), '') is not null
        or cardinality(account.work_types) > 0
        or cardinality(account.categories) > 0
        or nullif(btrim(coalesce(account.custom_specialty, '')), '') is not null
        or exists (select 1 from public.bounties bounty where bounty.creator_id = account.id)
        or exists (select 1 from public.proposals proposal where proposal.provider_id = account.id and proposal.status = 'accepted')
        or exists (select 1 from public.participant_reviews review where review.subject_id = account.id and review.moderation_status = 'visible')
      )
    order by activity_score desc, account.profile_updated_at desc, account.wallet_address
    limit result_limit
  ) directory;

  return result;
end $$;

revoke all on function public.app_browse_public_wallet_profiles(uuid,integer)
from public,anon,authenticated;
grant execute on function public.app_browse_public_wallet_profiles(uuid,integer)
to service_role;
