-- Report-scoped moderation decisions and a short-lived projection of the exact
-- shared Bittrees `moderator` role. Upstash remains an authorization source only;
-- Postgres remains authoritative for reports, visibility, notifications, and audit.

alter table public.moderation_staff
  add column if not exists source text not null default 'operations',
  add column if not exists source_version text,
  add column if not exists verified_at timestamptz,
  add column if not exists expires_at timestamptz;

alter table public.moderation_staff
  drop constraint if exists moderation_staff_source_check,
  drop constraint if exists moderation_staff_source_version_check,
  drop constraint if exists moderation_staff_freshness_check;

alter table public.moderation_staff
  add constraint moderation_staff_source_check
    check (source in ('operations', 'upstash')),
  add constraint moderation_staff_source_version_check
    check (source_version is null or char_length(source_version) between 1 and 160),
  add constraint moderation_staff_freshness_check check (
    (source = 'operations' and verified_at is null and expires_at is null)
    or
    (source = 'upstash'
      and role = 'moderator'
      and source_version is not null
      and verified_at is not null
      and expires_at is not null
      and expires_at > verified_at
      and expires_at <= verified_at + interval '5 minutes')
  );

alter table public.content_reports
  add column if not exists decision text,
  add column if not exists moderator_response text,
  add column if not exists internal_note text,
  add column if not exists version integer not null default 1;

alter table public.content_reports
  drop constraint if exists content_reports_decision_check,
  drop constraint if exists content_reports_moderator_response_check,
  drop constraint if exists content_reports_internal_note_check,
  drop constraint if exists content_reports_version_check,
  drop constraint if exists content_reports_resolution_shape_check;

-- Preserve resolutions made by the earlier visibility-only workflow so the new
-- resolution-shape constraint is safe on databases that already contain reports.
update public.content_reports report
set decision = case
      when report.status = 'dismissed' then 'no_action'
      else coalesce((
        select action.action
        from public.moderation_actions action
        where action.entity_type = report.entity_type
          and action.entity_id = report.entity_id
        order by action.created_at desc
        limit 1
      ), 'no_action')
    end,
    moderator_response = 'This report was reviewed before moderator responses were introduced.',
    resolved_by = coalesce(report.resolved_by, (
      select action.actor_id
      from public.moderation_actions action
      where action.entity_type = report.entity_type
        and action.entity_id = report.entity_id
      order by action.created_at desc
      limit 1
    ), report.reporter_id),
    resolved_at = coalesce(report.resolved_at, report.created_at)
where report.status in ('resolved', 'dismissed');

alter table public.content_reports
  add constraint content_reports_decision_check
    check (decision is null or decision in ('hide', 'restore', 'no_action')),
  add constraint content_reports_moderator_response_check
    check (moderator_response is null or char_length(moderator_response) between 3 and 1000),
  add constraint content_reports_internal_note_check
    check (internal_note is null or char_length(internal_note) between 1 and 2000),
  add constraint content_reports_version_check check (version > 0),
  add constraint content_reports_resolution_shape_check check (
    (status = 'open'
      and decision is null
      and moderator_response is null
      and internal_note is null
      and resolved_by is null
      and resolved_at is null)
    or
    (status in ('resolved', 'dismissed')
      and decision is not null
      and moderator_response is not null
      and resolved_by is not null
      and resolved_at is not null)
  );

alter table public.moderation_actions
  add column if not exists report_id uuid references public.content_reports(id) on delete restrict,
  add column if not exists report_version integer,
  add column if not exists moderator_response text,
  add column if not exists internal_note text;

alter table public.moderation_actions
  drop constraint if exists moderation_actions_action_check,
  drop constraint if exists moderation_actions_reason_check,
  drop constraint if exists moderation_actions_report_version_check,
  drop constraint if exists moderation_actions_moderator_response_check,
  drop constraint if exists moderation_actions_internal_note_check,
  add constraint moderation_actions_action_check check (action in ('hide', 'restore', 'no_action')),
  add constraint moderation_actions_reason_check check (char_length(reason) between 3 and 1000),
  add constraint moderation_actions_report_version_check check (report_version is null or report_version > 0),
  add constraint moderation_actions_moderator_response_check
    check (moderator_response is null or char_length(moderator_response) between 3 and 1000),
  add constraint moderation_actions_internal_note_check
    check (internal_note is null or char_length(internal_note) between 1 and 2000);

