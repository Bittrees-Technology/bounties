-- Partner, Junior Partner, and Associate are the administrative roles for the
-- audit-history feature. Moderators retain queue authority but receive no audit
-- access unless they independently hold one of these governance roles.

alter function public.app_moderation_audit_history(uuid,text,integer)
  rename to app_moderation_audit_history_before_governance_admins;

create function public.app_moderation_audit_history(
  p_actor_id uuid,
  p_access_role text,
  p_limit integer default 100
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if p_access_role is null
    or p_access_role not in ('associate', 'junior_partner', 'partner', 'admin') then
    raise exception 'AUDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;

  -- The prior projection exposes internal notes for its administrator role.
  -- Every accepted governance role is an audit administrator, so reuse that
  -- projection and preserve the caller's actual governance title in metadata.
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

revoke all on function public.app_moderation_audit_history_before_governance_admins(uuid,text,integer)
from public, anon, authenticated, service_role;
revoke all on function public.app_moderation_audit_history(uuid,text,integer)
from public, anon, authenticated;
grant execute on function public.app_moderation_audit_history(uuid,text,integer)
to service_role;
