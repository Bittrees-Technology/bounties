-- Include the capital-provider wallet in every authorized bounty projection so
-- both participants can resolve the same profile identity in the interface.
create or replace function public.app_bounty_json(p_bounty_id uuid,p_actor_id uuid)
returns jsonb language sql stable security definer set search_path=public as $$
  select to_jsonb(b)||jsonb_build_object(
    'creator_wallet_address',creator.wallet_address,
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
  ) from public.bounties b
    join public.tokens t on t.id=b.token_id
    join public.wallet_accounts creator on creator.id=b.creator_id
  where b.id=p_bounty_id and (
    (b.status<>'draft' and b.moderation_status='visible') or b.creator_id=p_actor_id or public.app_is_moderation_staff(p_actor_id)
    or exists(select 1 from public.proposals accepted where accepted.id=b.accepted_proposal_id and accepted.provider_id=p_actor_id))
$$;
