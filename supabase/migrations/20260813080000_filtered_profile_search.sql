-- Focused profile discovery. Matching stays behind the service-role API and
-- hidden profiles are excluded before any public profile JSON is assembled.

create function public.app_filter_public_wallet_profiles(
  p_query text default null,
  p_search_field text default 'all',
  p_work_type text default null,
  p_category text default null,
  p_limit integer default 12
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  normalized_query text := lower(btrim(coalesce(p_query, '')));
  normalized_field text := lower(btrim(coalesce(p_search_field, 'all')));
  normalized_work_type text := nullif(btrim(coalesce(p_work_type, '')), '');
  normalized_category text := nullif(btrim(coalesce(p_category, '')), '');
  escaped_query text;
  result_limit integer := least(greatest(coalesce(p_limit, 12), 1), 20);
  result jsonb;
begin
  if (normalized_query <> '' and char_length(normalized_query) not between 2 and 80)
    or normalized_field not in ('all', 'identity', 'bio', 'specialty')
    or (normalized_query = '' and normalized_work_type is null and normalized_category is null) then
    return '[]'::jsonb;
  end if;

  escaped_query := replace(replace(replace(normalized_query, '\', '\\'), '%', '\%'), '_', '\_');

  select coalesce(jsonb_agg(match.profile order by match.rank, match.display_sort, match.wallet_sort), '[]'::jsonb)
    into result
  from (
    select
      public.app_public_wallet_profile(account.wallet_address) as profile,
      case
        when normalized_query <> '' and account.wallet_address = normalized_query then 0
        when normalized_query <> '' and lower(coalesce(account.display_name, '')) = normalized_query then 1
        when normalized_work_type is not null and exists (
          select 1 from unnest(account.work_types) work_type where lower(work_type) = lower(normalized_work_type)
        ) then 2
        when normalized_category is not null and exists (
          select 1 from unnest(account.categories) category where lower(category) = lower(normalized_category)
        ) then 3
        else 4
      end as rank,
      lower(coalesce(account.display_name, '')) as display_sort,
      account.wallet_address as wallet_sort
    from public.wallet_accounts account
    where account.profile_moderation_status = 'visible'
      and (
        normalized_work_type is null or exists (
          select 1 from unnest(account.work_types) work_type where lower(work_type) = lower(normalized_work_type)
        )
      )
      and (
        normalized_category is null or exists (
          select 1 from unnest(account.categories) category where lower(category) = lower(normalized_category)
        )
      )
      and (
        normalized_query = ''
        or case normalized_field
          when 'identity' then
            (normalized_query like '0x%' and account.wallet_address like escaped_query || '%' escape '\')
            or lower(coalesce(account.display_name, '')) like '%' || escaped_query || '%' escape '\'
          when 'bio' then
            lower(coalesce(account.profile_bio, '')) like '%' || escaped_query || '%' escape '\'
          when 'specialty' then
            exists (select 1 from unnest(account.work_types) work_type where lower(work_type) like '%' || escaped_query || '%' escape '\')
            or exists (select 1 from unnest(account.categories) category where lower(category) like '%' || escaped_query || '%' escape '\')
            or lower(coalesce(account.custom_specialty, '')) like '%' || escaped_query || '%' escape '\'
          else
            (normalized_query like '0x%' and account.wallet_address like escaped_query || '%' escape '\')
            or lower(coalesce(account.display_name, '')) like '%' || escaped_query || '%' escape '\'
            or lower(coalesce(account.profile_bio, '')) like '%' || escaped_query || '%' escape '\'
            or exists (select 1 from unnest(account.work_types) work_type where lower(work_type) like '%' || escaped_query || '%' escape '\')
            or exists (select 1 from unnest(account.categories) category where lower(category) like '%' || escaped_query || '%' escape '\')
            or lower(coalesce(account.custom_specialty, '')) like '%' || escaped_query || '%' escape '\'
        end
      )
    order by rank, display_sort, wallet_sort
    limit result_limit
  ) match;

  return result;
end $$;

revoke all on function public.app_filter_public_wallet_profiles(text,text,text,text,integer)
from public,anon,authenticated;
grant execute on function public.app_filter_public_wallet_profiles(text,text,text,text,integer)
to service_role;
