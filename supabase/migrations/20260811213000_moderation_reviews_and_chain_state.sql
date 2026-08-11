-- App-only moderation, canonical escrow-state observations, and bilateral reviews.
-- None of these tables or functions can pause, redirect, release, refund, or otherwise
-- influence the permissionless BountyEscrow contract.

alter table public.bounties
  add column if not exists moderation_status text not null default 'visible'
    check (moderation_status in ('visible', 'hidden')),
  add column if not exists moderation_reason text check (moderation_reason is null or char_length(moderation_reason) between 3 and 500),
  add column if not exists moderated_by uuid references public.wallet_accounts(id) on delete restrict,
  add column if not exists moderated_at timestamptz;

alter table public.escrow_records
  add column if not exists onchain_state text
    check (onchain_state is null or onchain_state in ('Created', 'Funded', 'ProviderAccepted', 'Delivered', 'BuyerApproved', 'Released', 'Cancelled', 'Refunded', 'Settled')),
  add column if not exists remaining_base_units numeric(78,0)
    check (remaining_base_units is null or (remaining_base_units >= 0 and trunc(remaining_base_units) = remaining_base_units)),
  add column if not exists review_deadline timestamptz,
  add column if not exists settlement_proposer text
    check (settlement_proposer is null or settlement_proposer = public.app_normalize_wallet(settlement_proposer)),
  add column if not exists proposed_provider_payout_base_units numeric(78,0)
    check (proposed_provider_payout_base_units is null or (proposed_provider_payout_base_units >= 0 and trunc(proposed_provider_payout_base_units) = proposed_provider_payout_base_units)),
  add column if not exists state_checked_at timestamptz;

create table public.moderation_staff (
  account_id uuid primary key references public.wallet_accounts(id) on delete restrict,
  role text not null check (role in ('moderator', 'admin')),
  granted_at timestamptz not null default now(),
  granted_by text not null default 'operations' check (char_length(granted_by) between 3 and 120)
);

create table public.participant_reviews (
  id uuid primary key default gen_random_uuid(),
  bounty_id uuid not null references public.bounties(id) on delete restrict,
  author_id uuid not null references public.wallet_accounts(id) on delete restrict,
  subject_id uuid not null references public.wallet_accounts(id) on delete restrict,
  direction text not null check (direction in ('service_received', 'payment_received')),
  rating integer not null check (rating between 1 and 5),
  body text not null check (char_length(body) between 3 and 2000),
  moderation_status text not null default 'visible' check (moderation_status in ('visible', 'hidden')),
  moderation_reason text check (moderation_reason is null or char_length(moderation_reason) between 3 and 500),
  moderated_by uuid references public.wallet_accounts(id) on delete restrict,
  moderated_at timestamptz,
  created_at timestamptz not null default now(),
  check (author_id <> subject_id),
  unique (bounty_id, author_id)
);

create table public.content_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references public.wallet_accounts(id) on delete restrict,
  entity_type text not null check (entity_type in ('bounty', 'review')),
  entity_id uuid not null,
  reason text not null check (char_length(reason) between 3 and 500),
  status text not null default 'open' check (status in ('open', 'resolved', 'dismissed')),
  resolved_by uuid references public.wallet_accounts(id) on delete restrict,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (reporter_id, entity_type, entity_id)
);

create table public.moderation_actions (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.wallet_accounts(id) on delete restrict,
  entity_type text not null check (entity_type in ('bounty', 'review')),
  entity_id uuid not null,
  action text not null check (action in ('hide', 'restore')),
  reason text not null check (char_length(reason) between 3 and 500),
  created_at timestamptz not null default now()
);

alter table public.moderation_staff enable row level security;
alter table public.moderation_staff force row level security;
alter table public.participant_reviews enable row level security;
alter table public.participant_reviews force row level security;
alter table public.content_reports enable row level security;
alter table public.content_reports force row level security;
alter table public.moderation_actions enable row level security;
alter table public.moderation_actions force row level security;

