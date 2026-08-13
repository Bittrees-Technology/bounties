-- Preserve the first canonical observation of terminal escrow completion and
-- expose it to public profiles. "Last active" therefore means released or
-- bilaterally settled work, not an application or accepted proposal.

alter table public.escrow_records
  add column if not exists terminal_at timestamptz;

update public.escrow_records
set terminal_at = coalesce(state_checked_at, updated_at)
where onchain_state in ('Released', 'Settled')
  and terminal_at is null;

create function public.app_set_escrow_terminal_at()
returns trigger
language plpgsql
set search_path = public as $$
begin
  if new.onchain_state in ('Released', 'Settled') then
    if tg_op = 'UPDATE' then
      new.terminal_at := coalesce(old.terminal_at, new.state_checked_at, now());
    else
      new.terminal_at := coalesce(new.terminal_at, new.state_checked_at, now());
    end if;
  else
    new.terminal_at := null;
  end if;
  return new;
end $$;

create trigger escrow_records_terminal_at
before insert or update of onchain_state on public.escrow_records
for each row execute function public.app_set_escrow_terminal_at();

alter function public.app_public_wallet_profile(text)
  rename to app_public_wallet_profile_before_completed_activity_at;

create function public.app_public_wallet_profile(p_wallet_address text)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when prior.profile is null then null else
    prior.profile || jsonb_build_object(
      'last_completed_activity_at', (
        select max(escrow.terminal_at)
        from public.bounties bounty
        join public.proposals proposal on proposal.id = bounty.accepted_proposal_id
        join public.escrow_records escrow on escrow.bounty_id = bounty.id
        where bounty.moderation_status = 'visible'
          and bounty.status <> 'draft'
          and escrow.onchain_state in ('Released', 'Settled')
          and (
            bounty.creator_id = account.id
            or proposal.provider_id = account.id
          )
      )
    )
  end
  from (select public.app_public_wallet_profile_before_completed_activity_at(p_wallet_address) as profile) prior
  left join public.wallet_accounts account
    on account.wallet_address = public.app_normalize_wallet(p_wallet_address)
$$;

revoke all on function public.app_set_escrow_terminal_at()
from public,anon,authenticated,service_role;
revoke all on function public.app_public_wallet_profile_before_completed_activity_at(text)
from public,anon,authenticated,service_role;
revoke all on function public.app_public_wallet_profile(text)
from public,anon,authenticated;
grant execute on function public.app_public_wallet_profile(text) to service_role;
