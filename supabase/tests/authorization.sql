-- Discoverable by `supabase test db` and executable directly with psql.
begin;
select plan(73);

select ok(
  not has_table_privilege('anon', 'public.milestones', 'select'),
  'anonymous REST access cannot reconstruct hidden bounty milestones'
);
select ok(
  not has_table_privilege('authenticated', 'public.bounties', 'select'),
  'browser sessions cannot bypass the same-origin service API through base tables'
);

-- Test through the same transaction-local wallet claim used by the application API.
-- Grants are transaction-scoped test harness setup; production grants remain migration-owned.
grant select, insert, update, delete on
  public.wallet_accounts, public.account_roles, public.auth_nonces, public.wallet_sessions,
  public.tokens, public.bounties, public.proposals, public.milestones,
  public.delivery_evidence, public.escrow_records, public.notifications to authenticated;

create temporary table qa_ids (
  buyer uuid, provider uuid, stranger uuid, token uuid, bounty uuid,
  proposal uuid, milestone_one uuid, milestone_two uuid, notification uuid
);
grant select on qa_ids to authenticated;

insert into public.wallet_accounts (wallet_address) values
  ('0x1111111111111111111111111111111111111111'),
  ('0x2222222222222222222222222222222222222222'),
  ('0x3333333333333333333333333333333333333333');
insert into public.tokens (
  chain_id, contract_address, checksum_address, name, symbol, decimals,
  total_supply, bytecode_present, explorer_url, source_verification_status, risk_flags
) values (
  8453, '0x4444444444444444444444444444444444444444',
  '0x4444444444444444444444444444444444444444', 'Collision token', 'USDC', 6,
  1000000000, true, 'https://basescan.org/address/0x4444444444444444444444444444444444444444',
  'unverified', '["symbol_collision","unverified_source"]'
);
insert into qa_ids (buyer, provider, stranger, token, bounty, proposal, milestone_one, milestone_two, notification)
select
  (select id from public.wallet_accounts where wallet_address = '0x1111111111111111111111111111111111111111'),
  (select id from public.wallet_accounts where wallet_address = '0x2222222222222222222222222222222222222222'),
  (select id from public.wallet_accounts where wallet_address = '0x3333333333333333333333333333333333333333'),
  (select id from public.tokens where chain_id = 8453 and contract_address = '0x4444444444444444444444444444444444444444'),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid();

set local role authenticated;
select throws_ok(
  $$ insert into public.bounties (creator_id,title,description,scope_hash,chain_id,token_id,token_decimals,budget_base_units)
     values (gen_random_uuid(),'Unauthorized','x','0x' || repeat('0',64),1,gen_random_uuid(),18,1) $$,
  '42501', null, 'anonymous/missing-claim bounty insertion is denied'
);
select is(public.app_current_wallet(), null, 'missing claim resolves to no wallet');
select set_config('app.wallet_address', 'not-a-wallet', true);
select is(public.app_current_account_id(), null, 'malformed claim resolves to no account');
select throws_ok(
  $$ insert into public.account_roles (account_id, role) values ((select buyer from qa_ids), 'buyer') $$,
  '42501', null, 'malformed claim cannot forge a role'
);

select set_config('app.wallet_address', '0x1111111111111111111111111111111111111111', true);
select lives_ok(
  $$ insert into public.account_roles (account_id, role) values ((select buyer from qa_ids), 'buyer') $$,
  'wallet may self-select the buyer capability'
);
select lives_ok(
  $$ insert into public.bounties
       (id,creator_id,title,description,scope_source,scope_hash,chain_id,token_id,token_decimals,budget_base_units,status)
     values ((select bounty from qa_ids),(select buyer from qa_ids),'Exact 250 bounty','Persistent scope',
       '{"acceptance":"evidence"}', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
       8453,(select token from qa_ids),6,250,'open');
     insert into public.milestones
       (id,bounty_id,ordinal,title,amount_base_units,assigned_provider_id)
     values
       ((select milestone_one from qa_ids),(select bounty from qa_ids),0,'First',125,null),
       ((select milestone_two from qa_ids),(select bounty from qa_ids),1,'Second',125,null);
     set constraints all immediate $$,
  'any authenticated wallet can persist an exactly reconciled bounty'
);
select is((select sum(amount_base_units)::text from public.milestones where bounty_id = (select bounty from qa_ids)), '250', 'milestone base units persist exactly');
select throws_ok(
  $$ insert into public.milestones (bounty_id,ordinal,title,amount_base_units)
     values ((select bounty from qa_ids),2,'Rounding loss',1); set constraints all immediate $$,
  '23514', null, 'custom milestone sum mismatch is rejected'
);