create unique index if not exists moderation_actions_report_version_unique
  on public.moderation_actions (report_id, report_version)
  where report_id is not null;

create table public.content_report_events (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.content_reports(id) on delete restrict,
  actor_id uuid not null references public.wallet_accounts(id) on delete restrict,
  event_type text not null check (event_type in ('submitted', 'updated', 'reopened', 'decided')),
  report_version integer not null check (report_version > 0),
  reason text not null check (char_length(reason) between 3 and 500),
  status text not null check (status in ('open', 'resolved', 'dismissed')),
  decision text check (decision is null or decision in ('hide', 'restore', 'no_action')),
  moderator_response text check (moderator_response is null or char_length(moderator_response) between 3 and 1000),
  internal_note text check (internal_note is null or char_length(internal_note) between 1 and 2000),
  content_moderation_status text check (content_moderation_status is null or content_moderation_status in ('visible', 'hidden')),
  created_at timestamptz not null default now(),
  unique (report_id, report_version)
);

alter table public.content_report_events enable row level security;
alter table public.content_report_events force row level security;

create table public.shared_moderation_grants (
  account_id uuid primary key references public.wallet_accounts(id) on delete restrict,
  source text not null check (source = 'upstash:bittrees:roles'),
  verified_at timestamptz not null,
  expires_at timestamptz not null,
  check (expires_at > verified_at and expires_at <= verified_at + interval '5 minutes')
);

alter table public.shared_moderation_grants enable row level security;
alter table public.shared_moderation_grants force row level security;

alter table public.api_rate_limits
  drop constraint if exists api_rate_limits_action_check,
  add constraint api_rate_limits_action_check
    check (action in ('token_inspection', 'content_report'));

create or replace function public.app_consume_rate_limit(
  p_actor_id uuid,
  p_action text,
  p_limit integer,
  p_window_seconds integer
)
returns void
language plpgsql security definer set search_path = public as $$
declare current_row public.api_rate_limits;
begin
  if p_actor_id is null
    or p_action not in ('token_inspection', 'content_report')
    or p_limit < 1
    or p_window_seconds < 1 then
    raise exception 'RATE_LIMIT_CONFIG_INVALID' using errcode = '22023';
  end if;

  insert into public.api_rate_limits (actor_id, action, window_started_at, request_count)
  values (p_actor_id, p_action, now(), 1)
  on conflict (actor_id, action) do update
    set window_started_at = case
          when public.api_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds) then now()
          else public.api_rate_limits.window_started_at
        end,
        request_count = case
          when public.api_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds) then 1
          else public.api_rate_limits.request_count + 1
        end
  returning * into current_row;

  if current_row.request_count > p_limit then
    raise exception 'RATE_LIMITED' using errcode = '22023';
  end if;
end $$;

insert into public.content_report_events (
  report_id, actor_id, event_type, report_version, reason, status, decision,
  moderator_response, internal_note, content_moderation_status, created_at
)
select
  report.id,
  coalesce(report.resolved_by, report.reporter_id),
  case when report.status = 'open' then 'submitted' else 'decided' end,
  report.version,
  report.reason,
  report.status,
  report.decision,
  report.moderator_response,
  report.internal_note,
  case
    when report.entity_type = 'bounty' then (select bounty.moderation_status from public.bounties bounty where bounty.id = report.entity_id)
    when report.entity_type = 'review' then (select review.moderation_status from public.participant_reviews review where review.id = report.entity_id)
    else null
  end,
  coalesce(report.resolved_at, report.created_at)
from public.content_reports report;

-- Operations roles and short-lived shared roles stay separate so synchronizing a
-- shared role can never overwrite or delete an operations-provisioned record.
create or replace function public.app_is_moderation_staff(p_actor_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.moderation_staff staff
    where staff.account_id = p_actor_id
      and staff.source = 'operations'
      and staff.role in ('moderator', 'admin')
  ) or exists (
    select 1
    from public.shared_moderation_grants shared
    where shared.account_id = p_actor_id
      and shared.verified_at <= now()
      and shared.expires_at > now()
  )
$$;

