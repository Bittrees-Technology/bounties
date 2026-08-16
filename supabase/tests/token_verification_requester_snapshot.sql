begin;
select plan(2);

insert into public.wallet_accounts (id, wallet_address) values
  ('91000000-0000-4000-8000-000000000001', '0x9100000000000000000000000000000000000001'),
  ('91000000-0000-4000-8000-000000000002', '0x9100000000000000000000000000000000000002');

insert into public.tokens (
  id, chain_id, contract_address, checksum_address, name, symbol, decimals,
  total_supply, bytecode_present, explorer_url, source_verification_status, risk_flags
) values (
  '91000000-0000-4000-8000-000000000010', 1,
  '0x9100000000000000000000000000000000000010',
  '0x9100000000000000000000000000000000000010',
  'Verified token', 'VFY', 18, 1000000, true,
  'https://etherscan.io/address/0x9100000000000000000000000000000000000010',
  'verified', '[]'
);

insert into public.content_reports (
  id, reporter_id, entity_type, entity_id, reason, status, resolved_by,
  resolved_at, decision, moderator_response, version, request_kind,
  verification_outcome
) values (
  '91000000-0000-4000-8000-000000000020',
  '91000000-0000-4000-8000-000000000001', 'token',
  '91000000-0000-4000-8000-000000000010',
  'Token/source verification review', 'resolved',
  '91000000-0000-4000-8000-000000000002', now(), 'no_action',
  'The token was verified for Bounties.', 2, 'verification_request', 'verified'
);

select is(
  public.app_marketplace_snapshot('91000000-0000-4000-8000-000000000001')
    #>> '{myReports,0,request_kind}',
  'verification_request',
  'the requester snapshot identifies a token verification request'
);

select is(
  public.app_marketplace_snapshot('91000000-0000-4000-8000-000000000001')
    #>> '{myReports,0,verification_outcome}',
  'verified',
  'the requester snapshot preserves the exact moderator outcome'
);

select * from finish();
rollback;
