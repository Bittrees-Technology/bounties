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
      else (select profile_moderation_status from public.wallet_accounts where id=report_row.entity_id)
    end
  );
  return to_jsonb(report_row) - 'internal_note';
end $$;
