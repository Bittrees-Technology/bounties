-- Read-only moderation history for explicitly authorized governance roles.
-- Role authority is resolved fresh by the server from the shared Bittrees role
-- registry. This service-role-only function cannot mutate reports or content.

create function public.app_moderation_audit_history(
  p_actor_id uuid,
  p_access_role text,
  p_limit integer default 100
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  include_internal_notes boolean;
  events jsonb;
begin
  if p_actor_id is null
    or not exists (select 1 from public.wallet_accounts account where account.id = p_actor_id) then
    raise exception 'ACCOUNT_REQUIRED' using errcode = '42501';
  end if;
  if p_access_role is null
    or p_access_role not in ('associate', 'junior_partner', 'partner', 'admin') then
    raise exception 'AUDIT_ACCESS_REQUIRED' using errcode = '42501';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 250 then
    raise exception 'INVALID_AUDIT_LIMIT' using errcode = '22023';
  end if;

  include_internal_notes := p_access_role = 'admin';

  select coalesce(jsonb_agg(to_jsonb(history) order by history.created_at desc, history.event_id desc), '[]'::jsonb)
  into events
  from (
    select
      event.id as event_id,
      event.report_id,
      event.report_version,
      event.created_at,
      report.entity_type,
      report.entity_id,
      report.request_kind,
      report.verification_outcome,
      report.reason,
      event.status,
      event.decision,
      event.moderator_response as public_response,
      case when include_internal_notes then event.internal_note else null end as internal_note,
      event.content_moderation_status,
      event.actor_id,
      actor.wallet_address as actor_wallet_address,
      actor.display_name as actor_display_name,
      report.reporter_id,
      reporter.wallet_address as reporter_wallet_address,
      reporter.display_name as reporter_display_name,
      case report.entity_type
        when 'bounty' then coalesce((select bounty.title from public.bounties bounty where bounty.id = report.entity_id), 'Bounty')
        when 'review' then coalesce((
          select 'Review on ' || bounty.title
          from public.participant_reviews review
          join public.bounties bounty on bounty.id = review.bounty_id
          where review.id = report.entity_id
        ), 'Participant review')
        when 'profile' then coalesce((
          select coalesce(profile.display_name, profile.wallet_address)
          from public.wallet_accounts profile where profile.id = report.entity_id
        ), 'Wallet profile')
        when 'token' then coalesce((
          select coalesce(token.symbol, token.name, 'ERC20') || ' on network ' || token.chain_id::text
          from public.tokens token where token.id = report.entity_id
        ), 'ERC20 token')
        else 'Moderated content'
      end as entity_title
    from public.content_report_events event
    join public.content_reports report on report.id = event.report_id
    join public.wallet_accounts actor on actor.id = event.actor_id
    join public.wallet_accounts reporter on reporter.id = report.reporter_id
    where event.event_type = 'decided'
    order by event.created_at desc, event.id desc
    limit p_limit
  ) history;

  return jsonb_build_object(
    'accessRole', p_access_role,
    'canViewInternalNotes', include_internal_notes,
    'events', events
  );
end $$;

revoke all on function public.app_moderation_audit_history(uuid,text,integer)
from public, anon, authenticated;
grant execute on function public.app_moderation_audit_history(uuid,text,integer)
to service_role;
