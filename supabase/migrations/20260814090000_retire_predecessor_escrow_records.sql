-- Preserve predecessor deployment records for private audit purposes while
-- starting the public marketplace from the replacement escrow deployment.

update public.bounties bounty
set
  moderation_status = 'hidden',
  moderation_reason = 'Retired predecessor escrow deployment'
where bounty.moderation_status = 'visible'
  and exists (
    select 1
    from public.escrow_records escrow
    where escrow.bounty_id = bounty.id
      and lower(escrow.contract_address) = lower('0x49f1B16d144df1D72D2056fB33342f563B1eFC74')
  );
