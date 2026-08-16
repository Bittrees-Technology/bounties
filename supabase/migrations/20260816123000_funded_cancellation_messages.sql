-- Preserve an optional public cancellation explanation without changing the
-- escrow contract. The API verifies that the same text and SHA-256 fingerprint
-- are appended to the canonical BountyCancelled transaction calldata.

alter table public.escrow_records
  add column if not exists cancellation_message text,
  add column if not exists cancellation_message_hash text,
  add column if not exists cancellation_transaction_hash text,
  add column if not exists cancellation_refunded_base_units numeric(78,0),
  add column if not exists cancellation_recorded_at timestamptz;

alter table public.escrow_records
  add constraint escrow_records_cancellation_message_check
    check (cancellation_message is null or char_length(cancellation_message) between 1 and 500),
  add constraint escrow_records_cancellation_message_hash_check
    check (cancellation_message_hash is null or cancellation_message_hash ~ '^0x[0-9a-f]{64}$'),
  add constraint escrow_records_cancellation_transaction_hash_check
    check (cancellation_transaction_hash is null or cancellation_transaction_hash ~ '^0x[0-9a-f]{64}$'),
  add constraint escrow_records_cancellation_record_complete_check
    check ((cancellation_message is null
      and cancellation_message_hash is null
      and cancellation_transaction_hash is null
      and cancellation_refunded_base_units is null
      and cancellation_recorded_at is null)
      or (cancellation_message is not null
        and cancellation_message_hash is not null
        and cancellation_transaction_hash is not null
        and cancellation_refunded_base_units is not null
        and cancellation_recorded_at is not null));

create or replace function public.app_record_escrow_cancellation(
  p_actor_id uuid,
  p_bounty_id uuid,
  p_message text,
  p_message_hash text,
  p_transaction_hash text,
  p_refunded_base_units text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  bounty_row public.bounties;
  escrow_row public.escrow_records;
  provider_id uuid;
  canonical_message text := btrim(p_message);
  canonical_hash text := lower(p_message_hash);
  canonical_transaction_hash text := lower(p_transaction_hash);
begin
  if canonical_message = '' or char_length(canonical_message) > 500
    or canonical_hash !~ '^0x[0-9a-f]{64}$'
    or canonical_transaction_hash !~ '^0x[0-9a-f]{64}$'
    or p_refunded_base_units !~ '^[0-9]+$'
    or canonical_hash <> '0x' || encode(digest(convert_to(canonical_message, 'UTF8'), 'sha256'), 'hex') then
    raise exception 'INVALID_ESCROW_CANCELLATION_MESSAGE' using errcode = '22023';
  end if;

  select * into bounty_row from public.bounties where id = p_bounty_id for update;
  if not found then raise exception 'BOUNTY_NOT_FOUND' using errcode = '22023'; end if;
  if bounty_row.creator_id <> p_actor_id then raise exception 'BOUNTY_OWNER_REQUIRED' using errcode = '42501'; end if;

  select * into escrow_row from public.escrow_records where bounty_id = p_bounty_id for update;
  if not found then raise exception 'ESCROW_OBSERVATION_REQUIRED' using errcode = '22023'; end if;
  if escrow_row.onchain_state <> 'Cancelled' or coalesce(escrow_row.remaining_base_units, 0) <> 0 then
    raise exception 'ESCROW_CANCELLATION_POST_STATE_INVALID' using errcode = '23514';
  end if;
  if escrow_row.cancellation_transaction_hash is not null then
    if escrow_row.cancellation_message = canonical_message
      and escrow_row.cancellation_message_hash = canonical_hash
      and escrow_row.cancellation_transaction_hash = canonical_transaction_hash
      and escrow_row.cancellation_refunded_base_units = p_refunded_base_units::numeric(78,0) then
      return to_jsonb(escrow_row);
    end if;
    raise exception 'ESCROW_CANCELLATION_ALREADY_RECORDED' using errcode = '23505';
  end if;

  update public.escrow_records
  set cancellation_message = canonical_message,
      cancellation_message_hash = canonical_hash,
      cancellation_transaction_hash = canonical_transaction_hash,
      cancellation_refunded_base_units = p_refunded_base_units::numeric(78,0),
      cancellation_recorded_at = now()
  where bounty_id = p_bounty_id
  returning * into escrow_row;

  update public.bounties set status = 'cancelled' where id = p_bounty_id;
  update public.milestones
  set status = 'cancelled'
  where bounty_id = p_bounty_id and status in ('pending', 'assigned', 'funded');

  select proposal.provider_id into provider_id
  from public.proposals proposal where proposal.id = bounty_row.accepted_proposal_id;
  if provider_id is not null then
    insert into public.notifications(recipient_id, type, entity_type, entity_id, body, dedupe_key)
    values (
      provider_id,
      'bounty_cancelled',
      'bounty',
      p_bounty_id,
      left('The capital provider cancelled and refunded the bounty. Message: ' || canonical_message, 500),
      'funded-bounty-cancelled:' || p_bounty_id::text
    )
    on conflict(dedupe_key) do nothing;
  end if;

  return to_jsonb(escrow_row);
end;
$$;

revoke all on function public.app_record_escrow_cancellation(uuid,uuid,text,text,text,text)
  from public, anon, authenticated;
grant execute on function public.app_record_escrow_cancellation(uuid,uuid,text,text,text,text)
  to service_role;

comment on function public.app_record_escrow_cancellation(uuid,uuid,text,text,text,text) is
  'Stores a server-verified funded cancellation message whose exact text and SHA-256 fingerprint were appended to the canonical cancellation transaction.';
