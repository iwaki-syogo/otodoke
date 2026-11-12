-- Read-only prerequisite proof and aggregate inventory. No history row is created here.
-- Missing real history OR dependency footprint returns FAILED without changing any state.
with prerequisites as (
  select case when to_regclass('supabase_migrations.schema_migrations') is not null
    and exists(select 1 from pg_attribute where attrelid=to_regclass('supabase_migrations.schema_migrations') and attname='version' and not attisdropped)
    then ((xpath('//n/text()',query_to_xml($history$select count(distinct version::text) as n
      from supabase_migrations.schema_migrations where version::text in ('20261113110000','20261113120000','20261113121000')$history$,false,true,'')))[1])::text::integer=3
    else false end as applied_history,
    to_regprocedure('public.lock_sample_owner(uuid)') is not null
    and to_regprocedure('public.update_mail_parcel_without_sample_fence(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)') is not null
    and to_regprocedure('public.ai_consent_waiting_retention()') is not null
    and to_regprocedure('public.purge_expired_consent_waiting_mail()') is not null
    and to_regprocedure('public.set_ai_reading_before_consent_storage(text,text)') is not null
    and to_regprocedure('public.assert_claude_claim_consent(uuid)') is not null
    and to_regprocedure('public.purge_old_screen_events()') is not null
    and exists(select 1 from pg_attribute where attrelid=to_regclass('public.emails') and attname='consent_waiting_until' and not attisdropped)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.claim_claude_call(uuid,integer,integer)') and prosrc like '%public.assert_claude_claim_consent(p_user_id)%')
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.claim_claude_call_v2(uuid,integer,integer)') and prosrc like '%public.assert_claude_claim_consent(p_user_id)%')
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.set_ai_reading(text,text)')
      and prosrc like '%perform public.lock_sample_owner(v_user);%perform id from public.emails where user_id=v_user order by id for update;%public.set_ai_reading_before_consent_storage(p_decision,p_text_version)%')
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)')
      and prosrc like '%perform public.lock_sample_owner(v_user_id);%public.update_mail_parcel_without_sample_fence(%')
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.lock_sample_owner(uuid)')
      and prosrc like '%from auth.users where id=p_user_id for key share;%from public.sample_generations where user_id = p_user_id for update;%')
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events()')
      and (prosrc like '%public.purge_expired_consent_waiting_mail()%'
        or (prosrc like '%public.purge_old_screen_events_before_receipt_retention()%'
          and exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events_before_receipt_retention()')
            and prosrc like '%public.purge_expired_consent_waiting_mail()%')))) as dependency_footprint,
    (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lock_parcel_owner')
      and exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.lock_parcel_owner(uuid)')
        and md5(p.prosrc)='cba30ab8864f4e637cdd74bb913e2f43' and p.proargnames=array['p_user'] and p.pronargdefaults=0 and not p.proisstrict
        and pg_get_function_result(p.oid)='void' and p.prosecdef and p.proconfig=array['search_path=""']
        and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('service_role',p.oid,'EXECUTE')
        and p.proowner=(select relowner from pg_class where oid=to_regclass('public.emails'))
        and (select count(*)=1 and bool_and(a.grantor=p.proowner and a.grantee=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable)
          from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) as shared_owner_helper_ok,
    coalesce((select oid from pg_roles where rolname=current_user)=(select relowner from pg_class where oid=to_regclass('public.emails')),false)
      and coalesce(has_schema_privilege((select relowner from pg_class where oid=to_regclass('public.emails')),to_regnamespace('auth'),'USAGE')
        and has_column_privilege((select relowner from pg_class where oid=to_regclass('public.emails')),to_regclass('auth.users'),'id','SELECT')
        and has_any_column_privilege((select relowner from pg_class where oid=to_regclass('public.emails')),to_regclass('auth.users'),'UPDATE'),false)
      and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('mark_parcels_received','restore_parcel_receipts','update_mail_parcel_without_sample_fence','update_mail_parcel','lock_sample_owner','parcel_receipt_retention','purge_expired_parcel_receipts','purge_old_screen_events','purge_old_screen_events_before_receipt_retention')
        and (p.proowner is distinct from (select relowner from pg_class where oid=to_regclass('public.emails'))
          or not (select count(*)=case when p.proname in ('mark_parcels_received','restore_parcel_receipts','update_mail_parcel') then 2 else 1 end
            and bool_and(a.grantor=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable and
              (a.grantee=p.proowner or coalesce(a.grantee=case when p.proname in ('mark_parcels_received','restore_parcel_receipts') then 'authenticated'::regrole::oid
                when p.proname='update_mail_parcel' then 'service_role'::regrole::oid else null::oid end,false)))
            from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)))
      and not exists(select 1 from pg_class where oid=to_regclass('public.parcel_receipt_undos')
        and relowner is distinct from (select relowner from pg_class where oid=to_regclass('public.emails'))) as receipt_execution_owner_ok,
    not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.prosrc ~* 'pg_(try_)?advisory(_xact)?_lock(_shared)?[[:space:]]*\([[:space:]]*62803[[:space:]]*,[[:space:]]*0[[:space:]]*\)') as no_global_candidate_lock
), inventory as (
  select count(*) as parcels,count(*) filter(where to_jsonb(p)->>'received_at' is not null) as received from public.parcels p
), checks as (
  select prerequisites.*,inventory.*,
    (select count(*)<=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='mark_parcels_received')
    and (select count(*)<=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='restore_parcel_receipts') as no_extra_overloads
  from prerequisites cross join inventory
)
select case when applied_history and dependency_footprint and shared_owner_helper_ok and receipt_execution_owner_ok and no_global_candidate_lock and no_extra_overloads then 'OK' else 'FAILED' end as verdict,checks.* from checks;
