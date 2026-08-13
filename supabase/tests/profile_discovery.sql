begin;
select plan(14);

insert into public.wallet_accounts (id, wallet_address, display_name, profile_moderation_status) values
  ('21000000-0000-4000-8000-000000000001','0x1111111111111111111111111111111111111111','Alice Builder','visible'),
  ('21000000-0000-4000-8000-000000000002','0x2222222222222222222222222222222222222222','Bob Capital','visible'),
  ('21000000-0000-4000-8000-000000000003','0x3333333333333333333333333333333333333333','Hidden Person','hidden');

insert into public.tokens (
  id,chain_id,contract_address,checksum_address,name,symbol,decimals,total_supply,
  bytecode_present,explorer_url,source_verification_status,risk_flags
) values (
  '21000000-0000-4000-8000-000000000010',84532,
  '0x4444444444444444444444444444444444444444','0x4444444444444444444444444444444444444444',
  'Discovery token','DISC',6,1000000,true,
  'https://sepolia.basescan.org/address/0x4444444444444444444444444444444444444444','unverified','[]'
);

insert into public.bounties (
  id,creator_id,title,description,scope_hash,chain_id,token_id,token_decimals,budget_base_units,status
) values (
  '21000000-0000-4000-8000-000000000020','21000000-0000-4000-8000-000000000002',
  'Discovery bounty','Profile activity fixture',
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  84532,'21000000-0000-4000-8000-000000000010',6,100,'open'
);

insert into public.proposals (
  id,bounty_id,provider_id,note,proposed_total_base_units,proposed_milestones,status
) values (
  '21000000-0000-4000-8000-000000000030','21000000-0000-4000-8000-000000000020',
  '21000000-0000-4000-8000-000000000001','Deliver it',100,'[]','accepted'
);

update public.bounties
set accepted_proposal_id='21000000-0000-4000-8000-000000000030',status='accepted'
where id='21000000-0000-4000-8000-000000000020';

insert into public.escrow_records (
  bounty_id,chain_id,token_id,contract_address,onchain_bounty_id,
  requested_base_units,received_base_units,status,transaction_hash,
  block_hash,log_index,onchain_state,remaining_base_units,state_checked_at
) values (
  '21000000-0000-4000-8000-000000000020',84532,
  '21000000-0000-4000-8000-000000000010',
  '0x5555555555555555555555555555555555555555','1',
  100,100,'confirmed','0x' || repeat('1',64),
  '0x' || repeat('2',64),0,'ProviderAccepted',100,now()
);

select is(
  public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')#>>'{activity_summary,capital_bounties}',
  '1','profile includes capital-provider activity count'
);
select is(
  public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')#>>'{activity_summary,labor_bounties}',
  '0','accepted in-progress work is not counted as completed labor activity'
);
update public.escrow_records set onchain_state='Released',remaining_base_units=0
where bounty_id='21000000-0000-4000-8000-000000000020';
select is(
  public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')#>>'{activity_summary,labor_bounties}',
  '1','released work is counted as completed labor activity'
);
select ok(
  (public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')#>>'{last_completed_activity_at}') is not null,
  'released work records the provider last-completed activity timestamp'
);
select is(
  public.app_public_wallet_profile('0x2222222222222222222222222222222222222222')#>>'{last_completed_activity_at}',
  public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')#>>'{last_completed_activity_at}',
  'the same terminal bounty records requester last-completed activity'
);
select is(
  public.app_search_public_wallet_profiles('alice',12)#>>'{0,display_name}',
  'Alice Builder','custom display names are discoverable case-insensitively'
);
select is(
  public.app_search_public_wallet_profiles('0x2222',12)#>>'{0,wallet_address}',
  '0x2222222222222222222222222222222222222222','wallet prefixes are discoverable'
);
select is(
  jsonb_array_length(public.app_search_public_wallet_profiles('hidden',12)),
  0,'moderator-hidden profiles are excluded from discovery'
);
select is(
  jsonb_array_length(public.app_search_public_wallet_profiles('a',12)),
  0,'short broad queries do not enumerate profiles'
);
select is(
  jsonb_array_length(public.app_search_public_wallet_profiles('%%',12)),
  0,'SQL wildcard characters do not enumerate profiles'
);
select is(
  jsonb_array_length(public.app_search_public_wallet_profiles('alice',0)),
  1,'search result limits are clamped to a safe positive value'
);
select ok(
  not has_function_privilege('anon','public.app_search_public_wallet_profiles(text,integer)','execute'),
  'anonymous PostgREST callers cannot bypass the server discovery route'
);
select ok(
  not has_function_privilege('authenticated','public.app_search_public_wallet_profiles(text,integer)','execute'),
  'authenticated PostgREST callers cannot bypass the server discovery route'
);
select ok(
  has_function_privilege('service_role','public.app_search_public_wallet_profiles(text,integer)','execute'),
  'the application server can search public profiles'
);

select * from finish();
rollback;