drop policy if exists bounties_read on public.bounties;
create policy bounties_read on public.bounties for select using (
  (status <> 'draft' and moderation_status = 'visible') or creator_id = public.app_current_account_id()
);

drop policy if exists proposals_read on public.proposals;
create policy proposals_read on public.proposals for select using (
  provider_id = public.app_current_account_id()
  or exists (
    select 1 from public.bounties b
    where b.id = bounty_id
      and (b.moderation_status = 'visible' or b.creator_id = public.app_current_account_id())
  )
);

create policy participant_reviews_read on public.participant_reviews for select using (
  moderation_status = 'visible'
  or author_id = public.app_current_account_id()
  or subject_id = public.app_current_account_id()
);
create policy content_reports_self on public.content_reports for select using (reporter_id = public.app_current_account_id());
create policy content_reports_self_insert on public.content_reports for insert with check (reporter_id = public.app_current_account_id());

revoke all on public.moderation_staff, public.participant_reviews, public.content_reports, public.moderation_actions from anon, authenticated;

create function public.app_is_moderation_staff(p_actor_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.moderation_staff where account_id = p_actor_id)
$$;

create function public.app_block_hidden_bounty_proposals()
returns trigger
language plpgsql set search_path = public as $$
begin
  if exists (select 1 from public.bounties where id = new.bounty_id and moderation_status = 'hidden') then
    raise exception 'BOUNTY_HIDDEN' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists proposals_block_hidden_bounty on public.proposals;
create trigger proposals_block_hidden_bounty
before insert on public.proposals
for each row execute function public.app_block_hidden_bounty_proposals();

