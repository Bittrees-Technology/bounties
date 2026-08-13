begin;
select plan(7);

insert into public.wallet_accounts (
  id, wallet_address, display_name, profile_bio, profile_moderation_status, profile_updated_at
) values
  ('26000000-0000-4000-8000-000000000001','0x1111111111111111111111111111111111111111',null,null,'visible','2026-01-01T00:00:00Z'),
  ('26000000-0000-4000-8000-000000000002','0x2222222222222222222222222222222222222222','Directory Alice','Builds public goods.','visible','2026-01-03T00:00:00Z'),
  ('26000000-0000-4000-8000-000000000003','0x3333333333333333333333333333333333333333','Directory Bob','Funds open work.','visible','2026-01-02T00:00:00Z'),
  ('26000000-0000-4000-8000-000000000004','0x4444444444444444444444444444444444444444','Hidden Directory Profile','Hidden.','hidden','2026-01-04T00:00:00Z'),
  ('26000000-0000-4000-8000-000000000005','0x5555555555555555555555555555555555555555',null,null,'visible','2026-01-05T00:00:00Z');

select is(
  public.app_browse_public_wallet_profiles('26000000-0000-4000-8000-000000000001',18)#>>'{0,display_name}',
  'Directory Alice',
  'the directory returns the most recently updated completed profile first'
);
select is(
  jsonb_array_length(public.app_browse_public_wallet_profiles('26000000-0000-4000-8000-000000000001',18)),
  2,
  'empty accounts are not shown as browseable profiles'
);
select is(
  jsonb_path_query_array(
    public.app_browse_public_wallet_profiles('26000000-0000-4000-8000-000000000001',18),
    '$[*].display_name ? (@ == "Hidden Directory Profile")'
  ),
  '[]'::jsonb,
  'moderator-hidden profiles are excluded'
);
select is(
  jsonb_array_length(public.app_browse_public_wallet_profiles('26000000-0000-4000-8000-000000000001',0)),
  1,
  'directory limits are clamped to a safe positive value'
);
select throws_ok(
  $$select public.app_browse_public_wallet_profiles(null,18)$$,
  '42501',
  'ACCOUNT_REQUIRED',
  'a verified account is required to browse the directory'
);
select ok(
  not has_function_privilege('anon','public.app_browse_public_wallet_profiles(uuid,integer)','execute'),
  'anonymous PostgREST callers cannot enumerate the directory'
);
select ok(
  has_function_privilege('service_role','public.app_browse_public_wallet_profiles(uuid,integer)','execute'),
  'the application server can browse the directory for a verified session'
);

select * from finish();
rollback;
