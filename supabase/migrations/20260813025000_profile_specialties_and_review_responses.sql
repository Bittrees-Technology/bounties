-- Searchable public specialties and immutable counterparty responses. These
-- fields remain behind the server-owned API/RPC boundary; no browser role gains
-- direct table access.

create function public.app_profile_selections_valid(p_values text[])
returns boolean
language sql immutable parallel safe set search_path = public as $$
  select cardinality(coalesce(p_values, '{}'::text[])) <= 12
    and not exists (
      select 1
      from unnest(coalesce(p_values, '{}'::text[])) value
      where value is null
        or value <> btrim(value)
        or char_length(value) not between 1 and 64
        or value ~ '[[:cntrl:]]'
    )
    and cardinality(coalesce(p_values, '{}'::text[])) = (
      select count(distinct lower(value))
      from unnest(coalesce(p_values, '{}'::text[])) value
    )
$$;

alter table public.wallet_accounts
  add column if not exists work_types text[] not null default '{}'::text[],
  add column if not exists categories text[] not null default '{}'::text[],
  add column if not exists custom_specialty text;

alter table public.wallet_accounts
  drop constraint if exists wallet_accounts_work_types_check,
  drop constraint if exists wallet_accounts_categories_check,
  drop constraint if exists wallet_accounts_custom_specialty_check,
  add constraint wallet_accounts_work_types_check
    check (public.app_profile_selections_valid(work_types)),
  add constraint wallet_accounts_categories_check
    check (public.app_profile_selections_valid(categories)),
  add constraint wallet_accounts_custom_specialty_check check (
    custom_specialty is null or (
      custom_specialty = btrim(custom_specialty)
      and char_length(custom_specialty) between 1 and 120
      and custom_specialty !~ '[[:cntrl:]]'
    )
  );

alter table public.participant_reviews
  alter column body drop not null,
  add column if not exists response_body text,
  add column if not exists response_author_id uuid references public.wallet_accounts(id) on delete restrict,
  add column if not exists response_created_at timestamptz;

alter table public.participant_reviews
  drop constraint if exists participant_reviews_body_check,
  drop constraint if exists participant_reviews_response_body_check,
  drop constraint if exists participant_reviews_response_shape_check,
  add constraint participant_reviews_body_check
    check (body is null or char_length(body) between 3 and 2000),
  add constraint participant_reviews_response_body_check
    check (response_body is null or char_length(response_body) between 3 and 2000),
  add constraint participant_reviews_response_shape_check check (
    (response_body is null and response_author_id is null and response_created_at is null)
    or
    (response_body is not null and response_author_id = subject_id and response_created_at is not null)
  );

