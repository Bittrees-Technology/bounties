-- Keep private buyer/provider and escrow ownership unchanged.
ALTER TABLE public.shared_moderation_grants DROP CONSTRAINT shared_moderation_grants_source_check;
ALTER TABLE public.shared_moderation_grants ADD CONSTRAINT shared_moderation_grants_source_check CHECK(source IN ('upstash:bittrees:roles','roles.bittrees.org'));
create or replace function public.app_sync_shared_moderation_role(
  p_actor_id uuid,
  p_wallet_address text,
  p_authorized boolean,
  p_source text,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  normalized_wallet text;
  result_row public.shared_moderation_grants;
begin
  normalized_wallet := public.app_normalize_wallet(p_wallet_address);
  if p_actor_id is null
    or normalized_wallet is null
    or not exists (
      select 1 from public.wallet_accounts account
      where account.id = p_actor_id and account.wallet_address = normalized_wallet
    ) then
    raise exception 'ACCOUNT_WALLET_MISMATCH' using errcode = '42501';
  end if;
  if p_authorized is null
    or p_source is null
    or btrim(p_source) <> 'roles.bittrees.org'
    or (p_authorized and (p_expires_at is null or p_expires_at <= clock_timestamp() or p_expires_at > clock_timestamp()+interval '5 seconds')) then
    raise exception 'INVALID_ROLE_PROJECTION' using errcode = '22023';
  end if;

  if p_authorized then
    insert into public.shared_moderation_grants (account_id, source, verified_at, expires_at)
    values (p_actor_id, btrim(p_source), now(), least(p_expires_at,clock_timestamp()+interval '5 seconds'))
    on conflict (account_id) do update
      set source = excluded.source,
          verified_at = excluded.verified_at,
          expires_at = excluded.expires_at
    returning * into result_row;
  else
    delete from public.shared_moderation_grants shared
    where shared.account_id = p_actor_id;
    result_row := null;
  end if;

  return case when result_row.account_id is null then
    jsonb_build_object('account_id', p_actor_id, 'role', null, 'authorized', false)
  else
    jsonb_build_object(
      'account_id', result_row.account_id,
      'role', 'moderator',
      'authorized', true,
      'source', result_row.source,
      'verified_at', result_row.verified_at,
      'expires_at', result_row.expires_at
    )
  end;
end $$;
REVOKE ALL ON FUNCTION public.app_sync_shared_moderation_role(uuid,text,boolean,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.app_sync_shared_moderation_role(uuid,text,boolean,text,timestamptz) TO service_role;
