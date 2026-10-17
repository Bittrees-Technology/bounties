\set ON_ERROR_STOP on
begin;
insert into public.wallet_accounts(id,wallet_address) values('11111111-1111-4111-8111-111111111111','0x1111111111111111111111111111111111111111');
insert into public.account_roles(account_id,role) values('11111111-1111-4111-8111-111111111111','buyer'),('11111111-1111-4111-8111-111111111111','provider');
insert into public.moderation_staff(account_id,role) values('11111111-1111-4111-8111-111111111111','admin');
\ir ../migrations/20261017100000_bounties_roles_only_authority.sql
DO $$
declare actor uuid:='11111111-1111-4111-8111-111111111111';
begin
 if public.app_is_moderation_staff(actor) then raise exception 'Legacy admin still authorized'; end if;
 if has_function_privilege('service_role','public.app_sync_shared_moderation_role(uuid,text,boolean,text)','EXECUTE') then raise exception 'Legacy projection callable'; end if;
 perform public.app_sync_shared_moderation_role(actor,'0x1111111111111111111111111111111111111111',true,'roles.bittrees.org',clock_timestamp()+interval '4 seconds');
 if not public.app_is_moderation_staff(actor) then raise exception 'Fresh approved moderation denied'; end if;
 perform public.app_sync_shared_moderation_role(actor,'0x1111111111111111111111111111111111111111',false,'roles.bittrees.org',null);
 if public.app_is_moderation_staff(actor) then raise exception 'Revoked grant remains authorized'; end if;
 insert into public.shared_moderation_grants values(actor,'roles.bittrees.org',clock_timestamp()-interval '10 seconds',clock_timestamp()-interval '1 second');
 if public.app_is_moderation_staff(actor) then raise exception 'Expired grant authorized'; end if;
 update public.shared_moderation_grants set source='upstash:bittrees:roles',verified_at=clock_timestamp(),expires_at=clock_timestamp()+interval '4 seconds';
 if public.app_is_moderation_staff(actor) then raise exception 'Legacy source authorized'; end if;
 begin perform public.app_moderation_audit_history(actor,'partner',1); raise exception 'Gov membership allowed audit'; exception when insufficient_privilege then null; end;
 if (select count(*) from public.account_roles where account_id=actor)<>2 or (select count(*) from public.moderation_staff where account_id=actor)<>1 then raise exception 'Private roles or historical records modified'; end if;
end $$;
rollback;
