-- Public wallet profiles are read through the server-owned API boundary. Rating
-- summaries remain derived solely from authorized, visible bilateral reviews:
-- buyers rate labor providers for service received, and labor providers rate
-- capital providers for payment received.

alter table public.wallet_accounts
  add column if not exists profile_bio text
    check (profile_bio is null or char_length(profile_bio) between 1 and 1000),
  add column if not exists profile_url text
    check (profile_url is null or (char_length(profile_url) <= 2048 and profile_url ~ '^https://')),
  add column if not exists profile_updated_at timestamptz not null default now(),
  add column if not exists profile_moderation_status text not null default 'visible'
    check (profile_moderation_status in ('visible', 'hidden')),
  add column if not exists profile_moderation_reason text
    check (profile_moderation_reason is null or char_length(profile_moderation_reason) between 3 and 500),
  add column if not exists profile_moderated_by uuid references public.wallet_accounts(id) on delete restrict,
  add column if not exists profile_moderated_at timestamptz;

alter table public.milestones
  add column if not exists delivery_deadline timestamptz;

alter table public.content_reports
  drop constraint if exists content_reports_entity_type_check;
alter table public.content_reports
  add constraint content_reports_entity_type_check check (entity_type in ('bounty', 'review', 'profile'));

alter table public.moderation_actions
  drop constraint if exists moderation_actions_entity_type_check;
alter table public.moderation_actions
  add constraint moderation_actions_entity_type_check check (entity_type in ('bounty', 'review', 'profile'));

create function public.app_validate_milestone_schedule()
returns trigger
language plpgsql set search_path = public as $$
declare
  schedule_count integer;
  invalid_count integer;
begin
  select count(*), count(*) filter (where position <> ordinal)
    into schedule_count, invalid_count
  from (
    select
      milestone.ordinal,
      row_number() over (order by milestone.ordinal) - 1 as position
    from public.milestones milestone
    where milestone.bounty_id = coalesce(new.bounty_id, old.bounty_id)
  ) ordered;
  if schedule_count not between 1 and 32 or invalid_count > 0 then
    raise exception 'INVALID_MILESTONE_SCHEDULE' using errcode = '23514';
  end if;
  if exists (
    select 1
    from (
      select
        milestone.delivery_deadline,
        lag(milestone.delivery_deadline) over (order by milestone.ordinal) as previous_deadline,
        bool_or(milestone.delivery_deadline is null) over (
          order by milestone.ordinal rows between unbounded preceding and 1 preceding
        ) as no_timeout_seen
      from public.milestones milestone
      where milestone.bounty_id = coalesce(new.bounty_id, old.bounty_id)
    ) ordered
    where ordered.delivery_deadline is not null
      and (coalesce(ordered.no_timeout_seen, false) or (
        ordered.previous_deadline is not null
        and ordered.delivery_deadline <= ordered.previous_deadline
      ))
  ) then
    raise exception 'INVALID_MILESTONE_DEADLINES' using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger milestones_validate_schedule
after insert or update or delete on public.milestones
deferrable initially deferred
for each row execute function public.app_validate_milestone_schedule();