select set_config('app.wallet_address', '0x2222222222222222222222222222222222222222', true);
select lives_ok(
  $$ insert into public.account_roles (account_id, role) values ((select provider from qa_ids), 'provider') $$,
  'wallet may self-select the provider capability'
);
select throws_ok(
  $$ insert into public.proposals (bounty_id,provider_id,note,proposed_total_base_units,proposed_milestones)
     values ((select bounty from qa_ids),(select buyer from qa_ids),'forged provider',250,'[]') $$,
  '42501', null, 'provider identity cannot be forged'
);
select lives_ok(
  $$ insert into public.proposals (id,bounty_id,provider_id,note,proposed_total_base_units,proposed_milestones)
     values ((select proposal from qa_ids),(select bounty from qa_ids),(select provider from qa_ids),
       'Delivery with evidence',250,'[{"amount":"125"},{"amount":"125"}]') $$,
  'another authenticated wallet can propose without an allowlist'
);
select is_empty(
  $$ update public.bounties set title = 'Provider takeover' where id = (select bounty from qa_ids) returning id $$,
  'non-owner cannot edit a bounty'
);
select is_empty(
  $$ update public.bounties set accepted_proposal_id = (select proposal from qa_ids), status = 'accepted'
     where id = (select bounty from qa_ids) returning id $$,
  'non-owner cannot accept a proposal'
);
select throws_ok(
  $$ insert into public.delivery_evidence (milestone_id,provider_id,uri,content_hash,evidence_hash)
     values ((select milestone_one from qa_ids),(select provider from qa_ids),'https://example.test/early',
       '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
       '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc') $$,
  '42501', null, 'unassigned provider cannot submit delivery'
);

select set_config('app.wallet_address', '0x1111111111111111111111111111111111111111', true);
select lives_ok(
  $$ update public.bounties set accepted_proposal_id = (select proposal from qa_ids), status = 'accepted'
     where id = (select bounty from qa_ids);
     update public.milestones set assigned_provider_id = (select provider from qa_ids), status = 'assigned'
     where bounty_id = (select bounty from qa_ids); set constraints all immediate $$,
  'creator accepts the matching proposal and assigns milestones'
);
reset role;
select throws_ok(
  $$ select public.app_submit_delivery_evidence(
       (select provider from qa_ids),(select milestone_one from qa_ids),'https://example.test/unfunded',
       '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab',
       '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaac','bounties-evidence-v1') $$,
  '22023', null, 'server rejects delivery evidence before escrow funding is verified'
);
set local role authenticated;
select set_config('app.wallet_address', '0x1111111111111111111111111111111111111111', true);
select lives_ok(
  $$ update public.milestones set status = 'funded'
     where bounty_id = (select bounty from qa_ids); set constraints all immediate $$,
  'verified funding state unlocks assigned milestones for delivery'
);
select is_empty(
  $$ update public.proposals set proposed_total_base_units = 249 where id = (select proposal from qa_ids) returning id $$,
  'buyer cannot mutate an accepted provider proposal'
);
select throws_ok(
  $$ insert into public.proposals (bounty_id,provider_id,note,proposed_total_base_units,proposed_milestones)
     values ((select bounty from qa_ids),(select buyer from qa_ids),'self proposal',250,'[]') $$,
  '42501', null, 'creator cannot propose to own bounty'
);

select set_config('app.wallet_address', '0x2222222222222222222222222222222222222222', true);
select lives_ok(
  $$ insert into public.delivery_evidence (milestone_id,provider_id,uri,content_hash,evidence_hash)
     values ((select milestone_one from qa_ids),(select provider from qa_ids),'https://example.test/evidence',
       '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
       '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') $$,
  'assigned provider persists delivery evidence'
);
select is((select count(*)::integer from public.delivery_evidence where milestone_id = (select milestone_one from qa_ids)), 1, 'delivery evidence survives a subsequent query');
select is_empty(
  $$ update public.milestones set status = 'accepted' where id = (select milestone_one from qa_ids) returning id $$,
  'provider cannot accept its own delivery'
);

