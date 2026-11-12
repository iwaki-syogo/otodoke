-- One final row, every Boolean true and verdict OK. Aggregate counts are informational.
-- SQL/concurrency behavior still requires tests/postgres/run-consent-waiting-storage.mjs.
with checks as (
  select
    exists(select 1 from pg_attribute where attrelid='public.emails'::regclass and attname='consent_waiting_until'
      and atttypid='timestamptz'::regtype and not attisdropped) as expiry_column,
    exists(select 1 from pg_trigger where tgrelid='public.emails'::regclass and tgname='emails_consent_waiting_marker'
      and not tgisinternal and tgenabled='O') as final_write_marker,
    exists(select 1 from pg_proc where oid=to_regprocedure('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)')
      and prosrc like '%filter (where consent_waiting_until is null)%'
      and prosrc like '%v_old.consent_waiting_until <= v_now%'
      and prosrc like '%consent_wait_expired%') as isolated_expiring_intake,
    exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events()')
      and prosrc like '%public.purge_expired_consent_waiting_mail()%') as existing_purge_extended,
    (select count(*)=1 from cron.job where jobname='otodoke-purge-old-screen-events'
      and command='select public.purge_old_screen_events()' and schedule='30 18 * * *' and active) as same_daily_job,
    (select count(*)=8 and bool_and(p.proconfig=array['search_path=""']
      and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not has_function_privilege('service_role',p.oid,'EXECUTE'))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (
        'ai_consent_waiting_retention','mark_consent_waiting_mail','expire_consent_waiting_row','purge_expired_consent_waiting_mail',
        'store_mail_run_before_consent_storage','set_ai_reading_before_consent_storage','purge_old_screen_events_before_consent_storage',
        'store_mail_run_without_sample_fence')) as private_helpers,
    has_function_privilege('authenticated','public.set_ai_reading(text,text)','EXECUTE')
      and not has_function_privilege('anon','public.set_ai_reading(text,text)','EXECUTE')
      and not has_function_privilege('service_role','public.set_ai_reading(text,text)','EXECUTE') as consent_acl,
    not exists(select 1 from public.emails e where e.body_state='plain' and e.processing_status<>'processed'
      and coalesce(e.provider_email_id,'') not like 'demo:%' and coalesce(e.classification,'')<>'forwarding_confirmation'
      and e.consent_waiting_until is null
      and not exists(select 1 from public.ai_reading_consents c where c.user_id=e.user_id and c.decision='granted')) as undecided_declined_backfilled
), inventory as (
  select count(*) filter(where consent_waiting_until is not null) as isolated_waiting_mails,
    count(*) filter(where consent_waiting_until<=clock_timestamp()) as expiry_candidates_next_daily_sweep
  from public.emails where body_state='plain' and processing_status<>'processed'
)
select case when expiry_column and final_write_marker and isolated_expiring_intake and existing_purge_extended
  and same_daily_job and private_helpers and consent_acl and undecided_declined_backfilled then 'OK' else 'FAILED' end as verdict,
  checks.*,inventory.* from checks cross join inventory;
