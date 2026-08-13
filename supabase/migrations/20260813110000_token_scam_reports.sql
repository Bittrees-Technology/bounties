-- Treat inspected ERC20 contracts as first-class reportable entities. A
-- moderator can remove a token from future Bounties payment selection without
-- changing existing bounty, escrow, or public-chain records.

alter table public.tokens
  add column if not exists moderation_status text not null default 'visible'
    check (moderation_status in ('visible', 'hidden')),
  add column if not exists moderation_reason text
    check (moderation_reason is null or char_length(moderation_reason) between 3 and 500),
  add column if not exists moderated_by uuid references public.wallet_accounts(id) on delete restrict,
  add column if not exists moderated_at timestamptz;

alter table public.content_reports
  drop constraint if exists content_reports_entity_type_check;
alter table public.content_reports
  add constraint content_reports_entity_type_check
    check (entity_type in ('bounty', 'review', 'profile', 'token'));

alter table public.moderation_actions
  drop constraint if exists moderation_actions_entity_type_check;
alter table public.moderation_actions
  add constraint moderation_actions_entity_type_check
    check (entity_type in ('bounty', 'review', 'profile', 'token'));

create function public.app_require_visible_bounty_token()
returns trigger
language plpgsql security definer set search_path = public as $$
declare token_status text;
begin
  select token.moderation_status into token_status
  from public.tokens token
  where token.id = new.token_id;

  if token_status = 'hidden' then
    raise exception 'TOKEN_MODERATOR_HIDDEN' using errcode = '22023';
  end if;
  return new;
end $$;

create trigger bounties_require_visible_token
before insert or update of token_id on public.bounties
for each row execute function public.app_require_visible_bounty_token();

