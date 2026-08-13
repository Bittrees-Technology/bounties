begin;
select plan(36);

insert into public.wallet_accounts (id, wallet_address) values
  ('22000000-0000-4000-8000-000000000001','0x1111111111111111111111111111111111111111'),
  ('22000000-0000-4000-8000-000000000002','0x2222222222222222222222222222222222222222'),
  ('22000000-0000-4000-8000-000000000003','0x3333333333333333333333333333333333333333');

insert into public.account_roles (account_id,role) values
  ('22000000-0000-4000-8000-000000000001','buyer'),
  ('22000000-0000-4000-8000-000000000002','provider');

insert into public.tokens (
  id,chain_id,contract_address,checksum_address,name,symbol,decimals,total_supply,
  bytecode_present,explorer_url,source_verification_status,risk_flags
) values (
  '22000000-0000-4000-8000-000000000010',84532,
  '0x4444444444444444444444444444444444444444','0x4444444444444444444444444444444444444444',
  'Profile response token','PRT',6,1000000,true,
  'https://sepolia.basescan.org/address/0x4444444444444444444444444444444444444444','unverified','[]'
);

insert into public.bounties (
  id,creator_id,title,description,scope_hash,chain_id,token_id,token_decimals,
  budget_base_units,status
) values (
  '22000000-0000-4000-8000-000000000020','22000000-0000-4000-8000-000000000001',
  'Review response fixture','Completed profile work',
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  84532,'22000000-0000-4000-8000-000000000010',6,100,'open'
);

insert into public.proposals (
  id,bounty_id,provider_id,note,proposed_total_base_units,proposed_milestones,status
) values (
  '22000000-0000-4000-8000-000000000030','22000000-0000-4000-8000-000000000020',
  '22000000-0000-4000-8000-000000000002','Complete profile work',100,'[]','accepted'
);

update public.bounties
set accepted_proposal_id='22000000-0000-4000-8000-000000000030',status='completed'
where id='22000000-0000-4000-8000-000000000020';

insert into public.participant_reviews (
  id,bounty_id,author_id,subject_id,direction,rating,body
) values (
  '22000000-0000-4000-8000-000000000040','22000000-0000-4000-8000-000000000020',
  '22000000-0000-4000-8000-000000000001','22000000-0000-4000-8000-000000000002',
  'service_received',5,null
);

select lives_ok(
  $$ select public.app_update_public_profile(
       '22000000-0000-4000-8000-000000000002',
       'Alice Protocol','Builds secure products','https://example.test/alice',
       array['Project','Audit'],array['Engineering','Smart Contracts & Web3'],
       'Zero-knowledge systems') $$,
  'an authenticated account can save multiple work types and categories'
);
select is(
  public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')->'work_types',
  '["Project", "Audit"]'::jsonb,'public profiles expose the selected work types'
);
select is(
  public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')->'categories',
  '["Engineering", "Smart Contracts & Web3"]'::jsonb,'public profiles expose selected categories'
);
select is(
  public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')->>'custom_specialty',
  'Zero-knowledge systems','public profiles expose the optional custom specialty'
);
select is(
  public.app_search_public_wallet_profiles('audit',12)#>>'{0,wallet_address}',
  '0x2222222222222222222222222222222222222222','work type is searchable case-insensitively'
);
select is(
  public.app_search_public_wallet_profiles('smart contracts',12)#>>'{0,wallet_address}',
  '0x2222222222222222222222222222222222222222','category is searchable case-insensitively'
);
select is(
  public.app_search_public_wallet_profiles('knowledge systems',12)#>>'{0,wallet_address}',
  '0x2222222222222222222222222222222222222222','custom specialty is searchable case-insensitively'
);
select throws_ok(
  $$ select public.app_update_public_profile(
       '22000000-0000-4000-8000-000000000002',null,null,null,
       array['Audit','audit'],'{}'::text[],null) $$,
  '22023',null,'duplicate selections differing only by case are rejected'
);
select throws_ok(
  $$ select public.app_update_public_profile(
       '22000000-0000-4000-8000-000000000002',null,null,null,
       array['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16','17'],'{}'::text[],null) $$,
  '22023',null,'the number of public profile selections is bounded'
);
select ok(
  public.app_profile_selections_valid(array['1','2','3','4','5','6','7','8','9','10','11','12','13','14','15','16']),
  'profiles can combine standard preferences with several custom selections'
);
select throws_ok(
  $$ select public.app_update_public_profile(
       '22000000-0000-4000-8000-000000000002',null,null,null,
       '{}'::text[],'{}'::text[],E'unsafe\nvalue') $$,
  '22023',null,'control characters are rejected from custom specialties'
);
select ok(
  not has_function_privilege('anon','public.app_update_public_profile(uuid,text,text,text,text[],text[],text)','execute'),
  'anonymous callers cannot update profile specialties directly'
);
select ok(
  has_function_privilege('service_role','public.app_update_public_profile(uuid,text,text,text,text[],text[],text)','execute'),
  'the session-verifying server can update profile specialties'
);
select ok(
  not has_table_privilege('authenticated','public.wallet_accounts','select'),
  'profile discovery does not expose the wallet account table'
);
select is(
  (select body from public.participant_reviews where id='22000000-0000-4000-8000-000000000040'),
  null,'a mandatory rating can be stored without an original written comment'
);

