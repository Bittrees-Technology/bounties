-- Bound anonymous wallet-auth and public-profile work before it can trigger
-- expensive verification or chain RPC. Only keyed source digests are stored;
-- raw network addresses never enter application persistence.

create table public.anonymous_api_rate_limits (
  bucket_digest text not null check (bucket_digest ~ '^[0-9a-f]{64}$'),
  action text not null check (action in ('auth_nonce_source', 'auth_verify_source', 'public_profile_discovery')),
  window_started_at timestamptz not null default now(),
  request_count integer not null default 0 check (request_count >= 0),
  primary key (bucket_digest, action)
);

alter table public.anonymous_api_rate_limits enable row level security;
alter table public.anonymous_api_rate_limits force row level security;
revoke all on public.anonymous_api_rate_limits from public, anon, authenticated;
create index anonymous_api_rate_limits_window_idx
  on public.anonymous_api_rate_limits (window_started_at);

create function public.app_consume_anonymous_rate_limit(
  p_bucket_digest text,
  p_action text,
  p_limit integer,
  p_window_seconds integer
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare current_row public.anonymous_api_rate_limits;
begin
  if p_bucket_digest !~ '^[0-9a-f]{64}$'
     or p_action not in ('auth_nonce_source', 'auth_verify_source', 'public_profile_discovery')
     or p_limit < 1 or p_limit > 1000
     or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'RATE_LIMIT_CONFIG_INVALID' using errcode = '22023';
  end if;

  delete from public.anonymous_api_rate_limits
   where window_started_at < now() - interval '1 day';

  insert into public.anonymous_api_rate_limits (bucket_digest, action, window_started_at, request_count)
  values (p_bucket_digest, p_action, now(), 1)
  on conflict (bucket_digest, action) do update
    set window_started_at = case
          when public.anonymous_api_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds)
            then now()
          else public.anonymous_api_rate_limits.window_started_at
        end,
        request_count = case
          when public.anonymous_api_rate_limits.window_started_at <= now() - make_interval(secs => p_window_seconds)
            then 1
          else public.anonymous_api_rate_limits.request_count + 1
        end
  returning * into current_row;

  if current_row.request_count > p_limit then
    raise exception 'RATE_LIMITED' using errcode = '22023';
  end if;
end
$$;

alter table public.auth_nonces
  add column source_digest text check (source_digest is null or source_digest ~ '^[0-9a-f]{64}$'),
  add column verification_attempts integer not null default 0 check (verification_attempts between 0 and 5);

create index auth_nonces_source_window_idx
  on public.auth_nonces (source_digest, issued_at desc)
  where consumed_at is null;

