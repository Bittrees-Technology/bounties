begin;
select plan(8);

insert into public.wallet_accounts (id, wallet_address) values
  ('88000000-0000-4000-8000-000000000001', '0x8811111111111111111111111111111111111111');

select lives_ok($$
  select public.app_upsert_inspected_token_v2(
    '88000000-0000-4000-8000-000000000001', 11155111,
    '0x8822222222222222222222222222222222222222',
    '0x8822222222222222222222222222222222222222',
    'Exact Token', 'EXACT', 18, '1000000000000000000000', true,
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'not_proxy', 'none', null, null, 'verified',
    'https://sepolia.etherscan.io/address/0x8822222222222222222222222222222222222222',
    '[]'::jsonb, 'compatible', '[]'::jsonb, '123',
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    'erc20-compatibility.v1'
  )
$$, 'a server-authorized inspection stores the compatibility result');

select is(
  (select compatibility_status from public.tokens where contract_address='0x8822222222222222222222222222222222222222'),
  'compatible', 'the token summary exposes its point-in-time compatibility status'
);

select is(
  (select count(*)::integer from public.token_compatibility_checks where token_id=(select id from public.tokens where contract_address='0x8822222222222222222222222222222222222222')),
  1, 'the inspection also creates an append-only evidence record'
);

select throws_ok($$
  update public.token_compatibility_checks set status='inconclusive'
  where token_id=(select id from public.tokens where contract_address='0x8822222222222222222222222222222222222222')
$$, '55000', 'TOKEN_COMPATIBILITY_HISTORY_IMMUTABLE', 'compatibility history cannot be updated');

select throws_ok($$
  delete from public.token_compatibility_checks
  where token_id=(select id from public.tokens where contract_address='0x8822222222222222222222222222222222222222')
$$, '55000', 'TOKEN_COMPATIBILITY_HISTORY_IMMUTABLE', 'compatibility history cannot be deleted');

select is(
  has_function_privilege(
    'service_role',
    to_regprocedure('public.app_upsert_inspected_token(uuid,bigint,text,text,text,text,integer,text,boolean,text,text,text,text,jsonb)'),
    'EXECUTE'
  ),
  false,
  'the legacy inspection writer can no longer bypass compatibility evidence'
);

update public.tokens set compatibility_status='incompatible'
where contract_address='0x8822222222222222222222222222222222222222';

select throws_ok($$
  insert into public.bounties (
    creator_id,title,description,scope_hash,chain_id,token_id,token_decimals,budget_base_units
  ) values (
    '88000000-0000-4000-8000-000000000001','Blocked token bounty','test',
    '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    11155111,(select id from public.tokens where contract_address='0x8822222222222222222222222222222222222222'),18,1
  )
$$, '23514', 'TOKEN_COMPATIBILITY_BLOCKED', 'an incompatible token cannot back a new bounty');

update public.tokens set compatibility_status='inconclusive'
where contract_address='0x8822222222222222222222222222222222222222';

select lives_ok($$
  insert into public.bounties (
    creator_id,title,description,scope_hash,chain_id,token_id,token_decimals,budget_base_units
  ) values (
    '88000000-0000-4000-8000-000000000001','Permissionless bounty','test',
    '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    11155111,(select id from public.tokens where contract_address='0x8822222222222222222222222222222222222222'),18,1
  )
$$, 'an inconclusive result remains permissionless');

select * from finish();
rollback;
