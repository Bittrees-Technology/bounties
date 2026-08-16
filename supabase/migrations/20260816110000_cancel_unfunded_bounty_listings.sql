-- A published listing with no escrow has no onchain object to cancel. Keep this
-- database-only path narrow: creator-owned, still open, no accepted applicant,
-- and no escrow record. Any onchain escrow must use the contract cancellation.
create or replace function public.app_cancel_unfunded_bounty(
  p_actor_id uuid,
  p_bounty_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  bounty_row public.bounties;
begin
  select * into bounty_row
  from public.bounties
  where id = p_bounty_id
  for update;

  if not found then
    raise exception 'BOUNTY_NOT_FOUND' using errcode = '22023';
  end if;
  if bounty_row.creator_id <> p_actor_id then
    raise exception 'BOUNTY_OWNER_REQUIRED' using errcode = '42501';
  end if;
  if bounty_row.status = 'cancelled' then
    return public.app_bounty_json(p_bounty_id, p_actor_id);
  end if;
  if bounty_row.status <> 'open' or bounty_row.accepted_proposal_id is not null then
    raise exception 'BOUNTY_CANCELLATION_UNAVAILABLE' using errcode = '23514';
  end if;
  if exists (select 1 from public.escrow_records where bounty_id = p_bounty_id) then
    raise exception 'BOUNTY_ESCROW_CANCELLATION_REQUIRED' using errcode = '23514';
  end if;

  with rejected as (
    update public.proposals
    set status = 'rejected'
    where bounty_id = p_bounty_id and status = 'active'
    returning provider_id
  )
  insert into public.notifications(recipient_id, type, entity_type, entity_id, body, dedupe_key)
  select provider_id,
    'bounty_cancelled',
    'bounty',
    p_bounty_id,
    'A bounty you applied to was cancelled before escrow funding.',
    'bounty-cancelled:' || p_bounty_id::text || ':' || provider_id::text
  from rejected
  group by provider_id
  on conflict(dedupe_key) do nothing;

  update public.milestones
  set status = 'cancelled'
  where bounty_id = p_bounty_id and status in ('pending', 'assigned');

  update public.bounties
  set status = 'cancelled'
  where id = p_bounty_id;

  return public.app_bounty_json(p_bounty_id, p_actor_id);
end;
$$;

revoke all on function public.app_cancel_unfunded_bounty(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.app_cancel_unfunded_bounty(uuid, uuid)
  to service_role;

comment on function public.app_cancel_unfunded_bounty(uuid, uuid) is
  'Closes a creator-owned open listing only when no applicant is accepted and no escrow record exists.';
