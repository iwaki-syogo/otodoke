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
            and prosrc like '%public.purge_expired_consent_waiting_mail()%')))) as dependency_footprint
), inventory as (
  select count(*) as parcels,count(*) filter(where to_jsonb(p)->>'received_at' is not null) as received from public.parcels p
), checks as (
  select prerequisites.*,inventory.*,
    (select count(*)<=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='mark_parcels_received')
    and (select count(*)<=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='restore_parcel_receipts') as no_extra_overloads
  from prerequisites cross join inventory
)
select case when applied_history and dependency_footprint and no_extra_overloads then 'OK' else 'FAILED' end as verdict,checks.* from checks;
