-- Roll back 20261113110000 BEFORE 20261113100000 and 20261113090000.
-- Full rollback order: 20261113110000 -> 20261113100000 -> 20261113090000
--   -> 20261112181000 -> 20261112180000 (110000 -> 100000 -> 090000 -> 181000 -> 180000).
-- Stop and drain sample loads, clears, re-reads and all parcel writers first.
-- The older application uses two DELETE requests; its original sample/clear race returns.
-- Preserve saved data and all four prerequisite features. DROP RESTRICT rejects unknown
-- dependencies atomically. Unknown newer gateways require an explicitly reviewed rollback.
begin;
set local lock_timeout='5s';
do $$
declare
  v_owner name := (select tableowner from pg_tables where schemaname='public' and tablename='emails');
  v_count integer;
  v_installed boolean;
  v_core regprocedure;
  v_public regprocedure;
  x record;
begin
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence');
  if v_count not in (0,8) then raise exception 'sample rollback: partial core gateways; stop and inspect'; end if;
  v_installed := v_count=8;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('store_mail_run','mail_run_write','create_mail_parcel','update_mail_parcel','ensure_mail_parcel_items','claim_ai_reading_backlog','release_claude_call','claim_claude_call_v2','store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence','lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete','begin_sample_load','clear_all_parcels','receive_sample_parcels','lock_parcel_candidates','mail_parcel_snapshot','claim_claude_call','set_ai_reading') and not (select count(*)=case when p.proname in ('store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence','lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete') then 1 else 2 end
      and bool_and(a.grantor=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable
        and (a.grantee=p.proowner or coalesce(a.grantee=case when p.proname in ('store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence','lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete') then null::oid
          when p.proname='set_ai_reading' then 'authenticated'::regrole::oid else 'service_role'::regrole::oid end,false)))
    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) then
    raise exception 'sample rollback: nonstandard function ACL; review its rollback gate';
  end if;
  if to_regclass('public.ai_reading_consents') is null or to_regclass('public.ai_consent_read_runs') is null
    or not exists(select 1 from pg_proc where oid=to_regprocedure('public.set_ai_reading(text,text)') and md5(prosrc)='3a0d1452f9a11dc8396691b04e95448b')
    or not exists(select 1 from pg_proc where oid=to_regprocedure(case when v_installed then 'public.claim_ai_reading_backlog_without_sample_fence(uuid,timestamptz)' else 'public.claim_ai_reading_backlog(uuid,timestamptz)' end) and md5(prosrc)='6d302317a1265f556b7a7457c5975908')
    or to_regprocedure('public.mail_parcel_snapshot(uuid)') is null then
    raise exception 'sample rollback: all four preceding migrations must remain installed';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('store_mail_run','mail_run_write','create_mail_parcel','update_mail_parcel','ensure_mail_parcel_items','claim_ai_reading_backlog','release_claude_call','claim_claude_call_v2'))<>8 then
    raise exception 'sample rollback: public gateway ABI is partial or overloaded';
  end if;
  for x in select * from (values
      ('store_mail_run','uuid,uuid,uuid,jsonb,timestamptz,jsonb','3ea94d29e7f03b05060d3cd428b6f645','9b376382ace9f7b90e85c6db747a790c',array['p_user_id','p_email_id','p_run_id','p_columns','p_expected_created_at','p_limits','verdict','email_id'],'TABLE(verdict text, email_id uuid)',0),
      ('mail_run_write','uuid,uuid,text,text,jsonb,jsonb','2672195186996d6c1da415ce09216014','7de48eb9d022e5bb73e76c70cd76d7cb',array['p_email_id','p_run_id','p_table','p_operation','p_values','p_filters'],'jsonb',0),
      ('create_mail_parcel','jsonb,jsonb,jsonb,uuid,uuid','c4c8cd221d81a65693501f1f76c6da43','70f30aad142f93aa95ce73a48bf8d9cb',array['p_snapshot','p_values','p_items','p_email_id','p_run_id','verdict','parcel_id'],'TABLE(verdict text, parcel_id uuid)',2),
      ('update_mail_parcel','jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid','1f31656cb496ae7332d5ce722ef5039a','fe9df2cb9b9833c1a18fdbc1988114be',array['p_snapshot','p_parcel_id','p_expected_updated_at','p_values','p_category','p_items','p_email_id','p_run_id','verdict','parcel_id','parcel_row'],'TABLE(verdict text, parcel_id uuid, parcel_row jsonb)',2),
      ('ensure_mail_parcel_items','uuid,timestamptz,jsonb,uuid,uuid','9b794fc0498e1a85e6058a68e0895755','193a3dbf00b515c93ab412de7fc25eb6',array['p_parcel_id','p_expected_updated_at','p_items','p_email_id','p_run_id','verdict'],'TABLE(verdict text)',2),
      ('claim_ai_reading_backlog','uuid,timestamptz','6d302317a1265f556b7a7457c5975908','3bff58f66dec66c0f838e10571e2d3dd',array['p_user_id','p_decided_at'],'boolean',0),
      ('release_claude_call','bigint,uuid','c32011cb8f66c469cd947af2a2be4461','8ff987a5ce6a60eedf56d429f23cbb98',array['p_claim_id','p_user_id'],'integer',0),
      ('claim_claude_call_v2','uuid,integer,integer','9cac5bf34db2a84a7f9554569e3940ba','7a8227959c7525cf265a713ab844dfc1',array['p_user_id','p_user_limit','p_global_limit','verdict','claim_id'],'TABLE(verdict text, claim_id bigint)',0)
    ) m(name,signature,core_hash,wrapper_hash,argnames,result_type,defaults)
  loop
    v_public := to_regprocedure('public.'||x.name||'('||x.signature||')');
    v_core := case when v_installed then to_regprocedure('public.'||x.name||'_without_sample_fence('||x.signature||')') else v_public end;
    if not exists(select 1 from pg_proc p where p.oid=v_core and md5(p.prosrc)=x.core_hash
      and p.proargnames=x.argnames and pg_get_function_result(p.oid)=x.result_type and p.pronargdefaults=x.defaults
      and p.prosecdef and p.proconfig=array['search_path=""'] and pg_get_userbyid(p.proowner)=v_owner
      and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
      and has_function_privilege('service_role',p.oid,'EXECUTE')=not v_installed) then
      raise exception 'sample rollback: expected prior owned gateways are missing or changed: %',x.name;
    end if;
    if v_installed and not exists(select 1 from pg_proc p where p.oid=v_public and md5(p.prosrc)=x.wrapper_hash
      and p.proargnames=x.argnames and pg_get_function_result(p.oid)=x.result_type and p.pronargdefaults=x.defaults
      and p.prosecdef and p.proconfig=array['search_path=""'] and pg_get_userbyid(p.proowner)=v_owner
      and has_function_privilege('service_role',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not has_function_privilege('authenticated',p.oid,'EXECUTE')) then
      raise exception 'sample rollback: public sample wrapper changed; review its rollback before removing it: %',x.name;
    end if;
  end loop;
  if not exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.lock_parcel_candidates()')
    and md5(p.prosrc)=case when v_installed then '9f7ee53462feefb38eb3f83c4f9a8ea8' else '9b397e6fa6a3471f713395ee78ccd9b9' end
    and p.prosecdef and p.proconfig=array['search_path=""'] and pg_get_userbyid(p.proowner)=v_owner
    and has_function_privilege('service_role',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE')
    and not has_function_privilege('authenticated',p.oid,'EXECUTE')) then
    raise exception 'sample rollback: candidate lock boundary changed; stop and inspect';
  end if;
  if v_installed then
    if to_regprocedure('public.begin_sample_load(uuid)') is null
      or to_regprocedure('public.clear_all_parcels(uuid)') is null
      or to_regprocedure('public.receive_sample_parcels(uuid,uuid[],timestamptz)') is null
      or to_regprocedure('public.lock_sample_owner(uuid)') is null
      or to_regprocedure('public.assert_sample_generation(uuid,boolean)') is null
      or to_regprocedure('public.fence_sample_write()') is null
      or to_regprocedure('public.prelock_sample_request()') is null
      or to_regprocedure('public.prelock_sample_statement()') is null
      or to_regprocedure('public.prelock_sample_owner_delete()') is null then
      raise exception 'sample rollback: required helper signature is missing; stop and inspect';
    end if;
    if to_regclass('public.sample_generations') is null
      or (select count(*) from pg_attribute where attrelid=to_regclass('public.emails') and attname='sample_generation' and not attisdropped)<>1
      or (select count(*) from pg_trigger where tgname='sample_generation_fence' and not tgisinternal)<>4
      or (select count(*) from pg_trigger where tgname='sample_generation_statement_fence' and not tgisinternal)<>2
      or (select count(*) from pg_trigger where tgrelid=to_regclass('auth.users') and tgname='sample_generation_owner_delete' and not tgisinternal)<>1
      or (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('begin_sample_load','clear_all_parcels','receive_sample_parcels','lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete','store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence'))<>17 then
      raise exception 'sample rollback: partial sample installation; stop and inspect';
    end if;
  elsif to_regclass('public.sample_generations') is not null
    or exists(select 1 from pg_attribute where attrelid=to_regclass('public.emails') and attname='sample_generation' and not attisdropped)
    or exists(select 1 from pg_trigger where tgname in ('sample_generation_fence','sample_generation_statement_fence','sample_generation_owner_delete') and not tgisinternal)
    or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('begin_sample_load','clear_all_parcels','receive_sample_parcels','lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete','store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence')) then
    raise exception 'sample rollback: partial rolled-back state; stop and inspect';
  end if;
