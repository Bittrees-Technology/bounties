begin;
select plan(39);

insert into public.wallet_accounts(id,wallet_address) values
  ('30000000-0000-4000-8000-000000000001','0x1111111111111111111111111111111111111111'),
  ('30000000-0000-4000-8000-000000000002','0x2222222222222222222222222222222222222222');
insert into public.tokens(id,chain_id,contract_address,checksum_address,name,symbol,decimals,bytecode_present,explorer_url,risk_flags)
values('30000000-0000-4000-8000-000000000010',84532,'0x3333333333333333333333333333333333333333',
  '0x3333333333333333333333333333333333333333','Schedule token','SCH',6,true,
  'https://sepolia.basescan.org/address/0x3333333333333333333333333333333333333333','[]');

insert into public.bounties(id,creator_id,title,description,scope_hash,chain_id,token_id,token_decimals,budget_base_units,status)
values('30000000-0000-4000-8000-000000000020','30000000-0000-4000-8000-000000000001','Legacy ambiguous','Legacy',
  '0x'||repeat('a',64),84532,'30000000-0000-4000-8000-000000000010',6,100,'accepted');
insert into public.milestones(id,bounty_id,ordinal,title,amount_base_units,status)
values('30000000-0000-4000-8000-000000000021','30000000-0000-4000-8000-000000000020',0,'Legacy',100,'assigned');

select is((select escrow_schedule_status from public.bounties where id='30000000-0000-4000-8000-000000000020'),
  'requires_recreation','a legacy NULL deadline remains recreate-only rather than receiving invented terms');
select throws_ok($$select public.app_record_escrow_observation(
  '30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000020',
  '0x4444444444444444444444444444444444444444','escrow-adapter.v1','9','100','100','confirmed',
  '0x'||repeat('1',64),'0x'||repeat('2',64),0,'Funded','100','100','0',1,0,
  '0x'||repeat('3',64),'0x'||repeat('4',64),
  jsonb_build_object('milestone_index',0,'amount_base_units','100','delivery_deadline',null,'review_deadline',null,
    'state','Pending','evidence_hash','0x'||repeat('0',64),'approval_hash','0x'||repeat('0',64)))$$,
  '22023',null,'a recreate-only bounty cannot be bound to escrow');

select lives_ok($$select public.app_create_bounty(
  '30000000-0000-4000-8000-000000000001','Canonical schedule','Exact terms','{}','0x'||repeat('b',64),84532,
  '30000000-0000-4000-8000-000000000010','100',jsonb_build_array(
    jsonb_build_object('ordinal',0,'title','First','amount_base_units','40','delivery_deadline',(now()+interval '2 days')::text),
    jsonb_build_object('ordinal',1,'title','Second','amount_base_units','60','delivery_deadline',(now()+interval '24 days')::text)))$$,
  'structured schedule creation succeeds');

insert into public.proposals(id,bounty_id,provider_id,note,proposed_total_base_units,proposed_milestones,status)
select '30000000-0000-4000-8000-000000000030',id,'30000000-0000-4000-8000-000000000002','Canonical provider',100,'[]','accepted'
from public.bounties where title='Canonical schedule';
update public.bounties set accepted_proposal_id='30000000-0000-4000-8000-000000000030',status='accepted'
where title='Canonical schedule';
update public.milestones set assigned_provider_id='30000000-0000-4000-8000-000000000002',status='assigned'
where bounty_id=(select id from public.bounties where title='Canonical schedule');

select is((select escrow_schedule_status from public.bounties where title='Canonical schedule'),'structured',
  'new API schedules are marked structured');
select lives_ok($$select public.app_record_escrow_observation(
  '30000000-0000-4000-8000-000000000001',(select id from public.bounties where title='Canonical schedule'),
  '0x4444444444444444444444444444444444444444','escrow-adapter.v1','10','100','100','confirmed',
  '0x'||repeat('5',64),'0x'||repeat('6',64),0,'Funded','100','100','0',2,0,
  '0x'||repeat('7',64),'0x'||repeat('8',64),
  jsonb_build_object('milestone_index',0,'amount_base_units','40','delivery_deadline',(now()+interval '2 days')::text,
    'review_deadline',null,'state','Pending','evidence_hash','0x'||repeat('0',64),'approval_hash','0x'||repeat('0',64)))$$,
  'verified receipt persists immutable schedule identity and current milestone detail');
select is((select milestone_count from public.escrow_records where onchain_bounty_id='10'),2,
  'canonical milestone count persists');
