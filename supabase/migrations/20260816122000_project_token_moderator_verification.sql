-- Project completed token-verification reviews onto the token record so every
-- marketplace surface can present the moderator result consistently. Automated
-- inspection fields remain unchanged and continue to enforce funding policy.

alter table public.tokens
  add column moderator_verification_outcome text
    check (moderator_verification_outcome in ('verified', 'source_verified', 'inconclusive', 'incompatible')),
  add column moderator_verified_at timestamptz,
  add column moderator_verified_by uuid references public.wallet_accounts(id) on delete set null,
  add column moderator_verification_response text
    check (moderator_verification_response is null or char_length(moderator_verification_response) between 3 and 1000);

create function public.app_project_token_verification_decision()
returns trigger
language plpgsql set search_path = public as $$
begin
  if new.entity_type = 'token'
    and new.request_kind = 'verification_request'
    and new.status = 'resolved'
    and new.verification_outcome in ('verified', 'source_verified', 'inconclusive', 'incompatible') then
    update public.tokens token set
      moderator_verification_outcome = new.verification_outcome,
      moderator_verified_at = coalesce(new.resolved_at, now()),
      moderator_verified_by = new.resolved_by,
      moderator_verification_response = new.moderator_response
    where token.id = new.entity_id;
  end if;
  return new;
end $$;

create trigger content_reports_project_token_verification
after insert or update of status, verification_outcome, moderator_response, resolved_by, resolved_at
on public.content_reports
for each row execute function public.app_project_token_verification_decision();

with latest_verification as (
  select distinct on (report.entity_id)
    report.entity_id,
    report.verification_outcome,
    report.resolved_at,
    report.resolved_by,
    report.moderator_response
  from public.content_reports report
  where report.entity_type = 'token'
    and report.request_kind = 'verification_request'
    and report.status = 'resolved'
    and report.verification_outcome in ('verified', 'source_verified', 'inconclusive', 'incompatible')
  order by report.entity_id, report.resolved_at desc nulls last, report.created_at desc, report.id desc
)
update public.tokens token set
  moderator_verification_outcome = latest.verification_outcome,
  moderator_verified_at = latest.resolved_at,
  moderator_verified_by = latest.resolved_by,
  moderator_verification_response = latest.moderator_response
from latest_verification latest
where token.id = latest.entity_id;

revoke all on function public.app_project_token_verification_decision()
from public, anon, authenticated, service_role;
