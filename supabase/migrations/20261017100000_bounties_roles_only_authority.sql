-- Retain historical moderation rows; only fresh Roles decisions confer staff access.
create or replace function public.app_is_moderation_staff(p_actor_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
 select exists(select 1 from public.shared_moderation_grants g
 where g.account_id=p_actor_id and g.source='roles.bittrees.org'
 and g.verified_at<=clock_timestamp() and g.expires_at>clock_timestamp()
 and g.expires_at<=g.verified_at+interval '5 seconds')
$$;
-- Disable the old projection entry point without deleting audit history.
revoke all on function public.app_sync_shared_moderation_role(uuid,text,boolean,text)
 from public,anon,authenticated,service_role;

create or replace function public.app_moderation_audit_history(
  p_actor_id uuid,
  p_access_role text,
  p_limit integer default 100
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if p_access_role is null
    or p_access_role <> 'admin' then
    raise exception 'AUDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  -- Only explicitly authorized project administration may view audit notes.
  result := public.app_moderation_audit_history_before_governance_admins(
    p_actor_id,
    'admin',
    p_limit
  );

  return result || jsonb_build_object(
    'accessRole', p_access_role,
    'canViewInternalNotes', true
  );
end $$;