select is((select allocated_amount_base_units::text from public.escrow_records where onchain_bounty_id='10'),'100',
  'canonical allocated total persists exactly');
select is(public.app_bounty_json((select id from public.bounties where title='Canonical schedule'),'30000000-0000-4000-8000-000000000001')
  #>>'{escrow,current_milestone_detail,amount_base_units}','40','snapshot exposes exact current milestone detail');

select throws_ok($$select public.app_submit_delivery_evidence(
  '30000000-0000-4000-8000-000000000002',
  (select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=1),
  'https://example.test/wrong','0x'||repeat('9',64),'0x'||repeat('a',64),'bounties-evidence-v1',0)$$,
  '40001',null,'evidence for a non-current ordinal is rejected under the escrow row lock');
select throws_ok($$select public.app_submit_delivery_evidence(
  '30000000-0000-4000-8000-000000000002',
  (select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=0),
  'https://example.test/unaccepted','0x'||repeat('9',64),'0x'||repeat('a',64),'bounties-evidence-v1',0)$$,
  '40001',null,'evidence requires a freshly observed ProviderAccepted/Pending canonical state');

select lives_ok($$select public.app_record_escrow_state(
  '30000000-0000-4000-8000-000000000002',(select id from public.bounties where title='Canonical schedule'),
  'ProviderAccepted','100',null,'0x0000000000000000000000000000000000000000','0','100','0',2,0,'0x'||repeat('7',64),
  jsonb_build_object('milestone_index',0,'amount_base_units','40','delivery_deadline',(now()+interval '2 days')::text,
    'review_deadline',null,'state','Pending','evidence_hash','0x'||repeat('0',64),'approval_hash','0x'||repeat('0',64)))$$,
  'participant reconciliation persists the fresh current milestone');
select lives_ok($$select public.app_record_escrow_state(
  '30000000-0000-4000-8000-000000000002',(select id from public.bounties where title='Canonical schedule'),
  'ProviderAccepted','100',null,'0x2222222222222222222222222222222222222222','10',now()+interval '1 day',
  '100','0',2,0,'0x'||repeat('7',64),
  jsonb_build_object('milestone_index',0,'amount_base_units','40','delivery_deadline',(now()+interval '2 days')::text,
    'review_deadline',null,'state','Pending','evidence_hash','0x'||repeat('0',64),'approval_hash','0x'||repeat('0',64)))$$,
  'the expiry-aware observation boundary persists an active bilateral offer');
select ok((select settlement_proposal_expiry > now() from public.escrow_records where onchain_bounty_id='10'),
  'the active offer expiry remains available to API and UI reads');
select throws_ok($$select public.app_submit_canonical_delivery_evidence(
  '30000000-0000-4000-8000-000000000002',
  (select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=0),
  'https://example.test/current',
  '0x'||repeat('0',64),
  '0x'||repeat('1',64),'0x'||repeat('2',64),'0x'||repeat('a',64),'bounty-evidence-commitment.v1',
  '0x'||repeat('3',64),'0x'||repeat('4',64),'0x'||repeat('b',64),0,84532,
  '0x4444444444444444444444444444444444444444','10','0x'||repeat('b',64),'0x'||repeat('8',64),
  '0x2222222222222222222222222222222222222222','0x1111111111111111111111111111111111111111')$$,
  '23514',null,'a zero delivered-byte digest is rejected before persistence');
select lives_ok($$select public.app_submit_canonical_delivery_evidence(
  '30000000-0000-4000-8000-000000000002',
  (select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=0),
  'https://example.test/current',
  '0x'||repeat('c',64),
  '0x'||repeat('1',64),'0x'||repeat('2',64),'0x'||repeat('a',64),'bounty-evidence-commitment.v1',
  '0x'||repeat('3',64),'0x'||repeat('4',64),'0x'||repeat('b',64),0,84532,
  '0x4444444444444444444444444444444444444444','10','0x'||repeat('b',64),'0x'||repeat('8',64),
  '0x2222222222222222222222222222222222222222','0x1111111111111111111111111111111111111111')$$,
  'the exact current provider can persist a server-derived canonical commitment');
select is((select content_hash from public.delivery_evidence where milestone_id=(
  select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=0)),
  '0x'||repeat('c',64),'the provider-supplied delivered-byte digest persists without being derived from the URI');
select is((select canonical_approval_hash from public.delivery_evidence where milestone_id=(
  select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=0)),
  '0x'||repeat('b',64),'canonical approval metadata is persisted for wallet and acceptance verification');

select lives_ok($$select public.app_record_escrow_state(
  '30000000-0000-4000-8000-000000000001',(select id from public.bounties where title='Canonical schedule'),
  'Delivered','100',now()+interval '7 days','0x0000000000000000000000000000000000000000','0','100','0',2,0,'0x'||repeat('7',64),
  jsonb_build_object('milestone_index',0,'amount_base_units','40','delivery_deadline',(now()+interval '2 days')::text,
    'review_deadline',(now()+interval '7 days')::text,'state','Submitted','evidence_hash','0x'||repeat('a',64),'approval_hash','0x'||repeat('0',64)))$$,
  'submitted canonical state can be reconciled');
select is(public.app_revision_request_context(
  '30000000-0000-4000-8000-000000000001',
  (select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=0)
) #>>'{onchain_bounty_id}','10','revision verification context is bound to the requester and canonical escrow');
select lives_ok($$select public.app_record_milestone_revision_request(
  '30000000-0000-4000-8000-000000000001',
  (select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=0),
  'Add the missing test evidence.','0x'||repeat('d',64),'0x'||repeat('e',64),'0x'||repeat('9',64),4,
  'ProviderAccepted','100',null,'0x0000000000000000000000000000000000000000','0','100','0',2,0,'0x'||repeat('7',64),
  jsonb_build_object('milestone_index',0,'amount_base_units','40','delivery_deadline',(now()+interval '2 days')::text,
    'review_deadline',null,'revision_deadline',(now()+interval '7 days')::text,'state','Pending',
    'evidence_hash','0x'||repeat('0',64),'previous_evidence_hash','0x'||repeat('a',64),
    'approval_hash','0x'||repeat('0',64),'revision_reason_hash','0x'||repeat('d',64),'revision_requested',true))$$,
  'the requester can atomically persist verified post-revision state and its exact explanation');
select is((select reason from public.milestone_revision_requests where milestone_id=(
  select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=0)),
  'Add the missing test evidence.','revision explanation is immutable and readable');
select throws_ok($$select public.app_record_milestone_revision_request(
  '30000000-0000-4000-8000-000000000002',
  (select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=0),
  'Provider cannot rewrite it.','0x'||repeat('f',64),'0x'||repeat('1',64),'0x'||repeat('2',64),5,
  'ProviderAccepted','100',null,'0x0000000000000000000000000000000000000000','0','100','0',2,0,'0x'||repeat('7',64),
  jsonb_build_object('milestone_index',0,'amount_base_units','40','delivery_deadline',(now()+interval '2 days')::text,
    'review_deadline',null,'revision_deadline',(now()+interval '7 days')::text,'state','Pending',
    'evidence_hash','0x'||repeat('0',64),'previous_evidence_hash','0x'||repeat('a',64),
    'approval_hash','0x'||repeat('0',64),'revision_reason_hash','0x'||repeat('f',64),'revision_requested',true))$$,
  '42501',null,'the provider cannot author the requester revision explanation');
select is(public.app_bounty_json((select id from public.bounties where title='Canonical schedule'),'30000000-0000-4000-8000-000000000002')
  #>>'{milestones,0,revision_request,reason}','Add the missing test evidence.',
  'the provider snapshot exposes the matching revision explanation');
select throws_ok($$select public.app_accept_delivery('30000000-0000-4000-8000-000000000001',
  (select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=0),0)$$,
  '40001',null,'stale Delivered/Submitted observation cannot authorize buyer acceptance');

select lives_ok($$select public.app_record_escrow_state(
  '30000000-0000-4000-8000-000000000001',(select id from public.bounties where title='Canonical schedule'),
  'BuyerApproved','100',now()+interval '7 days','0x0000000000000000000000000000000000000000','0','100','0',2,0,'0x'||repeat('7',64),
  jsonb_build_object('milestone_index',0,'amount_base_units','40','delivery_deadline',(now()+interval '2 days')::text,
    'review_deadline',(now()+interval '7 days')::text,'state','Approved','evidence_hash','0x'||repeat('a',64),'approval_hash','0x'||repeat('b',64)))$$,
  'approved canonical state can be reconciled');
select lives_ok($$update public.escrow_records set current_milestone_detail=jsonb_set(
  current_milestone_detail,'{evidence_hash}',to_jsonb('0x'||repeat('c',64)))
  where bounty_id=(select id from public.bounties where title='Canonical schedule')$$,
  'test fixture can represent a direct onchain delivery with different evidence');
select throws_ok($$select public.app_accept_delivery('30000000-0000-4000-8000-000000000001',
  (select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=0),0)$$,
  '40001','EVIDENCE_COMMITMENT_MISMATCH','evidence A in the database cannot accept chain evidence B');
select lives_ok($$update public.escrow_records set current_milestone_detail=jsonb_set(jsonb_set(
  current_milestone_detail,'{evidence_hash}',to_jsonb('0x'||repeat('a',64))),
  '{approval_hash}',to_jsonb('0x'||repeat('c',64)))
  where bounty_id=(select id from public.bounties where title='Canonical schedule')$$,
  'test fixture can represent an approval for the wrong canonical commitment');
select throws_ok($$select public.app_accept_delivery('30000000-0000-4000-8000-000000000001',
  (select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=0),0)$$,
  '40001','APPROVAL_COMMITMENT_MISMATCH','an approval hash for another evidence/requester commitment is rejected');
update public.escrow_records set current_milestone_detail=jsonb_set(
  current_milestone_detail,'{approval_hash}',to_jsonb('0x'||repeat('b',64)))
where bounty_id=(select id from public.bounties where title='Canonical schedule');
select lives_ok($$select public.app_accept_delivery('30000000-0000-4000-8000-000000000001',
  (select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=0),0)$$,
  'buyer acceptance is authorized only for the canonically approved current ordinal');

select lives_ok($$select public.app_record_escrow_state(
  '30000000-0000-4000-8000-000000000002',(select id from public.bounties where title='Canonical schedule'),
  'ProviderAccepted','60',null,'0x0000000000000000000000000000000000000000','0','100','40',2,1,'0x'||repeat('7',64),
  jsonb_build_object('milestone_index',1,'amount_base_units','60','delivery_deadline',(now()+interval '24 days')::text,
    'review_deadline',null,'state','Pending','evidence_hash','0x'||repeat('0',64),'approval_hash','0x'||repeat('0',64)))$$,
  'release reconciliation advances the exact current ordinal and released amount');
select is((select released_amount_base_units::text from public.escrow_records where onchain_bounty_id='10'),'40',
  'released amount persists exactly');
select is((select status::text from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=0),
  'released','prior milestone is reconciled as released');
select is((select status::text from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=1),
  'funded','new current milestone is reconciled as deliverable');
select throws_ok($$select public.app_record_escrow_state(
  '30000000-0000-4000-8000-000000000001',(select id from public.bounties where title='Canonical schedule'),
  'ProviderAccepted','60',null,'0x0000000000000000000000000000000000000000','0','100','40',2,1,'0x'||repeat('f',64),
  jsonb_build_object('milestone_index',1,'amount_base_units','60','delivery_deadline',(now()+interval '24 days')::text,
    'review_deadline',null,'state','Pending','evidence_hash','0x'||repeat('0',64),'approval_hash','0x'||repeat('0',64)))$$,
  '23514',null,'canonical refresh cannot substitute a different schedule hash');
select lives_ok($$select public.app_record_escrow_state(
  '30000000-0000-4000-8000-000000000001',(select id from public.bounties where title='Canonical schedule'),
  'BuyerApproved','60',now()+interval '7 days','0x0000000000000000000000000000000000000000','0','100','40',2,1,'0x'||repeat('7',64),
  jsonb_build_object('milestone_index',1,'amount_base_units','60','delivery_deadline',(now()+interval '24 days')::text,
    'review_deadline',(now()+interval '7 days')::text,'state','Approved','evidence_hash','0x'||repeat('d',64),'approval_hash','0x'||repeat('e',64)))$$,
  'direct-contract approval can be observed without inventing offchain evidence');
select throws_ok($$select public.app_accept_delivery('30000000-0000-4000-8000-000000000001',
  (select id from public.milestones where bounty_id=(select id from public.bounties where title='Canonical schedule') and ordinal=1),1)$$,
  '40001','EVIDENCE_COMMITMENT_REQUIRED','direct-contract approval cannot bypass an absent canonical offchain evidence record');
select ok(not has_function_privilege('service_role','public.app_submit_delivery_evidence(uuid,uuid,text,text,text,text)','execute'),
  'service role cannot use the obsolete ungated evidence RPC');
select ok(has_function_privilege('service_role','public.app_submit_canonical_delivery_evidence(uuid,uuid,text,text,text,text,text,text,text,text,text,integer,bigint,text,text,text,text,text,text)','execute'),
  'service role can use only the canonical evidence persistence boundary');

select * from finish();
rollback;