-- Called only after the server has resolved the authenticated wallet against the
-- read-only shared role registry. There is deliberately no role parameter and no
-- public/self-service grant: the only role this routine can project is moderator.
create function public.app_sync_shared_moderation_role(
  p_actor_id uuid,
  p_wallet_address text,
  p_authorized boolean,
  p_source text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  normalized_wallet text;
  result_row public.shared_moderation_grants;
begin
  normalized_wallet := public.app_normalize_wallet(p_wallet_address);
  if p_actor_id is null
    or normalized_wallet is null
    or not exists (
      select 1 from public.wallet_accounts account
      where account.id = p_actor_id and account.wallet_address = normalized_wallet
    ) then
    raise exception 'ACCOUNT_WALLET_MISMATCH' using errcode = '42501';
  end if;
  if p_authorized is null
    or p_source is null
    or btrim(p_source) <> 'upstash:bittrees:roles' then
    raise exception 'INVALID_ROLE_PROJECTION' using errcode = '22023';
  end if;

  if p_authorized then
    insert into public.shared_moderation_grants (account_id, source, verified_at, expires_at)
    values (p_actor_id, btrim(p_source), now(), now() + interval '5 minutes')
    on conflict (account_id) do update
      set source = excluded.source,
          verified_at = excluded.verified_at,
          expires_at = excluded.expires_at
    returning * into result_row;
  else
    delete from public.shared_moderation_grants shared
    where shared.account_id = p_actor_id;
    result_row := null;
  end if;

  return case when result_row.account_id is null then
    jsonb_build_object('account_id', p_actor_id, 'role', null, 'authorized', false)
  else
    jsonb_build_object(
      'account_id', result_row.account_id,
      'role', 'moderator',
      'authorized', true,
      'source', result_row.source,
      'verified_at', result_row.verified_at,
      'expires_at', result_row.expires_at
    )
  end;
end $$;

-- A repeated report keeps one current queue row while appending an immutable event.
-- Reopening clears the current decision fields, but the prior decision remains in
-- content_report_events and moderation_actions.
create or replace function public.app_report_content(
  p_actor_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  report_row public.content_reports;
  next_event text;
begin
  if p_actor_id is null or not exists (select 1 from public.wallet_accounts where id = p_actor_id) then
    raise exception 'ACCOUNT_REQUIRED' using errcode = '42501';
  end if;
  if p_entity_type = 'bounty' then
    if not exists (select 1 from public.bounties where id = p_entity_id) then
      raise exception 'CONTENT_NOT_FOUND' using errcode = '22023';
    end if;
  elsif p_entity_type = 'review' then
    if not exists (select 1 from public.participant_reviews where id = p_entity_id) then
      raise exception 'CONTENT_NOT_FOUND' using errcode = '22023';
    end if;
  else
    raise exception 'INVALID_CONTENT_TYPE' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'INVALID_REPORT_REASON' using errcode = '22023';
  end if;

  perform public.app_consume_rate_limit(p_actor_id, 'content_report', 10, 600);

  select * into report_row
  from public.content_reports report
  where report.reporter_id = p_actor_id
    and report.entity_type = p_entity_type
    and report.entity_id = p_entity_id
  for update;

  if report_row.id is null then
    insert into public.content_reports (reporter_id, entity_type, entity_id, reason)
    values (p_actor_id, p_entity_type, p_entity_id, btrim(p_reason))
    returning * into report_row;
    next_event := 'submitted';
  else
    next_event := case when report_row.status = 'open' then 'updated' else 'reopened' end;
    update public.content_reports report
       set reason = btrim(p_reason),
           status = 'open',
           decision = null,
           moderator_response = null,
           internal_note = null,
           resolved_by = null,
           resolved_at = null,
           version = report.version + 1,
           created_at = now()
     where report.id = report_row.id
     returning * into report_row;
  end if;

  insert into public.content_report_events (
    report_id, actor_id, event_type, report_version, reason, status, content_moderation_status
  ) values (
    report_row.id,
    p_actor_id,
    next_event,
    report_row.version,
    report_row.reason,
    report_row.status,
    case
      when report_row.entity_type = 'bounty' then (select bounty.moderation_status from public.bounties bounty where bounty.id = report_row.entity_id)
      else (select review.moderation_status from public.participant_reviews review where review.id = report_row.entity_id)
    end
  );

  return to_jsonb(report_row) - 'internal_note';
end $$;

create function public.app_decide_content_report(
  p_actor_id uuid,
  p_report_id uuid,
  p_decision text,
  p_public_response text,
  p_internal_note text,
  p_expected_version integer
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  report_row public.content_reports;
  content_owner_id uuid;
  current_moderation_status text;
  next_version integer;
begin
  if not public.app_is_moderation_staff(p_actor_id) then
    raise exception 'MODERATOR_REQUIRED' using errcode = '42501';
  end if;
  if p_report_id is null
    or p_decision is null
    or p_decision not in ('hide', 'restore', 'no_action')
    or p_public_response is null
    or char_length(btrim(p_public_response)) not between 3 and 1000
    or (p_internal_note is not null and char_length(btrim(p_internal_note)) not between 1 and 2000)
    or p_expected_version is null
    or p_expected_version < 1 then
    raise exception 'INVALID_REPORT_DECISION' using errcode = '22023';
  end if;

  select * into report_row
  from public.content_reports report
  where report.id = p_report_id
  for update;
  if report_row.id is null then
    raise exception 'REPORT_NOT_FOUND' using errcode = '22023';
  end if;
  if report_row.status <> 'open' then
    raise exception 'REPORT_ALREADY_DECIDED' using errcode = '40001';
  end if;
  if report_row.version <> p_expected_version then
    raise exception 'REPORT_VERSION_CONFLICT' using errcode = '40001';
  end if;

  if report_row.entity_type = 'bounty' then
    select bounty.creator_id, bounty.moderation_status
      into content_owner_id, current_moderation_status
    from public.bounties bounty
    where bounty.id = report_row.entity_id
    for update;
    if not found then raise exception 'CONTENT_NOT_FOUND' using errcode = '22023'; end if;

    if p_decision in ('hide', 'restore') then
      update public.bounties bounty
         set moderation_status = case p_decision when 'hide' then 'hidden' else 'visible' end,
             moderation_reason = case p_decision when 'hide' then left(btrim(p_public_response), 500) else null end,
             moderated_by = p_actor_id,
             moderated_at = now()
       where bounty.id = report_row.entity_id
       returning bounty.moderation_status into current_moderation_status;
    end if;
  elsif report_row.entity_type = 'review' then
    select review.author_id, review.moderation_status
      into content_owner_id, current_moderation_status
    from public.participant_reviews review
    where review.id = report_row.entity_id
    for update;
    if not found then raise exception 'CONTENT_NOT_FOUND' using errcode = '22023'; end if;

    if p_decision in ('hide', 'restore') then
      update public.participant_reviews review
         set moderation_status = case p_decision when 'hide' then 'hidden' else 'visible' end,
             moderation_reason = case p_decision when 'hide' then left(btrim(p_public_response), 500) else null end,
             moderated_by = p_actor_id,
             moderated_at = now()
       where review.id = report_row.entity_id
       returning review.moderation_status into current_moderation_status;
    end if;
  else
    raise exception 'INVALID_CONTENT_TYPE' using errcode = '22023';
  end if;

  next_version := report_row.version + 1;
  update public.content_reports report
     set status = case when p_decision = 'no_action' then 'dismissed' else 'resolved' end,
         decision = p_decision,
         moderator_response = btrim(p_public_response),
         internal_note = nullif(btrim(p_internal_note), ''),
         resolved_by = p_actor_id,
         resolved_at = now(),
         version = next_version
   where report.id = report_row.id
   returning * into report_row;

  insert into public.moderation_actions (
    actor_id, entity_type, entity_id, action, reason, report_id, report_version,
    moderator_response, internal_note
  ) values (
    p_actor_id, report_row.entity_type, report_row.entity_id, p_decision,
    btrim(p_public_response), report_row.id, next_version,
    btrim(p_public_response), nullif(btrim(p_internal_note), '')
  );

  insert into public.content_report_events (
    report_id, actor_id, event_type, report_version, reason, status, decision,
    moderator_response, internal_note, content_moderation_status
  ) values (
    report_row.id, p_actor_id, 'decided', next_version, report_row.reason,
    report_row.status, p_decision, btrim(p_public_response),
    nullif(btrim(p_internal_note), ''), current_moderation_status
  );

  insert into public.notifications (recipient_id, type, entity_type, entity_id, body, dedupe_key)
  values (
    report_row.reporter_id,
    'moderation_report_decision',
    'report',
    report_row.id,
    'Your content report has been reviewed. Open Bounties to view the moderator response.',
    'moderation-report:' || report_row.id::text || ':' || next_version::text || ':reporter'
  ) on conflict (dedupe_key) do nothing;

  if p_decision in ('hide', 'restore')
    and content_owner_id is not null
    and content_owner_id <> report_row.reporter_id then
    insert into public.notifications (recipient_id, type, entity_type, entity_id, body, dedupe_key)
    values (
      content_owner_id,
      'moderation_content_visibility',
      report_row.entity_type,
      report_row.entity_id,
      case p_decision
        when 'hide' then 'Your content was hidden from the Bounties marketplace after moderation review. Escrow and blockchain records are unchanged.'
        else 'Your content was restored to the Bounties marketplace after moderation review. Escrow and blockchain records are unchanged.'
      end,
      'moderation-report:' || report_row.id::text || ':' || next_version::text || ':owner'
    ) on conflict (dedupe_key) do nothing;
  end if;

  return jsonb_build_object(
    'report', to_jsonb(report_row),
    'content', jsonb_build_object(
      'entity_type', report_row.entity_type,
      'entity_id', report_row.entity_id,
      'moderation_status', current_moderation_status
    )
  );
end $$;

-- Open report objects include bounded, moderator-only context needed to make a
-- decision without exposing internal notes to ordinary marketplace users.
create or replace function public.app_marketplace_snapshot(p_actor_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'account', (
      select jsonb_build_object('id', id, 'wallet_address', wallet_address, 'display_name', display_name)
      from public.wallet_accounts where id = p_actor_id
    ),
    'roles', coalesce((select jsonb_agg(role order by role) from public.account_roles where account_id = p_actor_id), '[]'::jsonb),
    'staffRole', case
      when exists (
        select 1 from public.shared_moderation_grants shared
        where shared.account_id = p_actor_id
          and shared.verified_at <= now()
          and shared.expires_at > now()
      ) then 'moderator'
      when public.app_is_moderation_staff(p_actor_id)
        then (select role from public.moderation_staff where account_id = p_actor_id)
      else null
    end,
    'tokens', coalesce((
      select jsonb_agg(to_jsonb(token) || jsonb_build_object(
        'total_supply', case when token.total_supply is null then null else token.total_supply::text end
      ) order by token.chain_id, token.contract_address) from public.tokens token
    ), '[]'::jsonb),
    'bounties', coalesce((
      select jsonb_agg(public.app_bounty_json(bounty.id, p_actor_id) order by bounty.created_at desc)
      from public.bounties bounty
      where (bounty.status <> 'draft' and bounty.moderation_status = 'visible')
        or bounty.creator_id = p_actor_id
        or public.app_is_moderation_staff(p_actor_id)
        or exists (
          select 1 from public.proposals accepted
          where accepted.id = bounty.accepted_proposal_id and accepted.provider_id = p_actor_id
        )
    ), '[]'::jsonb),
    'notifications', coalesce((
      select jsonb_agg(to_jsonb(notification) order by notification.created_at desc)
      from public.notifications notification where notification.recipient_id = p_actor_id
    ), '[]'::jsonb),
    'myReports', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', report.id,
          'entity_type', report.entity_type,
          'entity_id', report.entity_id,
          'reason', report.reason,
          'status', report.status,
          'decision', report.decision,
          'moderator_response', report.moderator_response,
          'version', report.version,
          'resolved_at', report.resolved_at,
          'created_at', report.created_at
        ) order by report.created_at desc
      )
      from (
        select * from public.content_reports mine
        where mine.reporter_id = p_actor_id
        order by mine.created_at desc
        limit 100
      ) report
    ), '[]'::jsonb),
    'moderationReports', case when public.app_is_moderation_staff(p_actor_id) then coalesce((
      select jsonb_agg(
        to_jsonb(report)
        || jsonb_build_object(
          'current_moderation_status', case
            when report.entity_type = 'bounty' then (select bounty.moderation_status from public.bounties bounty where bounty.id = report.entity_id)
            else (select review.moderation_status from public.participant_reviews review where review.id = report.entity_id)
          end,
          'entity_title', case
            when report.entity_type = 'bounty' then (select bounty.title from public.bounties bounty where bounty.id = report.entity_id)
            else (select 'Review on ' || bounty.title from public.participant_reviews review join public.bounties bounty on bounty.id = review.bounty_id where review.id = report.entity_id)
          end,
          'content', case
            when report.entity_type = 'bounty' then (
              select jsonb_build_object(
                'type', 'bounty',
                'id', bounty.id,
                'title', bounty.title,
                'description', bounty.description,
                'status', bounty.status,
                'creator_id', bounty.creator_id,
                'moderation_status', bounty.moderation_status
              ) from public.bounties bounty where bounty.id = report.entity_id
            )
            else (
              select jsonb_build_object(
                'type', 'review',
                'id', review.id,
                'bounty_id', review.bounty_id,
                'bounty_title', bounty.title,
                'author_id', review.author_id,
                'direction', review.direction,
                'rating', review.rating,
                'body', review.body,
                'moderation_status', review.moderation_status
              ) from public.participant_reviews review
              join public.bounties bounty on bounty.id = review.bounty_id
              where review.id = report.entity_id
            )
          end
        ) order by report.created_at desc
      )
      from (
        select * from public.content_reports open_report
        where open_report.status = 'open'
        order by open_report.created_at desc
        limit 100
      ) report
    ), '[]'::jsonb) else '[]'::jsonb end
  )
