begin;
select plan(20);

select ok(
  not has_table_privilege('anon', 'public.anonymous_api_rate_limits', 'select'),
  'anonymous callers cannot inspect keyed source buckets'
);
select ok(
  not has_table_privilege('authenticated', 'public.anonymous_api_rate_limits', 'select'),
  'browser sessions cannot inspect keyed source buckets'
);
select ok(
  not has_function_privilege('anon', 'public.app_consume_anonymous_rate_limit(text,text,integer,integer)', 'execute'),
  'anonymous callers cannot choose their own rate-limit bucket'
);
select ok(
  has_function_privilege('service_role', 'public.app_consume_anonymous_rate_limit(text,text,integer,integer)', 'execute'),
  'the application server may consume anonymous rate limits'
);
select ok(
  not has_function_privilege('anon', 'public.app_validate_auth_nonce(uuid,text,text,bigint,text,text,timestamptz,timestamptz,text)', 'execute'),
  'anonymous callers cannot preflight nonce records directly'
);
select ok(
  has_function_privilege('service_role', 'public.app_validate_auth_nonce(uuid,text,text,bigint,text,text,timestamptz,timestamptz,text)', 'execute'),
  'the wallet-auth server may preflight nonce records'
);

select lives_ok(
  $$ select public.app_issue_auth_nonce(
       '0x1111111111111111111111111111111111111111',8453,'example.test','https://example.test',
       repeat('1',64),repeat('a',64),date_trunc('milliseconds',now()),
       date_trunc('milliseconds',now()) + interval '5 minutes') $$,
  'nonce issuance accepts a server-keyed source bucket'
);
select is(
  (select source_digest from public.auth_nonces where nonce_digest = repeat('a',64)),
  repeat('1',64),
  'only the keyed source digest is retained with the nonce'
);
select throws_ok(
  $$ select public.app_validate_auth_nonce(
       (select id from public.auth_nonces where nonce_digest=repeat('a',64)),repeat('b',64),
       '0x1111111111111111111111111111111111111111',8453,'example.test','https://example.test',
       (select issued_at from public.auth_nonces where nonce_digest=repeat('a',64)),
       (select expires_at from public.auth_nonces where nonce_digest=repeat('a',64)),repeat('1',64)) $$,
  '28000',null,'a forged nonce is rejected before signature verification'
);
select is(
  (select verification_attempts from public.auth_nonces where nonce_digest=repeat('a',64)),
  0,'a forged nonce does not consume a legitimate verification retry'
);
select lives_ok(
  $$ select public.app_validate_auth_nonce(
       (select id from public.auth_nonces where nonce_digest=repeat('a',64)),repeat('a',64),
       '0x1111111111111111111111111111111111111111',8453,'example.test','https://example.test',
       (select issued_at from public.auth_nonces where nonce_digest=repeat('a',64)),
       (select expires_at from public.auth_nonces where nonce_digest=repeat('a',64)),repeat('1',64)) $$,
  'a legitimate nonce is proven without being consumed'
);
select is(
  (select consumed_at is null from public.auth_nonces where nonce_digest=repeat('a',64)),
  true,'preflight preserves legitimate signature retry semantics'
);
select lives_ok(
  $$ select public.app_consume_auth_nonce(
       (select id from public.auth_nonces where nonce_digest=repeat('a',64)),repeat('a',64),
       '0x1111111111111111111111111111111111111111',8453,'example.test','https://example.test',
       (select issued_at from public.auth_nonces where nonce_digest=repeat('a',64)),
       (select expires_at from public.auth_nonces where nonce_digest=repeat('a',64))) $$,
  'a proven nonce can be consumed after successful signature verification'
);
select throws_ok(
  $$ select public.app_validate_auth_nonce(
       (select id from public.auth_nonces where nonce_digest=repeat('a',64)),repeat('a',64),
       '0x1111111111111111111111111111111111111111',8453,'example.test','https://example.test',
       (select issued_at from public.auth_nonces where nonce_digest=repeat('a',64)),
       (select expires_at from public.auth_nonces where nonce_digest=repeat('a',64)),repeat('1',64)) $$,
  '28000',null,'a consumed nonce cannot reach signature verification again'
);

select lives_ok(
  $$ select public.app_issue_auth_nonce(
       '0x2222222222222222222222222222222222222222',8453,'example.test','https://example.test',
       repeat('2',64),repeat('c',64),date_trunc('milliseconds',now()),
       date_trunc('milliseconds',now()) + interval '5 minutes') $$,
  'a second nonce may be issued for bounded retry testing'
);
select lives_ok(
  $$ select public.app_validate_auth_nonce(
       (select id from public.auth_nonces where nonce_digest=repeat('c',64)),repeat('c',64),
       '0x2222222222222222222222222222222222222222',8453,'example.test','https://example.test',
       (select issued_at from public.auth_nonces where nonce_digest=repeat('c',64)),
       (select expires_at from public.auth_nonces where nonce_digest=repeat('c',64)),repeat('2',64))
     from generate_series(1,5) $$,
  'five signature retries remain available for a legitimate challenge'
);
select throws_ok(
  $$ select public.app_validate_auth_nonce(
       (select id from public.auth_nonces where nonce_digest=repeat('c',64)),repeat('c',64),
       '0x2222222222222222222222222222222222222222',8453,'example.test','https://example.test',
       (select issued_at from public.auth_nonces where nonce_digest=repeat('c',64)),
       (select expires_at from public.auth_nonces where nonce_digest=repeat('c',64)),repeat('2',64)) $$,
  '28000',null,'a sixth signature attempt is blocked before EIP-1271 work'
);

select lives_ok(
  $$ select public.app_consume_anonymous_rate_limit(repeat('3',64),'public_profile_discovery',30,600) $$,
  'the first public profile discovery is admitted'
);
update public.anonymous_api_rate_limits set request_count=30
 where bucket_digest=repeat('3',64) and action='public_profile_discovery';
select throws_ok(
  $$ select public.app_consume_anonymous_rate_limit(repeat('3',64),'public_profile_discovery',30,600) $$,
  '22023',null,'public profile and ENS discovery is bounded per source window'
);
select throws_ok(
  $$ select public.app_consume_anonymous_rate_limit('raw-network-address','public_profile_discovery',30,600) $$,
  '22023',null,'raw or malformed source values cannot enter the limiter'
);

select * from finish();
rollback;