-- The source bucket is concurrency-safe in anonymous_api_rate_limits. The
-- existing wallet/domain limit is serialized explicitly so parallel requests
-- cannot all pass the count check.
create function public.app_issue_auth_nonce(
  p_wallet_address text,
  p_chain_id bigint,
  p_domain text,
  p_uri text,
  p_source_digest text,
  p_nonce_digest text,
  p_issued_at timestamptz,
  p_expires_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_wallet text := public.app_normalize_wallet(p_wallet_address);
  nonce_id uuid;
begin
  if normalized_wallet is null then raise exception 'INVALID_WALLET' using errcode = '22023'; end if;
  if p_domain is null or p_domain = '' or p_uri is null or p_uri = '' then
    raise exception 'INVALID_NONCE_ORIGIN' using errcode = '22023';
  end if;
  if p_source_digest !~ '^[0-9a-f]{64}$' or p_nonce_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_NONCE_DIGEST' using errcode = '22023';
  end if;
  if p_issued_at < now() - interval '30 seconds'
     or p_issued_at > now() + interval '30 seconds'
     or p_expires_at <> p_issued_at + interval '5 minutes' then
    raise exception 'INVALID_NONCE_LIFETIME' using errcode = '22023';
  end if;

  perform public.app_consume_anonymous_rate_limit(p_source_digest, 'auth_nonce_source', 30, 300);
  perform pg_advisory_xact_lock(hashtextextended(normalized_wallet || E'\n' || p_domain, 0));
  delete from public.auth_nonces where expires_at < now() - interval '1 day';
  if (select count(*) from public.auth_nonces
      where wallet_address = normalized_wallet
        and domain = p_domain
        and issued_at >= now() - interval '5 minutes') >= 10 then
    raise exception 'NONCE_RATE_LIMITED' using errcode = '22023';
  end if;

  insert into public.auth_nonces (
    wallet_address, chain_id, domain, uri, source_digest, nonce_digest, issued_at, expires_at
  ) values (
    normalized_wallet, p_chain_id, p_domain, p_uri, p_source_digest, p_nonce_digest, p_issued_at, p_expires_at
  ) returning id into nonce_id;
  return nonce_id;
end
$$;

drop function public.app_issue_auth_nonce(text,bigint,text,text,text,timestamptz,timestamptz);

-- Validation reserves one of five bounded attempts without consuming the
-- challenge. A mistyped or transiently failed signature may therefore retry,
-- while an arbitrary or replayed nonce cannot reach EIP-1271 chain RPC.
create function public.app_validate_auth_nonce(
  p_nonce_id uuid,
  p_nonce_digest text,
  p_wallet_address text,
  p_chain_id bigint,
  p_domain text,
  p_uri text,
  p_issued_at timestamptz,
  p_expires_at timestamptz,
  p_source_digest text
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.app_consume_anonymous_rate_limit(p_source_digest, 'auth_verify_source', 30, 300);
  update public.auth_nonces
     set verification_attempts = verification_attempts + 1
   where id = p_nonce_id
     and nonce_digest = p_nonce_digest
     and wallet_address = public.app_normalize_wallet(p_wallet_address)
     and chain_id = p_chain_id
     and domain = p_domain
     and uri = p_uri
     and issued_at = p_issued_at
     and expires_at = p_expires_at
     and consumed_at is null
     and expires_at > now()
     and verification_attempts < 5;
  if not found then
    raise exception 'NONCE_INVALID_OR_EXPIRED' using errcode = '28000';
  end if;
  return true;
end
$$;

create or replace function public.app_consume_auth_nonce(
  p_nonce_id uuid,
  p_nonce_digest text,
  p_wallet_address text,
  p_chain_id bigint,
  p_domain text,
  p_uri text,
  p_issued_at timestamptz,
  p_expires_at timestamptz
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare account_id uuid;
begin
  update public.auth_nonces
     set consumed_at = now()
   where id = p_nonce_id
     and nonce_digest = p_nonce_digest
     and wallet_address = public.app_normalize_wallet(p_wallet_address)
     and chain_id = p_chain_id
     and domain = p_domain
     and uri = p_uri
     and issued_at = p_issued_at
     and expires_at = p_expires_at
     and verification_attempts between 1 and 5
     and consumed_at is null
     and expires_at > now();
  if not found then raise exception 'NONCE_INVALID_OR_EXPIRED' using errcode = '28000'; end if;
  insert into public.wallet_accounts (wallet_address)
  values (public.app_normalize_wallet(p_wallet_address))
  on conflict (wallet_address) do update set last_seen_at = now()
  returning id into account_id;
  return account_id;
end
$$;

revoke all on function public.app_consume_anonymous_rate_limit(text,text,integer,integer) from public, anon, authenticated;
revoke all on function public.app_issue_auth_nonce(text,bigint,text,text,text,text,timestamptz,timestamptz) from public, anon, authenticated;
revoke all on function public.app_validate_auth_nonce(uuid,text,text,bigint,text,text,timestamptz,timestamptz,text) from public, anon, authenticated;
revoke all on function public.app_consume_auth_nonce(uuid,text,text,bigint,text,text,timestamptz,timestamptz) from public, anon, authenticated;

grant execute on function public.app_consume_anonymous_rate_limit(text,text,integer,integer) to service_role;
grant execute on function public.app_issue_auth_nonce(text,bigint,text,text,text,text,timestamptz,timestamptz) to service_role;
grant execute on function public.app_validate_auth_nonce(uuid,text,text,bigint,text,text,timestamptz,timestamptz,text) to service_role;
grant execute on function public.app_consume_auth_nonce(uuid,text,text,bigint,text,text,timestamptz,timestamptz) to service_role;