$$;

-- NULL is never an admissible canonical state. Mutable chain observations may be
-- refreshed, but the verified escrow identity/binding remains immutable below.
create or replace function public.app_record_escrow_state(
  p_actor_id uuid,
  p_bounty_id uuid,
  p_onchain_state text,
  p_remaining_base_units text,
  p_review_deadline timestamptz,
  p_settlement_proposer text,
  p_proposed_provider_payout_base_units text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  bounty_row public.bounties;
  provider_id uuid;
  escrow_row public.escrow_records;
begin
  select * into bounty_row from public.bounties where id = p_bounty_id;
  if not found then raise exception 'BOUNTY_NOT_FOUND' using errcode = '22023'; end if;
  select proposal.provider_id into provider_id
    from public.proposals proposal where proposal.id = bounty_row.accepted_proposal_id;
  if p_actor_id <> bounty_row.creator_id and p_actor_id is distinct from provider_id then
    raise exception 'BOUNTY_PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;
  if p_onchain_state is null
    or p_onchain_state not in ('Created', 'Funded', 'ProviderAccepted', 'Delivered', 'BuyerApproved', 'Released', 'Cancelled', 'Refunded', 'Settled')
    or p_remaining_base_units is null
    or p_remaining_base_units !~ '^[0-9]+$'
    or p_proposed_provider_payout_base_units is null
    or p_proposed_provider_payout_base_units !~ '^[0-9]+$'
    or (p_settlement_proposer is not null and public.app_normalize_wallet(p_settlement_proposer) is null) then
    raise exception 'INVALID_ESCROW_STATE' using errcode = '22023';
  end if;

  update public.escrow_records record
     set onchain_state = p_onchain_state,
         remaining_base_units = p_remaining_base_units::numeric(78,0),
         review_deadline = p_review_deadline,
         settlement_proposer = case when p_settlement_proposer is null then null else public.app_normalize_wallet(p_settlement_proposer) end,
         proposed_provider_payout_base_units = p_proposed_provider_payout_base_units::numeric(78,0),
         state_checked_at = now()
   where record.bounty_id = p_bounty_id
   returning * into escrow_row;
  if not found then raise exception 'ESCROW_OBSERVATION_REQUIRED' using errcode = '22023'; end if;

  return to_jsonb(escrow_row)
    || jsonb_build_object(
      'requested_base_units', escrow_row.requested_base_units::text,
      'received_base_units', escrow_row.received_base_units::text,
      'remaining_base_units', escrow_row.remaining_base_units::text,
      'proposed_provider_payout_base_units', escrow_row.proposed_provider_payout_base_units::text
    );
end $$;

create or replace function public.app_create_participant_review(
  p_actor_id uuid,
  p_bounty_id uuid,
  p_rating integer,
  p_body text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  bounty_row public.bounties;
  provider_id uuid;
  subject_id uuid;
  review_direction text;
  escrow_row public.escrow_records;
  review_row public.participant_reviews;
begin
  select * into bounty_row from public.bounties where id = p_bounty_id;
  if not found or bounty_row.accepted_proposal_id is null then
    raise exception 'ACCEPTED_PROPOSAL_REQUIRED' using errcode = '22023';
  end if;
  select proposal.provider_id into provider_id
    from public.proposals proposal where proposal.id = bounty_row.accepted_proposal_id;
  if p_actor_id = bounty_row.creator_id then
    subject_id := provider_id;
    review_direction := 'service_received';
  elsif p_actor_id = provider_id then
    subject_id := bounty_row.creator_id;
    review_direction := 'payment_received';
  else
    raise exception 'BOUNTY_PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;

  select * into escrow_row from public.escrow_records where bounty_id = p_bounty_id;
  if not found
    or not coalesce(escrow_row.onchain_state in ('Released', 'Settled'), false)
    or escrow_row.state_checked_at is null
    or escrow_row.state_checked_at < now() - interval '10 minutes' then
    raise exception 'TERMINAL_ESCROW_VERIFICATION_REQUIRED' using errcode = '22023';
  end if;
  if p_rating is null
    or p_rating < 1
    or p_rating > 5
    or p_body is null
    or char_length(btrim(p_body)) not between 3 and 2000 then
    raise exception 'INVALID_REVIEW' using errcode = '22023';
  end if;

  insert into public.participant_reviews (bounty_id, author_id, subject_id, direction, rating, body)
  values (p_bounty_id, p_actor_id, subject_id, review_direction, p_rating, btrim(p_body))
  returning * into review_row;

  insert into public.notifications (recipient_id, type, entity_type, entity_id, body, dedupe_key)
  values (subject_id, 'participant_review', 'bounty', p_bounty_id, 'A participant left a review', 'participant-review:' || review_row.id::text)
  on conflict (dedupe_key) do nothing;

  return to_jsonb(review_row);
end $$;

create function public.app_reject_escrow_binding_change()
returns trigger
language plpgsql set search_path = public as $$
begin
  if new.bounty_id is distinct from old.bounty_id
    or new.chain_id is distinct from old.chain_id
    or new.token_id is distinct from old.token_id
    or new.contract_address is distinct from old.contract_address
    or new.interface_version is distinct from old.interface_version
    or new.onchain_bounty_id is distinct from old.onchain_bounty_id
    or new.requested_base_units is distinct from old.requested_base_units
    or new.received_base_units is distinct from old.received_base_units
    or new.transaction_hash is distinct from old.transaction_hash
    or new.block_hash is distinct from old.block_hash
    or new.log_index is distinct from old.log_index then
    raise exception 'ESCROW_BINDING_IMMUTABLE' using errcode = '23505';
  end if;
  return new;
end $$;

drop trigger if exists escrow_records_binding_immutable on public.escrow_records;
create trigger escrow_records_binding_immutable
before update on public.escrow_records
for each row execute function public.app_reject_escrow_binding_change();

create function public.app_reject_audit_log_mutation()
returns trigger
language plpgsql set search_path = public as $$
begin
  raise exception 'AUDIT_LOG_IMMUTABLE' using errcode = '42501';
end $$;

drop trigger if exists content_report_events_immutable on public.content_report_events;
create trigger content_report_events_immutable
before update or delete on public.content_report_events
for each row execute function public.app_reject_audit_log_mutation();

drop trigger if exists moderation_actions_immutable on public.moderation_actions;
create trigger moderation_actions_immutable
before update or delete on public.moderation_actions
for each row execute function public.app_reject_audit_log_mutation();

-- Browser and PostgREST roles cannot reach moderation base tables. The server
-- receives only EXECUTE on narrowly scoped SECURITY DEFINER routines.
revoke all on public.moderation_staff, public.shared_moderation_grants,
  public.participant_reviews, public.content_reports,
  public.content_report_events, public.moderation_actions, public.escrow_records
from public, anon, authenticated;

-- These records are mutated only through SECURITY DEFINER RPCs. The service role
-- may execute the RPCs but cannot bypass authorization, concurrency, or immutable
-- escrow-binding checks through direct PostgREST table operations.
revoke all on public.moderation_staff, public.shared_moderation_grants,
  public.content_reports, public.content_report_events, public.moderation_actions,
  public.escrow_records
from service_role;

revoke all on function
  public.app_sync_shared_moderation_role(uuid,text,boolean,text),
  public.app_decide_content_report(uuid,uuid,text,text,text,integer),
  public.app_reject_escrow_binding_change(),
  public.app_reject_audit_log_mutation()
from public, anon, authenticated;

revoke execute on function public.app_moderate_content(uuid,text,uuid,text,text) from service_role;

grant execute on function
  public.app_sync_shared_moderation_role(uuid,text,boolean,text),
  public.app_decide_content_report(uuid,uuid,text,text,text,integer)
to service_role;
