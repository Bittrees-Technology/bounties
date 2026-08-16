-- Retire testnet marketplace history after the production mainnet cutover.
-- Profiles, wallet accounts, roles, tokens, compatibility checks, sessions,
-- authentication records, and mainnet marketplace records are preserved.

alter table public.bounties disable trigger bounties_validate_amounts;
alter table public.proposals disable trigger proposals_validate_amounts;
alter table public.milestones disable trigger milestones_validate_amounts;
alter table public.milestones disable trigger milestones_validate_schedule;

create temporary table retired_testnet_bounties on commit drop as
select bounty.id
from public.bounties bounty
where bounty.chain_id in (11155111, 84532, 46630);

create temporary table retired_testnet_proposals on commit drop as
select proposal.id
from public.proposals proposal
join retired_testnet_bounties target on target.id = proposal.bounty_id;

create temporary table retired_testnet_milestones on commit drop as
select milestone.id
from public.milestones milestone
join retired_testnet_bounties target on target.id = milestone.bounty_id;

create temporary table retired_testnet_evidence on commit drop as
select evidence.id
from public.delivery_evidence evidence
join retired_testnet_milestones target on target.id = evidence.milestone_id;

create temporary table retired_testnet_escrows on commit drop as
select escrow.id
from public.escrow_records escrow
join retired_testnet_bounties target on target.id = escrow.bounty_id;

create temporary table retired_testnet_reviews on commit drop as
select review.id
from public.participant_reviews review
join retired_testnet_bounties target on target.id = review.bounty_id;

create temporary table retired_testnet_reports on commit drop as
select report.id
from public.content_reports report
where (report.entity_type = 'bounty' and report.entity_id in (select id from retired_testnet_bounties))
   or (report.entity_type = 'review' and report.entity_id in (select id from retired_testnet_reviews));

delete from public.content_report_events event
using retired_testnet_reports target
where event.report_id = target.id;

delete from public.moderation_actions action
where action.report_id in (select id from retired_testnet_reports)
   or (action.entity_type = 'bounty' and action.entity_id in (select id from retired_testnet_bounties))
   or (action.entity_type = 'review' and action.entity_id in (select id from retired_testnet_reviews));

delete from public.content_reports report
using retired_testnet_reports target
where report.id = target.id;

delete from public.notifications notification
where notification.entity_id in (
  select id from retired_testnet_bounties
  union all select id from retired_testnet_proposals
  union all select id from retired_testnet_milestones
  union all select id from retired_testnet_evidence
  union all select id from retired_testnet_escrows
  union all select id from retired_testnet_reviews
  union all select id from retired_testnet_reports
);

delete from public.participant_reviews review
using retired_testnet_reviews target
where review.id = target.id;

delete from public.delivery_evidence evidence
using retired_testnet_evidence target
where evidence.id = target.id;

delete from public.milestone_revision_requests request
using retired_testnet_milestones target
where request.milestone_id = target.id;

delete from public.escrow_records escrow
using retired_testnet_escrows target
where escrow.id = target.id;

update public.bounties bounty
set accepted_proposal_id = null
where bounty.id in (select id from retired_testnet_bounties)
  and bounty.accepted_proposal_id is not null;

delete from public.proposals proposal
using retired_testnet_proposals target
where proposal.id = target.id;

delete from public.milestones milestone
using retired_testnet_milestones target
where milestone.id = target.id;

delete from public.bounties bounty
using retired_testnet_bounties target
where bounty.id = target.id;

alter table public.bounties enable trigger bounties_validate_amounts;
alter table public.proposals enable trigger proposals_validate_amounts;
alter table public.milestones enable trigger milestones_validate_amounts;
alter table public.milestones enable trigger milestones_validate_schedule;
