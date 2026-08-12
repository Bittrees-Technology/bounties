begin;
select plan(41);

insert into public.wallet_accounts (id, wallet_address) values
  ('20000000-0000-4000-8000-000000000001', '0x1111111111111111111111111111111111111111'),
  ('20000000-0000-4000-8000-000000000002', '0x2222222222222222222222222222222222222222'),
  ('20000000-0000-4000-8000-000000000003', '0x3333333333333333333333333333333333333333');

insert into public.account_roles (account_id, role) values
  ('20000000-0000-4000-8000-000000000001', 'buyer'),
  ('20000000-0000-4000-8000-000000000002', 'provider');

insert into public.tokens (
  id, chain_id, contract_address, checksum_address, name, symbol, decimals,
  total_supply, bytecode_present, explorer_url, source_verification_status, risk_flags
) values (
  '20000000-0000-4000-8000-000000000010', 84532,
  '0x4444444444444444444444444444444444444444',
  '0x4444444444444444444444444444444444444444',
  'Profile test token', 'PTT', 6, 1000000, true,
  'https://sepolia.basescan.org/address/0x4444444444444444444444444444444444444444',
  'unverified', '[]'
);

insert into public.bounties (
  id, creator_id, title, description, scope_hash, chain_id, token_id,
  token_decimals, budget_base_units, status
) values (
  '20000000-0000-4000-8000-000000000020',
  '20000000-0000-4000-8000-000000000001',
  'Profile rating fixture', 'Completed work',
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  84532, '20000000-0000-4000-8000-000000000010', 6, 100, 'open'
);

insert into public.proposals (
  id, bounty_id, provider_id, note, proposed_total_base_units,
  proposed_milestones, status
) values (
  '20000000-0000-4000-8000-000000000030',
  '20000000-0000-4000-8000-000000000020',
  '20000000-0000-4000-8000-000000000002',
  'Complete the work', 100, '[]', 'accepted'
);

update public.bounties
set accepted_proposal_id = '20000000-0000-4000-8000-000000000030', status = 'completed'
where id = '20000000-0000-4000-8000-000000000020';

insert into public.escrow_records (
  bounty_id, chain_id, token_id, contract_address, onchain_bounty_id,
  requested_base_units, received_base_units, status, transaction_hash,
  block_hash, log_index, onchain_state, remaining_base_units, state_checked_at
) values (
  '20000000-0000-4000-8000-000000000020', 84532,
  '20000000-0000-4000-8000-000000000010',
  '0x5555555555555555555555555555555555555555', '1',
  100, 100, 'confirmed', '0x' || repeat('1', 64),
  '0x' || repeat('2', 64), 0, 'Released', 0, now()
);

select lives_ok(
  $$ select public.app_update_public_profile(
       '20000000-0000-4000-8000-000000000001',
       'Capital Provider', 'Pays promptly', 'https://example.test/capital') $$,
  'an authenticated account identity can update its public profile through the server routine'
);
select is(
  public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')->>'display_name',
  'Capital Provider', 'the public profile exposes the saved display name'
);
select ok(
  public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')->>'profile_updated_at' is not null,
  'the public profile response includes the typed profile update timestamp'
);
select throws_ok(
  $$ select public.app_update_public_profile(
       '20000000-0000-4000-8000-000000000099', 'Forged', null, null) $$,
  '42501', null, 'an unknown account cannot update a profile'
);
select throws_ok(
  $$ select public.app_update_public_profile(
       '20000000-0000-4000-8000-000000000001', 'Capital Provider', null, 'http://unsafe.test') $$,
  '22023', null, 'profile links must use HTTPS'
);

