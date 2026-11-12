-- Read the ONE final row: every Boolean must be true and verdict must be OK.
-- Missing output, an SQL error or FAILED means stop. Runtime/concurrency verification is separate.
-- Probe the existing SECURITY DEFINER helper as its real owner. No user values are returned.
-- An absent UUID must fail before generation INSERT. A theoretical concurrent appearance or
-- an altered helper returning normally aborts this statement, rolling back any probe write.
do $auth_lock_probe$
declare
  v_probe uuid := pg_catalog.gen_random_uuid();
  v_missing boolean := false;
begin
  while exists(select 1 from auth.users where id=v_probe) loop
    v_probe := pg_catalog.gen_random_uuid();
  end loop;
  begin
    perform public.lock_sample_owner(v_probe);
  exception
    when foreign_key_violation then
      if sqlerrm is distinct from 'sample owner no longer exists' then
        raise exception 'sample verification: unexpected Auth row-lock probe failure' using errcode='55000';
      end if;
      v_missing := true;
    when others then
      raise exception 'sample verification: Auth row-lock probe failed (SQLSTATE %)',sqlstate using errcode=sqlstate;
  end;
  if v_missing is distinct from true then
    raise exception 'sample verification: Auth row-lock helper returned normally; probe rolled back' using errcode='55000';
  end if;
end $auth_lock_probe$;

with checks as (
  select
    (select count(*)=5 and bool_and(coalesce(has_schema_privilege(p.proowner,to_regnamespace('auth'),'USAGE')
      and has_column_privilege(p.proowner,to_regclass('auth.users'),'id','SELECT')
      and has_any_column_privilege(p.proowner,to_regclass('auth.users'),'UPDATE'),false))
      from pg_proc p where p.oid in (
        to_regprocedure('public.begin_sample_load(uuid)'),to_regprocedure('public.lock_sample_owner(uuid)'),
        to_regprocedure('public.claim_claude_call_v2(uuid,integer,integer)'),
        to_regprocedure('public.release_claude_call(bigint,uuid)'),to_regprocedure('public.claim_ai_reading_backlog(uuid,timestamptz)'))
    ) as runtime_auth_lock_owners_ok,
    (select count(*) = 4 from pg_trigger where tgname = 'sample_generation_fence' and not tgisinternal and tgenabled = 'O') as four_write_fences,
    not exists(select 1 from public.emails where provider_email_id like 'demo:%' and sample_generation is null) as sample_metadata_backfilled,
    not has_table_privilege('anon','public.sample_generations','SELECT')
      and not has_table_privilege('authenticated','public.sample_generations','SELECT')
      and not has_table_privilege('service_role','public.sample_generations','UPDATE') as private_generation_state,
    (select count(*) = 11 and bool_and(has_function_privilege('service_role',p.oid,'EXECUTE')
      and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE'))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
      and p.proname in ('begin_sample_load','clear_all_parcels','receive_sample_parcels','store_mail_run','mail_run_write','create_mail_parcel','update_mail_parcel','ensure_mail_parcel_items','claim_ai_reading_backlog','release_claude_call','claim_claude_call_v2')) as service_only_entrypoints,
    (select count(*) = 14 and bool_and(not has_function_privilege('service_role',p.oid,'EXECUTE')
      and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE'))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in (
        'store_mail_run_without_sample_fence','mail_run_write_without_sample_fence',
        'create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence',
        'lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete')) as core_helpers_private,
    (select count(*) = 11 and bool_and(p.prosecdef and p.proconfig is not distinct from array['search_path=""']
      and pg_get_userbyid(p.proowner) = (select tableowner from pg_tables where schemaname = 'public' and tablename = 'emails')
      and pg_get_userbyid(p.proowner) = (select tableowner from pg_tables where schemaname = 'public' and tablename = 'sample_generations'))
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
      and p.proname in ('begin_sample_load','clear_all_parcels','receive_sample_parcels','store_mail_run','mail_run_write','create_mail_parcel','update_mail_parcel','ensure_mail_parcel_items','claim_ai_reading_backlog','release_claude_call','claim_claude_call_v2')) and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('store_mail_run','mail_run_write','create_mail_parcel','update_mail_parcel','ensure_mail_parcel_items','claim_ai_reading_backlog','release_claude_call','claim_claude_call_v2','store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence','lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete','begin_sample_load','clear_all_parcels','receive_sample_parcels','lock_parcel_candidates','mail_parcel_snapshot','claim_claude_call','set_ai_reading') and not (select count(*)=case when p.proname in ('store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence','lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete') then 1 else 2 end
      and bool_and(a.grantor=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable
        and (a.grantee=p.proowner or coalesce(a.grantee=case when p.proname in ('store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence','lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete') then null::oid
          when p.proname='set_ai_reading' then 'authenticated'::regrole::oid else 'service_role'::regrole::oid end,false)))
    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) as secure_gateways,
    (select count(*)=2 from pg_trigger where tgname='sample_generation_statement_fence' and not tgisinternal and tgenabled='O')
      and exists(select 1 from pg_proc where oid=to_regprocedure('public.lock_parcel_candidates()')
        and prosrc like '%perform public.prelock_sample_request();%pg_advisory_xact_lock(62803,pg_catalog.hashtext(v_owner::text))%')
      and (select count(*)=2 from pg_trigger where tgname in ('parcels_candidate_owner','parcel_items_candidate_owner')
        and tgtype=31 and tgfoid=to_regprocedure('public.lock_parcel_candidates()') and not tgisinternal and tgenabled='O'
        and tgrelid=case tgname when 'parcels_candidate_owner' then 'public.parcels'::regclass else 'public.parcel_items'::regclass end
        and tgqual is null and tgattr=''::int2vector and tgnargs=0)
      and (select count(*)=1 from pg_trigger where tgrelid=to_regclass('auth.users') and tgname='parcel_candidate_owner_delete'
        and tgtype=11 and tgfoid=to_regprocedure('public.prelock_sample_owner_delete()') and not tgisinternal and tgenabled='O' and tgqual is null and tgnargs=0) as statement_prelocks
)
select checks.*, case when four_write_fences and sample_metadata_backfilled and private_generation_state
  and service_only_entrypoints and core_helpers_private and secure_gateways and statement_prelocks and runtime_auth_lock_owners_ok then 'OK' else 'FAILED' end as verdict
from checks;
