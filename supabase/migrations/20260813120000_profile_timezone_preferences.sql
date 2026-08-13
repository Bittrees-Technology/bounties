-- Let wallet owners save an IANA timezone while independently choosing
-- whether it appears on their public profile. Private timezone data remains
-- available only through the server-authorized owner profile route.

alter table public.wallet_accounts
  add column if not exists timezone text,
  add column if not exists timezone_public boolean not null default false;

alter table public.wallet_accounts
  drop constraint if exists wallet_accounts_timezone_check,
  add constraint wallet_accounts_timezone_check check (
    timezone is null or (
      timezone = btrim(timezone)
      and char_length(timezone) between 1 and 64
      and timezone ~ '^[A-Za-z0-9_+.-]+(/[A-Za-z0-9_+.-]+)*$'
    )
  );

alter function public.app_public_wallet_profile(text)
  rename to app_public_wallet_profile_before_timezone_preferences;

create function public.app_public_wallet_profile(p_wallet_address text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when prior.profile is null then null else
    prior.profile || jsonb_build_object(
      'timezone', case
        when account.profile_moderation_status = 'visible' and account.timezone_public
          then account.timezone
        else null
      end,
      'timezone_public', account.profile_moderation_status = 'visible'
        and account.timezone_public
        and account.timezone is not null
    )
  end
  from (select public.app_public_wallet_profile_before_timezone_preferences(p_wallet_address) as profile) prior
  left join public.wallet_accounts account
    on account.wallet_address = public.app_normalize_wallet(p_wallet_address)
$$;

create or replace function public.app_my_wallet_profile(p_actor_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select public.app_public_wallet_profile(account.wallet_address) || jsonb_build_object(
    'display_name', account.display_name,
    'profile_bio', account.profile_bio,
    'profile_url', account.profile_url,
    'work_types', to_jsonb(account.work_types),
    'categories', to_jsonb(account.categories),
    'custom_specialty', account.custom_specialty,
    'timezone', account.timezone,
    'timezone_public', account.timezone_public,
    'visibility_source', case
      when account.profile_moderation_status = 'hidden' and account.profile_moderated_by is null then 'owner'
      when account.profile_moderation_status = 'hidden' then 'moderation'
      else null
    end
  )
  from public.wallet_accounts account
  where account.id = p_actor_id
$$;

create function public.app_update_public_profile(
  p_actor_id uuid,
  p_display_name text,
  p_profile_bio text,
  p_profile_url text,
  p_work_types text[],
  p_categories text[],
  p_custom_specialty text,
  p_timezone text,
  p_timezone_public boolean
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  normalized_work_types text[];
  normalized_categories text[];
  normalized_custom_specialty text;
  normalized_timezone text := nullif(btrim(p_timezone), '');
begin
  if p_actor_id is null or not exists (
    select 1 from public.wallet_accounts account where account.id = p_actor_id
  ) then
    raise exception 'ACCOUNT_REQUIRED' using errcode = '42501';
  end if;
  if p_display_name is not null and char_length(btrim(p_display_name)) not between 1 and 80 then
    raise exception 'INVALID_DISPLAY_NAME' using errcode = '22023';
  end if;
  if p_profile_bio is not null and char_length(btrim(p_profile_bio)) not between 1 and 1000 then
    raise exception 'INVALID_PROFILE_BIO' using errcode = '22023';
  end if;
  if p_profile_url is not null and (
    char_length(btrim(p_profile_url)) > 2048 or btrim(p_profile_url) !~ '^https://'
  ) then
    raise exception 'INVALID_PROFILE_URL' using errcode = '22023';
  end if;

  select coalesce(array_agg(btrim(value) order by ordinal), '{}'::text[])
    into normalized_work_types
  from unnest(coalesce(p_work_types, '{}'::text[])) with ordinality values_with_order(value, ordinal);
  select coalesce(array_agg(btrim(value) order by ordinal), '{}'::text[])
    into normalized_categories
  from unnest(coalesce(p_categories, '{}'::text[])) with ordinality values_with_order(value, ordinal);
  normalized_custom_specialty := nullif(btrim(p_custom_specialty), '');

  if not public.app_profile_selections_valid(normalized_work_types) then
    raise exception 'INVALID_WORK_TYPES' using errcode = '22023';
  end if;
  if not public.app_profile_selections_valid(normalized_categories) then
    raise exception 'INVALID_CATEGORIES' using errcode = '22023';
  end if;
  if normalized_custom_specialty is not null and (
    char_length(normalized_custom_specialty) not between 1 and 120
    or normalized_custom_specialty ~ '[[:cntrl:]]'
  ) then
    raise exception 'INVALID_CUSTOM_SPECIALTY' using errcode = '22023';
  end if;
  if normalized_timezone is not null and not exists (
    select 1 from pg_timezone_names where name = normalized_timezone
  ) then
    raise exception 'INVALID_TIMEZONE' using errcode = '22023';
  end if;

  update public.wallet_accounts account
     set display_name = case when p_display_name is null then null else btrim(p_display_name) end,
         profile_bio = case when p_profile_bio is null then null else btrim(p_profile_bio) end,
         profile_url = case when p_profile_url is null then null else btrim(p_profile_url) end,
         work_types = normalized_work_types,
         categories = normalized_categories,
         custom_specialty = normalized_custom_specialty,
         timezone = normalized_timezone,
         timezone_public = coalesce(p_timezone_public, false) and normalized_timezone is not null,
         profile_updated_at = now()
   where account.id = p_actor_id;

  return public.app_my_wallet_profile(p_actor_id);
end $$;

revoke all on function public.app_public_wallet_profile_before_timezone_preferences(text)
from public,anon,authenticated,service_role;
revoke all on function public.app_public_wallet_profile(text)
from public,anon,authenticated;
revoke all on function public.app_my_wallet_profile(uuid)
from public,anon,authenticated;
revoke all on function public.app_update_public_profile(uuid,text,text,text,text[],text[],text,text,boolean)
from public,anon,authenticated;
grant execute on function public.app_public_wallet_profile(text) to service_role;
grant execute on function public.app_my_wallet_profile(uuid) to service_role;
grant execute on function public.app_update_public_profile(uuid,text,text,text,text[],text[],text,text,boolean)
to service_role;
