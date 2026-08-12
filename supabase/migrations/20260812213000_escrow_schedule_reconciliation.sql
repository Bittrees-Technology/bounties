-- Canonical milestone schedule reconciliation. The database records only terms
-- independently verified from the configured escrow contract; it never invents
-- missing legacy schedule terms.

alter table public.bounties
  add column if not exists escrow_schedule_status text not null default 'requires_recreation'
    check (escrow_schedule_status in ('structured', 'requires_recreation'));

-- Existing schedules that predate canonical absolute deadline persistence must
-- be recreated rather than silently converted into onchain terms. Even a
-- one-row NULL deadline is ambiguous because older clients displayed a bounty
-- fallback date that was never persisted as a contract term.
update public.bounties bounty
set escrow_schedule_status = 'structured'
where exists (select 1 from public.milestones milestone where milestone.bounty_id = bounty.id)
  and not exists (
    select 1 from public.milestones milestone
    where milestone.bounty_id = bounty.id and milestone.delivery_deadline is null
  );

alter table public.escrow_records
  add column if not exists allocated_amount_base_units numeric(78,0)
    check (allocated_amount_base_units is null or (allocated_amount_base_units >= 0 and trunc(allocated_amount_base_units) = allocated_amount_base_units)),
  add column if not exists released_amount_base_units numeric(78,0)
    check (released_amount_base_units is null or (released_amount_base_units >= 0 and trunc(released_amount_base_units) = released_amount_base_units)),
  add column if not exists milestone_count integer
    check (milestone_count is null or milestone_count between 1 and 32),
  add column if not exists current_milestone integer
    check (current_milestone is null or current_milestone >= 0),
  add column if not exists schedule_hash text
    check (schedule_hash is null or schedule_hash ~ '^0x[0-9a-f]{64}$'),
  add column if not exists terms_hash text
    check (terms_hash is null or terms_hash ~ '^0x[0-9a-f]{64}$'),
  add column if not exists current_milestone_detail jsonb;

alter table public.escrow_records
  add constraint escrow_records_current_milestone_bound
    check (current_milestone is null or (milestone_count is not null and current_milestone < milestone_count)),
  add constraint escrow_records_current_milestone_detail_shape
    check (
      current_milestone_detail is null or (
        jsonb_typeof(current_milestone_detail) = 'object'
        and coalesce(current_milestone_detail->>'milestone_index','') ~ '^[0-9]+$'
        and coalesce(current_milestone_detail->>'amount_base_units','') ~ '^[0-9]+$'
        and coalesce(current_milestone_detail->>'state','') in ('Pending', 'Submitted', 'Approved', 'Released')
        and coalesce(current_milestone_detail->>'evidence_hash','') ~ '^0x[0-9a-f]{64}$'
        and coalesce(current_milestone_detail->>'approval_hash','') ~ '^0x[0-9a-f]{64}$'
        and (current_milestone_detail->'delivery_deadline' = 'null'::jsonb or jsonb_typeof(current_milestone_detail->'delivery_deadline') = 'string')
        and (current_milestone_detail->'review_deadline' = 'null'::jsonb or jsonb_typeof(current_milestone_detail->'review_deadline') = 'string')
      )
    );

create function public.app_validate_canonical_milestone_observation(
  p_milestone_count integer,
  p_current_milestone integer,
  p_current_milestone_detail jsonb
)
returns void
language plpgsql immutable set search_path = public as $$
begin
  if p_milestone_count not between 1 and 32
    or p_current_milestone < 0
    or p_current_milestone >= p_milestone_count
    or jsonb_typeof(coalesce(p_current_milestone_detail, 'null'::jsonb)) <> 'object'
    or coalesce((p_current_milestone_detail->>'milestone_index')::integer, -1) <> p_current_milestone
    or coalesce(p_current_milestone_detail->>'amount_base_units', '') !~ '^[0-9]+$'
    or coalesce(p_current_milestone_detail->>'state', '') not in ('Pending', 'Submitted', 'Approved', 'Released')
    or coalesce(p_current_milestone_detail->>'evidence_hash', '') !~ '^0x[0-9a-f]{64}$'
    or coalesce(p_current_milestone_detail->>'approval_hash', '') !~ '^0x[0-9a-f]{64}$' then
    raise exception 'INVALID_MILESTONE_OBSERVATION' using errcode = '22023';
  end if;
