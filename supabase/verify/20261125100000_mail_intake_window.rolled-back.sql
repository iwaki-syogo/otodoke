-- Run after supabase/rollback/20261125100000_mail_intake_window.down.sql. Returns ONE row; 'OK' = nothing of the
-- migration is left and screen_events is still there. Reads only.
select
  case
    when to_regclass('public.screen_events') is not null
     and to_regclass('public.mail_intake_user_counts') is null
     and to_regclass('public.mail_intake_global_counts') is null
     and to_regclass('public.screen_events_delivery_digest_idx') is null
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'screen_events' and column_name = 'delivery_digest')
     and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname in ('claim_mail_intake', 'log_screen_event'))
    then 'OK' else 'FAILED'
  end as verdict,
  (select count(*) from public.screen_events) as screen_event_rows;
