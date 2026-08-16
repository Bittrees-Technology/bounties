-- Paid token/source verification is a review service, not a safety report.
-- Keep both queue item types distinct and prevent verification completion from
-- changing token visibility.

alter table public.content_reports
  add column if not exists request_kind text not null default 'safety_report',
  add column if not exists verification_outcome text;

update public.content_reports report
set request_kind = 'verification_request',
    verification_outcome = case when report.status = 'open' then null else 'inconclusive' end
where report.entity_type = 'token'
  and report.reason like 'Token/source verification review%'
  and exists (
    select 1
    from public.paid_token_review_payments payment
    where payment.reporter_id = report.reporter_id
      and payment.token_id = report.entity_id
  );

alter table public.content_reports
  drop constraint if exists content_reports_reporter_id_entity_type_entity_id_key,
  drop constraint if exists content_reports_request_kind_check,
  drop constraint if exists content_reports_verification_outcome_check,
  drop constraint if exists content_reports_verification_shape_check;

alter table public.content_reports
  add constraint content_reports_request_kind_check
    check (request_kind in ('safety_report', 'verification_request')),
  add constraint content_reports_verification_outcome_check
    check (verification_outcome is null or verification_outcome in ('verified', 'source_verified', 'inconclusive', 'incompatible')),
  add constraint content_reports_verification_shape_check check (
    (request_kind = 'safety_report' and verification_outcome is null)
    or
    (request_kind = 'verification_request' and (
      (status = 'open' and verification_outcome is null)
      or (status in ('resolved', 'dismissed') and verification_outcome is not null)
    ))
  ),
  add constraint content_reports_actor_entity_kind_unique
    unique (reporter_id, entity_type, entity_id, request_kind);

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
    where report.reporter_id = p_actor_id
      and report.entity_type = p_entity_type
      and report.entity_id = p_entity_id
      and report.request_kind = 'safety_report'
    for update;

  if report_row.id is null then
    insert into public.content_reports (reporter_id, entity_type, entity_id, reason, request_kind)
    values (p_actor_id, p_entity_type, p_entity_id, btrim(p_reason), 'safety_report')
    returning * into report_row;
    next_event := 'submitted';
  else
    next_event := case when report_row.status = 'open' then 'updated' else 'reopened' end;
    update public.content_reports report set reason=btrim(p_reason), status='open', decision=null,
      moderator_response=null, internal_note=null, resolved_by=null, resolved_at=null,
      verification_outcome=null, version=report.version+1, created_at=now()
      where report.id=report_row.id returning * into report_row;
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

