-- Remove bounty-derived product records that predate the verified testnet-v3
-- application release. Wallet accounts, profiles, roles, tokens, compatibility
-- checks, sessions, and authentication records are intentionally preserved.
--
-- The fixed cutoff prevents this one-time reset from deleting any bounty created
-- after the reset was requested, even if the migration is applied later.

-- The schedule and amount validators are deferred consistency triggers for
-- ordinary product writes. A complete hard delete would otherwise be evaluated
-- as a zero-milestone schedule at transaction commit. They are disabled only
-- inside this migration transaction and restored before it can commit.
alter table public.bounties disable trigger bounties_validate_amounts;
alter table public.proposals disable trigger proposals_validate_amounts;
alter table public.milestones disable trigger milestones_validate_amounts;
alter table public.milestones disable trigger milestones_validate_schedule;

create temporary table app_v3_reset_bounties on commit drop as
select bounty.id
from public.bounties bounty
where bounty.created_at < timestamptz '2026-08-16T01:29:17Z';

create temporary table app_v3_reset_proposals on commit drop as
select proposal.id
from public.proposals proposal
join app_v3_reset_bounties target on target.id = proposal.bounty_id;

create temporary table app_v3_reset_milestones on commit drop as
select milestone.id
from public.milestones milestone
join app_v3_reset_bounties target on target.id = milestone.bounty_id;

create temporary table app_v3_reset_evidence on commit drop as
select evidence.id
from public.delivery_evidence evidence
join app_v3_reset_milestones target on target.id = evidence.milestone_id;

create temporary table app_v3_reset_escrows on commit drop as
select escrow.id
from public.escrow_records escrow
join app_v3_reset_bounties target on target.id = escrow.bounty_id;

create temporary table app_v3_reset_reviews on commit drop as
select review.id
from public.participant_reviews review
join app_v3_reset_bounties target on target.id = review.bounty_id;

create temporary table app_v3_reset_reports on commit drop as
select report.id
from public.content_reports report
where (report.entity_type = 'bounty' and report.entity_id in (select id from app_v3_reset_bounties))
   or (report.entity_type = 'review' and report.entity_id in (select id from app_v3_reset_reviews));

delete from public.content_report_events event
using app_v3_reset_reports target
where event.report_id = target.id;

delete from public.moderation_actions action
where action.report_id in (select id from app_v3_reset_reports)
   or (action.entity_type = 'bounty' and action.entity_id in (select id from app_v3_reset_bounties))
   or (action.entity_type = 'review' and action.entity_id in (select id from app_v3_reset_reviews));

delete from public.content_reports report
using app_v3_reset_reports target
where report.id = target.id;

delete from public.notifications notification
where notification.entity_id in (
  select id from app_v3_reset_bounties
  union all select id from app_v3_reset_proposals
  union all select id from app_v3_reset_milestones
  union all select id from app_v3_reset_evidence
  union all select id from app_v3_reset_escrows
  union all select id from app_v3_reset_reviews
  union all select id from app_v3_reset_reports
);

delete from public.participant_reviews review
using app_v3_reset_reviews target
where review.id = target.id;

delete from public.delivery_evidence evidence
using app_v3_reset_evidence target
where evidence.id = target.id;

delete from public.milestone_revision_requests request
using app_v3_reset_milestones target
where request.milestone_id = target.id;

delete from public.escrow_records escrow
using app_v3_reset_escrows target
where escrow.id = target.id;

update public.bounties bounty
set accepted_proposal_id = null
where bounty.id in (select id from app_v3_reset_bounties)
  and bounty.accepted_proposal_id is not null;

delete from public.proposals proposal
using app_v3_reset_proposals target
where proposal.id = target.id;

delete from public.milestones milestone
using app_v3_reset_milestones target
where milestone.id = target.id;

delete from public.bounties bounty
using app_v3_reset_bounties target
where bounty.id = target.id;

alter table public.bounties enable trigger bounties_validate_amounts;
alter table public.proposals enable trigger proposals_validate_amounts;
alter table public.milestones enable trigger milestones_validate_amounts;
alter table public.milestones enable trigger milestones_validate_schedule;
