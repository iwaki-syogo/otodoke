-- Read-only. Apply only after 120000 verify: its U/G/E -> C setter is a lock dependency.
-- Read the final row: all Boolean checks true and verdict OK. No contents/env values.
with checks as (
  select
    to_regprocedure('public.ai_consent_waiting_retention()') is not null
      and to_regprocedure('public.set_ai_reading_before_consent_storage(text,text)') is not null
      and exists(select 1 from pg_proc where oid=to_regprocedure('public.set_ai_reading(text,text)')
        and md5(prosrc)='0d232f68c8eb0f71f60a1f55c40cb0b3') as required_120000_setter_prefix,
    to_regprocedure('public.claim_claude_call(uuid,integer,integer)') is not null
      and to_regprocedure('public.claim_claude_call_v2(uuid,integer,integer)') is not null
      and to_regprocedure('public.claim_claude_call_v2_without_sample_fence(uuid,integer,integer)') is not null as prior_quota_gateways,
    exists(select 1 from pg_proc where oid=to_regprocedure('public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb)')
      and prosrc like '%public.lock_sample_owner(v_user_id)%') as owned_parent_prefix,
    coalesce(has_schema_privilege(current_user,to_regnamespace('auth'),'USAGE')
      and has_column_privilege(current_user,to_regclass('auth.users'),'id','SELECT')
      and has_any_column_privilege(current_user,to_regclass('auth.users'),'UPDATE'),false)
      and has_table_privilege(current_user,'public.sample_generations','SELECT') and has_table_privilege(current_user,'public.sample_generations','UPDATE')
      and has_table_privilege(current_user,'public.ai_reading_consents','SELECT') and has_table_privilege(current_user,'public.ai_reading_consents','UPDATE') as required_lock_privileges,
    not has_function_privilege('anon','public.claim_claude_call_v2_without_sample_fence(uuid,integer,integer)','EXECUTE')
      and not has_function_privilege('authenticated','public.claim_claude_call_v2_without_sample_fence(uuid,integer,integer)','EXECUTE')
      and not has_function_privilege('service_role','public.claim_claude_call_v2_without_sample_fence(uuid,integer,integer)','EXECUTE') as prior_core_private,
    (select count(*) in (0,2) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname in ('claim_claude_call_before_consent_guard','claim_claude_call_v2_before_consent_guard')) as complete_backup_state
)
select case when required_120000_setter_prefix and prior_quota_gateways and owned_parent_prefix and required_lock_privileges
  and prior_core_private and complete_backup_state then 'OK' else 'FAILED' end as verdict, checks.* from checks;