reset role;
insert into public.notifications (id,recipient_id,type,entity_type,entity_id,body,dedupe_key)
values ((select notification from qa_ids),(select buyer from qa_ids),'proposal','bounty',(select bounty from qa_ids),'Proposal received','qa-proposal');
set local role authenticated;
select set_config('app.wallet_address', '0x2222222222222222222222222222222222222222', true);
select is((select count(*)::integer from public.notifications), 0, 'cross-account notifications are hidden');
select is_empty(
  $$ update public.notifications set read_at = now() where id = (select notification from qa_ids) returning id $$,
  'cross-account notification update is denied'
);
select throws_ok(
  $$ insert into public.tokens (chain_id,contract_address,checksum_address,explorer_url)
     values (8453,'0x5555555555555555555555555555555555555555','0x5555555555555555555555555555555555555555','https://basescan.org/address/0x5555555555555555555555555555555555555555') $$,
  '42501', null, 'wallet cannot bypass server-side token inspection/finalization'
);
select is((select jsonb_array_length(risk_flags) from public.tokens where id = (select token from qa_ids)), 2, 'token collision and verification risk flags persist');
select is(
  left((select explorer_url from public.tokens where id = (select token from qa_ids)), length('https://basescan.org/address/')),
  'https://basescan.org/address/',
  'token record retains a direct explorer contract link'
);

