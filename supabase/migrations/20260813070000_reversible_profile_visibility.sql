-- Reversible owner-controlled profile visibility. Profile data is never
-- deleted. Moderator-hidden profiles cannot be restored by their owner.

create function public.app_my_wallet_profile(p_actor_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select public.app_public_wallet_profile(account.wallet_address) || jsonb_build_object(
    'display_name', account.display_name,
    'profile_bio', account.profile_bio,
    'profile_url', account.profile_url,
    'work_types', to_jsonb(account.work_types),
    'categories', to_jsonb(account.categories),
    'custom_specialty', account.custom_specialty,
    'visibility_source', case
      when account.profile_moderation_status = 'hidden' and account.profile_moderated_by is null then 'owner'
      when account.profile_moderation_status = 'hidden' then 'moderation'
      else null
    end
  )
  from public.wallet_accounts account
  where account.id = p_actor_id
$$;

create function public.app_set_profile_visibility(
  p_actor_id uuid,
  p_visible boolean
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  account_row public.wallet_accounts;
begin
  if p_actor_id is null or p_visible is null then
    raise exception 'INVALID_PROFILE_VISIBILITY' using errcode = '22023';
  end if;

  select * into account_row
  from public.wallet_accounts account
  where account.id = p_actor_id
  for update;
  if not found then
    raise exception 'ACCOUNT_REQUIRED' using errcode = '42501';
  end if;

  if p_visible then
    if account_row.profile_moderation_status = 'hidden' and account_row.profile_moderated_by is not null then
      raise exception 'PROFILE_MODERATOR_HIDDEN' using errcode = '42501';
    end if;
    update public.wallet_accounts account
       set profile_moderation_status = 'visible',
           profile_moderation_reason = null,
           profile_moderated_at = null,
           profile_updated_at = now()
     where account.id = p_actor_id;
  else
    if account_row.profile_moderation_status = 'hidden' and account_row.profile_moderated_by is not null then
      raise exception 'PROFILE_MODERATOR_HIDDEN' using errcode = '42501';
    end if;
    update public.wallet_accounts account
       set profile_moderation_status = 'hidden',
           profile_moderation_reason = 'Hidden by profile owner',
           profile_moderated_by = null,
           profile_moderated_at = now(),
           profile_updated_at = now()
     where account.id = p_actor_id;
  end if;

  return public.app_my_wallet_profile(p_actor_id);
end $$;

revoke all on function public.app_my_wallet_profile(uuid)
from public,anon,authenticated;
revoke all on function public.app_set_profile_visibility(uuid,boolean)
from public,anon,authenticated;
grant execute on function public.app_my_wallet_profile(uuid) to service_role;
grant execute on function public.app_set_profile_visibility(uuid,boolean) to service_role;