create or replace function public.app_report_content(
  p_actor_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare report_row public.content_reports; next_event text;
begin
  if p_actor_id is null or not exists (select 1 from public.wallet_accounts where id = p_actor_id) then
    raise exception 'ACCOUNT_REQUIRED' using errcode = '42501';
  end if;
  if p_entity_type = 'bounty' then
    if not exists (select 1 from public.bounties where id = p_entity_id) then raise exception 'CONTENT_NOT_FOUND' using errcode = '22023'; end if;
  elsif p_entity_type = 'review' then
    if not exists (select 1 from public.participant_reviews where id = p_entity_id) then raise exception 'CONTENT_NOT_FOUND' using errcode = '22023'; end if;
  elsif p_entity_type = 'profile' then
    if p_entity_id = p_actor_id then raise exception 'SELF_REPORT_NOT_ALLOWED' using errcode = '22023'; end if;
    if not exists (select 1 from public.wallet_accounts where id = p_entity_id) then raise exception 'CONTENT_NOT_FOUND' using errcode = '22023'; end if;
  elsif p_entity_type = 'token' then
    if not exists (select 1 from public.tokens where id = p_entity_id) then raise exception 'CONTENT_NOT_FOUND' using errcode = '22023'; end if;
  else raise exception 'INVALID_CONTENT_TYPE' using errcode = '22023'; end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then raise exception 'INVALID_REPORT_REASON' using errcode = '22023'; end if;
  perform public.app_consume_rate_limit(p_actor_id, 'content_report', 10, 600);
  select * into report_row from public.content_reports report
    where report.reporter_id = p_actor_id and report.entity_type = p_entity_type and report.entity_id = p_entity_id for update;
  if report_row.id is null then
    insert into public.content_reports (reporter_id, entity_type, entity_id, reason)
    values (p_actor_id, p_entity_type, p_entity_id, btrim(p_reason)) returning * into report_row;
    next_event := 'submitted';
  else
    next_event := case when report_row.status = 'open' then 'updated' else 'reopened' end;
    update public.content_reports report set reason=btrim(p_reason), status='open', decision=null,
      moderator_response=null, internal_note=null, resolved_by=null, resolved_at=null,
      version=report.version+1, created_at=now() where report.id=report_row.id returning * into report_row;
  end if;
  insert into public.content_report_events (
    report_id,actor_id,event_type,report_version,reason,status,content_moderation_status
  ) values (
    report_row.id,p_actor_id,next_event,report_row.version,report_row.reason,report_row.status,
    case report_row.entity_type
      when 'bounty' then (select moderation_status from public.bounties where id=report_row.entity_id)
      when 'review' then (select moderation_status from public.participant_reviews where id=report_row.entity_id)
      when 'profile' then (select profile_moderation_status from public.wallet_accounts where id=report_row.entity_id)
      else (select moderation_status from public.tokens where id=report_row.entity_id)
    end
  );
  return to_jsonb(report_row) - 'internal_note';
end $$;

create or replace function public.app_decide_content_report(
  p_actor_id uuid,p_report_id uuid,p_decision text,p_public_response text,
  p_internal_note text,p_expected_version integer
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare report_row public.content_reports; content_owner_id uuid; current_status text; next_version integer;
begin
  if not public.app_is_moderation_staff(p_actor_id) then raise exception 'MODERATOR_REQUIRED' using errcode='42501'; end if;
  if p_report_id is null or p_decision not in ('hide','restore','no_action') or p_public_response is null
    or char_length(btrim(p_public_response)) not between 3 and 1000
    or (p_internal_note is not null and char_length(btrim(p_internal_note)) not between 1 and 2000)
    or p_expected_version is null or p_expected_version < 1 then raise exception 'INVALID_REPORT_DECISION' using errcode='22023'; end if;
  select * into report_row from public.content_reports report where report.id=p_report_id for update;
  if report_row.id is null then raise exception 'REPORT_NOT_FOUND' using errcode='22023'; end if;
  if report_row.status <> 'open' then raise exception 'REPORT_ALREADY_DECIDED' using errcode='40001'; end if;
  if report_row.version <> p_expected_version then raise exception 'REPORT_VERSION_CONFLICT' using errcode='40001'; end if;

  if report_row.entity_type='bounty' then
    select creator_id,moderation_status into content_owner_id,current_status from public.bounties where id=report_row.entity_id for update;
    if not found then raise exception 'CONTENT_NOT_FOUND' using errcode='22023'; end if;
    if p_decision in ('hide','restore') then update public.bounties set moderation_status=case p_decision when 'hide' then 'hidden' else 'visible' end,
      moderation_reason=case p_decision when 'hide' then left(btrim(p_public_response),500) else null end,
      moderated_by=p_actor_id,moderated_at=now() where id=report_row.entity_id returning moderation_status into current_status; end if;
  elsif report_row.entity_type='review' then
    select author_id,moderation_status into content_owner_id,current_status from public.participant_reviews where id=report_row.entity_id for update;
    if not found then raise exception 'CONTENT_NOT_FOUND' using errcode='22023'; end if;
    if p_decision in ('hide','restore') then update public.participant_reviews set moderation_status=case p_decision when 'hide' then 'hidden' else 'visible' end,
      moderation_reason=case p_decision when 'hide' then left(btrim(p_public_response),500) else null end,
      moderated_by=p_actor_id,moderated_at=now() where id=report_row.entity_id returning moderation_status into current_status; end if;
  elsif report_row.entity_type='profile' then
    select id,profile_moderation_status into content_owner_id,current_status from public.wallet_accounts where id=report_row.entity_id for update;
    if not found then raise exception 'CONTENT_NOT_FOUND' using errcode='22023'; end if;
    if p_decision in ('hide','restore') then update public.wallet_accounts set profile_moderation_status=case p_decision when 'hide' then 'hidden' else 'visible' end,
      profile_moderation_reason=case p_decision when 'hide' then left(btrim(p_public_response),500) else null end,
      profile_moderated_by=p_actor_id,profile_moderated_at=now() where id=report_row.entity_id returning profile_moderation_status into current_status; end if;
  elsif report_row.entity_type='token' then
    select created_by,moderation_status into content_owner_id,current_status from public.tokens where id=report_row.entity_id for update;
    if not found then raise exception 'CONTENT_NOT_FOUND' using errcode='22023'; end if;
    if p_decision in ('hide','restore') then update public.tokens set moderation_status=case p_decision when 'hide' then 'hidden' else 'visible' end,
      moderation_reason=case p_decision when 'hide' then left(btrim(p_public_response),500) else null end,
      moderated_by=p_actor_id,moderated_at=now() where id=report_row.entity_id returning moderation_status into current_status; end if;
  else raise exception 'INVALID_CONTENT_TYPE' using errcode='22023'; end if;

  next_version:=report_row.version+1;
  update public.content_reports set status=case when p_decision='no_action' then 'dismissed' else 'resolved' end,
    decision=p_decision,moderator_response=btrim(p_public_response),internal_note=nullif(btrim(p_internal_note),''),
    resolved_by=p_actor_id,resolved_at=now(),version=next_version where id=report_row.id returning * into report_row;
  insert into public.moderation_actions(actor_id,entity_type,entity_id,action,reason,report_id,report_version,moderator_response,internal_note)
    values(p_actor_id,report_row.entity_type,report_row.entity_id,p_decision,btrim(p_public_response),report_row.id,next_version,btrim(p_public_response),nullif(btrim(p_internal_note),''));
  insert into public.content_report_events(report_id,actor_id,event_type,report_version,reason,status,decision,moderator_response,internal_note,content_moderation_status)
    values(report_row.id,p_actor_id,'decided',next_version,report_row.reason,report_row.status,p_decision,btrim(p_public_response),nullif(btrim(p_internal_note),''),current_status);
  insert into public.notifications(recipient_id,type,entity_type,entity_id,body,dedupe_key)
    values(report_row.reporter_id,'moderation_report_decision','report',report_row.id,'Your content report has been reviewed. Open Bounties to view the moderator response.','moderation-report:'||report_row.id::text||':'||next_version::text||':reporter') on conflict(dedupe_key) do nothing;
  if p_decision in ('hide','restore') and content_owner_id is not null and content_owner_id<>report_row.reporter_id then
    insert into public.notifications(recipient_id,type,entity_type,entity_id,body,dedupe_key)
      values(content_owner_id,'moderation_content_visibility',report_row.entity_type,report_row.entity_id,
      case
        when report_row.entity_type='token' and p_decision='hide' then 'A token contract you added was hidden from future Bounties payment selection after moderation review. Existing escrow and blockchain records are unchanged.'
        when report_row.entity_type='token' then 'A token contract you added was restored for future Bounties payment selection after moderation review. Existing escrow and blockchain records are unchanged.'
        when p_decision='hide' then 'Your content was hidden from the Bounties marketplace after moderation review. Escrow and blockchain records are unchanged.'
        else 'Your content was restored to the Bounties marketplace after moderation review. Escrow and blockchain records are unchanged.'
      end,
      'moderation-report:'||report_row.id::text||':'||next_version::text||':owner') on conflict(dedupe_key) do nothing;
  end if;
  return jsonb_build_object('report',to_jsonb(report_row),'content',jsonb_build_object('entity_type',report_row.entity_type,'entity_id',report_row.entity_id,'moderation_status',current_status));
end $$;

-- Preserve all existing snapshot behavior, then enrich only token reports. The
-- prior report wrapper continues to own listing, review, and profile context.
alter function public.app_marketplace_snapshot(uuid)
  rename to app_marketplace_snapshot_before_token_reports;

create function public.app_marketplace_snapshot(p_actor_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_set(
    prior.snapshot,
    '{moderationReports}',
    coalesce((
      select jsonb_agg(
        case when report->>'entity_type' = 'token' then
          report || jsonb_build_object(
            'current_moderation_status', token.moderation_status,
            'entity_title', coalesce(nullif(token.symbol,''),nullif(token.name,''),'Token') || ' on network ' || token.chain_id::text,
            'content', jsonb_build_object(
              'type','token','id',token.id,'chain_id',token.chain_id,
              'contract_address',token.contract_address,'checksum_address',token.checksum_address,
              'name',token.name,'symbol',token.symbol,'explorer_url',token.explorer_url,
              'proxy_status',token.proxy_status,'source_verification_status',token.source_verification_status,
              'risk_flags',token.risk_flags,'moderation_status',token.moderation_status
            )
          )
        else report end
        order by report->>'created_at' desc
      )
      from jsonb_array_elements(coalesce(prior.snapshot->'moderationReports','[]'::jsonb)) report
      left join public.tokens token
        on report->>'entity_type' = 'token' and token.id = (report->>'entity_id')::uuid
    ),'[]'::jsonb),
    true
  )
  from (select public.app_marketplace_snapshot_before_token_reports(p_actor_id) as snapshot) prior
$$;

revoke all on function public.app_require_visible_bounty_token()
from public, anon, authenticated, service_role;
revoke all on function public.app_marketplace_snapshot_before_token_reports(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.app_marketplace_snapshot(uuid)
from public, anon, authenticated;
revoke all on function public.app_report_content(uuid,text,uuid,text)
from public, anon, authenticated;
revoke all on function public.app_decide_content_report(uuid,uuid,text,text,text,integer)
from public, anon, authenticated;

grant execute on function public.app_marketplace_snapshot(uuid) to service_role;
grant execute on function public.app_report_content(uuid,text,uuid,text) to service_role;
grant execute on function public.app_decide_content_report(uuid,uuid,text,text,text,integer) to service_role;