create or replace function public.app_report_paid_token_review(
  p_actor_id uuid,
  p_token_id uuid,
  p_reason text,
  p_payment_chain_id bigint,
  p_payment_tx_hash text,
  p_payment_token_address text,
  p_payment_amount_base_units text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  claimed public.paid_token_review_payments;
  existing public.paid_token_review_payments;
  report_row public.content_reports;
  next_event text;
begin
  if p_actor_id is null or not exists (select 1 from public.wallet_accounts where id = p_actor_id) then
    raise exception 'ACCOUNT_REQUIRED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.tokens where id = p_token_id) then
    raise exception 'CONTENT_NOT_FOUND' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not like 'Token/source verification review%'
    or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'INVALID_TOKEN_REVIEW_REASON' using errcode = '22023';
  end if;
  if p_payment_chain_id not in (1,11155111)
    or p_payment_tx_hash !~ '^0x[0-9a-f]{64}$'
    or p_payment_token_address !~ '^0x[0-9a-fA-F]{40}$'
    or p_payment_amount_base_units !~ '^[1-9][0-9]*$' then
    raise exception 'INVALID_TOKEN_REVIEW_PAYMENT' using errcode = '22023';
  end if;

  insert into public.paid_token_review_payments (
    reporter_id,token_id,payment_chain_id,payment_tx_hash,payment_token_address,payment_amount_base_units
  ) values (
    p_actor_id,p_token_id,p_payment_chain_id,lower(p_payment_tx_hash),p_payment_token_address,p_payment_amount_base_units::numeric
  ) on conflict (payment_chain_id,payment_tx_hash) do nothing
  returning * into claimed;

  if claimed.id is null then
    select * into existing from public.paid_token_review_payments payment
      where payment.payment_chain_id=p_payment_chain_id and payment.payment_tx_hash=lower(p_payment_tx_hash);
    if existing.reporter_id<>p_actor_id or existing.token_id<>p_token_id
      or lower(existing.payment_token_address)<>lower(p_payment_token_address)
      or existing.payment_amount_base_units<>p_payment_amount_base_units::numeric then
      raise exception 'TOKEN_REVIEW_PAYMENT_ALREADY_USED' using errcode = '23505';
    end if;
    select * into report_row from public.content_reports report
      where report.reporter_id=p_actor_id and report.entity_type='token'
        and report.entity_id=p_token_id and report.request_kind='verification_request';
    if report_row.id is null then raise exception 'TOKEN_REVIEW_PAYMENT_STATE_INVALID' using errcode='40001'; end if;
    return to_jsonb(report_row) - 'internal_note';
  end if;

  perform public.app_consume_rate_limit(p_actor_id, 'content_report', 10, 600);
  select * into report_row from public.content_reports report
    where report.reporter_id=p_actor_id and report.entity_type='token'
      and report.entity_id=p_token_id and report.request_kind='verification_request'
    for update;

  if report_row.id is null then
    insert into public.content_reports (reporter_id,entity_type,entity_id,reason,request_kind)
    values (p_actor_id,'token',p_token_id,btrim(p_reason),'verification_request')
    returning * into report_row;
    next_event := 'submitted';
  else
    next_event := case when report_row.status='open' then 'updated' else 'reopened' end;
    update public.content_reports report set reason=btrim(p_reason),status='open',decision=null,
      moderator_response=null,internal_note=null,resolved_by=null,resolved_at=null,
      verification_outcome=null,version=report.version+1,created_at=now()
      where report.id=report_row.id returning * into report_row;
  end if;

  insert into public.content_report_events (
    report_id,actor_id,event_type,report_version,reason,status,content_moderation_status
  ) values (
    report_row.id,p_actor_id,next_event,report_row.version,report_row.reason,report_row.status,
    (select moderation_status from public.tokens where id=report_row.entity_id)
  );
  return to_jsonb(report_row) - 'internal_note';
end $$;

alter function public.app_decide_content_report(uuid,uuid,text,text,text,integer)
  rename to app_decide_content_safety_report;

create function public.app_decide_content_report(
  p_actor_id uuid,p_report_id uuid,p_decision text,p_public_response text,
  p_internal_note text,p_expected_version integer
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare report_kind text; result jsonb;
begin
  select request_kind into report_kind from public.content_reports where id=p_report_id;
  if report_kind is null then raise exception 'REPORT_NOT_FOUND' using errcode='22023'; end if;
  if report_kind <> 'safety_report' then
    raise exception 'VERIFICATION_REQUEST_REQUIRES_VERIFICATION_OUTCOME' using errcode='22023';
  end if;
  select public.app_decide_content_safety_report(
    p_actor_id,p_report_id,p_decision,p_public_response,p_internal_note,p_expected_version
  ) into result;
  return result;
end $$;

create function public.app_complete_token_verification_request(
  p_actor_id uuid,p_report_id uuid,p_outcome text,p_public_response text,
  p_internal_note text,p_expected_version integer
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare report_row public.content_reports; current_status text; next_version integer;
begin
  if not public.app_is_moderation_staff(p_actor_id) then raise exception 'MODERATOR_REQUIRED' using errcode='42501'; end if;
  if p_report_id is null or p_outcome not in ('verified','source_verified','inconclusive','incompatible')
    or p_public_response is null or char_length(btrim(p_public_response)) not between 3 and 1000
    or (p_internal_note is not null and char_length(btrim(p_internal_note)) not between 1 and 2000)
    or p_expected_version is null or p_expected_version < 1 then
    raise exception 'INVALID_TOKEN_VERIFICATION_DECISION' using errcode='22023';
  end if;

  select * into report_row from public.content_reports report where report.id=p_report_id for update;
  if report_row.id is null then raise exception 'REPORT_NOT_FOUND' using errcode='22023'; end if;
  if report_row.request_kind <> 'verification_request' or report_row.entity_type <> 'token' then
    raise exception 'NOT_TOKEN_VERIFICATION_REQUEST' using errcode='22023';
  end if;
  if report_row.status <> 'open' then raise exception 'REPORT_ALREADY_DECIDED' using errcode='40001'; end if;
  if report_row.version <> p_expected_version then raise exception 'REPORT_VERSION_CONFLICT' using errcode='40001'; end if;
  select moderation_status into current_status from public.tokens where id=report_row.entity_id;
  if current_status is null then raise exception 'CONTENT_NOT_FOUND' using errcode='22023'; end if;

  next_version := report_row.version + 1;
  update public.content_reports report set status='resolved',decision='no_action',
    verification_outcome=p_outcome,moderator_response=btrim(p_public_response),
    internal_note=nullif(btrim(p_internal_note),''),resolved_by=p_actor_id,
    resolved_at=now(),version=next_version
    where report.id=report_row.id returning * into report_row;

  insert into public.content_report_events(
    report_id,actor_id,event_type,report_version,reason,status,decision,
    moderator_response,internal_note,content_moderation_status
  ) values (
    report_row.id,p_actor_id,'decided',next_version,report_row.reason,report_row.status,
    'no_action',btrim(p_public_response),nullif(btrim(p_internal_note),''),current_status
  );
  insert into public.notifications(recipient_id,type,entity_type,entity_id,body,dedupe_key)
    values(report_row.reporter_id,'token_verification_completed','report',report_row.id,
      'Your token/source verification request is complete. Open Bounties to view the outcome.',
      'token-verification:'||report_row.id::text||':'||next_version::text)
    on conflict(dedupe_key) do nothing;

  return jsonb_build_object(
    'report',to_jsonb(report_row)-'internal_note',
    'content',jsonb_build_object('entity_type','token','entity_id',report_row.entity_id,'moderation_status',current_status)
  );
end $$;

revoke all on function public.app_decide_content_safety_report(uuid,uuid,text,text,text,integer)
from public,anon,authenticated,service_role;
revoke all on function public.app_complete_token_verification_request(uuid,uuid,text,text,text,integer)
from public,anon,authenticated;
revoke all on function public.app_decide_content_report(uuid,uuid,text,text,text,integer)
from public,anon,authenticated;
revoke all on function public.app_report_content(uuid,text,uuid,text)
from public,anon,authenticated;
revoke all on function public.app_report_paid_token_review(uuid,uuid,text,bigint,text,text,text)
from public,anon,authenticated;

grant execute on function public.app_complete_token_verification_request(uuid,uuid,text,text,text,integer)
to service_role;
grant execute on function public.app_decide_content_report(uuid,uuid,text,text,text,integer)
to service_role;
grant execute on function public.app_report_content(uuid,text,uuid,text)
to service_role;
grant execute on function public.app_report_paid_token_review(uuid,uuid,text,bigint,text,text,text)
to service_role;
