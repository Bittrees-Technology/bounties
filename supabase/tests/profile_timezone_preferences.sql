begin;
select plan(9);

insert into public.wallet_accounts (
  id, wallet_address, display_name, timezone, timezone_public, profile_moderation_status
) values (
  '82000000-0000-4000-8000-000000000001',
  '0x1111111111111111111111111111111111111111',
  'Timezone profile', 'Europe/Lisbon', false, 'visible'
);

select is(
  public.app_my_wallet_profile('82000000-0000-4000-8000-000000000001')->>'timezone',
  'Europe/Lisbon', 'the owner can read a private saved timezone'
);
select is(
  public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')->>'timezone',
  null::text, 'a private timezone is omitted from the public profile'
);
select lives_ok(
  $$select public.app_update_public_profile(
    '82000000-0000-4000-8000-000000000001', 'Timezone profile', null, null,
    '{}'::text[], '{}'::text[], null, 'America/New_York', true
  )$$,
  'the owner can publish a valid IANA timezone'
);
select is(
  public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')->>'timezone',
  'America/New_York', 'a public timezone appears on the public profile'
);
select is(
  public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')->>'timezone_public',
  'true', 'the public profile marks the timezone as public'
);
select throws_ok(
  $$select public.app_update_public_profile(
    '82000000-0000-4000-8000-000000000001', 'Timezone profile', null, null,
    '{}'::text[], '{}'::text[], null, 'Not/A_Timezone', true
  )$$,
  '22023', 'INVALID_TIMEZONE', 'invalid timezone identifiers fail closed'
);
select is(
  (select timezone from public.wallet_accounts where id='82000000-0000-4000-8000-000000000001'),
  'America/New_York', 'a rejected update does not replace the saved timezone'
);
select ok(
  not has_function_privilege('anon','public.app_update_public_profile(uuid,text,text,text,text[],text[],text,text,boolean)','execute'),
  'anonymous callers cannot update timezone preferences'
);
select ok(
  has_function_privilege('service_role','public.app_update_public_profile(uuid,text,text,text,text[],text[],text,text,boolean)','execute'),
  'the server can update timezone preferences for a verified owner'
);

select * from finish();
rollback;
