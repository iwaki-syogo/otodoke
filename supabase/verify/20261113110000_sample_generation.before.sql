-- Read-only preflight, also valid after this migration's rollback. Read the ONE final row.
-- No row, an SQL error, a partial state, an unexpected definition, or FAILED means STOP.
-- The cost and parcel-conflict gateways must already exist. A pending state is informational,
-- never permission to apply this migration. Apply/verify the four preceding migrations first.
-- Stop and drain sample loads/clears/re-reads before changing their database boundary.
-- Body fingerprints identify the supported, unwrapped prior RPC versions. A legitimate new
-- implementation needs an explicit review of this gate and its real SQL verification too.
with inventory as (
  select
    to_regclass('auth.users') is not null and to_regprocedure('auth.uid()') is not null
      and to_regclass('public.emails') is not null and to_regclass('public.parcels') is not null
      and to_regclass('public.extractions') is not null and to_regclass('public.parcel_items') is not null as auth_and_base_ok,
    coalesce(has_table_privilege(current_user,to_regclass('auth.users'),'TRIGGER'),false) as can_create_auth_delete_trigger,
    (select count(*) = 3 from pg_roles where rolname in ('anon','authenticated','service_role')) as roles_ok,
    to_regclass('public.ai_reading_consents') is not null as consent_table,
    to_regprocedure('public.set_ai_reading(text,text)') is not null as consent_rpc,
    to_regclass('public.ai_consent_read_runs') is not null as auto_table,
    to_regprocedure('public.claim_ai_reading_backlog(uuid,timestamptz)') is not null as auto_rpc,
    to_regclass('public.mail_intake_notices') is not null as intake_table,
    to_regprocedure('public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb)') is not null as intake_rpc,
    to_regprocedure('public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb)') is not null as owned_rpc,
    to_regprocedure('public.create_mail_parcel(jsonb,jsonb,jsonb,uuid,uuid)') is not null
      and to_regprocedure('public.update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)') is not null
      and to_regprocedure('public.ensure_mail_parcel_items(uuid,timestamptz,jsonb,uuid,uuid)') is not null
      and to_regprocedure('public.mail_parcel_snapshot(uuid)') is not null
      and to_regprocedure('public.lock_parcel_candidates()') is not null as parcel_rpcs,
    (select count(*) from pg_attribute where attrelid = to_regclass('public.emails') and attname in ('processing_run_id','processing_lease_until') and not attisdropped) as lease_columns,
    to_regclass('public.sample_generations') is null
      and not exists(select 1 from pg_attribute where attrelid = to_regclass('public.emails') and attname = 'sample_generation' and not attisdropped)
      and not exists(select 1 from pg_trigger where tgname in ('sample_generation_fence','sample_generation_statement_fence','sample_generation_owner_delete') and not tgisinternal)
      and not exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in (
        'begin_sample_load','clear_all_parcels','receive_sample_parcels','lock_sample_owner','assert_sample_generation','fence_sample_write',
        'store_mail_run_without_sample_fence','mail_run_write_without_sample_fence',
        'create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence',
        'prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete')) as sample_absent
), states as (
  select inventory.*,
    case when not consent_table and not consent_rpc then 'pending_with_prior_migrations'
      when consent_table and consent_rpc then 'present' else 'partial' end as consent_state,
    case when not auto_table and not auto_rpc then 'pending_with_prior_migrations'
      when auto_table and auto_rpc and consent_table and consent_rpc then 'present' else 'partial' end as auto_read_state,
    case when not intake_table and not intake_rpc and not owned_rpc and lease_columns = 0 then 'pending_with_prior_migrations'
      when intake_table and intake_rpc and owned_rpc and lease_columns = 2 then 'present' else 'partial' end as prerequisite_state
  from inventory
), checks as (
  select states.*,
    intake_rpc as required_store_mail_run_present,
    owned_rpc as required_owned_write_present,
    parcel_rpcs as required_parcel_gateways_present,
    (not auto_table or consent_table) and (not intake_table or auto_table) and (not parcel_rpcs or intake_table) as prior_prefix_ok,
    not exists(select 1 from (values
      ('public.ai_reading_consents',consent_state,4), ('public.ai_consent_read_runs',auto_read_state,2), ('public.mail_intake_notices',prerequisite_state,3)
    ) t(relation,state,n) where t.state = 'present' and (
      (select count(*) from pg_attribute where attrelid = to_regclass(t.relation) and attnum > 0 and not attisdropped) <> t.n
      or not coalesce((select relrowsecurity from pg_class where oid = to_regclass(t.relation)),false)
      or not exists(select 1 from pg_constraint where conrelid = to_regclass(t.relation) and contype = 'p' and pg_get_constraintdef(oid) = 'PRIMARY KEY (user_id)')
      or not exists(select 1 from pg_constraint where conrelid = to_regclass(t.relation) and contype = 'f' and confrelid = to_regclass('auth.users') and confdeltype = 'c' and convalidated)
    )) and not exists(select 1 from (values
      ('public.ai_reading_consents',consent_state,'user_id','uuid'::regtype,true),
      ('public.ai_reading_consents',consent_state,'decision','text'::regtype,true),
      ('public.ai_reading_consents',consent_state,'decided_at','timestamptz'::regtype,true),
      ('public.ai_reading_consents',consent_state,'text_version','text'::regtype,true),
      ('public.ai_consent_read_runs',auto_read_state,'user_id','uuid'::regtype,true),
      ('public.ai_consent_read_runs',auto_read_state,'consent_decided_at','timestamptz'::regtype,true),
      ('public.mail_intake_notices',prerequisite_state,'user_id','uuid'::regtype,true),
      ('public.mail_intake_notices',prerequisite_state,'limited_at','timestamptz'::regtype,true),
      ('public.mail_intake_notices',prerequisite_state,'reason','text'::regtype,true),
      ('public.emails',prerequisite_state,'processing_run_id','uuid'::regtype,false),
      ('public.emails',prerequisite_state,'processing_lease_until','timestamptz'::regtype,false)
    ) e(relation,state,column_name,type_oid,required)
      left join pg_attribute a on a.attrelid = to_regclass(e.relation) and a.attname = e.column_name and not a.attisdropped
      where e.state = 'present' and (a.atttypid is distinct from e.type_oid or a.attnotnull is distinct from e.required))
    and (consent_state <> 'present' or (
      exists(select 1 from pg_constraint where conrelid = to_regclass('public.ai_reading_consents') and contype = 'c' and convalidated
        and pg_get_constraintdef(oid) like '%granted%' and pg_get_constraintdef(oid) like '%declined%')
      and has_table_privilege('authenticated',to_regclass('public.ai_reading_consents'),'SELECT')
      and has_table_privilege('service_role',to_regclass('public.ai_reading_consents'),'SELECT')
      and not has_table_privilege('authenticated',to_regclass('public.ai_reading_consents'),'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege('service_role',to_regclass('public.ai_reading_consents'),'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege('anon',to_regclass('public.ai_reading_consents'),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    )) and (auto_read_state <> 'present' or (
      not has_table_privilege('anon',to_regclass('public.ai_consent_read_runs'),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege('authenticated',to_regclass('public.ai_consent_read_runs'),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege('service_role',to_regclass('public.ai_consent_read_runs'),'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    )) and (prerequisite_state <> 'present' or (
      has_table_privilege('authenticated',to_regclass('public.mail_intake_notices'),'SELECT')
      and has_table_privilege('authenticated',to_regclass('public.mail_intake_notices'),'DELETE')
      and not has_table_privilege('authenticated',to_regclass('public.mail_intake_notices'),'INSERT,UPDATE')
      and not has_table_privilege('anon',to_regclass('public.mail_intake_notices'),'SELECT,INSERT,UPDATE,DELETE')
    )) as expected_structures_ok,
    (select count(*) = case when consent_state = 'present' then 1 else 0 end from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'set_ai_reading')
      and (select count(*) = case when auto_read_state = 'present' then 1 else 0 end from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'claim_ai_reading_backlog')
      and (select count(*) = case when prerequisite_state = 'present' then 2 else 0 end from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('store_mail_run','mail_run_write')) and (not parcel_rpcs or (select count(*)=5 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('create_mail_parcel','update_mail_parcel','ensure_mail_parcel_items','mail_parcel_snapshot','lock_parcel_candidates'))) and (prerequisite_state<>'present' or (select count(*)=3 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('claim_claude_call','claim_claude_call_v2','release_claude_call'))) as no_extra_overloads,
    (prerequisite_state <> 'present' or (
      exists(select 1 from pg_proc p where p.oid = to_regprocedure('public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb)')
        and p.proargnames = array['p_user_id','p_email_id','p_run_id','p_columns','p_expected_created_at','p_limits','verdict','email_id']
        and pg_get_function_result(p.oid) = 'TABLE(verdict text, email_id uuid)')
      and exists(select 1 from pg_proc p where p.oid = to_regprocedure('public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb)')
        and p.proargnames = array['p_email_id','p_run_id','p_table','p_operation','p_values','p_filters'] and pg_get_function_result(p.oid) = 'jsonb')
    )) as expected_rpc_abi_ok,
    (prerequisite_state <> 'present' or (
      exists(select 1 from pg_proc where oid = to_regprocedure('public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb)') and md5(prosrc) = '3ea94d29e7f03b05060d3cd428b6f645')
      and exists(select 1 from pg_proc where oid = to_regprocedure('public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb)') and md5(prosrc) = case when parcel_rpcs then '2672195186996d6c1da415ce09216014' else '09f1ab05ad5ccac3c31a8f5512dc9c0c' end)
      and exists(select 1 from pg_proc where oid = to_regprocedure('public.claim_claude_call(uuid,integer,integer)') and md5(prosrc) = 'ab7586c4c396b0ca1db60c4d63225b60')
      and exists(select 1 from pg_proc where oid = to_regprocedure('public.claim_claude_call_v2(uuid,integer,integer)') and md5(prosrc) = '9cac5bf34db2a84a7f9554569e3940ba')
      and exists(select 1 from pg_proc where oid = to_regprocedure('public.release_claude_call(bigint,uuid)') and md5(prosrc) = 'c32011cb8f66c469cd947af2a2be4461')
    )) and (consent_state <> 'present' or exists(select 1 from pg_proc where oid = to_regprocedure('public.set_ai_reading(text,text)')
      and md5(prosrc) = case when auto_read_state = 'present' then '3a0d1452f9a11dc8396691b04e95448b' else 'da05fd2061bc698db9809bc1741b62c3' end))
    and (auto_read_state <> 'present' or exists(select 1 from pg_proc where oid = to_regprocedure('public.claim_ai_reading_backlog(uuid,timestamptz)') and md5(prosrc) = '6d302317a1265f556b7a7457c5975908'))
    and (not parcel_rpcs or (
      exists(select 1 from pg_proc where oid = to_regprocedure('public.create_mail_parcel(jsonb,jsonb,jsonb,uuid,uuid)') and md5(prosrc) = 'c4c8cd221d81a65693501f1f76c6da43' and pronargdefaults=2
        and proargnames=array['p_snapshot','p_values','p_items','p_email_id','p_run_id','verdict','parcel_id'] and pg_get_function_result(oid)='TABLE(verdict text, parcel_id uuid)')
      and exists(select 1 from pg_proc where oid = to_regprocedure('public.update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)') and md5(prosrc) = '1f31656cb496ae7332d5ce722ef5039a' and pronargdefaults=2
        and proargnames=array['p_snapshot','p_parcel_id','p_expected_updated_at','p_values','p_category','p_items','p_email_id','p_run_id','verdict','parcel_id','parcel_row'] and pg_get_function_result(oid)='TABLE(verdict text, parcel_id uuid, parcel_row jsonb)')
      and exists(select 1 from pg_proc where oid = to_regprocedure('public.ensure_mail_parcel_items(uuid,timestamptz,jsonb,uuid,uuid)') and md5(prosrc) = '9b794fc0498e1a85e6058a68e0895755' and pronargdefaults=2
        and proargnames=array['p_parcel_id','p_expected_updated_at','p_items','p_email_id','p_run_id','verdict'] and pg_get_function_result(oid)='TABLE(verdict text)')
      and exists(select 1 from pg_proc where oid = to_regprocedure('public.mail_parcel_snapshot(uuid)') and md5(prosrc)='93b25c57e72edd8476fa87b9276daaca')
      and exists(select 1 from pg_proc where oid = to_regprocedure('public.lock_parcel_candidates()') and md5(prosrc) = '9b397e6fa6a3471f713395ee78ccd9b9')
    )) as expected_guard_definitions_ok,
    not exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname in ('store_mail_run','mail_run_write','set_ai_reading','claim_ai_reading_backlog','create_mail_parcel','update_mail_parcel','ensure_mail_parcel_items','lock_parcel_candidates','mail_parcel_snapshot','claim_claude_call','claim_claude_call_v2','release_claude_call') and (
        not p.prosecdef or p.proconfig is distinct from array['search_path=""']
        or pg_get_userbyid(p.proowner) is distinct from (select tableowner from pg_tables where schemaname = 'public' and tablename = 'emails')
        or has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE') is distinct from (p.proname = 'set_ai_reading')
        or has_function_privilege('service_role', p.oid, 'EXECUTE') is distinct from (p.proname <> 'set_ai_reading')
      )) as expected_privileges_owner_ok,
    not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('store_mail_run','mail_run_write','create_mail_parcel','update_mail_parcel','ensure_mail_parcel_items','claim_ai_reading_backlog','release_claude_call','claim_claude_call_v2','store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence','lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete','begin_sample_load','clear_all_parcels','receive_sample_parcels','lock_parcel_candidates','mail_parcel_snapshot','claim_claude_call','set_ai_reading') and not (select count(*)=case when p.proname in ('store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence','lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete') then 1 else 2 end
      and bool_and(a.grantor=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable
        and (a.grantee=p.proowner or coalesce(a.grantee=case when p.proname in ('store_mail_run_without_sample_fence','mail_run_write_without_sample_fence','create_mail_parcel_without_sample_fence','update_mail_parcel_without_sample_fence','ensure_mail_parcel_items_without_sample_fence','claim_ai_reading_backlog_without_sample_fence','release_claude_call_without_sample_fence','claim_claude_call_v2_without_sample_fence','lock_sample_owner','assert_sample_generation','fence_sample_write','prelock_sample_request','prelock_sample_statement','prelock_sample_owner_delete') then null::oid
          when p.proname='set_ai_reading' then 'authenticated'::regrole::oid else 'service_role'::regrole::oid end,false)))
    from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) as expected_function_acls_ok
  from states
)
select auth_and_base_ok, can_create_auth_delete_trigger, roles_ok, consent_state, auto_read_state, prerequisite_state, prior_prefix_ok, sample_absent, expected_structures_ok,
  required_store_mail_run_present, required_owned_write_present, required_parcel_gateways_present,
  expected_rpc_abi_ok, expected_guard_definitions_ok, expected_privileges_owner_ok, expected_function_acls_ok, no_extra_overloads,
  case when auth_and_base_ok and can_create_auth_delete_trigger and roles_ok and consent_state <> 'partial' and auto_read_state <> 'partial' and prerequisite_state <> 'partial'
    and required_store_mail_run_present and required_owned_write_present and required_parcel_gateways_present
    and prior_prefix_ok and sample_absent and expected_structures_ok and expected_rpc_abi_ok and expected_guard_definitions_ok and expected_privileges_owner_ok and expected_function_acls_ok and no_extra_overloads
    then 'OK' else 'FAILED' end as verdict
from checks;
