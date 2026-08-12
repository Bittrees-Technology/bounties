-- Discoverable by `supabase test db` and executable directly with psql.
begin;
select plan(37);

insert into public.wallet_accounts (id, wallet_address) values
  ('10000000-0000-4000-8000-000000000001', '0x1111111111111111111111111111111111111111'),
  ('10000000-0000-4000-8000-000000000002', '0x2222222222222222222222222222222222222222'),
  ('10000000-0000-4000-8000-000000000003', '0x3333333333333333333333333333333333333333'),
  ('10000000-0000-4000-8000-000000000004', '0x4444444444444444444444444444444444444444');

insert into public.tokens (
  id, chain_id, contract_address, checksum_address, name, symbol, decimals,
  total_supply, bytecode_present, explorer_url, source_verification_status, risk_flags
) values (
  '10000000-0000-4000-8000-000000000010', 8453,
  '0x5555555555555555555555555555555555555555',
  '0x5555555555555555555555555555555555555555',
  'Test token', 'TEST', 6, 1000000, true,
  'https://basescan.org/address/0x5555555555555555555555555555555555555555',
  'unverified', '[]'
);

insert into public.bounties (
  id, creator_id, title, description, scope_hash, chain_id, token_id,
  token_decimals, budget_base_units, status
) values (
  '10000000-0000-4000-8000-000000000020',
  '10000000-0000-4000-8000-000000000003',
  'Reported listing', 'Reported listing details',
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  8453, '10000000-0000-4000-8000-000000000010', 6, 100, 'open'
);

insert into public.escrow_records (
  id, bounty_id, chain_id, token_id, contract_address, interface_version,
  onchain_bounty_id, requested_base_units, received_base_units, status,
  transaction_hash, block_hash, log_index
) values (
  '10000000-0000-4000-8000-000000000030',
  '10000000-0000-4000-8000-000000000020', 8453,
  '10000000-0000-4000-8000-000000000010',
  '0x6666666666666666666666666666666666666666', 'escrow-adapter.v1',
  '1', 100, 100, 'confirmed',
  '0x' || repeat('1', 64), '0x' || repeat('2', 64), 0
);

