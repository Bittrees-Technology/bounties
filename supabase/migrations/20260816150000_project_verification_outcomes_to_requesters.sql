-- Preserve the exact moderator outcome in the requester's marketplace
-- snapshot. The preceding snapshot projection intentionally exposed a bounded
-- report shape, but it predated paid token verification and therefore omitted
-- request_kind and verification_outcome. A missing outcome made the client
-- fall back to "Inconclusive" even when the stored decision was "verified".

alter function public.app_marketplace_snapshot(uuid)
  rename to app_marketplace_snapshot_before_request_outcomes;

create function public.app_marketplace_snapshot(p_actor_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_set(
    prior.snapshot,
    '{myReports}',
    coalesce((
      select jsonb_agg(
        report
        || jsonb_build_object(
          'request_kind', source.request_kind,
          'verification_outcome', source.verification_outcome
        )
        order by report->>'created_at' desc
      )
      from jsonb_array_elements(coalesce(prior.snapshot->'myReports', '[]'::jsonb)) report
      join public.content_reports source on source.id = (report->>'id')::uuid
    ), '[]'::jsonb),
    true
  )
  from (
    select public.app_marketplace_snapshot_before_request_outcomes(p_actor_id) as snapshot
  ) prior
$$;

revoke all on function public.app_marketplace_snapshot_before_request_outcomes(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.app_marketplace_snapshot(uuid)
from public, anon, authenticated;
grant execute on function public.app_marketplace_snapshot(uuid) to service_role;