create function public.app_record_escrow_state(
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
  select p.provider_id into provider_id
    from public.proposals p where p.id = bounty_row.accepted_proposal_id;
  if p_actor_id <> bounty_row.creator_id and p_actor_id is distinct from provider_id then
    raise exception 'BOUNTY_PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;
  if p_onchain_state not in ('Created', 'Funded', 'ProviderAccepted', 'Delivered', 'BuyerApproved', 'Released', 'Cancelled', 'Refunded', 'Settled') then
    raise exception 'INVALID_ESCROW_STATE' using errcode = '22023';
  end if;

  update public.escrow_records
     set onchain_state = p_onchain_state,
         remaining_base_units = p_remaining_base_units::numeric(78,0),
         review_deadline = p_review_deadline,
         settlement_proposer = case when p_settlement_proposer is null then null else public.app_normalize_wallet(p_settlement_proposer) end,
         proposed_provider_payout_base_units = p_proposed_provider_payout_base_units::numeric(78,0),
         state_checked_at = now()
   where bounty_id = p_bounty_id
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

create function public.app_create_participant_review(
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
  select p.provider_id into provider_id from public.proposals p where p.id = bounty_row.accepted_proposal_id;
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
    or escrow_row.onchain_state is null
    or escrow_row.onchain_state not in ('Released', 'Settled')
    or escrow_row.state_checked_at is null
    or escrow_row.state_checked_at < now() - interval '10 minutes' then
    raise exception 'TERMINAL_ESCROW_VERIFICATION_REQUIRED' using errcode = '22023';
  end if;
  if p_rating < 1 or p_rating > 5 or char_length(btrim(p_body)) not between 3 and 2000 then
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

create function public.app_report_content(
  p_actor_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare report_row public.content_reports;
begin
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
  if char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'INVALID_REPORT_REASON' using errcode = '22023';
  end if;
  insert into public.content_reports (reporter_id, entity_type, entity_id, reason)
  values (p_actor_id, p_entity_type, p_entity_id, btrim(p_reason))
  on conflict (reporter_id, entity_type, entity_id) do update
    set reason = excluded.reason, status = 'open', resolved_by = null, resolved_at = null
  returning * into report_row;
  return to_jsonb(report_row);
end $$;

create function public.app_moderate_content(
  p_actor_id uuid,
  p_entity_type text,
  p_entity_id uuid,
  p_action text,
  p_reason text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare result_row jsonb;
begin
  if not public.app_is_moderation_staff(p_actor_id) then
    raise exception 'MODERATOR_REQUIRED' using errcode = '42501';
  end if;
  if p_action not in ('hide', 'restore') or char_length(btrim(p_reason)) not between 3 and 500 then
    raise exception 'INVALID_MODERATION_ACTION' using errcode = '22023';
  end if;

  if p_entity_type = 'bounty' then
    update public.bounties as moderated_bounty
       set moderation_status = case p_action when 'hide' then 'hidden' else 'visible' end,
           moderation_reason = case p_action when 'hide' then btrim(p_reason) else null end,
           moderated_by = p_actor_id,
           moderated_at = now()
     where id = p_entity_id
     returning to_jsonb(moderated_bounty.*) into result_row;
  elsif p_entity_type = 'review' then
    update public.participant_reviews as moderated_review
       set moderation_status = case p_action when 'hide' then 'hidden' else 'visible' end,
           moderation_reason = case p_action when 'hide' then btrim(p_reason) else null end,
           moderated_by = p_actor_id,
           moderated_at = now()
     where id = p_entity_id
     returning to_jsonb(moderated_review.*) into result_row;
  else
    raise exception 'INVALID_CONTENT_TYPE' using errcode = '22023';
  end if;
  if result_row is null then raise exception 'CONTENT_NOT_FOUND' using errcode = '22023'; end if;

  insert into public.moderation_actions (actor_id, entity_type, entity_id, action, reason)
  values (p_actor_id, p_entity_type, p_entity_id, p_action, btrim(p_reason));
  update public.content_reports
     set status = 'resolved', resolved_by = p_actor_id, resolved_at = now()
   where entity_type = p_entity_type and entity_id = p_entity_id and status = 'open';

  return result_row;
end $$;

create or replace function public.app_bounty_json(p_bounty_id uuid, p_actor_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select to_jsonb(b) ||
    jsonb_build_object(
      'budget_base_units', b.budget_base_units::text,
      'token', to_jsonb(t) || jsonb_build_object(
        'total_supply', case when t.total_supply is null then null else t.total_supply::text end
      ),
      'milestones', coalesce((
        select jsonb_agg(to_jsonb(m) || jsonb_build_object(
          'amount_base_units', m.amount_base_units::text,
          'evidence', coalesce((
            select jsonb_agg(to_jsonb(e) order by e.revision)
            from public.delivery_evidence e where e.milestone_id = m.id
          ), '[]'::jsonb)
        ) order by m.ordinal)
        from public.milestones m where m.bounty_id = b.id
      ), '[]'::jsonb),
      'proposals', coalesce((
        select jsonb_agg(to_jsonb(p) || jsonb_build_object(
          'proposed_total_base_units', p.proposed_total_base_units::text,
          'provider_wallet_address', provider.wallet_address
        ) order by p.created_at)
        from public.proposals p
        join public.wallet_accounts provider on provider.id = p.provider_id
        where p.bounty_id = b.id
      ), '[]'::jsonb),
      'escrow', (
        select to_jsonb(er) || jsonb_build_object(
          'requested_base_units', er.requested_base_units::text,
          'received_base_units', er.received_base_units::text,
          'remaining_base_units', case when er.remaining_base_units is null then null else er.remaining_base_units::text end,
          'proposed_provider_payout_base_units', case when er.proposed_provider_payout_base_units is null then null else er.proposed_provider_payout_base_units::text end
        ) from public.escrow_records er where er.bounty_id = b.id
      ),
      'reviews', coalesce((
        select jsonb_agg(to_jsonb(r) || jsonb_build_object(
          'author_wallet_address', author.wallet_address,
          'subject_wallet_address', subject.wallet_address
        ) order by r.created_at)
        from public.participant_reviews r
        join public.wallet_accounts author on author.id = r.author_id
        join public.wallet_accounts subject on subject.id = r.subject_id
        where r.bounty_id = b.id
          and (r.moderation_status = 'visible' or r.author_id = p_actor_id or r.subject_id = p_actor_id or public.app_is_moderation_staff(p_actor_id))
      ), '[]'::jsonb)
    )
  from public.bounties b
  join public.tokens t on t.id = b.token_id
  where b.id = p_bounty_id
    and (
      (b.status <> 'draft' and b.moderation_status = 'visible')
      or b.creator_id = p_actor_id
      or public.app_is_moderation_staff(p_actor_id)
      or exists (select 1 from public.proposals accepted where accepted.id = b.accepted_proposal_id and accepted.provider_id = p_actor_id)
    )
$$;

create or replace function public.app_marketplace_snapshot(p_actor_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'account', (
      select jsonb_build_object('id', id, 'wallet_address', wallet_address, 'display_name', display_name)
      from public.wallet_accounts where id = p_actor_id
    ),
    'roles', coalesce((select jsonb_agg(role order by role) from public.account_roles where account_id = p_actor_id), '[]'::jsonb),
    'staffRole', (select role from public.moderation_staff where account_id = p_actor_id),
    'tokens', coalesce((
      select jsonb_agg(to_jsonb(t) || jsonb_build_object(
        'total_supply', case when t.total_supply is null then null else t.total_supply::text end
      ) order by t.chain_id, t.contract_address) from public.tokens t
    ), '[]'::jsonb),
    'bounties', coalesce((
      select jsonb_agg(public.app_bounty_json(b.id, p_actor_id) order by b.created_at desc)
      from public.bounties b
      where (b.status <> 'draft' and b.moderation_status = 'visible')
        or b.creator_id = p_actor_id
        or public.app_is_moderation_staff(p_actor_id)
        or exists (select 1 from public.proposals accepted where accepted.id = b.accepted_proposal_id and accepted.provider_id = p_actor_id)
    ), '[]'::jsonb),
    'notifications', coalesce((
      select jsonb_agg(to_jsonb(n) order by n.created_at desc)
      from public.notifications n where n.recipient_id = p_actor_id
    ), '[]'::jsonb),
    'moderationReports', case when public.app_is_moderation_staff(p_actor_id) then coalesce((
      select jsonb_agg(to_jsonb(report) order by report.created_at desc)
      from public.content_reports report where report.status = 'open'
    ), '[]'::jsonb) else '[]'::jsonb end
  )
$$;

revoke all on function
  public.app_is_moderation_staff(uuid),
  public.app_record_escrow_state(uuid,uuid,text,text,timestamptz,text,text),
  public.app_create_participant_review(uuid,uuid,integer,text),
  public.app_report_content(uuid,text,uuid,text),
  public.app_moderate_content(uuid,text,uuid,text,text)
from public;

grant execute on function
  public.app_is_moderation_staff(uuid),
  public.app_record_escrow_state(uuid,uuid,text,text,timestamptz,text,text),
  public.app_create_participant_review(uuid,uuid,integer,text),
  public.app_report_content(uuid,text,uuid,text),
  public.app_moderate_content(uuid,text,uuid,text,text)
to service_role;

-- The browser uses only the same-origin Edge API. Removing direct table privileges prevents
-- hidden or draft marketplace content from being reconstructed through Supabase REST endpoints.
revoke all on public.wallet_accounts, public.account_roles, public.tokens, public.bounties,
  public.proposals, public.milestones, public.delivery_evidence, public.escrow_records,
  public.notifications, public.moderation_staff, public.participant_reviews,
  public.content_reports, public.moderation_actions, public.api_rate_limits
from anon, authenticated;

-- Staff rows are provisioned only through an operations-controlled service-role SQL
-- change after the target wallet account exists. No public/self-service grant exists.
