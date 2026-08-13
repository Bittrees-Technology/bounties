begin;
select plan(12);

insert into public.wallet_accounts (
  id, wallet_address, display_name, profile_bio, work_types, categories, custom_specialty, profile_moderation_status
) values
  ('81000000-0000-4000-8000-000000000001', '0x1111111111111111111111111111111111111111', 'Alice Builder', 'Designs accessible public goods.', array['project'], array['Product & UX Design'], 'Design systems', 'visible'),
  ('81000000-0000-4000-8000-000000000002', '0x2222222222222222222222222222222222222222', 'Bob Auditor', 'Reviews protocol security.', array['audit'], array['Smart Contracts & Web3'], 'Formal verification', 'visible'),
  ('81000000-0000-4000-8000-000000000003', '0x3333333333333333333333333333333333333333', 'Hidden Auditor', 'Reviews protocol security.', array['audit'], array['Smart Contracts & Web3'], null, 'hidden');

select is(public.app_filter_public_wallet_profiles('alice', 'identity', null, null, 12)#>>'{0,display_name}', 'Alice Builder', 'identity search matches display names');
select is(public.app_filter_public_wallet_profiles('accessible', 'bio', null, null, 12)#>>'{0,display_name}', 'Alice Builder', 'bio search matches biography text');
select is(public.app_filter_public_wallet_profiles('accessible', 'all', null, null, 12)#>>'{0,display_name}', 'Alice Builder', 'all-profile search includes biographies');
select is(public.app_filter_public_wallet_profiles('verification', 'specialty', null, null, 12)#>>'{0,display_name}', 'Bob Auditor', 'specialty search matches custom specialties');
select is(public.app_filter_public_wallet_profiles(null, 'all', 'audit', null, 12)#>>'{0,display_name}', 'Bob Auditor', 'work-type-only filters are supported');
select is(public.app_filter_public_wallet_profiles(null, 'all', null, 'Product & UX Design', 12)#>>'{0,display_name}', 'Alice Builder', 'category-only filters are supported');
select is(jsonb_array_length(public.app_filter_public_wallet_profiles('accessible', 'bio', 'audit', null, 12)), 0, 'text and structured filters combine with AND semantics');
select is(jsonb_array_length(public.app_filter_public_wallet_profiles('protocol', 'bio', 'audit', 'Smart Contracts & Web3', 12)), 1, 'matching combined filters return one visible profile');
select is(jsonb_array_length(public.app_filter_public_wallet_profiles('hidden', 'identity', null, null, 12)), 0, 'hidden profiles stay excluded');
select is(jsonb_array_length(public.app_filter_public_wallet_profiles(null, 'all', null, null, 12)), 0, 'empty searches fail closed');
select ok(not has_function_privilege('anon','public.app_filter_public_wallet_profiles(text,text,text,text,integer)','execute'), 'anon cannot execute filtered search');
select ok(has_function_privilege('service_role','public.app_filter_public_wallet_profiles(text,text,text,text,integer)','execute'), 'service role can execute filtered search');

select * from finish();
rollback;
