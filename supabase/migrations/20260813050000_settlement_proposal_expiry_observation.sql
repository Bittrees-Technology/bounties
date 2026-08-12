-- Persist the bounded settlement-offer expiry from canonical chain reads. This
-- is descriptive state only and grants no authority to move or pause escrow.

alter table public.escrow_records
  add column if not exists settlement_proposal_expiry timestamptz;

create function public.app_clear_stale_settlement_expiry()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.settlement_proposer is null
    or new.settlement_proposer = '0x0000000000000000000000000000000000000000' then
    new.settlement_proposal_expiry := null;
  end if;
  return new;
end $$;

create trigger escrow_records_clear_stale_settlement_expiry
before insert or update of settlement_proposer on public.escrow_records
for each row execute function public.app_clear_stale_settlement_expiry();

create function public.app_record_escrow_state(
  p_actor_id uuid,
  p_bounty_id uuid,
  p_onchain_state text,
  p_remaining_base_units text,
  p_review_deadline timestamptz,
  p_settlement_proposer text,
  p_proposed_provider_payout_base_units text,
  p_settlement_proposal_expiry timestamptz,
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
  normalized_proposer text;
  escrow_row public.escrow_records;
begin
  normalized_proposer := case when p_settlement_proposer is null then null
    else public.app_normalize_wallet(p_settlement_proposer) end;
  if normalized_proposer is null
    or normalized_proposer = '0x0000000000000000000000000000000000000000' then
    if p_settlement_proposal_expiry is not null then
      raise exception 'ESCROW_SETTLEMENT_EXPIRY_INCONSISTENT' using errcode = '23514';
    end if;
  elsif p_settlement_proposal_expiry is null then
    raise exception 'ESCROW_SETTLEMENT_EXPIRY_REQUIRED' using errcode = '23514';
  end if;

  perform public.app_record_escrow_state(
    p_actor_id,p_bounty_id,p_onchain_state,p_remaining_base_units,p_review_deadline,
    p_settlement_proposer,p_proposed_provider_payout_base_units,p_allocated_amount_base_units,
    p_released_amount_base_units,p_milestone_count,p_current_milestone,p_schedule_hash,
    p_current_milestone_detail
  );

  update public.escrow_records record
  set settlement_proposal_expiry = p_settlement_proposal_expiry
  where record.bounty_id = p_bounty_id
  returning * into escrow_row;
  return to_jsonb(escrow_row);
end $$;

revoke all on function public.app_record_escrow_state(
  uuid,uuid,text,text,timestamptz,text,text,timestamptz,text,text,integer,integer,text,jsonb
) from public,anon,authenticated;
grant execute on function public.app_record_escrow_state(
  uuid,uuid,text,text,timestamptz,text,text,timestamptz,text,text,integer,integer,text,jsonb
) to service_role;

-- Same-origin server calls must use the expiry-aware observation boundary.
revoke execute on function public.app_record_escrow_state(
  uuid,uuid,text,text,timestamptz,text,text,text,text,integer,integer,text,jsonb
) from service_role;

comment on column public.escrow_records.settlement_proposal_expiry is
  'Canonical onchain expiry of the current bilateral settlement proposal; descriptive only.';
