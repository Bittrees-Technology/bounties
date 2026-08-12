-- Contract-compatible milestone dates. A complete first-delivery review,
-- revision period, and revised-delivery review can consume 21 days. Structured
-- schedules must therefore leave more than 21 days before the next deadline.

create table public.milestone_revision_requests (
  milestone_id uuid primary key references public.milestones(id) on delete cascade,
  requester_id uuid not null references public.wallet_accounts(id),
  reason text not null check (reason = btrim(reason) and char_length(reason) between 1 and 500),
  reason_hash text not null check (reason_hash ~ '^0x[0-9a-f]{64}$'),
  transaction_hash text not null check (transaction_hash ~ '^0x[0-9a-f]{64}$'),
  block_hash text not null check (block_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer not null check (log_index >= 0),
  created_at timestamptz not null default now()
);

alter table public.milestone_revision_requests enable row level security;
alter table public.milestone_revision_requests force row level security;

create policy milestone_revision_requests_read on public.milestone_revision_requests
for select using (true);

-- Returns only immutable chain binding data after proving that the signed-in
-- actor owns the bounty. Receipt and event verification remains server-side.
create function public.app_revision_request_context(p_actor_id uuid,p_milestone_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  milestone_row public.milestones;
  bounty_row public.bounties;
  escrow_row public.escrow_records;
  requester_wallet text;
begin
  select * into milestone_row from public.milestones where id=p_milestone_id;
  if not found then raise exception 'MILESTONE_NOT_FOUND' using errcode='22023'; end if;
  select * into bounty_row from public.bounties where id=milestone_row.bounty_id;
  if bounty_row.creator_id <> p_actor_id then raise exception 'BOUNTY_OWNER_REQUIRED' using errcode='42501'; end if;
  select * into escrow_row from public.escrow_records where bounty_id=milestone_row.bounty_id;
  if not found then raise exception 'ESCROW_OBSERVATION_REQUIRED' using errcode='22023'; end if;
  select wallet_address into requester_wallet from public.wallet_accounts where id=bounty_row.creator_id;
  return jsonb_build_object(
    'milestone_id',milestone_row.id,'bounty_id',bounty_row.id,'ordinal',milestone_row.ordinal,
    'chain_id',escrow_row.chain_id,'contract_address',escrow_row.contract_address,
    'onchain_bounty_id',escrow_row.onchain_bounty_id,'requester_wallet',requester_wallet
  );
end $$;

create function public.app_record_milestone_revision_request(
  p_actor_id uuid,
  p_milestone_id uuid,
  p_reason text,
  p_reason_hash text,
  p_transaction_hash text,
  p_block_hash text,
  p_log_index integer,
  p_onchain_state text,
  p_remaining_base_units text,
  p_review_deadline timestamptz,
  p_settlement_proposer text,
  p_proposed_provider_payout_base_units text,
  p_allocated_amount_base_units text,
  p_released_amount_base_units text,
  p_milestone_count integer,
  p_current_milestone integer,
  p_schedule_hash text,
  p_current_milestone_detail jsonb
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  milestone_row public.milestones;
  bounty_row public.bounties;
  escrow_row public.escrow_records;
  existing_row public.milestone_revision_requests;
begin
  select * into milestone_row from public.milestones where id = p_milestone_id for update;
  if not found then raise exception 'MILESTONE_NOT_FOUND' using errcode = '22023'; end if;
  select * into bounty_row from public.bounties where id = milestone_row.bounty_id;
  select * into escrow_row from public.escrow_records where bounty_id = milestone_row.bounty_id for update;
  if bounty_row.creator_id <> p_actor_id then raise exception 'BOUNTY_OWNER_REQUIRED' using errcode = '42501'; end if;
  if p_reason is null or p_reason <> btrim(p_reason) or char_length(p_reason) not between 1 and 500
    or lower(p_reason_hash) !~ '^0x[0-9a-f]{64}$'
    or coalesce(lower(p_transaction_hash), '') !~ '^0x[0-9a-f]{64}$'
    or coalesce(lower(p_block_hash), '') !~ '^0x[0-9a-f]{64}$'
    or p_log_index is null or p_log_index < 0 then
    raise exception 'INVALID_REVISION_REQUEST' using errcode = '22023';
  end if;

  -- The server calls this routine only after a successful, finalized receipt,
  -- exact escrow event, and receipt-block state have all been verified. Persist
  -- that post-transaction observation and the explanation atomically so a
  -- network failure cannot leave the explanation unrecordable after refresh.
  perform public.app_record_escrow_state(
    p_actor_id,milestone_row.bounty_id,p_onchain_state,p_remaining_base_units,p_review_deadline,
    p_settlement_proposer,p_proposed_provider_payout_base_units,p_allocated_amount_base_units,
    p_released_amount_base_units,p_milestone_count,p_current_milestone,p_schedule_hash,
    p_current_milestone_detail
  );
  select * into escrow_row from public.escrow_records where bounty_id=milestone_row.bounty_id for update;
  if escrow_row.current_milestone is distinct from milestone_row.ordinal
    or escrow_row.state_checked_at < now() - interval '2 minutes'
    or escrow_row.onchain_state <> 'ProviderAccepted'
    or escrow_row.current_milestone_detail->>'state' <> 'Pending'
    or coalesce((escrow_row.current_milestone_detail->>'revision_requested')::boolean, false) = false
    or escrow_row.current_milestone_detail->>'revision_reason_hash' <> lower(p_reason_hash) then
    raise exception 'CURRENT_MILESTONE_RECONCILIATION_REQUIRED' using errcode = '40001';
  end if;

  select * into existing_row from public.milestone_revision_requests where milestone_id = p_milestone_id;
  if found then
    if existing_row.requester_id = p_actor_id and existing_row.reason = p_reason
      and existing_row.reason_hash = lower(p_reason_hash)
      and existing_row.transaction_hash = lower(p_transaction_hash)
      and existing_row.block_hash = lower(p_block_hash)
      and existing_row.log_index = p_log_index then
      return to_jsonb(existing_row);
    end if;
    raise exception 'REVISION_ALREADY_RECORDED' using errcode = '23505';
  end if;

  insert into public.milestone_revision_requests(
    milestone_id,requester_id,reason,reason_hash,transaction_hash,block_hash,log_index
  ) values(
    p_milestone_id,p_actor_id,p_reason,lower(p_reason_hash),lower(p_transaction_hash),lower(p_block_hash),p_log_index
  )
  returning * into existing_row;

  if milestone_row.assigned_provider_id is not null then
    insert into public.notifications(recipient_id,type,entity_type,entity_id,body,dedupe_key)
    values(milestone_row.assigned_provider_id,'revision_requested','milestone',p_milestone_id,
      'A revision was requested for ' || milestone_row.title,'revision-requested:' || p_milestone_id::text)
    on conflict(dedupe_key) do nothing;
  end if;
  return to_jsonb(existing_row);
end $$;

with invalid_bounties as (
  select distinct milestone.bounty_id
  from (
    select bounty_id, ordinal, delivery_deadline,
      lag(delivery_deadline) over (partition by bounty_id order by ordinal) as previous_deadline
    from public.milestones
  ) milestone
  where milestone.delivery_deadline is null
    or (milestone.previous_deadline is not null
      and milestone.delivery_deadline <= milestone.previous_deadline + interval '21 days')
)
update public.bounties bounty
set escrow_schedule_status = 'requires_recreation'
where bounty.escrow_schedule_status = 'structured'
  and bounty.id in (select bounty_id from invalid_bounties);

create function public.app_enforce_structured_milestone_deadline()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  schedule_status text;
  previous_deadline timestamptz;
  next_deadline timestamptz;
begin
  select escrow_schedule_status into schedule_status
  from public.bounties where id = new.bounty_id;
  if schedule_status <> 'structured' then return new; end if;

  if new.delivery_deadline is null or new.delivery_deadline <= now() then
    raise exception 'INVALID_MILESTONE_DEADLINES' using errcode = '22023';
  end if;

  select delivery_deadline into previous_deadline
  from public.milestones
  where bounty_id = new.bounty_id and ordinal = new.ordinal - 1 and id <> new.id;
  if new.ordinal > 0 and (
    previous_deadline is null or new.delivery_deadline <= previous_deadline + interval '21 days'
  ) then
    raise exception 'INVALID_MILESTONE_DEADLINES' using errcode = '22023';
  end if;

  select delivery_deadline into next_deadline
  from public.milestones
  where bounty_id = new.bounty_id and ordinal = new.ordinal + 1 and id <> new.id;
  if next_deadline is not null and next_deadline <= new.delivery_deadline + interval '21 days' then
    raise exception 'INVALID_MILESTONE_DEADLINES' using errcode = '22023';
  end if;
  return new;
end $$;

create trigger milestones_lifecycle_safe_deadline
before insert or update of bounty_id, ordinal, delivery_deadline on public.milestones
for each row execute function public.app_enforce_structured_milestone_deadline();

revoke all on function public.app_enforce_structured_milestone_deadline() from public, anon, authenticated;

create or replace function public.app_bounty_json(p_bounty_id uuid,p_actor_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  select to_jsonb(b)||jsonb_build_object(
    'budget_base_units',b.budget_base_units::text,
    'token',to_jsonb(t)||jsonb_build_object('total_supply',case when t.total_supply is null then null else t.total_supply::text end),
    'milestones',coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object(
      'amount_base_units',m.amount_base_units::text,
      'evidence',coalesce((select jsonb_agg(to_jsonb(e) order by e.revision) from public.delivery_evidence e where e.milestone_id=m.id),'[]'::jsonb),
      'revision_request',(select to_jsonb(revision) from public.milestone_revision_requests revision where revision.milestone_id=m.id)
    ) order by m.ordinal) from public.milestones m where m.bounty_id=b.id),'[]'::jsonb),
    'proposals',coalesce((select jsonb_agg(to_jsonb(p)||jsonb_build_object('proposed_total_base_units',p.proposed_total_base_units::text,'provider_wallet_address',provider.wallet_address) order by p.created_at)
      from public.proposals p join public.wallet_accounts provider on provider.id=p.provider_id where p.bounty_id=b.id),'[]'::jsonb),
    'escrow',(select to_jsonb(er)||jsonb_build_object(
      'requested_base_units',er.requested_base_units::text,'received_base_units',er.received_base_units::text,
      'remaining_base_units',case when er.remaining_base_units is null then null else er.remaining_base_units::text end,
      'released_base_units',er.released_base_units::text,
      'allocated_amount_base_units',case when er.allocated_amount_base_units is null then null else er.allocated_amount_base_units::text end,
      'released_amount_base_units',case when er.released_amount_base_units is null then null else er.released_amount_base_units::text end,
      'current_milestone_detail',er.current_milestone_detail
    ) from public.escrow_records er where er.bounty_id=b.id),
    'reviews',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('author_wallet_address',author.wallet_address,'subject_wallet_address',subject.wallet_address) order by r.created_at)
      from public.participant_reviews r join public.wallet_accounts author on author.id=r.author_id join public.wallet_accounts subject on subject.id=r.subject_id
      where r.bounty_id=b.id and (r.moderation_status='visible' or r.author_id=p_actor_id or r.subject_id=p_actor_id or public.app_is_moderation_staff(p_actor_id))),'[]'::jsonb)
  ) from public.bounties b join public.tokens t on t.id=b.token_id where b.id=p_bounty_id and (
    (b.status<>'draft' and b.moderation_status='visible') or b.creator_id=p_actor_id or public.app_is_moderation_staff(p_actor_id)
    or exists(select 1 from public.proposals accepted where accepted.id=b.accepted_proposal_id and accepted.provider_id=p_actor_id))
$$;

revoke all on table public.milestone_revision_requests from public, anon, authenticated;
revoke all on function public.app_revision_request_context(uuid,uuid) from public, anon, authenticated;
revoke all on function public.app_record_milestone_revision_request(uuid,uuid,text,text,text,text,integer,text,text,timestamptz,text,text,text,text,integer,integer,text,jsonb) from public, anon, authenticated;
grant execute on function public.app_revision_request_context(uuid,uuid) to service_role;
grant execute on function public.app_record_milestone_revision_request(uuid,uuid,text,text,text,text,integer,text,text,timestamptz,text,text,text,text,integer,integer,text,jsonb) to service_role;
