-- Read-only preflight and aggregate inventory. No mail contents or environment values.
-- Run after 110000 verify, with all mail/sample/parcel writers stopped and drained.
with checks as (
  select
    to_regprocedure('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)') is not null as owned_core,
    to_regprocedure('public.lock_sample_owner(uuid)') is not null as owner_prefix,
    to_regprocedure('public.set_ai_reading(text,text)') is not null as consent_entry,
    to_regprocedure('public.purge_old_screen_events()') is not null as existing_purge,
    exists(select 1 from cron.job where jobname='otodoke-purge-old-screen-events'
      and command='select public.purge_old_screen_events()' and schedule='30 18 * * *' and active) as existing_daily_job,
    (select count(*) in (0,3) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname in ('store_mail_run_before_consent_storage','set_ai_reading_before_consent_storage','purge_old_screen_events_before_consent_storage')) as complete_backup_state,
    exists(select 1 from pg_attribute where attrelid='public.emails'::regclass and attname='received_at' and attnotnull and not attisdropped) as arrival_timestamp
), inventory as (
  select count(*) as plain_unread_mails,count(distinct e.user_id) as plain_unread_owners,
    count(*) filter(where e.error in ('ai_consent_required','ai_consent_unknown')
      or not exists(select 1 from public.ai_reading_consents c where c.user_id=e.user_id and c.decision='granted')) as waiting_backfill_candidates
  from public.emails e where e.body_state='plain' and e.processing_status<>'processed'
    and coalesce(e.provider_email_id,'') not like 'demo:%' and coalesce(e.classification,'')<>'forwarding_confirmation'
)
select case when owned_core and owner_prefix and consent_entry and existing_purge and existing_daily_job
  and complete_backup_state and arrival_timestamp then 'OK' else 'FAILED' end as verdict, checks.*,inventory.*
from checks cross join inventory;