end $$;

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
      or coalesce(milestone->>'amount_base_units', '') !~ '^[0-9]+$'
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
    creator_id,title,description,scope_source,scope_hash,chain_id,token_id,token_decimals,
    budget_base_units,status,escrow_schedule_status
  ) values (
    p_actor_id,btrim(p_title),p_description,coalesce(p_scope_source,'{}'::jsonb),p_scope_hash,
    p_chain_id,p_token_id,token_row.decimals,budget,'open','structured'
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

create function public.app_record_escrow_observation(
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
    or p_allocated_amount_base_units !~ '^[0-9]+$' or p_released_amount_base_units !~ '^[0-9]+$'
    or p_remaining_base_units !~ '^[0-9]+$' then
    raise exception 'INVALID_ESCROW_SCHEDULE' using errcode = '22023';
  end if;
  perform public.app_validate_canonical_milestone_observation(p_milestone_count, p_current_milestone, p_current_milestone_detail);
  if p_milestone_count <> (select count(*) from public.milestones where bounty_id=p_bounty_id)
    or p_allocated_amount_base_units::numeric(78,0) <> (select sum(amount_base_units) from public.milestones where bounty_id=p_bounty_id)
    or (p_current_milestone_detail->>'amount_base_units')::numeric(78,0) <> (
      select amount_base_units from public.milestones where bounty_id=p_bounty_id and ordinal=p_current_milestone)
    or coalesce(extract(epoch from (p_current_milestone_detail->>'delivery_deadline')::timestamptz)::bigint,0) <> coalesce((
      select extract(epoch from delivery_deadline)::bigint from public.milestones where bounty_id=p_bounty_id and ordinal=p_current_milestone),0)
  then raise exception 'ESCROW_MILESTONE_MISMATCH' using errcode = '23514'; end if;

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
    p_bounty_id,bounty_row.chain_id,bounty_row.token_id,normalized_contract,coalesce(p_interface_version,'escrow-adapter.v1'),p_onchain_bounty_id,
    p_requested_base_units::numeric(78,0),p_received_base_units::numeric(78,0),p_released_amount_base_units::numeric(78,0),
    coalesce(p_status,'confirmed')::public.escrow_status,lower(p_transaction_hash),lower(p_block_hash),p_log_index,
    p_onchain_state,p_remaining_base_units::numeric(78,0),p_allocated_amount_base_units::numeric(78,0),
    p_released_amount_base_units::numeric(78,0),p_milestone_count,p_current_milestone,lower(p_schedule_hash),lower(p_terms_hash),
    p_current_milestone_detail,now()
  ) returning * into escrow_row;

  update public.bounties set status = 'funded'
  where id = p_bounty_id and status in ('accepted','funding_pending','funded');
  if not found then raise exception 'BOUNTY_NOT_READY_FOR_FUNDING' using errcode = '22023'; end if;
  update public.milestones set status = 'funded'
  where bounty_id = p_bounty_id and status = 'assigned';
  return to_jsonb(escrow_row);
end $$;

create function public.app_record_escrow_state(
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
  if p_onchain_state not in ('Created','Funded','ProviderAccepted','Delivered','BuyerApproved','Released','Cancelled','Refunded','Settled')
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
  if p_onchain_state not in ('Cancelled','Refunded','Settled') then
    update public.milestones set status = case milestone_state
      when 'Pending' then 'funded'::public.milestone_status
      when 'Submitted' then 'delivered'::public.milestone_status
      when 'Approved' then 'accepted'::public.milestone_status
      when 'Released' then 'released'::public.milestone_status end
    where bounty_id=p_bounty_id and ordinal=p_current_milestone;
  end if;
  return to_jsonb(escrow_row);
end $$;

create function public.app_submit_delivery_evidence(
  p_actor_id uuid,p_milestone_id uuid,p_uri text,p_content_hash text,p_evidence_hash text,p_hash_version text,
  p_expected_current_milestone integer
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare milestone_row public.milestones; bounty_row public.bounties; escrow_row public.escrow_records; next_revision integer; evidence_row public.delivery_evidence;
begin
  select * into milestone_row from public.milestones where id=p_milestone_id;
  if not found then raise exception 'ASSIGNED_PROVIDER_REQUIRED' using errcode='42501'; end if;
  select * into bounty_row from public.bounties where id=milestone_row.bounty_id for update;
  select * into escrow_row from public.escrow_records where bounty_id=milestone_row.bounty_id for update;
  select * into milestone_row from public.milestones where id=p_milestone_id for update;
  if milestone_row.assigned_provider_id <> p_actor_id then raise exception 'ASSIGNED_PROVIDER_REQUIRED' using errcode='42501'; end if;
  if not found or escrow_row.state_checked_at < now()-interval '2 minutes'
    or escrow_row.onchain_state <> 'ProviderAccepted'
    or escrow_row.current_milestone <> p_expected_current_milestone
    or milestone_row.ordinal <> p_expected_current_milestone
    or escrow_row.current_milestone_detail->>'state' <> 'Pending' then
    raise exception 'CURRENT_MILESTONE_RECONCILIATION_REQUIRED' using errcode='40001';
  end if;
  if milestone_row.status <> 'funded' then raise exception 'MILESTONE_NOT_DELIVERABLE' using errcode='22023'; end if;
  select coalesce(max(revision),0)+1 into next_revision from public.delivery_evidence where milestone_id=p_milestone_id;
  insert into public.delivery_evidence(milestone_id,provider_id,uri,content_hash,evidence_hash,hash_version,revision)
  values(p_milestone_id,p_actor_id,p_uri,p_content_hash,p_evidence_hash,coalesce(p_hash_version,'bounties-evidence-v1'),next_revision)
  returning * into evidence_row;
  update public.milestones set status='delivered' where id=p_milestone_id;
  insert into public.notifications(recipient_id,type,entity_type,entity_id,body,dedupe_key)
  values(bounty_row.creator_id,'delivery','milestone',p_milestone_id,'Delivery evidence submitted','delivery:'||evidence_row.id::text)
  on conflict(dedupe_key) do nothing;
  return to_jsonb(evidence_row);
end $$;

create function public.app_accept_delivery(p_actor_id uuid,p_milestone_id uuid,p_expected_current_milestone integer)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare milestone_row public.milestones; bounty_row public.bounties; escrow_row public.escrow_records; provider uuid;
begin
  select * into milestone_row from public.milestones where id=p_milestone_id;
  if not found then raise exception 'MILESTONE_NOT_FOUND' using errcode='22023'; end if;
  select * into bounty_row from public.bounties where id=milestone_row.bounty_id for update;
  if bounty_row.creator_id <> p_actor_id then raise exception 'BOUNTY_OWNER_REQUIRED' using errcode='42501'; end if;
  select * into escrow_row from public.escrow_records where bounty_id=milestone_row.bounty_id for update;
  select * into milestone_row from public.milestones where id=p_milestone_id for update;
  if not found or escrow_row.state_checked_at < now()-interval '2 minutes'
    or escrow_row.onchain_state <> 'BuyerApproved'
    or escrow_row.current_milestone <> p_expected_current_milestone
    or milestone_row.ordinal <> p_expected_current_milestone
    or escrow_row.current_milestone_detail->>'state' <> 'Approved' then
    raise exception 'CURRENT_MILESTONE_RECONCILIATION_REQUIRED' using errcode='40001';
  end if;
  if milestone_row.status not in ('delivered','accepted') then raise exception 'MILESTONE_NOT_DELIVERED' using errcode='22023'; end if;
  provider:=milestone_row.assigned_provider_id;
  update public.milestones set status='accepted' where id=p_milestone_id;
  if provider is not null then
    insert into public.notifications(recipient_id,type,entity_type,entity_id,body,dedupe_key)
    values(provider,'delivery_accepted','milestone',p_milestone_id,'Delivery accepted','delivery-accepted:'||p_milestone_id::text)
    on conflict(dedupe_key) do nothing;
  end if;
  return public.app_bounty_json(bounty_row.id,p_actor_id);
end $$;

create or replace function public.app_reject_escrow_binding_change()
returns trigger language plpgsql set search_path=public as $$
begin
  if new.bounty_id is distinct from old.bounty_id or new.chain_id is distinct from old.chain_id
    or new.token_id is distinct from old.token_id or new.contract_address is distinct from old.contract_address
    or new.interface_version is distinct from old.interface_version or new.onchain_bounty_id is distinct from old.onchain_bounty_id
    or new.requested_base_units is distinct from old.requested_base_units or new.received_base_units is distinct from old.received_base_units
    or new.transaction_hash is distinct from old.transaction_hash or new.block_hash is distinct from old.block_hash
    or new.log_index is distinct from old.log_index or new.allocated_amount_base_units is distinct from old.allocated_amount_base_units
    or new.milestone_count is distinct from old.milestone_count or new.schedule_hash is distinct from old.schedule_hash
    or new.terms_hash is distinct from old.terms_hash then
    raise exception 'ESCROW_BINDING_IMMUTABLE' using errcode='23505';
  end if;
  return new;
end $$;

create or replace function public.app_bounty_json(p_bounty_id uuid,p_actor_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  select to_jsonb(b)||jsonb_build_object(
    'budget_base_units',b.budget_base_units::text,
    'token',to_jsonb(t)||jsonb_build_object('total_supply',case when t.total_supply is null then null else t.total_supply::text end),
    'milestones',coalesce((select jsonb_agg(to_jsonb(m)||jsonb_build_object(
      'amount_base_units',m.amount_base_units::text,'evidence',coalesce((select jsonb_agg(to_jsonb(e) order by e.revision) from public.delivery_evidence e where e.milestone_id=m.id),'[]'::jsonb)
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

revoke execute on function public.app_record_escrow_observation(uuid,uuid,text,text,text,text,text,text,text,text,integer) from service_role;
revoke execute on function public.app_record_escrow_state(uuid,uuid,text,text,timestamptz,text,text) from service_role;
revoke execute on function public.app_submit_delivery_evidence(uuid,uuid,text,text,text,text) from service_role;
revoke execute on function public.app_accept_delivery(uuid,uuid) from service_role;

revoke all on function
  public.app_validate_canonical_milestone_observation(integer,integer,jsonb),
  public.app_record_escrow_observation(uuid,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,text,integer,integer,text,text,jsonb),
  public.app_record_escrow_state(uuid,uuid,text,text,timestamptz,text,text,text,text,integer,integer,text,jsonb),
  public.app_submit_delivery_evidence(uuid,uuid,text,text,text,text,integer),
  public.app_accept_delivery(uuid,uuid,integer)
from public,anon,authenticated;

grant execute on function
  public.app_record_escrow_observation(uuid,uuid,text,text,text,text,text,text,text,text,integer,text,text,text,text,integer,integer,text,text,jsonb),
  public.app_record_escrow_state(uuid,uuid,text,text,timestamptz,text,text,text,text,integer,integer,text,jsonb),
  public.app_submit_delivery_evidence(uuid,uuid,text,text,text,text,integer),
  public.app_accept_delivery(uuid,uuid,integer)
to service_role;
