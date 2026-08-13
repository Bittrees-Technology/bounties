-- Discoverable by `supabase test db` and executable directly with psql.
begin;
select plan(16);

insert into public.wallet_accounts (id, wallet_address) values
  ('70000000-0000-4000-8000-000000000001', '0x7111111111111111111111111111111111111111'),
  ('70000000-0000-4000-8000-000000000002', '0x7222222222222222222222222222222222222222'),
  ('70000000-0000-4000-8000-000000000003', '0x7333333333333333333333333333333333333333');

select lives_ok(
  $$ select public.app_sync_shared_moderation_role(
       '70000000-0000-4000-8000-000000000003',
       '0x7333333333333333333333333333333333333333', true,
       'upstash:bittrees:roles') $$,
  'a synchronized moderator can review token reports'
);

insert into public.tokens (
  id, chain_id, contract_address, checksum_address, name, symbol, decimals,
  total_supply, bytecode_present, explorer_url, source_verification_status,
  risk_flags, created_by
) values (
  '70000000-0000-4000-8000-000000000010', 8453,
  '0x7444444444444444444444444444444444444444',
  '0x7444444444444444444444444444444444444444',
  'Suspicious Dollar', 'SCAM', 18, 1000000, true,
  'https://basescan.org/address/0x7444444444444444444444444444444444444444',
  'unverified', '["unverified_source"]',
  '70000000-0000-4000-8000-000000000002'
);

select is(
  (select moderation_status from public.tokens where id='70000000-0000-4000-8000-000000000010'),
  'visible', 'newly inspected tokens begin visible'
);

select lives_ok(
  $$ select public.app_report_content(
       '70000000-0000-4000-8000-000000000001', 'token',
       '70000000-0000-4000-8000-000000000010',
       'Suspected scam token: impersonates a known asset') $$,
  'an authenticated wallet can report an exact token record'
);

select is(
  (select entity_type from public.content_reports where reporter_id='70000000-0000-4000-8000-000000000001'),
  'token', 'the report preserves token as its entity type'
);

select is(
  (select content_moderation_status from public.content_report_events where event_type='submitted'),
  'visible', 'the immutable report event records the token visibility state'
);

select lives_ok(
  $$ select public.app_report_content(
       '70000000-0000-4000-8000-000000000001', 'token',
       '70000000-0000-4000-8000-000000000010',
       'Suspected scam token: additional transfer evidence') $$,
  'a repeated flag updates the reporter existing token report'
);

select is(
  (select count(*)::integer from public.content_reports where reporter_id='70000000-0000-4000-8000-000000000001'),
  1, 'duplicate token flags do not create duplicate reports'
);

select is(
  (select version from public.content_reports where reporter_id='70000000-0000-4000-8000-000000000001'),
  2, 'updating a token report advances its version'
);

select is(
  public.app_marketplace_snapshot('70000000-0000-4000-8000-000000000003') #>> '{moderationReports,0,content,type}',
  'token', 'the moderator queue includes token-specific context'
);

select is(
  public.app_marketplace_snapshot('70000000-0000-4000-8000-000000000003') #>> '{moderationReports,0,content,explorer_url}',
  'https://basescan.org/address/0x7444444444444444444444444444444444444444',
  'moderators receive the exact explorer contract link'
);

select is(
  jsonb_array_length(public.app_marketplace_snapshot('70000000-0000-4000-8000-000000000001')->'moderationReports'),
  0, 'ordinary wallets cannot read the moderator token queue'
);

select is(
  public.app_decide_content_report(
    '70000000-0000-4000-8000-000000000003',
    (select id from public.content_reports where reporter_id='70000000-0000-4000-8000-000000000001'),
    'hide', 'This contract is hidden while the scam report is upheld.', null, 2
  ) #>> '{content,moderation_status}',
  'hidden', 'a moderator can hide the token from Bounties selection'
);

select is(
  (select moderation_status from public.tokens where id='70000000-0000-4000-8000-000000000010'),
  'hidden', 'the token registry persists the moderator visibility decision'
);

select is(
  (select count(*)::integer from public.notifications
   where recipient_id='70000000-0000-4000-8000-000000000002'
     and type='moderation_content_visibility'),
  1, 'the wallet that added the token receives the visibility decision'
);

select throws_ok(
  $$ insert into public.bounties (
       creator_id,title,description,scope_hash,chain_id,token_id,token_decimals,budget_base_units,status
     ) values (
       '70000000-0000-4000-8000-000000000001','Blocked scam token','Should fail closed',
       '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',8453,
       '70000000-0000-4000-8000-000000000010',18,100,'open'
     ) $$,
  '22023', null, 'a hidden token cannot fund a newly created bounty'
);

select is(
  public.app_marketplace_snapshot('70000000-0000-4000-8000-000000000001') #>> '{myReports,0,entity_type}',
  'token', 'the reporter can track the token report and moderator response'
);

select * from finish();
rollback;
