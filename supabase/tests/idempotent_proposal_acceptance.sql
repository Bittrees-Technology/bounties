begin;
select plan(5);

insert into public.wallet_accounts (id, wallet_address) values
  ('41000000-0000-4000-8000-000000000001', '0x4100000000000000000000000000000000000001'),
  ('41000000-0000-4000-8000-000000000002', '0x4100000000000000000000000000000000000002');
insert into public.tokens (
  id, chain_id, contract_address, checksum_address, name, symbol, decimals,
  total_supply, bytecode_present, explorer_url, source_verification_status, risk_flags
) values (
  '41000000-0000-4000-8000-000000000003', 11155111,
  '0x4100000000000000000000000000000000000003', '0x4100000000000000000000000000000000000003',
  'Acceptance test token', 'ATT', 18, 1000000000000000000000, true,
  'https://sepolia.etherscan.io/address/0x4100000000000000000000000000000000000003', 'unverified', '[]'
);
insert into public.bounties (
  id, creator_id, title, description, scope_source, scope_hash, chain_id,
  token_id, token_decimals, budget_base_units, status
) values (
  '41000000-0000-4000-8000-000000000004', '41000000-0000-4000-8000-000000000001',
  'Idempotent applicant selection', 'Acceptance remains durable before wallet funding',
  '{"fundOnApplicantAcceptance":true}', '0x4141414141414141414141414141414141414141414141414141414141414141',
  11155111, '41000000-0000-4000-8000-000000000003', 18, 250000000000000000000, 'open'
);
insert into public.milestones (id, bounty_id, ordinal, title, amount_base_units, delivery_deadline)
values (
  '41000000-0000-4000-8000-000000000005', '41000000-0000-4000-8000-000000000004',
  0, 'Delivery', 250000000000000000000, '2099-12-31T23:59:59.999Z'
);
insert into public.proposals (id, bounty_id, provider_id, note, proposed_total_base_units, proposed_milestones)
values (
  '41000000-0000-4000-8000-000000000006', '41000000-0000-4000-8000-000000000004',
  '41000000-0000-4000-8000-000000000002', 'Selected plan', 250000000000000000000, '[]'
);

select lives_ok(
  $$ select public.app_accept_proposal(
    '41000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000004',
    '41000000-0000-4000-8000-000000000006'
  ) $$,
  'creator can accept an active proposal'
);
select is(
  (select status::text from public.bounties where id = '41000000-0000-4000-8000-000000000004'),
  'accepted', 'bounty remains accepted before wallet funding'
);
select is(
  (select status::text from public.proposals where id = '41000000-0000-4000-8000-000000000006'),
  'accepted', 'selected proposal is accepted'
);
select lives_ok(
  $$ select public.app_accept_proposal(
    '41000000-0000-4000-8000-000000000001',
    '41000000-0000-4000-8000-000000000004',
    '41000000-0000-4000-8000-000000000006'
  ) $$,
  'retrying the same selection is idempotent after wallet funding interruption'
);
select is(
  (select count(*)::integer from public.notifications where dedupe_key = 'proposal-accepted:41000000-0000-4000-8000-000000000006'),
  1, 'idempotent retry does not duplicate the acceptance notification'
);

select * from finish();
rollback;
