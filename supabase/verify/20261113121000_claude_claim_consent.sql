-- One final row. SQL behavior/concurrency is tested by run-claude-claim-consent.mjs.
with checks as (
  select
    exists(select 1 from pg_proc where oid=to_regprocedure('public.assert_claude_claim_consent(uuid)')
      and prosrc like '%from public.ai_reading_consents%for share%'
      and prosrc like '%v_decision is distinct from ''granted''%'
      and prosrc like '%raise exception ''ai_consent_required'' using errcode=''42501''%') as consent_row_lock,
    (select count(*)=2 and bool_and(prosrc like '%public.lock_sample_owner(p_user_id)%public.assert_claude_claim_consent(p_user_id)%before_consent_guard%')
      from pg_proc p where oid in (to_regprocedure('public.claim_claude_call(uuid,integer,integer)'),to_regprocedure('public.claim_claude_call_v2(uuid,integer,integer)'))) as parent_before_consent_and_quota,
    (select count(*)=2 and bool_and(p.prosecdef and p.proconfig=array['search_path=""']
      and has_function_privilege('service_role',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE')
      and not has_function_privilege('authenticated',p.oid,'EXECUTE')) from pg_proc p
      where oid in (to_regprocedure('public.claim_claude_call(uuid,integer,integer)'),to_regprocedure('public.claim_claude_call_v2(uuid,integer,integer)'))) as service_only_entries,
    (select count(*)=4 and bool_and(p.prosecdef and p.proconfig=array['search_path=""']
      and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not has_function_privilege('service_role',p.oid,'EXECUTE')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('assert_claude_claim_consent','claim_claude_call_before_consent_guard',
        'claim_claude_call_v2_before_consent_guard','claim_claude_call_v2_without_sample_fence')) as private_cores,
    exists(select 1 from pg_proc where oid=to_regprocedure('public.set_ai_reading(text,text)')
      and md5(prosrc)='0d232f68c8eb0f71f60a1f55c40cb0b3') as setter_prefix_unchanged,
    exists(select 1 from pg_proc where oid=to_regprocedure('public.release_claude_call(bigint,uuid)')
      and prosrc like '%public.release_claude_call_without_sample_fence(p_claim_id,p_user_id)%'
      and prosrc not like '%assert_claude_claim_consent%') as release_without_consent_gate
)
select case when consent_row_lock and parent_before_consent_and_quota and service_only_entries and private_cores
  and setter_prefix_unchanged and release_without_consent_gate then 'OK' else 'FAILED' end as verdict, checks.* from checks;