create or replace function public.app_create_bounty(
  p_actor_id uuid,
  p_title text,
  p_description text,
  p_scope_source jsonb,
  p_scope_hash text,
  p_chain_id bigint,
  p_token_id uuid,
  p_budget_base_units text,
  p_milestones jsonb
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  token_row public.tokens;
  bounty_row public.bounties;
  milestone jsonb;
  milestone_total numeric(78,0) := 0;
  budget numeric(78,0);
  milestone_count integer;
  ordinal integer;
  deadline timestamptz;
  previous_deadline timestamptz;
  no_timeout_seen boolean := false;
begin
  if p_actor_id is null or not exists (select 1 from public.wallet_accounts where id = p_actor_id) then
    raise exception 'ACCOUNT_REQUIRED' using errcode = '42501';
  end if;
  select * into token_row from public.tokens where id = p_token_id and chain_id = p_chain_id;
  if not found or token_row.decimals is null then raise exception 'TOKEN_NOT_INSPECTED' using errcode = '22023'; end if;
  if p_budget_base_units is null or p_budget_base_units !~ '^[0-9]+$' then raise exception 'INVALID_BUDGET_BASE_UNITS' using errcode = '22023'; end if;
  budget := p_budget_base_units::numeric(78,0);
  if budget <= 0 or trunc(budget) <> budget then raise exception 'INVALID_BUDGET_BASE_UNITS' using errcode = '22023'; end if;
  if jsonb_typeof(coalesce(p_milestones, 'null'::jsonb)) <> 'array' then raise exception 'INVALID_MILESTONES' using errcode = '22023'; end if;
  milestone_count := jsonb_array_length(p_milestones);
  if milestone_count not between 1 and 32 then raise exception 'INVALID_MILESTONES' using errcode = '22023'; end if;

  ordinal := 0;
  for milestone in select * from jsonb_array_elements(p_milestones) loop
    if coalesce((milestone->>'ordinal')::integer, -1) <> ordinal
      or milestone->>'amount_base_units' is null
      or milestone->>'amount_base_units' !~ '^[0-9]+$'
      or (milestone->>'amount_base_units')::numeric(78,0) <= 0
      or char_length(btrim(coalesce(milestone->>'title', ''))) not between 1 and 160 then
      raise exception 'INVALID_MILESTONE_SCHEDULE' using errcode = '22023';
    end if;
    deadline := case when milestone->>'delivery_deadline' is null then null else (milestone->>'delivery_deadline')::timestamptz end;
    if deadline is null then
      no_timeout_seen := true;
    elsif no_timeout_seen or deadline <= now() or (previous_deadline is not null and deadline <= previous_deadline) then
      raise exception 'INVALID_MILESTONE_DEADLINES' using errcode = '22023';
    else
      previous_deadline := deadline;
    end if;
    milestone_total := milestone_total + (milestone->>'amount_base_units')::numeric(78,0);
    ordinal := ordinal + 1;
  end loop;
  if milestone_total <> budget then raise exception 'MILESTONE_TOTAL_MISMATCH' using errcode = '23514'; end if;

  insert into public.account_roles (account_id, role) values (p_actor_id, 'buyer') on conflict do nothing;
  insert into public.bounties (
    creator_id,title,description,scope_source,scope_hash,chain_id,token_id,token_decimals,budget_base_units,status
  ) values (
    p_actor_id,btrim(p_title),p_description,coalesce(p_scope_source,'{}'::jsonb),p_scope_hash,
    p_chain_id,p_token_id,token_row.decimals,budget,'open'
  ) returning * into bounty_row;

  for milestone in select * from jsonb_array_elements(p_milestones) loop
    insert into public.milestones (
      bounty_id,ordinal,title,amount_base_units,delivery_deadline,scope_source,evidence_requirements
    ) values (
      bounty_row.id,(milestone->>'ordinal')::integer,btrim(milestone->>'title'),
      (milestone->>'amount_base_units')::numeric(78,0),
      case when milestone->>'delivery_deadline' is null then null else (milestone->>'delivery_deadline')::timestamptz end,
      coalesce(milestone->'scope_source','{}'::jsonb),coalesce(milestone->'evidence_requirements','{}'::jsonb)
    );
  end loop;
  return public.app_bounty_json(bounty_row.id,p_actor_id);
end $$;

create function public.app_update_public_profile(
  p_actor_id uuid,
  p_display_name text,
  p_profile_bio text,
  p_profile_url text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare account_row public.wallet_accounts;
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

  update public.wallet_accounts account
     set display_name = case when p_display_name is null then null else btrim(p_display_name) end,
         profile_bio = case when p_profile_bio is null then null else btrim(p_profile_bio) end,
         profile_url = case when p_profile_url is null then null else btrim(p_profile_url) end,
         profile_updated_at = now()
   where account.id = p_actor_id
   returning * into account_row;

  return public.app_public_wallet_profile(account_row.wallet_address);
end $$;

create function public.app_public_wallet_profile(p_wallet_address text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'account_id', account.id,
    'wallet_address', account.wallet_address,
    'display_name', case when account.profile_moderation_status = 'visible' then account.display_name else null end,
    'profile_bio', case when account.profile_moderation_status = 'visible' then account.profile_bio else null end,
    'profile_url', case when account.profile_moderation_status = 'visible' then account.profile_url else null end,
    'profile_moderation_status', account.profile_moderation_status,
    'member_since', account.created_at,
    'roles', coalesce((
      select jsonb_agg(role.role order by role.role)
      from public.account_roles role
      where role.account_id = account.id
    ), '[]'::jsonb),
    'rating_summaries', jsonb_build_object(
      'capital_provider', (
        select jsonb_build_object(
          'average_rating', round(avg(review.rating)::numeric, 2),
          'review_count', count(*)::integer,
          'rating_counts', jsonb_build_object(
            '1', count(*) filter (where review.rating = 1),
            '2', count(*) filter (where review.rating = 2),
            '3', count(*) filter (where review.rating = 3),
            '4', count(*) filter (where review.rating = 4),
            '5', count(*) filter (where review.rating = 5)
          )
        )
        from public.participant_reviews review
        where review.subject_id = account.id
          and review.direction = 'payment_received'
          and review.moderation_status = 'visible'
      ),
      'labor_provider', (
        select jsonb_build_object(
          'average_rating', round(avg(review.rating)::numeric, 2),
          'review_count', count(*)::integer,
          'rating_counts', jsonb_build_object(
            '1', count(*) filter (where review.rating = 1),
            '2', count(*) filter (where review.rating = 2),
            '3', count(*) filter (where review.rating = 3),
            '4', count(*) filter (where review.rating = 4),
            '5', count(*) filter (where review.rating = 5)
          )
        )
        from public.participant_reviews review
        where review.subject_id = account.id
          and review.direction = 'service_received'
          and review.moderation_status = 'visible'
      )
    ),
    'reviews_received', coalesce((
      select jsonb_agg(to_jsonb(received_review) order by received_review.created_at desc)
      from (
        select
          review.id,
          review.bounty_id,
          author.wallet_address as author_wallet_address,
          review.direction,
          review.rating,
          review.body,
          review.created_at
        from public.participant_reviews review
        join public.wallet_accounts author on author.id = review.author_id
        where review.subject_id = account.id
          and review.moderation_status = 'visible'
        order by review.created_at desc
        limit 50
      ) received_review
    ), '[]'::jsonb)
  )
  from public.wallet_accounts account
  where account.wallet_address = public.app_normalize_wallet(p_wallet_address)
$$;

-- Preserve the established snapshot and replace only the moderator queue with
-- three-type report context. This keeps ordinary marketplace response semantics
-- stable while making profile reports actionable rather than ambiguous.
alter function public.app_marketplace_snapshot(uuid)
  rename to app_marketplace_snapshot_before_profiles;

create function public.app_marketplace_snapshot(p_actor_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_set(
    public.app_marketplace_snapshot_before_profiles(p_actor_id),
    '{moderationReports}',
    case when public.app_is_moderation_staff(p_actor_id) then coalesce((
      select jsonb_agg(
        (to_jsonb(report) - 'internal_note') || jsonb_build_object(
          'current_moderation_status', case report.entity_type
            when 'bounty' then (select bounty.moderation_status from public.bounties bounty where bounty.id = report.entity_id)
            when 'review' then (select review.moderation_status from public.participant_reviews review where review.id = report.entity_id)
            else (select account.profile_moderation_status from public.wallet_accounts account where account.id = report.entity_id)
          end,
          'entity_title', case report.entity_type
            when 'bounty' then (select bounty.title from public.bounties bounty where bounty.id = report.entity_id)
            when 'review' then (select 'Review on ' || bounty.title from public.participant_reviews review join public.bounties bounty on bounty.id = review.bounty_id where review.id = report.entity_id)
            else (select 'Profile ' || account.wallet_address from public.wallet_accounts account where account.id = report.entity_id)
          end,
          'content', case report.entity_type
            when 'bounty' then (
              select jsonb_build_object('type','bounty','id',bounty.id,'title',bounty.title,
                'description',bounty.description,'status',bounty.status,'creator_id',bounty.creator_id,
                'moderation_status',bounty.moderation_status)
              from public.bounties bounty where bounty.id = report.entity_id
            )
            when 'review' then (
              select jsonb_build_object('type','review','id',review.id,'bounty_id',review.bounty_id,
                'bounty_title',bounty.title,'author_id',review.author_id,'direction',review.direction,
                'rating',review.rating,'body',review.body,'moderation_status',review.moderation_status)
              from public.participant_reviews review join public.bounties bounty on bounty.id=review.bounty_id
              where review.id=report.entity_id
            )
            else (
              select jsonb_build_object('type','profile','id',account.id,'wallet_address',account.wallet_address,
                'display_name',account.display_name,'profile_bio',account.profile_bio,'profile_url',account.profile_url,
                'moderation_status',account.profile_moderation_status)
              from public.wallet_accounts account where account.id=report.entity_id
            )
          end
        ) order by report.created_at desc
      )
      from (
        select * from public.content_reports open_report
        where open_report.status='open' order by open_report.created_at desc limit 100
      ) report
    ), '[]'::jsonb) else '[]'::jsonb end,
    true
  )
$$;

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
    if p_decision in ('hide','restore') then update public.bounties set moderation_status=case p_decision when 'hide' then 'hidden' else 'visible' end,
      moderation_reason=case p_decision when 'hide' then left(btrim(p_public_response),500) else null end,
      moderated_by=p_actor_id,moderated_at=now() where id=report_row.entity_id returning moderation_status into current_status; end if;
  elsif report_row.entity_type='review' then
    select author_id,moderation_status into content_owner_id,current_status from public.participant_reviews where id=report_row.entity_id for update;
    if p_decision in ('hide','restore') then update public.participant_reviews set moderation_status=case p_decision when 'hide' then 'hidden' else 'visible' end,
      moderation_reason=case p_decision when 'hide' then left(btrim(p_public_response),500) else null end,
      moderated_by=p_actor_id,moderated_at=now() where id=report_row.entity_id returning moderation_status into current_status; end if;
  elsif report_row.entity_type='profile' then
    select id,profile_moderation_status into content_owner_id,current_status from public.wallet_accounts where id=report_row.entity_id for update;
    if p_decision in ('hide','restore') then update public.wallet_accounts set profile_moderation_status=case p_decision when 'hide' then 'hidden' else 'visible' end,
      profile_moderation_reason=case p_decision when 'hide' then left(btrim(p_public_response),500) else null end,
      profile_moderated_by=p_actor_id,profile_moderated_at=now() where id=report_row.entity_id returning profile_moderation_status into current_status; end if;
  else raise exception 'INVALID_CONTENT_TYPE' using errcode='22023'; end if;
  if content_owner_id is null then raise exception 'CONTENT_NOT_FOUND' using errcode='22023'; end if;
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
  if p_decision in ('hide','restore') and content_owner_id<>report_row.reporter_id then
    insert into public.notifications(recipient_id,type,entity_type,entity_id,body,dedupe_key)
      values(content_owner_id,'moderation_content_visibility',report_row.entity_type,report_row.entity_id,
      case p_decision when 'hide' then 'Your content was hidden from the Bounties marketplace after moderation review. Escrow and blockchain records are unchanged.' else 'Your content was restored to the Bounties marketplace after moderation review. Escrow and blockchain records are unchanged.' end,
      'moderation-report:'||report_row.id::text||':'||next_version::text||':owner') on conflict(dedupe_key) do nothing;
  end if;
  return jsonb_build_object('report',to_jsonb(report_row),'content',jsonb_build_object('entity_type',report_row.entity_type,'entity_id',report_row.entity_id,'moderation_status',current_status));
end $$;

revoke all on function
  public.app_update_public_profile(uuid,text,text,text),
  public.app_public_wallet_profile(text),
  public.app_validate_milestone_schedule(),
  public.app_marketplace_snapshot_before_profiles(uuid),
  public.app_marketplace_snapshot(uuid)
from public, anon, authenticated;

revoke all on function public.app_marketplace_snapshot_before_profiles(uuid)
from service_role;

grant execute on function
  public.app_update_public_profile(uuid,text,text,text),
  public.app_public_wallet_profile(text),
  public.app_marketplace_snapshot(uuid)
to service_role;