select ok(
  not has_function_privilege(
    'authenticated',
    'public.app_sync_shared_moderation_role(uuid,text,boolean,text)',
    'execute'
  ),
  'a wallet session cannot self-grant a shared moderator projection'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.app_sync_shared_moderation_role(uuid,text,boolean,text)',
    'execute'
  ),
  'only the server service role can synchronize the shared moderator projection'
);
select ok(
  not has_table_privilege('service_role', 'public.moderation_staff', 'select'),
  'the service role cannot bypass moderation RPCs through the staff table'
);
select ok(
  not has_table_privilege('service_role', 'public.escrow_records', 'update'),
  'the service role cannot mutate escrow bindings through the base table'
);
select throws_ok(
  $$ select public.app_sync_shared_moderation_role(
       '10000000-0000-4000-8000-000000000002',
       '0x3333333333333333333333333333333333333333', true,
       'upstash:bittrees:roles') $$,
  '42501', null, 'shared role synchronization binds the exact account and wallet'
);
select throws_ok(
  $$ select public.app_sync_shared_moderation_role(
       '10000000-0000-4000-8000-000000000002',
       '0x2222222222222222222222222222222222222222', true,
       'untrusted:roles') $$,
  '22023', null, 'shared role synchronization accepts only the established source'
);
select lives_ok(
  $$ select public.app_sync_shared_moderation_role(
       '10000000-0000-4000-8000-000000000002',
       '0x2222222222222222222222222222222222222222', true,
       'upstash:bittrees:roles') $$,
  'a live exact shared moderator role creates a short-lived projection'
);
select ok(
  public.app_is_moderation_staff('10000000-0000-4000-8000-000000000002'),
  'a fresh shared projection authorizes moderation'
);
select is(
  public.app_marketplace_snapshot('10000000-0000-4000-8000-000000000002')->>'staffRole',
  'moderator', 'the snapshot identifies a shared-role moderator'
);
select lives_ok(
  $$ select public.app_consume_rate_limit(
       '10000000-0000-4000-8000-000000000001', 'content_report', 20, 3600) $$,
  'the report endpoint can enforce its independent per-wallet rate limit'
);
select lives_ok(
  $$ select public.app_report_content(
       '10000000-0000-4000-8000-000000000001', 'bounty',
       '10000000-0000-4000-8000-000000000020', 'Potential policy violation') $$,
  'a signed-in wallet can report a listing'
);
select is(
  (select version from public.content_reports
    where reporter_id = '10000000-0000-4000-8000-000000000001'),
  1, 'a new report starts at version one'
);
select is(
  (select count(*)::integer from public.content_report_events),
  1, 'a report submission appends its first immutable history event'
);
select throws_ok(
  $$ select public.app_decide_content_report(
       '10000000-0000-4000-8000-000000000004',
       (select id from public.content_reports where reporter_id = '10000000-0000-4000-8000-000000000001'),
       'hide', 'Hidden after review', null, 1) $$,
  '42501', null, 'a wallet without a moderator projection cannot decide a report'
);
select throws_ok(
  $$ select public.app_decide_content_report(
       '10000000-0000-4000-8000-000000000002',
       (select id from public.content_reports where reporter_id = '10000000-0000-4000-8000-000000000001'),
       'hide', 'Hidden after review', null, 99) $$,
  '40001', null, 'the expected version prevents concurrent decision overwrite'
);
select is(
  public.app_decide_content_report(
    '10000000-0000-4000-8000-000000000002',
    (select id from public.content_reports where reporter_id = '10000000-0000-4000-8000-000000000001'),
    'no_action', 'We reviewed the listing and no action is needed.',
    'Policy check completed', 1
  ) #>> '{content,moderation_status}',
  'visible', 'a no-action decision leaves content visible and returns current state'
);
select is(
  (select status from public.content_reports
    where reporter_id = '10000000-0000-4000-8000-000000000001'),
  'dismissed', 'a no-action decision dismisses only the reviewed report'
);
select is(
  (select moderator_response from public.content_reports
    where reporter_id = '10000000-0000-4000-8000-000000000001'),
  'We reviewed the listing and no action is needed.',
  'the reporter-facing response is persisted'
);
select is(
  (select count(*)::integer from public.notifications
    where recipient_id = '10000000-0000-4000-8000-000000000001'
      and type = 'moderation_report_decision'),
  1, 'the reporter receives a decision notification'
);
select is(
  (select count(*)::integer from public.moderation_actions
    where report_id = (
      select id from public.content_reports
      where reporter_id = '10000000-0000-4000-8000-000000000001'
    ) and action = 'no_action'),
  1, 'the decision is tied to its report in the moderation audit log'
);
select lives_ok(
  $$ select public.app_report_content(
       '10000000-0000-4000-8000-000000000004', 'bounty',
       '10000000-0000-4000-8000-000000000020', 'A separate safety concern') $$,
  'another reporter gets an independent open report'
);
select lives_ok(
  $$ select public.app_consume_rate_limit(
       '10000000-0000-4000-8000-000000000004', 'content_report', 20, 3600) $$,
  'report limits remain isolated between reporting wallets'
);
select lives_ok(
  $$ select public.app_report_content(
       '10000000-0000-4000-8000-000000000001', 'bounty',
       '10000000-0000-4000-8000-000000000020', 'New information after resolution') $$,
  'the original reporter can reopen a resolved report'
);
select is(
  (select version from public.content_reports
    where reporter_id = '10000000-0000-4000-8000-000000000001'),
  3, 'reopening advances beyond both the submission and decision versions'
);
select is(
  (select count(*)::integer from public.content_report_events
    where report_id = (
      select id from public.content_reports
      where reporter_id = '10000000-0000-4000-8000-000000000001'
    ) and decision = 'no_action'),
  1, 'reopening preserves the prior decision in immutable history'
);
select is(
  public.app_decide_content_report(
    '10000000-0000-4000-8000-000000000002',
    (select id from public.content_reports where reporter_id = '10000000-0000-4000-8000-000000000001'),
    'hide', 'This listing violates marketplace policy.', null, 3
  ) #>> '{content,moderation_status}',
  'hidden', 'a report-scoped hide decision atomically changes frontend visibility'
);
select is(
  (select status from public.content_reports
    where reporter_id = '10000000-0000-4000-8000-000000000004'),
  'open', 'deciding one report does not resolve a different report for the entity'
);
select is(
  (select count(*)::integer from public.notifications
    where recipient_id = '10000000-0000-4000-8000-000000000003'
      and type = 'moderation_content_visibility'),
  1, 'a hide decision notifies the content owner when distinct from the reporter'
);
select throws_ok(
  $$ update public.content_report_events set reason = 'Tampered history' $$,
  '42501', null, 'report history cannot be rewritten'
);
select throws_ok(
  $$ update public.escrow_records
       set transaction_hash = '0x' || repeat('3', 64)
       where id = '10000000-0000-4000-8000-000000000030' $$,
  '23505', null, 'a persisted escrow identity cannot be rebound'
);
select throws_ok(
  $$ select public.app_record_escrow_state(
       '10000000-0000-4000-8000-000000000003',
       '10000000-0000-4000-8000-000000000020', null, '100', null,
       '0x0000000000000000000000000000000000000000', '0') $$,
  '22023', null, 'a NULL canonical state is rejected explicitly'
);
select lives_ok(
  $$ select public.app_sync_shared_moderation_role(
       '10000000-0000-4000-8000-000000000002',
       '0x2222222222222222222222222222222222222222', false,
       'upstash:bittrees:roles') $$,
  'an absent live shared role removes its projection'
);
select ok(
  not public.app_is_moderation_staff('10000000-0000-4000-8000-000000000002'),
  'role removal fails closed immediately'
);
select throws_ok(
  $$ select public.app_decide_content_report(
       '10000000-0000-4000-8000-000000000002',
       (select id from public.content_reports where reporter_id = '10000000-0000-4000-8000-000000000004'),
       'no_action', 'No action after review', null, 1) $$,
  '42501', null, 'a revoked shared moderator cannot decide a remaining report'
);
select is(
  jsonb_array_length(
    public.app_marketplace_snapshot('10000000-0000-4000-8000-000000000004')->'moderationReports'
  ),
  0, 'an ordinary wallet receives no moderator queue data'
);
select is(
  (select count(*)::integer from public.content_report_events
    where event_type = 'decided'),
  2, 'both completed decisions remain in append-only report history'
);
select is(
  (select count(*)::integer from public.api_rate_limits
    where action = 'content_report'),
  2, 'report submission is bounded independently for each reporting wallet'
);

select * from finish();
rollback;
