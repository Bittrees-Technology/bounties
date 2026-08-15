-- Preserve the exact terminal settlement split from the configured escrow's
-- canonical BountySettled receipt. The contract intentionally clears its live
-- proposal fields after settlement, so these values must not be reconstructed
-- from terminal storage.

alter table public.escrow_records
  add column if not exists settlement_transaction_hash text,
  add column if not exists settlement_provider_payout_base_units numeric(78,0),
  add column if not exists settlement_requester_refund_base_units numeric(78,0);

alter table public.escrow_records
  add constraint escrow_records_settlement_transaction_hash_check
    check (settlement_transaction_hash is null or settlement_transaction_hash ~ '^0x[0-9a-f]{64}$'),
  add constraint escrow_records_settlement_result_complete_check
    check ((settlement_transaction_hash is null
      and settlement_provider_payout_base_units is null
      and settlement_requester_refund_base_units is null)
      or (settlement_transaction_hash is not null
        and settlement_provider_payout_base_units is not null
        and settlement_requester_refund_base_units is not null));

-- Numeric(78,0) values must cross the JSON boundary as decimal strings; JSON
-- numbers would be rounded by JavaScript above Number.MAX_SAFE_INTEGER.
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
      'settlement_provider_payout_base_units',case when er.settlement_provider_payout_base_units is null then null else er.settlement_provider_payout_base_units::text end,
      'settlement_requester_refund_base_units',case when er.settlement_requester_refund_base_units is null then null else er.settlement_requester_refund_base_units::text end,
      'current_milestone_detail',er.current_milestone_detail
    ) from public.escrow_records er where er.bounty_id=b.id),
    'reviews',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('author_wallet_address',author.wallet_address,'subject_wallet_address',subject.wallet_address) order by r.created_at)
      from public.participant_reviews r join public.wallet_accounts author on author.id=r.author_id join public.wallet_accounts subject on subject.id=r.subject_id
      where r.bounty_id=b.id and (r.moderation_status='visible' or r.author_id=p_actor_id or r.subject_id=p_actor_id or public.app_is_moderation_staff(p_actor_id))),'[]'::jsonb)
  ) from public.bounties b join public.tokens t on t.id=b.token_id where b.id=p_bounty_id and (
    (b.status<>'draft' and b.moderation_status='visible') or b.creator_id=p_actor_id or public.app_is_moderation_staff(p_actor_id)
    or exists(select 1 from public.proposals accepted where accepted.id=b.accepted_proposal_id and accepted.provider_id=p_actor_id))
$$;

create function public.app_record_settlement_result(
  p_actor_id uuid,
  p_bounty_id uuid,
  p_settlement_transaction_hash text,
  p_settlement_provider_payout_base_units text,
  p_settlement_requester_refund_base_units text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  bounty_row public.bounties;
  provider_id uuid;
  escrow_row public.escrow_records;
begin
  if p_settlement_transaction_hash !~ '^0x[0-9a-f]{64}$'
    or p_settlement_provider_payout_base_units !~ '^[0-9]+$'
    or p_settlement_requester_refund_base_units !~ '^[0-9]+$' then
    raise exception 'INVALID_ESCROW_SETTLEMENT_RESULT' using errcode = '22023';
  end if;

  select * into bounty_row from public.bounties where id = p_bounty_id for update;
  if not found then raise exception 'BOUNTY_NOT_FOUND' using errcode = '22023'; end if;
  select proposal.provider_id into provider_id
  from public.proposals proposal where proposal.id = bounty_row.accepted_proposal_id;
  if p_actor_id <> bounty_row.creator_id and p_actor_id is distinct from provider_id then
    raise exception 'BOUNTY_PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;

  select * into escrow_row from public.escrow_records record
  where record.bounty_id = p_bounty_id for update;
  if not found or escrow_row.onchain_state <> 'Settled' then
    raise exception 'ESCROW_SETTLEMENT_RECONCILIATION_REQUIRED' using errcode = '40001';
  end if;
  if escrow_row.settlement_transaction_hash is not null
    and (escrow_row.settlement_transaction_hash <> p_settlement_transaction_hash
      or escrow_row.settlement_provider_payout_base_units <> p_settlement_provider_payout_base_units::numeric(78,0)
      or escrow_row.settlement_requester_refund_base_units <> p_settlement_requester_refund_base_units::numeric(78,0)) then
    raise exception 'ESCROW_SETTLEMENT_RESULT_IMMUTABLE' using errcode = '23505';
  end if;
  if escrow_row.allocated_amount_base_units is null
    or escrow_row.released_amount_base_units is null
    or p_settlement_provider_payout_base_units::numeric(78,0)
      + p_settlement_requester_refund_base_units::numeric(78,0)
    <> escrow_row.allocated_amount_base_units - escrow_row.released_amount_base_units then
    raise exception 'ESCROW_SETTLEMENT_TOTAL_MISMATCH' using errcode = '23514';
  end if;

  update public.escrow_records record set
    settlement_transaction_hash = p_settlement_transaction_hash,
    settlement_provider_payout_base_units = p_settlement_provider_payout_base_units::numeric(78,0),
    settlement_requester_refund_base_units = p_settlement_requester_refund_base_units::numeric(78,0)
  where record.bounty_id = p_bounty_id
  returning * into escrow_row;
  return to_jsonb(escrow_row) || jsonb_build_object(
    'settlement_provider_payout_base_units',escrow_row.settlement_provider_payout_base_units::text,
    'settlement_requester_refund_base_units',escrow_row.settlement_requester_refund_base_units::text
  );
end $$;

revoke all on function public.app_record_settlement_result(uuid,uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.app_record_settlement_result(uuid,uuid,text,text,text)
  to service_role;

comment on column public.escrow_records.settlement_transaction_hash is
  'Canonical successful transaction containing the verified BountySettled event.';
comment on column public.escrow_records.settlement_provider_payout_base_units is
  'Exact provider payout decoded from the canonical BountySettled event.';
comment on column public.escrow_records.settlement_requester_refund_base_units is
  'Exact requester refund decoded from the canonical BountySettled event.';