end $$;

drop trigger if exists sample_generation_owner_delete on auth.users;
drop trigger if exists sample_generation_statement_fence on public.emails;
drop trigger if exists sample_generation_statement_fence on public.extractions;
drop trigger if exists sample_generation_fence on public.emails;
drop trigger if exists sample_generation_fence on public.parcels;
drop trigger if exists sample_generation_fence on public.extractions;
drop trigger if exists sample_generation_fence on public.parcel_items;
drop function if exists public.receive_sample_parcels(uuid,uuid[],timestamptz);
drop function if exists public.clear_all_parcels(uuid);
drop function if exists public.begin_sample_load(uuid);

-- Rename original objects back, preserving OID/body/ABI/owner/settings. Restore exact ACLs below.
do $$
declare x record;
begin
  for x in select * from (values ('store_mail_run','uuid,uuid,uuid,jsonb,timestamptz,jsonb'),('mail_run_write','uuid,uuid,text,text,jsonb,jsonb'),('create_mail_parcel','jsonb,jsonb,jsonb,uuid,uuid'),('update_mail_parcel','jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid'),('ensure_mail_parcel_items','uuid,timestamptz,jsonb,uuid,uuid'),('claim_ai_reading_backlog','uuid,timestamptz'),('release_claude_call','bigint,uuid'),('claim_claude_call_v2','uuid,integer,integer')) m(name,signature) loop
    if to_regprocedure('public.'||x.name||'_without_sample_fence('||x.signature||')') is not null then
      execute 'drop function public.'||x.name||'('||x.signature||')';
      execute 'alter function public.'||x.name||'_without_sample_fence('||x.signature||') rename to '||x.name;
    end if;
  end loop;