select lives_ok(
  $$ select public.app_create_participant_review(
       '20000000-0000-4000-8000-000000000001',
       '20000000-0000-4000-8000-000000000020', 5, 'Excellent service delivery') $$,
  'the capital provider can review service received'
);
select lives_ok(
  $$ select public.app_create_participant_review(
       '20000000-0000-4000-8000-000000000002',
       '20000000-0000-4000-8000-000000000020', 3, 'Payment was received') $$,
  'the labor provider can review payment received'
);
select throws_ok(
  $$ select public.app_create_participant_review(
       '20000000-0000-4000-8000-000000000003',
       '20000000-0000-4000-8000-000000000020', 5, 'Unauthorized review') $$,
  '42501', null, 'a nonparticipant still cannot create a review'
);
select throws_ok(
  $$ select public.app_create_participant_review(
       '20000000-0000-4000-8000-000000000001',
       '20000000-0000-4000-8000-000000000020', 4, 'Duplicate review') $$,
  '23505', null, 'the existing one-review-per-participant rule is preserved'
);

select is(
  (public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')
    #>> '{rating_summaries,capital_provider,review_count}')::integer,
  1, 'payment feedback contributes to the capital-provider summary'
);
select is(
  (public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')
    #>> '{rating_summaries,capital_provider,average_rating}')::numeric,
  3.00::numeric, 'capital-provider average is calculated separately'
);
select is(
  (public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')
    #>> '{rating_summaries,labor_provider,review_count}')::integer,
  0, 'capital profile does not mix in labor-provider ratings'
);
select is(
  (public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')
    #>> '{rating_summaries,labor_provider,review_count}')::integer,
  1, 'service feedback contributes to the labor-provider summary'
);
select is(
  (public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')
    #>> '{rating_summaries,labor_provider,average_rating}')::numeric,
  5.00::numeric, 'labor-provider average is calculated separately'
);
select is(
  (public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')
    #>> '{rating_summaries,capital_provider,review_count}')::integer,
  0, 'labor profile does not mix in capital-provider ratings'
);
select is(
  jsonb_array_length(public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')->'reviews_received'),
  1, 'capital-provider profile includes its visible received review'
);
select is(
  jsonb_array_length(public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')->'reviews_received'),
  1, 'labor-provider profile includes its visible received review'
);
select is(
  public.app_public_wallet_profile('0x9999999999999999999999999999999999999999'),
  null, 'an unknown wallet has no public profile'
);
select is(
  public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')#>>'{roles,0}',
  'buyer', 'public profile includes the wallet-selected marketplace role'
);
select ok(
  not has_function_privilege('anon', 'public.app_public_wallet_profile(text)', 'execute'),
  'anonymous PostgREST callers cannot bypass the server profile route'
);
select ok(
  not has_function_privilege('authenticated', 'public.app_public_wallet_profile(text)', 'execute'),
  'authenticated PostgREST callers cannot bypass the server profile route'
);
select ok(
  has_function_privilege('service_role', 'public.app_public_wallet_profile(text)', 'execute'),
  'the server role can read a public profile'
);
select ok(
  has_function_privilege('service_role', 'public.app_update_public_profile(uuid,text,text,text)', 'execute'),
  'the server role can update a profile after session authorization'
);

update public.participant_reviews
set moderation_status = 'hidden', moderation_reason = 'Moderated test review'
where subject_id = '20000000-0000-4000-8000-000000000002';

select is(
  (public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')
    #>> '{rating_summaries,labor_provider,review_count}')::integer,
  0, 'hidden reviews are excluded from labor-provider summaries'
);
select is(
  jsonb_array_length(public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')->'reviews_received'),
  0, 'hidden review text is excluded from the public profile'
);
select is(
  (public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')
    #>> '{rating_summaries,capital_provider,review_count}')::integer,
  1, 'moderating a labor review does not alter the capital-provider summary'
);

select lives_ok(
  $$ select public.app_report_content(
       '20000000-0000-4000-8000-000000000003','profile',
       '20000000-0000-4000-8000-000000000002','Profile contains prohibited content') $$,
  'an authenticated wallet can report a public profile'
);
insert into public.moderation_staff (account_id,role,granted_by)
values ('20000000-0000-4000-8000-000000000001','admin','profile pgTAP fixture');
select is(
  public.app_marketplace_snapshot('20000000-0000-4000-8000-000000000001')
    #>> '{moderationReports,0,content,type}',
  'profile', 'the moderator queue includes profile-specific content context'
);
select lives_ok(
  $$ select public.app_decide_content_report(
       '20000000-0000-4000-8000-000000000001',
       (select id from public.content_reports where entity_type='profile'),
       'hide','Profile violates marketplace rules','Internal profile decision',1) $$,
  'an authorized moderator can hide a reported profile'
);
select is(
  public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')->>'profile_moderation_status',
  'hidden', 'profile visibility is hidden without changing review ratings'
);
select is(
  public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')->>'profile_bio',
  null, 'hidden profile-authored biography is redacted from public output'
);
select lives_ok(
  $$ select public.app_update_public_profile(
       '20000000-0000-4000-8000-000000000002','Edited while hidden','Updated bio','https://example.test/updated') $$,
  'a profile owner can correct hidden content'
);
select is(
  public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')->>'profile_moderation_status',
  'hidden', 'editing cannot self-restore a moderator-hidden profile'
);
select is(
  (select count(*)::integer from public.notifications
    where recipient_id='20000000-0000-4000-8000-000000000002'
      and type='moderation_content_visibility'),
  1, 'profile owner receives the existing moderation visibility notification'
);

select lives_ok(
  $$ select public.app_create_bounty(
       '20000000-0000-4000-8000-000000000001','Ordered schedule','Two milestone delivery',
       '{}'::jsonb,'0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
       84532,'20000000-0000-4000-8000-000000000010','100',
       jsonb_build_array(
         jsonb_build_object('ordinal',0,'title','First','amount_base_units','40','delivery_deadline',(now()+interval '2 days')::text,'scope_source','{}'::jsonb,'evidence_requirements','{}'::jsonb),
         jsonb_build_object('ordinal',1,'title','Second','amount_base_units','60','delivery_deadline',(now()+interval '4 days')::text,'scope_source','{}'::jsonb,'evidence_requirements','{}'::jsonb)
       )) $$,
  'the database persists an exact ordered two-milestone schedule'
);
select is(
  (select count(*)::integer from public.milestones where title in ('First','Second')),
  2, 'all persisted schedule rows remain independently addressable'
);
select ok(
  (select bool_and(delivery_deadline is not null) from public.milestones where title in ('First','Second')),
  'the API-level absolute deadlines persist on milestone rows'
);
select throws_ok(
  $$ select public.app_create_bounty(
       '20000000-0000-4000-8000-000000000001','Bad order','Invalid deadlines','{}'::jsonb,
       '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',84532,
       '20000000-0000-4000-8000-000000000010','100',jsonb_build_array(
         jsonb_build_object('ordinal',0,'title','Later','amount_base_units','40','delivery_deadline',(now()+interval '4 days')::text),
         jsonb_build_object('ordinal',1,'title','Earlier','amount_base_units','60','delivery_deadline',(now()+interval '2 days')::text)
       )) $$,
  '22023', null, 'non-increasing milestone deadlines are rejected'
);
select throws_ok(
  $$ select public.app_create_bounty(
       '20000000-0000-4000-8000-000000000001','Bad suffix','Invalid timeout suffix','{}'::jsonb,
       '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',84532,
       '20000000-0000-4000-8000-000000000010','100',jsonb_build_array(
         jsonb_build_object('ordinal',0,'title','No timeout','amount_base_units','40','delivery_deadline',null),
         jsonb_build_object('ordinal',1,'title','Timed later','amount_base_units','60','delivery_deadline',(now()+interval '4 days')::text)
       )) $$,
  '22023', null, 'a timed milestone cannot follow the no-timeout suffix'
);
select throws_ok(
  $$ select public.app_create_bounty(
       '20000000-0000-4000-8000-000000000001','Bad total','Invalid allocation total','{}'::jsonb,
       '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',84532,
       '20000000-0000-4000-8000-000000000010','100',jsonb_build_array(
         jsonb_build_object('ordinal',0,'title','Short allocation','amount_base_units','99','delivery_deadline',(now()+interval '2 days')::text)
       )) $$,
  '23514', null, 'milestone allocations must sum exactly to funding'
);
select throws_ok(
  $$ delete from public.milestones where title in ('First','Second'); set constraints all immediate $$,
  '23514', null, 'a persisted bounty cannot be left with an empty schedule'
);

select * from finish();
rollback;
