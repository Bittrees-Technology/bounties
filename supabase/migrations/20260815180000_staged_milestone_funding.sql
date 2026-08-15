-- Sequential milestone funding for the immutable staged-funding escrow release.
-- The database remains descriptive: only canonical contract state moves funds.

alter table public.escrow_records
  drop constraint if exists escrow_records_onchain_state_check;

alter table public.escrow_records
  add constraint escrow_records_onchain_state_check check (
    onchain_state is null or onchain_state in (
      'Created','Funded','ProviderAccepted','Delivered','BuyerApproved','Released',
      'Cancelled','Refunded','Settled','AwaitingFunding','PartiallyCompleted'
    )
  );

create or replace function public.app_record_escrow_observation(
  p_actor_id uuid,
  p_bounty_id uuid,
  p_contract_address text,
  p_interface_version text,
  p_onchain_bounty_id text,
  p_requested_base_units text,
  p_received_base_units text,
  p_status text,
  p_transaction_hash text,
  p_block_hash text,
  p_log_index integer,
  p_onchain_state text,
  p_remaining_base_units text,
  p_allocated_amount_base_units text,
  p_released_amount_base_units text,
  p_milestone_count integer,
  p_current_milestone integer,
  p_schedule_hash text,
  p_terms_hash text,
  p_current_milestone_detail jsonb
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  bounty_row public.bounties;
  escrow_row public.escrow_records;
  existing_row public.escrow_records;
  normalized_contract text;
  received numeric(78,0);
begin
  select * into bounty_row from public.bounties where id = p_bounty_id for update;
  if not found or bounty_row.creator_id <> p_actor_id then raise exception 'BOUNTY_OWNER_REQUIRED' using errcode = '42501'; end if;
  if bounty_row.escrow_schedule_status <> 'structured' then raise exception 'BOUNTY_RECREATION_REQUIRED' using errcode = '22023'; end if;
  normalized_contract := public.app_normalize_wallet(p_contract_address);
  if normalized_contract is null then raise exception 'INVALID_ESCROW_CONTRACT' using errcode = '22023'; end if;
  if p_transaction_hash !~ '^0x[0-9a-fA-F]{64}$' or p_block_hash !~ '^0x[0-9a-fA-F]{64}$' or p_log_index < 0 then
    raise exception 'INVALID_ESCROW_RECEIPT' using errcode = '22023';
  end if;
  if p_schedule_hash !~ '^0x[0-9a-fA-F]{64}$' or p_terms_hash !~ '^0x[0-9a-fA-F]{64}$'
    or p_requested_base_units !~ '^[0-9]+$' or p_received_base_units !~ '^[0-9]+$'
    or p_allocated_amount_base_units !~ '^[0-9]+$' or p_released_amount_base_units !~ '^[0-9]+$'
    or p_remaining_base_units !~ '^[0-9]+$' then
    raise exception 'INVALID_ESCROW_SCHEDULE' using errcode = '22023';
  end if;
  received := p_received_base_units::numeric(78,0);
  perform public.app_validate_canonical_milestone_observation(p_milestone_count, p_current_milestone, p_current_milestone_detail);
  if p_milestone_count <> (select count(*) from public.milestones where bounty_id=p_bounty_id)
    or p_allocated_amount_base_units::numeric(78,0) <> (select sum(amount_base_units) from public.milestones where bounty_id=p_bounty_id)
    or (p_current_milestone_detail->>'amount_base_units')::numeric(78,0) <> (
      select amount_base_units from public.milestones where bounty_id=p_bounty_id and ordinal=p_current_milestone)
    or coalesce(extract(epoch from (p_current_milestone_detail->>'delivery_deadline')::timestamptz)::bigint,0) <> coalesce((
      select extract(epoch from delivery_deadline)::bigint from public.milestones where bounty_id=p_bounty_id and ordinal=p_current_milestone),0)
  then raise exception 'ESCROW_MILESTONE_MISMATCH' using errcode = '23514'; end if;
  if p_requested_base_units::numeric(78,0) <> received
    or p_remaining_base_units::numeric(78,0) <> received
    or received <= 0
    or (coalesce(bounty_row.scope_source->>'milestoneFundingMode','full') <> 'staged'
      and received <> bounty_row.budget_base_units)
    or not exists (
      select 1 from (
        select sum(amount_base_units) over (order by ordinal) as prefix_amount
        from public.milestones where bounty_id=p_bounty_id
      ) prefixes where prefixes.prefix_amount=received
    ) then
    raise exception 'ESCROW_FUNDING_PREFIX_MISMATCH' using errcode = '23514';
  end if;

  select * into existing_row from public.escrow_records where bounty_id = p_bounty_id for update;
  if found then
    if existing_row.chain_id <> bounty_row.chain_id
      or existing_row.contract_address is distinct from normalized_contract
      or existing_row.onchain_bounty_id is distinct from p_onchain_bounty_id
      or existing_row.transaction_hash is distinct from lower(p_transaction_hash)
      or existing_row.block_hash is distinct from lower(p_block_hash)
      or existing_row.log_index is distinct from p_log_index
      or existing_row.schedule_hash is distinct from lower(p_schedule_hash)
      or existing_row.terms_hash is distinct from lower(p_terms_hash)
      or existing_row.milestone_count is distinct from p_milestone_count
      or existing_row.allocated_amount_base_units is distinct from p_allocated_amount_base_units::numeric(78,0) then
      raise exception 'ESCROW_BINDING_IMMUTABLE' using errcode = '23505';
    end if;
    return to_jsonb(existing_row);
  end if;

  insert into public.escrow_records (
    bounty_id,chain_id,token_id,contract_address,interface_version,onchain_bounty_id,
    requested_base_units,received_base_units,released_base_units,status,transaction_hash,block_hash,log_index,
    onchain_state,remaining_base_units,allocated_amount_base_units,released_amount_base_units,
    milestone_count,current_milestone,schedule_hash,terms_hash,current_milestone_detail,state_checked_at
  ) values (
    p_bounty_id,bounty_row.chain_id,bounty_row.token_id,normalized_contract,coalesce(p_interface_version,'escrow-adapter.v2'),p_onchain_bounty_id,
    p_requested_base_units::numeric(78,0),received,p_released_amount_base_units::numeric(78,0),
    coalesce(p_status,'confirmed')::public.escrow_status,lower(p_transaction_hash),lower(p_block_hash),p_log_index,
    p_onchain_state,p_remaining_base_units::numeric(78,0),p_allocated_amount_base_units::numeric(78,0),
    p_released_amount_base_units::numeric(78,0),p_milestone_count,p_current_milestone,lower(p_schedule_hash),lower(p_terms_hash),
    p_current_milestone_detail,now()
  ) returning * into escrow_row;

  update public.bounties set status = 'funded'
  where id = p_bounty_id and status in ('accepted','funding_pending','funded');
  if not found then raise exception 'BOUNTY_NOT_READY_FOR_FUNDING' using errcode = '22023'; end if;
  update public.milestones milestone set status = 'funded'
  where milestone.bounty_id = p_bounty_id and milestone.status = 'assigned'
    and (select sum(prior.amount_base_units) from public.milestones prior
      where prior.bounty_id=p_bounty_id and prior.ordinal <= milestone.ordinal) <= received;
  return to_jsonb(escrow_row);
end $$;

create or replace function public.app_record_escrow_state(
  p_actor_id uuid,
  p_bounty_id uuid,
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
  bounty_row public.bounties;
  provider_id uuid;
  escrow_row public.escrow_records;
  milestone_state text;
begin
  select * into bounty_row from public.bounties where id = p_bounty_id for update;
  if not found then raise exception 'BOUNTY_NOT_FOUND' using errcode = '22023'; end if;
  select proposal.provider_id into provider_id from public.proposals proposal where proposal.id = bounty_row.accepted_proposal_id;
  if p_actor_id <> bounty_row.creator_id and p_actor_id is distinct from provider_id then
    raise exception 'BOUNTY_PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;
  if p_onchain_state not in ('Created','Funded','ProviderAccepted','Delivered','BuyerApproved','Released','Cancelled','Refunded','Settled','AwaitingFunding','PartiallyCompleted')
    or p_remaining_base_units !~ '^[0-9]+$' or p_proposed_provider_payout_base_units !~ '^[0-9]+$'
    or p_allocated_amount_base_units !~ '^[0-9]+$' or p_released_amount_base_units !~ '^[0-9]+$'
    or p_schedule_hash !~ '^0x[0-9a-fA-F]{64}$' then
    raise exception 'INVALID_ESCROW_STATE' using errcode = '22023';
  end if;
  perform public.app_validate_canonical_milestone_observation(p_milestone_count, p_current_milestone, p_current_milestone_detail);

  select * into escrow_row from public.escrow_records record where record.bounty_id = p_bounty_id for update;
  if not found then raise exception 'ESCROW_OBSERVATION_REQUIRED' using errcode = '22023'; end if;
  if escrow_row.schedule_hash is distinct from lower(p_schedule_hash)
    or escrow_row.milestone_count is distinct from p_milestone_count
    or escrow_row.allocated_amount_base_units is distinct from p_allocated_amount_base_units::numeric(78,0) then
    raise exception 'ESCROW_SCHEDULE_MISMATCH' using errcode = '23514';
  end if;
  if p_milestone_count <> (select count(*) from public.milestones where bounty_id=p_bounty_id)
    or p_allocated_amount_base_units::numeric(78,0) <> (select sum(amount_base_units) from public.milestones where bounty_id=p_bounty_id)
    or (p_current_milestone_detail->>'amount_base_units')::numeric(78,0) <> (
      select amount_base_units from public.milestones where bounty_id=p_bounty_id and ordinal=p_current_milestone)
    or coalesce(extract(epoch from (p_current_milestone_detail->>'delivery_deadline')::timestamptz)::bigint,0) <> coalesce((
      select extract(epoch from delivery_deadline)::bigint from public.milestones where bounty_id=p_bounty_id and ordinal=p_current_milestone),0)
  then raise exception 'ESCROW_MILESTONE_MISMATCH' using errcode = '23514'; end if;

  update public.escrow_records record
  set onchain_state=p_onchain_state,
      remaining_base_units=p_remaining_base_units::numeric(78,0),
      review_deadline=p_review_deadline,
      settlement_proposer=case when p_settlement_proposer is null then null else public.app_normalize_wallet(p_settlement_proposer) end,
      proposed_provider_payout_base_units=p_proposed_provider_payout_base_units::numeric(78,0),
      allocated_amount_base_units=p_allocated_amount_base_units::numeric(78,0),
      released_amount_base_units=p_released_amount_base_units::numeric(78,0),
      released_base_units=p_released_amount_base_units::numeric(78,0),
      milestone_count=p_milestone_count,current_milestone=p_current_milestone,
      schedule_hash=lower(p_schedule_hash),current_milestone_detail=p_current_milestone_detail,state_checked_at=now()
  where record.bounty_id=p_bounty_id returning * into escrow_row;

  update public.milestones set status='released'
  where bounty_id=p_bounty_id and ordinal < p_current_milestone and status <> 'cancelled';
  milestone_state := p_current_milestone_detail->>'state';
  if p_onchain_state = 'AwaitingFunding' then
    update public.milestones set status='assigned'
    where bounty_id=p_bounty_id and ordinal=p_current_milestone;
  elsif p_onchain_state not in ('Cancelled','Refunded','Settled','PartiallyCompleted') then
    update public.milestones set status = case milestone_state
      when 'Pending' then 'funded'::public.milestone_status
      when 'Submitted' then 'delivered'::public.milestone_status
      when 'Approved' then 'accepted'::public.milestone_status
      when 'Released' then 'released'::public.milestone_status end
    where bounty_id=p_bounty_id and ordinal=p_current_milestone;
  end if;
  return to_jsonb(escrow_row);
end $$;

-- The expiry-aware wrapper continues to call this exact core signature.
revoke all on function public.app_record_escrow_state(
  uuid,uuid,text,text,timestamptz,text,text,text,text,integer,integer,text,jsonb
) from public,anon,authenticated,service_role;

-- A partially completed bounty has at least one canonically released milestone.
-- Treat it as terminal participant activity without implying that unfunded work
-- was completed or paid.
update public.escrow_records
set terminal_at = coalesce(terminal_at,state_checked_at,updated_at)
where onchain_state='PartiallyCompleted' and terminal_at is null;

create or replace function public.app_set_escrow_terminal_at()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.onchain_state in ('Released','Settled','PartiallyCompleted') then
    if tg_op='UPDATE' then
      new.terminal_at:=coalesce(old.terminal_at,new.state_checked_at,now());
    else
      new.terminal_at:=coalesce(new.terminal_at,new.state_checked_at,now());
    end if;
  else
    new.terminal_at:=null;
  end if;
  return new;
end $$;

create or replace function public.app_create_participant_review(
  p_actor_id uuid,p_bounty_id uuid,p_rating integer,p_body text
)
returns jsonb
language plpgsql security definer set search_path=public as $$
declare
  bounty_row public.bounties;
  provider_id uuid;
  subject_id uuid;
  review_direction text;
  escrow_row public.escrow_records;
  review_row public.participant_reviews;
  normalized_body text:=nullif(btrim(p_body),'');
begin
  select * into bounty_row from public.bounties where id=p_bounty_id;
  if not found or bounty_row.accepted_proposal_id is null then
    raise exception 'ACCEPTED_PROPOSAL_REQUIRED' using errcode='22023';
  end if;
  select proposal.provider_id into provider_id from public.proposals proposal
  where proposal.id=bounty_row.accepted_proposal_id;
  if p_actor_id=bounty_row.creator_id then
    subject_id:=provider_id;
    review_direction:='service_received';
  elsif p_actor_id=provider_id then
    subject_id:=bounty_row.creator_id;
    review_direction:='payment_received';
  else
    raise exception 'BOUNTY_PARTICIPANT_REQUIRED' using errcode='42501';
  end if;

  select * into escrow_row from public.escrow_records where bounty_id=p_bounty_id;
  if not found
    or not coalesce(escrow_row.onchain_state in ('Released','Settled','PartiallyCompleted'),false)
    or escrow_row.state_checked_at is null
    or escrow_row.state_checked_at < now()-interval '10 minutes' then
    raise exception 'TERMINAL_ESCROW_VERIFICATION_REQUIRED' using errcode='22023';
  end if;
  if p_rating is null or p_rating < 1 or p_rating > 5
    or (normalized_body is not null and char_length(normalized_body) not between 3 and 2000) then
    raise exception 'INVALID_REVIEW' using errcode='22023';
  end if;

  insert into public.participant_reviews(bounty_id,author_id,subject_id,direction,rating,body)
  values(p_bounty_id,p_actor_id,subject_id,review_direction,p_rating,normalized_body)
  returning * into review_row;
  insert into public.notifications(recipient_id,type,entity_type,entity_id,body,dedupe_key)
  values(
    subject_id,'participant_review','bounty',p_bounty_id,
    case when normalized_body is null then 'A participant left a rating'
      else 'A participant left a rating and review' end,
    'participant-review:'||review_row.id::text
  ) on conflict(dedupe_key) do nothing;
  return to_jsonb(review_row);
end $$;

alter function public.app_public_wallet_profile(text)
  rename to app_public_wallet_profile_before_staged_completion;

create function public.app_public_wallet_profile(p_wallet_address text)
returns jsonb
language sql stable security definer set search_path=public as $$
  select case when prior.profile is null then null else
    jsonb_set(
      jsonb_set(
        prior.profile,
        '{activity_summary,labor_bounties}',
        to_jsonb((
          select count(*)::integer
          from public.bounties bounty
          join public.proposals proposal on proposal.id=bounty.accepted_proposal_id
          join public.escrow_records escrow on escrow.bounty_id=bounty.id
          where proposal.provider_id=account.id
            and bounty.status<>'draft'
            and bounty.moderation_status='visible'
            and escrow.onchain_state in ('Released','Settled','PartiallyCompleted')
        )),
        true
      ),
      '{last_completed_activity_at}',
      coalesce(to_jsonb((
        select max(escrow.terminal_at)
        from public.bounties bounty
        join public.proposals proposal on proposal.id=bounty.accepted_proposal_id
        join public.escrow_records escrow on escrow.bounty_id=bounty.id
        where bounty.moderation_status='visible'
          and bounty.status<>'draft'
          and escrow.onchain_state in ('Released','Settled','PartiallyCompleted')
          and (bounty.creator_id=account.id or proposal.provider_id=account.id)
      )),'null'::jsonb),
      true
    )
  end
  from (select public.app_public_wallet_profile_before_staged_completion(p_wallet_address) as profile) prior
  left join public.wallet_accounts account
    on account.wallet_address=public.app_normalize_wallet(p_wallet_address)
$$;

revoke all on function public.app_public_wallet_profile_before_staged_completion(text)
from public,anon,authenticated,service_role;
revoke all on function public.app_public_wallet_profile(text)
from public,anon,authenticated;
grant execute on function public.app_public_wallet_profile(text) to service_role;