-- Keep the original four-argument routine for backward-compatible migration
-- tests and older clients. The server uses this seven-argument overload.
create function public.app_update_public_profile(
  p_actor_id uuid,
  p_display_name text,
  p_profile_bio text,
  p_profile_url text,
  p_work_types text[],
  p_categories text[],
  p_custom_specialty text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  normalized_work_types text[];
  normalized_categories text[];
  normalized_custom_specialty text;
  account_wallet text;
begin
  if p_actor_id is null or not exists (
    select 1 from public.wallet_accounts account where account.id = p_actor_id
  ) then
    raise exception 'ACCOUNT_REQUIRED' using errcode = '42501';
  end if;
  if p_display_name is not null and char_length(btrim(p_display_name)) not between 1 and 80 then
    raise exception 'INVALID_DISPLAY_NAME' using errcode = '22023';
  end if;
  if p_profile_bio is not null and char_length(btrim(p_profile_bio)) not between 1 and 1000 then
    raise exception 'INVALID_PROFILE_BIO' using errcode = '22023';
  end if;
  if p_profile_url is not null and (
    char_length(btrim(p_profile_url)) > 2048 or btrim(p_profile_url) !~ '^https://'
  ) then
    raise exception 'INVALID_PROFILE_URL' using errcode = '22023';
  end if;

  select coalesce(array_agg(btrim(value) order by ordinal), '{}'::text[])
    into normalized_work_types
  from unnest(coalesce(p_work_types, '{}'::text[])) with ordinality values_with_order(value, ordinal);
  select coalesce(array_agg(btrim(value) order by ordinal), '{}'::text[])
    into normalized_categories
  from unnest(coalesce(p_categories, '{}'::text[])) with ordinality values_with_order(value, ordinal);
  normalized_custom_specialty := nullif(btrim(p_custom_specialty), '');

  if not public.app_profile_selections_valid(normalized_work_types) then
    raise exception 'INVALID_WORK_TYPES' using errcode = '22023';
  end if;
  if not public.app_profile_selections_valid(normalized_categories) then
    raise exception 'INVALID_CATEGORIES' using errcode = '22023';
  end if;
  if normalized_custom_specialty is not null and (
    char_length(normalized_custom_specialty) not between 1 and 120
    or normalized_custom_specialty ~ '[[:cntrl:]]'
  ) then
    raise exception 'INVALID_CUSTOM_SPECIALTY' using errcode = '22023';
  end if;

  update public.wallet_accounts account
     set display_name = case when p_display_name is null then null else btrim(p_display_name) end,
         profile_bio = case when p_profile_bio is null then null else btrim(p_profile_bio) end,
         profile_url = case when p_profile_url is null then null else btrim(p_profile_url) end,
         work_types = normalized_work_types,
         categories = normalized_categories,
         custom_specialty = normalized_custom_specialty,
         profile_updated_at = now()
   where account.id = p_actor_id
   returning account.wallet_address into account_wallet;

  return public.app_public_wallet_profile(account_wallet);
end $$;

create or replace function public.app_public_wallet_profile(p_wallet_address text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'account_id', account.id,
    'wallet_address', account.wallet_address,
    'display_name', case when account.profile_moderation_status = 'visible' then account.display_name else null end,
    'profile_bio', case when account.profile_moderation_status = 'visible' then account.profile_bio else null end,
    'profile_url', case when account.profile_moderation_status = 'visible' then account.profile_url else null end,
    'work_types', case when account.profile_moderation_status = 'visible' then to_jsonb(account.work_types) else '[]'::jsonb end,
    'categories', case when account.profile_moderation_status = 'visible' then to_jsonb(account.categories) else '[]'::jsonb end,
    'custom_specialty', case when account.profile_moderation_status = 'visible' then account.custom_specialty else null end,
    'profile_moderation_status', account.profile_moderation_status,
    'profile_updated_at', account.profile_updated_at,
    'member_since', account.created_at,
    'roles', coalesce((
      select jsonb_agg(role.role order by role.role)
      from public.account_roles role
      where role.account_id = account.id
    ), '[]'::jsonb),
    'activity_summary', jsonb_build_object(
      'capital_bounties', (
        select count(*)::integer
        from public.bounties bounty
        where bounty.creator_id = account.id
          and bounty.status <> 'draft'
          and bounty.moderation_status = 'visible'
      ),
      'labor_bounties', (
        select count(*)::integer
        from public.bounties bounty
        join public.proposals proposal on proposal.id = bounty.accepted_proposal_id
        where proposal.provider_id = account.id
          and bounty.status <> 'draft'
          and bounty.moderation_status = 'visible'
      )
    ),
    'rating_summaries', jsonb_build_object(
      'capital_provider', (
        select jsonb_build_object(
          'average_rating', round(avg(review.rating)::numeric, 2),
          'review_count', count(*)::integer,
          'rating_counts', jsonb_build_object(
            '1', count(*) filter (where review.rating = 1),
            '2', count(*) filter (where review.rating = 2),
            '3', count(*) filter (where review.rating = 3),
            '4', count(*) filter (where review.rating = 4),
            '5', count(*) filter (where review.rating = 5)
          )
        )
        from public.participant_reviews review
        where review.subject_id = account.id
          and review.direction = 'payment_received'
          and review.moderation_status = 'visible'
      ),
      'labor_provider', (
        select jsonb_build_object(
          'average_rating', round(avg(review.rating)::numeric, 2),
          'review_count', count(*)::integer,
          'rating_counts', jsonb_build_object(
            '1', count(*) filter (where review.rating = 1),
            '2', count(*) filter (where review.rating = 2),
            '3', count(*) filter (where review.rating = 3),
            '4', count(*) filter (where review.rating = 4),
            '5', count(*) filter (where review.rating = 5)
          )
        )
        from public.participant_reviews review
        where review.subject_id = account.id
          and review.direction = 'service_received'
          and review.moderation_status = 'visible'
      )
    ),
    'reviews_received', coalesce((
      select jsonb_agg(to_jsonb(received_review) order by received_review.created_at desc)
      from (
        select
          review.id,
          review.bounty_id,
          author.wallet_address as author_wallet_address,
          review.direction,
          review.rating,
          review.body,
          review.response_body,
          review.response_created_at,
          review.created_at
        from public.participant_reviews review
        join public.wallet_accounts author on author.id = review.author_id
        where review.subject_id = account.id
          and review.moderation_status = 'visible'
        order by review.created_at desc
        limit 50
      ) received_review
    ), '[]'::jsonb)
  )
  from public.wallet_accounts account
  where account.wallet_address = public.app_normalize_wallet(p_wallet_address)
$$;

create or replace function public.app_search_public_wallet_profiles(
  p_query text,
  p_limit integer default 12
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  normalized_query text := lower(btrim(coalesce(p_query, '')));
  escaped_query text;
  result_limit integer := least(greatest(coalesce(p_limit, 12), 1), 20);
  result jsonb;
begin
  if char_length(normalized_query) < 2 or char_length(normalized_query) > 80 then
    return '[]'::jsonb;
  end if;
  escaped_query := replace(replace(replace(normalized_query, '\', '\\'), '%', '\%'), '_', '\_');

  select coalesce(jsonb_agg(match.profile order by match.rank, match.display_sort, match.wallet_sort), '[]'::jsonb)
    into result
  from (
    select
      public.app_public_wallet_profile(account.wallet_address) as profile,
      case
        when account.wallet_address = normalized_query then 0
        when lower(coalesce(account.display_name, '')) = normalized_query then 1
        when exists (select 1 from unnest(account.work_types) work_type where lower(work_type) = normalized_query) then 2
        when exists (select 1 from unnest(account.categories) category where lower(category) = normalized_query) then 3
        when normalized_query like '0x%' and account.wallet_address like escaped_query || '%' escape '\' then 4
        else 5
      end as rank,
      lower(coalesce(account.display_name, '')) as display_sort,
      account.wallet_address as wallet_sort
    from public.wallet_accounts account
    where account.profile_moderation_status = 'visible'
      and (
        (normalized_query like '0x%' and account.wallet_address like escaped_query || '%' escape '\')
        or lower(coalesce(account.display_name, '')) like '%' || escaped_query || '%' escape '\'
        or exists (
          select 1 from unnest(account.work_types) work_type
          where lower(work_type) like '%' || escaped_query || '%' escape '\'
        )
        or exists (
          select 1 from unnest(account.categories) category
          where lower(category) like '%' || escaped_query || '%' escape '\'
        )
        or lower(coalesce(account.custom_specialty, '')) like '%' || escaped_query || '%' escape '\'
      )
    order by rank, display_sort, wallet_sort
    limit result_limit
  ) match;

  return result;
end $$;

create function public.app_create_participant_review_response(
  p_actor_id uuid,
  p_review_id uuid,
  p_body text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  review_row public.participant_reviews;
begin
  if p_body is null or char_length(btrim(p_body)) not between 3 and 2000 then
    raise exception 'INVALID_REVIEW_RESPONSE' using errcode = '22023';
  end if;

  select * into review_row
  from public.participant_reviews review
  where review.id = p_review_id
  for update;
  if not found then
    raise exception 'REVIEW_NOT_FOUND' using errcode = '22023';
  end if;
  if p_actor_id is null or p_actor_id <> review_row.subject_id then
    raise exception 'REVIEW_COUNTERPARTY_REQUIRED' using errcode = '42501';
  end if;
  if review_row.response_body is not null then
    raise exception 'REVIEW_RESPONSE_EXISTS' using errcode = '23505';
  end if;

  update public.participant_reviews review
     set response_body = btrim(p_body),
         response_author_id = p_actor_id,
         response_created_at = now()
   where review.id = p_review_id
   returning * into review_row;

  insert into public.notifications (recipient_id, type, entity_type, entity_id, body, dedupe_key)
  values (
    review_row.author_id,
    'participant_review_response',
    'review',
    review_row.id,
    'The other participant responded to your review.',
    'participant-review-response:' || review_row.id::text
  )
  on conflict (dedupe_key) do nothing;

  return to_jsonb(review_row);
end $$;

create or replace function public.app_create_participant_review(
  p_actor_id uuid,
  p_bounty_id uuid,
  p_rating integer,
  p_body text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  bounty_row public.bounties;
  provider_id uuid;
  subject_id uuid;
  review_direction text;
  escrow_row public.escrow_records;
  review_row public.participant_reviews;
  normalized_body text := nullif(btrim(p_body), '');
begin
  select * into bounty_row from public.bounties where id = p_bounty_id;
  if not found or bounty_row.accepted_proposal_id is null then
    raise exception 'ACCEPTED_PROPOSAL_REQUIRED' using errcode = '22023';
  end if;
  select proposal.provider_id into provider_id
    from public.proposals proposal where proposal.id = bounty_row.accepted_proposal_id;
  if p_actor_id = bounty_row.creator_id then
    subject_id := provider_id;
    review_direction := 'service_received';
  elsif p_actor_id = provider_id then
    subject_id := bounty_row.creator_id;
    review_direction := 'payment_received';
  else
    raise exception 'BOUNTY_PARTICIPANT_REQUIRED' using errcode = '42501';
  end if;

  select * into escrow_row from public.escrow_records where bounty_id = p_bounty_id;
  if not found
    or not coalesce(escrow_row.onchain_state in ('Released', 'Settled'), false)
    or escrow_row.state_checked_at is null
    or escrow_row.state_checked_at < now() - interval '10 minutes' then
    raise exception 'TERMINAL_ESCROW_VERIFICATION_REQUIRED' using errcode = '22023';
  end if;
  if p_rating is null
    or p_rating < 1
    or p_rating > 5
    or (normalized_body is not null and char_length(normalized_body) not between 3 and 2000) then
    raise exception 'INVALID_REVIEW' using errcode = '22023';
  end if;

  insert into public.participant_reviews (bounty_id, author_id, subject_id, direction, rating, body)
  values (p_bounty_id, p_actor_id, subject_id, review_direction, p_rating, normalized_body)
  returning * into review_row;

  insert into public.notifications (recipient_id, type, entity_type, entity_id, body, dedupe_key)
  values (
    subject_id,
    'participant_review',
    'bounty',
    p_bounty_id,
    case when normalized_body is null then 'A participant left a rating' else 'A participant left a rating and review' end,
    'participant-review:' || review_row.id::text
  )
  on conflict (dedupe_key) do nothing;

  return to_jsonb(review_row);
end $$;

-- Extend the existing report queue without exposing another table or endpoint.
-- A report against a review covers both the original review and its response.
alter function public.app_marketplace_snapshot(uuid)
  rename to app_marketplace_snapshot_before_profile_specialties;

create function public.app_marketplace_snapshot(p_actor_id uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_set(
    prior.snapshot,
    '{moderationReports}',
    coalesce((
      select jsonb_agg(
        report || jsonb_build_object(
          'content', coalesce(report->'content', '{}'::jsonb) || case report->>'entity_type'
            when 'review' then jsonb_build_object(
              'response_body', review.response_body,
              'response_created_at', review.response_created_at
            )
            when 'profile' then jsonb_build_object(
              'work_types', to_jsonb(profile.work_types),
              'categories', to_jsonb(profile.categories),
              'custom_specialty', profile.custom_specialty
            )
            else '{}'::jsonb
          end
        ) order by report->>'created_at' desc
      )
      from jsonb_array_elements(coalesce(prior.snapshot->'moderationReports', '[]'::jsonb)) report
      left join public.participant_reviews review
        on report->>'entity_type' = 'review' and review.id = (report->>'entity_id')::uuid
      left join public.wallet_accounts profile
        on report->>'entity_type' = 'profile' and profile.id = (report->>'entity_id')::uuid
    ), '[]'::jsonb),
    true
  )
  from (select public.app_marketplace_snapshot_before_profile_specialties(p_actor_id) as snapshot) prior
$$;

revoke all on function public.app_profile_selections_valid(text[])
from public, anon, authenticated, service_role;
revoke all on function public.app_update_public_profile(uuid,text,text,text,text[],text[],text)
from public, anon, authenticated;
revoke all on function public.app_public_wallet_profile(text)
from public, anon, authenticated;
revoke all on function public.app_search_public_wallet_profiles(text,integer)
from public, anon, authenticated;
revoke all on function public.app_create_participant_review_response(uuid,uuid,text)
from public, anon, authenticated;
revoke all on function public.app_create_participant_review(uuid,uuid,integer,text)
from public, anon, authenticated;
revoke all on function public.app_marketplace_snapshot_before_profile_specialties(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.app_marketplace_snapshot(uuid)
from public, anon, authenticated;

grant execute on function public.app_update_public_profile(uuid,text,text,text,text[],text[],text)
to service_role;
grant execute on function public.app_public_wallet_profile(text)
to service_role;
grant execute on function public.app_search_public_wallet_profiles(text,integer)
to service_role;
grant execute on function public.app_create_participant_review_response(uuid,uuid,text)
to service_role;
grant execute on function public.app_create_participant_review(uuid,uuid,integer,text)
to service_role;
grant execute on function public.app_marketplace_snapshot(uuid)
to service_role;