select throws_ok(
  $$ select public.app_create_participant_review_response(
       '22000000-0000-4000-8000-000000000001',
       '22000000-0000-4000-8000-000000000040','The review author cannot self-respond') $$,
  '42501',null,'the review author cannot add the counterparty response'
);
select throws_ok(
  $$ select public.app_create_participant_review_response(
       '22000000-0000-4000-8000-000000000003',
       '22000000-0000-4000-8000-000000000040','A stranger cannot respond') $$,
  '42501',null,'an unrelated wallet cannot respond to a review'
);
select lives_ok(
  $$ select public.app_create_participant_review_response(
       '22000000-0000-4000-8000-000000000002',
       '22000000-0000-4000-8000-000000000040','Thank you for the clear scope and prompt acceptance') $$,
  'the reviewed counterparty can publish one response'
);
select is(
  public.app_bounty_json(
    '22000000-0000-4000-8000-000000000020','22000000-0000-4000-8000-000000000001'
  )#>>'{reviews,0,response_body}',
  'Thank you for the clear scope and prompt acceptance','marketplace review JSON includes the response'
);
select is(
  public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')#>>'{reviews_received,0,response_body}',
  'Thank you for the clear scope and prompt acceptance','public rating history includes the response'
);
select is(
  (select response_author_id::text from public.participant_reviews where id='22000000-0000-4000-8000-000000000040'),
  '22000000-0000-4000-8000-000000000002','the persisted responder is exactly the review subject'
);
select throws_ok(
  $$ select public.app_create_participant_review_response(
       '22000000-0000-4000-8000-000000000002',
       '22000000-0000-4000-8000-000000000040','A second response must not replace the first') $$,
  '23505',null,'a review response is immutable and cannot be replaced'
);
select is(
  (select count(*)::integer from public.notifications
   where type='participant_review_response'
     and recipient_id='22000000-0000-4000-8000-000000000001'),
  1,'the review author receives one deduplicated response notification'
);
select throws_ok(
  $$ select public.app_create_participant_review_response(
       '22000000-0000-4000-8000-000000000002',
       '22000000-0000-4000-8000-000000000040','x') $$,
  '22023',null,'review responses enforce bounded meaningful content'
);

select lives_ok(
  $$ select public.app_report_content(
       '22000000-0000-4000-8000-000000000003','review',
       '22000000-0000-4000-8000-000000000040','Review response may violate policy') $$,
  'a review with a response remains reportable'
);
insert into public.moderation_staff (account_id,role,granted_by)
values ('22000000-0000-4000-8000-000000000001','admin','response pgTAP fixture');
select is(
  public.app_marketplace_snapshot('22000000-0000-4000-8000-000000000001')
    #>>'{moderationReports,0,content,response_body}',
  'Thank you for the clear scope and prompt acceptance','moderators can inspect the reported review response'
);
select lives_ok(
  $$ select public.app_decide_content_report(
       '22000000-0000-4000-8000-000000000001',
       (select id from public.content_reports where entity_type='review'),
       'hide','The complete review thread violates marketplace rules',null,1) $$,
  'existing report moderation hides the review and response together'
);
select is(
  jsonb_array_length(
    public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')->'reviews_received'
  ),
  0,'hiding a review also removes its response from the public profile'
);
select ok(
  not has_function_privilege('anon','public.app_create_participant_review_response(uuid,uuid,text)','execute'),
  'anonymous callers cannot invoke review-response persistence directly'
);
select ok(
  not has_function_privilege('authenticated','public.app_create_participant_review_response(uuid,uuid,text)','execute'),
  'authenticated PostgREST callers cannot bypass the server response route'
);
select ok(
  has_function_privilege('service_role','public.app_create_participant_review_response(uuid,uuid,text)','execute'),
  'the session-verifying server can invoke review-response persistence'
);
select throws_ok(
  $$ update public.participant_reviews
     set response_author_id='22000000-0000-4000-8000-000000000003'
     where id='22000000-0000-4000-8000-000000000040' $$,
  '23514',null,'the database rejects a forged response author even outside the RPC'
);

update public.wallet_accounts
set profile_moderation_status='hidden',profile_moderation_reason='Hidden profile fixture'
where id='22000000-0000-4000-8000-000000000002';
select is(
  public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')->'work_types',
  '[]'::jsonb,'hidden profiles redact work types from direct public reads'
);
select is(
  public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')->'categories',
  '[]'::jsonb,'hidden profiles redact categories from direct public reads'
);
select is(
  public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')->>'custom_specialty',
  null,'hidden profiles redact the custom specialty from direct public reads'
);
select is(
  jsonb_array_length(public.app_search_public_wallet_profiles('knowledge systems',12)),
  0,'hidden profiles cannot be rediscovered through specialty search'
);

select * from finish();
rollback;
