-- Participant ratings describe a completed bounty. A partially completed
-- staged escrow is still active and must not expose or accept reviews.

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
    or not coalesce(escrow_row.onchain_state in ('Released','Settled'),false)
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

revoke all on function public.app_create_participant_review(uuid,uuid,integer,text)
from public, anon, authenticated;
grant execute on function public.app_create_participant_review(uuid,uuid,integer,text)
to service_role;