reset role;
select is(
  jsonb_typeof(public.app_bounty_json((select bounty from qa_ids),(select buyer from qa_ids))->'budget_base_units'),
  'string',
  'bounty budget base units serialize as an exact JSON string'
);
select is(
  public.app_bounty_json((select bounty from qa_ids),(select buyer from qa_ids))->>'budget_base_units',
  '250',
  'serialized bounty budget retains its exact base-unit value'
);
select is(
  jsonb_typeof(public.app_bounty_json((select bounty from qa_ids),(select buyer from qa_ids))#>'{milestones,0,amount_base_units}'),
  'string',
  'milestone base units serialize as exact JSON strings'
);
select is(
  jsonb_typeof(public.app_bounty_json((select bounty from qa_ids),(select buyer from qa_ids))#>'{token,total_supply}'),
  'string',
  'token total supply serializes without JavaScript precision loss'
);
select lives_ok(
  $$ select public.app_issue_auth_nonce(
       '0x3333333333333333333333333333333333333333',8453,'example.test','https://example.test',repeat('f',64),repeat('a',64),
       date_trunc('milliseconds',now()),date_trunc('milliseconds',now()) + interval '5 minutes') $$,
  'service auth path can issue a bound five-minute nonce'
);
select lives_ok(
  $$ do $auth$
       declare nonce_row public.auth_nonces;
       begin
         select * into nonce_row from public.auth_nonces where nonce_digest = repeat('a',64);
         perform public.app_validate_auth_nonce(
           nonce_row.id,repeat('a',64),'0x3333333333333333333333333333333333333333',8453,
           'example.test','https://example.test',nonce_row.issued_at,nonce_row.expires_at,repeat('f',64));
         perform public.app_consume_auth_nonce(
           nonce_row.id,repeat('a',64),'0x3333333333333333333333333333333333333333',8453,
           'example.test','https://example.test',nonce_row.issued_at,nonce_row.expires_at);
       end $auth$ $$,
  'matching nonce is consumed once and creates the wallet account identity'
);
select throws_ok(
  $$ select public.app_consume_auth_nonce(
       (select id from public.auth_nonces where nonce_digest = repeat('a',64)),repeat('a',64),
       '0x3333333333333333333333333333333333333333',8453,'example.test','https://example.test',
       (select issued_at from public.auth_nonces where nonce_digest = repeat('a',64)),
       (select expires_at from public.auth_nonces where nonce_digest = repeat('a',64))) $$,
  '28000', null, 'nonce replay is rejected'
);
select lives_ok(
  $$ select public.app_create_wallet_session((select stranger from qa_ids),repeat('b',64),repeat('c',64)) $$,
  'service auth path persists only session and CSRF digests'
);
set local role authenticated;
select set_config('app.wallet_address', '0x2222222222222222222222222222222222222222', true);
select is((select count(*)::integer from public.wallet_sessions), 0, 'cross-account sessions are hidden');
select set_config('app.wallet_address', '0x3333333333333333333333333333333333333333', true);
select is((select count(*)::integer from public.wallet_sessions), 1, 'session owner can resolve its persisted session');
reset role;
select lives_ok(
  $$ select * from public.app_resolve_wallet_session(repeat('b',64), repeat('c',64), true) $$,
  'server API resolves a valid session by digest and matching CSRF digest'
);
select throws_ok(
  $$ select * from public.app_resolve_wallet_session(repeat('b',64), repeat('d',64), true) $$,
  '28000', null, 'server API rejects a valid session token with the wrong CSRF digest'
);
select throws_ok(
  $$ select public.app_create_proposal((select buyer from qa_ids),(select bounty from qa_ids),'self through API',250::text,'[]'::jsonb) $$,
  '22023', null, 'server proposal RPC rejects a proposal after bounty acceptance'
);
select throws_ok(
  $$ select public.app_mark_notification_read((select provider from qa_ids),(select notification from qa_ids)) $$,
  '42501', null, 'server notification RPC rejects cross-account notification updates'
);
select lives_ok(
  $$ select public.app_mark_notification_read((select buyer from qa_ids),(select notification from qa_ids)) $$,
  'server notification RPC lets the recipient mark a notification read'
);
select lives_ok(
  $$ select public.app_revoke_wallet_session(
       (select session_id from public.app_resolve_wallet_session(repeat('b',64), repeat('c',64), true)),
       (select stranger from qa_ids)) $$,
  'server logout RPC revokes the current session'
);
select throws_ok(
  $$ select * from public.app_resolve_wallet_session(repeat('b',64), repeat('c',64), true) $$,
  '28000', null, 'revoked sessions cannot be reused'
);

set local role authenticated;
select set_config('app.wallet_address', '0x1111111111111111111111111111111111111111', true);
select lives_ok(
  $$ update public.milestones set status = 'accepted' where id = (select milestone_one from qa_ids) $$,
  'creator accepts delivered milestone state'
);
select is((select status::text from public.milestones where id = (select milestone_one from qa_ids)), 'accepted', 'create/propose/accept/deliver lifecycle remains persisted');

reset role;
select lives_ok(
  $$ insert into public.escrow_records (
       bounty_id,chain_id,token_id,contract_address,onchain_bounty_id,
       requested_base_units,received_base_units,status,transaction_hash,block_hash,log_index
     ) values (
       (select bounty from qa_ids),8453,(select token from qa_ids),
       '0x6666666666666666666666666666666666666666','7',250,250,'confirmed',
       '0x' || repeat('1',64),'0x' || repeat('2',64),0
     ) $$,
  'verified escrow record is available for canonical state observations'
);
select throws_ok(
  $$ select public.app_create_participant_review((select buyer from qa_ids),(select bounty from qa_ids),5,'Null state') $$,
  '22023', null, 'null canonical state and freshness cannot bypass terminal review verification'
);
select lives_ok(
  $$ select public.app_record_escrow_observation(
       (select buyer from qa_ids),(select bounty from qa_ids),
       '0x6666666666666666666666666666666666666666','escrow-adapter.v1','7','250','250','confirmed',
       '0x' || repeat('1',64),'0x' || repeat('2',64),0) $$,
  'an identical escrow binding replay is idempotent'
);
select throws_ok(
  $$ select public.app_record_escrow_observation(
       (select buyer from qa_ids),(select bounty from qa_ids),
       '0x6666666666666666666666666666666666666666','escrow-adapter.v1','8','250','250','confirmed',
       '0x' || repeat('3',64),'0x' || repeat('4',64),1) $$,
  '23505', null, 'a confirmed bounty cannot be rebound to a different escrow transaction'
);
select lives_ok(
  $$ select public.app_record_escrow_state(
       (select buyer from qa_ids),(select bounty from qa_ids),'Funded','250',null::timestamptz,
       '0x0000000000000000000000000000000000000000','0') $$,
  'a bounty participant can persist a canonical nonterminal escrow state'
);
select throws_ok(
  $$ select public.app_create_participant_review((select buyer from qa_ids),(select bounty from qa_ids),5,'Too early') $$,
  '22023', null, 'reviews are rejected until a fresh terminal onchain state is verified'
);
select throws_ok(
  $$ select public.app_record_escrow_state(
       (select stranger from qa_ids),(select bounty from qa_ids),'Released','0',null::timestamptz,
       '0x0000000000000000000000000000000000000000','0') $$,
  '42501', null, 'a nonparticipant cannot record escrow state'
);
select lives_ok(
  $$ insert into public.moderation_staff (account_id,role,granted_by)
     values ((select buyer from qa_ids),'admin','pgTAP operations fixture') $$,
  'operations can provision a wallet account as moderation staff outside public RPCs'
);
select throws_ok(
  $$ select public.app_moderate_content(
       (select stranger from qa_ids),'bounty',(select bounty from qa_ids),'hide','Unauthorized hide') $$,
  '42501', null, 'a normal wallet cannot hide marketplace content'
);
select lives_ok(
  $$ select public.app_moderate_content(
       (select buyer from qa_ids),'bounty',(select bounty from qa_ids),'hide','Prohibited service listing') $$,
  'an authorized moderator can hide a bounty from public discovery'
);
select is(
  (select moderation_status from public.bounties where id = (select bounty from qa_ids)),
  'hidden', 'moderation changes only the persisted frontend visibility state'
);
select lives_ok(
  $$ select public.app_moderate_content(
       (select buyer from qa_ids),'bounty',(select bounty from qa_ids),'restore','Restored after review') $$,
  'authorized moderation can restore a bounty'
);
select lives_ok(
  $$ select public.app_record_escrow_state(
       (select buyer from qa_ids),(select bounty from qa_ids),'Released','0',now(),
       '0x0000000000000000000000000000000000000000','0') $$,
  'participant refresh can persist a freshly verified released state'
);
select lives_ok(
  $$ select public.app_create_participant_review(
       (select buyer from qa_ids),(select bounty from qa_ids),5,'Service delivered as agreed') $$,
  'buyer can review service after terminal verification'
);
select throws_ok(
  $$ select public.app_create_participant_review(
       (select buyer from qa_ids),(select bounty from qa_ids),4,'Duplicate review') $$,
  '23505', null, 'each participant may publish only one review per bounty'
);
select lives_ok(
  $$ select public.app_create_participant_review(
       (select provider from qa_ids),(select bounty from qa_ids),5,'Payment received as agreed') $$,
  'provider can review payment after terminal verification'
);
select throws_ok(
  $$ select public.app_create_participant_review(
       (select stranger from qa_ids),(select bounty from qa_ids),1,'Not a participant') $$,
  '42501', null, 'nonparticipants cannot review either party'
);
select is(
  (select count(*)::integer from public.participant_reviews where bounty_id = (select bounty from qa_ids)),
  2, 'the bilateral review pair persists independently'
);
select lives_ok(
  $$ select public.app_report_content(
       (select provider from qa_ids),'bounty',(select bounty from qa_ids),'Potential policy violation') $$,
  'participants can report content for moderator review'
);
select lives_ok(
  $$ select public.app_moderate_content(
       (select buyer from qa_ids),'review',
       (select id from public.participant_reviews where author_id = (select provider from qa_ids)),
       'hide','Review contains prohibited content') $$,
  'moderators can hide a review without changing the escrow'
);
select is(
  (select moderation_status from public.participant_reviews where author_id = (select provider from qa_ids)),
  'hidden', 'hidden review remains stored for audit and participant visibility'
);
select is(
  (select count(*)::integer from public.moderation_actions),
  3, 'every hide or restore action is retained in the immutable moderation log'
);
select is(
  public.app_marketplace_snapshot((select buyer from qa_ids))->>'staffRole',
  'admin', 'staff role is returned only from the server-owned marketplace snapshot'
);
select lives_ok(
  $$ select public.app_consume_rate_limit((select buyer from qa_ids),'token_inspection',30,600) $$,
  'the first token inspection in a window is admitted'
);
update public.api_rate_limits set request_count = 30
where actor_id = (select buyer from qa_ids) and action = 'token_inspection';
select throws_ok(
  $$ select public.app_consume_rate_limit((select buyer from qa_ids),'token_inspection',30,600) $$,
  '22023', null, 'token inspection work is bounded per wallet and time window'
);

select * from finish();
rollback;
