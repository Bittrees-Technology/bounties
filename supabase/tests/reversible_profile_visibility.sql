begin;
select plan(12);

insert into public.wallet_accounts (
  id, wallet_address, display_name, profile_bio, work_types, categories, custom_specialty,
  profile_moderation_status
) values (
  '27000000-0000-4000-8000-000000000001',
  '0x1111111111111111111111111111111111111111',
  'Persistent profile',
  'This data must survive deactivation.',
  array['audit'],
  array['Smart Contracts & Web3'],
  'Protocol assurance',
  'visible'
), (
  '27000000-0000-4000-8000-000000000002',
  '0x2222222222222222222222222222222222222222',
  'Moderator hidden',
  'Moderated profile fixture.',
  '{}'::text[],
  '{}'::text[],
  null,
  'hidden'
), (
  '27000000-0000-4000-8000-000000000003',
  '0x3333333333333333333333333333333333333333',
  'Moderator account',
  null,
  '{}'::text[],
  '{}'::text[],
  null,
  'visible'
);

update public.wallet_accounts
set profile_moderated_by = '27000000-0000-4000-8000-000000000003',
    profile_moderation_reason = 'Policy decision',
    profile_moderated_at = now()
where id = '27000000-0000-4000-8000-000000000002';

select is(
  public.app_set_profile_visibility('27000000-0000-4000-8000-000000000001',false)->>'profile_moderation_status',
  'hidden',
  'an owner can deactivate a visible profile'
);
select is(
  public.app_my_wallet_profile('27000000-0000-4000-8000-000000000001')->>'visibility_source',
  'owner',
  'owner-hidden state is distinguishable from moderation'
);
select is(
  public.app_my_wallet_profile('27000000-0000-4000-8000-000000000001')->>'display_name',
  'Persistent profile',
  'the owner can still read retained profile data'
);
select is(
  public.app_public_wallet_profile('0x1111111111111111111111111111111111111111')->>'display_name',
  null::text,
  'public profile reads mask owner-hidden content'
);
select is(
  public.app_set_profile_visibility('27000000-0000-4000-8000-000000000001',true)->>'profile_moderation_status',
  'visible',
  'the owner can reactivate an owner-hidden profile'
);
select is(
  public.app_my_wallet_profile('27000000-0000-4000-8000-000000000001')->>'profile_bio',
  'This data must survive deactivation.',
  'reactivation preserves the profile biography'
);
select is(
  public.app_my_wallet_profile('27000000-0000-4000-8000-000000000001')#>>'{work_types,0}',
  'audit',
  'reactivation preserves profile specialties'
);
select throws_ok(
  $$select public.app_set_profile_visibility('27000000-0000-4000-8000-000000000002',true)$$,
  '42501',
  'PROFILE_MODERATOR_HIDDEN',
  'an owner cannot override a moderator-hidden profile'
);
select is(
  public.app_my_wallet_profile('27000000-0000-4000-8000-000000000002')->>'visibility_source',
  'moderation',
  'moderator-hidden state remains distinguishable'
);
select ok(
  not has_function_privilege('anon','public.app_set_profile_visibility(uuid,boolean)','execute'),
  'anonymous callers cannot change profile visibility'
);
select ok(
  not has_function_privilege('authenticated','public.app_my_wallet_profile(uuid)','execute'),
  'authenticated PostgREST callers cannot bypass the server owner read'
);
select ok(
  has_function_privilege('service_role','public.app_set_profile_visibility(uuid,boolean)','execute'),
  'the application server can change visibility for a verified owner'
);

select * from finish();
rollback;