end $$;

create or replace function public.lock_parcel_candidates() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(62803,0);
  return null; -- statement trigger: no row is suppressed or replaced
end $$;

drop function if exists public.prelock_sample_owner_delete();
drop function if exists public.prelock_sample_statement();
drop function if exists public.prelock_sample_request();
drop function if exists public.fence_sample_write();
drop function if exists public.assert_sample_generation(uuid,boolean);
drop function if exists public.lock_sample_owner(uuid);
alter table public.emails drop column if exists sample_generation;
drop table if exists public.sample_generations;
revoke all on function public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb), public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb), public.create_mail_parcel(jsonb,jsonb,jsonb,uuid,uuid), public.update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid), public.ensure_mail_parcel_items(uuid,timestamptz,jsonb,uuid,uuid), public.claim_ai_reading_backlog(uuid,timestamptz), public.release_claude_call(bigint,uuid), public.claim_claude_call_v2(uuid,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb), public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb), public.create_mail_parcel(jsonb,jsonb,jsonb,uuid,uuid), public.update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid), public.ensure_mail_parcel_items(uuid,timestamptz,jsonb,uuid,uuid), public.claim_ai_reading_backlog(uuid,timestamptz), public.release_claude_call(bigint,uuid), public.claim_claude_call_v2(uuid,integer,integer) to service_role;
commit;
