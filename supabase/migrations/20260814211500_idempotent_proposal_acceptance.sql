-- Applicant selection is the durable first half of an optional accept-and-fund
-- flow. A wallet can cancel or fail during the later onchain funding request, so
-- retrying the same selection must return the already-accepted bounty instead of
-- presenting a stale client with BOUNTY_NOT_OPEN.

create or replace function public.app_accept_proposal(p_actor_id uuid, p_bounty_id uuid, p_proposal_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  bounty_row public.bounties;
  proposal_row public.proposals;
begin
  select * into bounty_row from public.bounties where id = p_bounty_id for update;
  if not found or bounty_row.creator_id <> p_actor_id then
    raise exception 'BOUNTY_OWNER_REQUIRED' using errcode = '42501';
  end if;

  select * into proposal_row
  from public.proposals
  where id = p_proposal_id and bounty_id = p_bounty_id
  for update;
  if not found then
    raise exception 'PROPOSAL_NOT_ACTIVE' using errcode = '22023';
  end if;

  if bounty_row.status <> 'open' then
    if bounty_row.accepted_proposal_id = p_proposal_id and proposal_row.status = 'accepted' then
      return public.app_bounty_json(p_bounty_id, p_actor_id);
    end if;
    raise exception 'BOUNTY_ALREADY_MATCHED' using errcode = '22023';
  end if;
  if proposal_row.status <> 'active' then
    raise exception 'PROPOSAL_NOT_ACTIVE' using errcode = '22023';
  end if;
  if proposal_row.proposed_total_base_units <> bounty_row.budget_base_units then
    raise exception 'PROPOSAL_BUDGET_MISMATCH' using errcode = '23514';
  end if;

  update public.proposals
     set status = case when id = p_proposal_id then 'accepted'::public.proposal_status else 'rejected'::public.proposal_status end
   where bounty_id = p_bounty_id and status = 'active';
  update public.bounties
     set accepted_proposal_id = p_proposal_id, status = 'accepted'
   where id = p_bounty_id;
  update public.milestones
     set assigned_provider_id = proposal_row.provider_id, status = 'assigned'
   where bounty_id = p_bounty_id and status = 'pending';
  insert into public.notifications (recipient_id, type, entity_type, entity_id, body, dedupe_key)
  values (proposal_row.provider_id, 'proposal_accepted', 'bounty', p_bounty_id, 'Proposal accepted', 'proposal-accepted:' || p_proposal_id::text)
  on conflict (dedupe_key) do nothing;

  return public.app_bounty_json(p_bounty_id, p_actor_id);
end $$;

revoke all on function public.app_accept_proposal(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.app_accept_proposal(uuid, uuid, uuid) to service_role;
