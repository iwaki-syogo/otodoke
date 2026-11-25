-- Run BEFORE applying 20261125100000_mail_intake_window.sql. Returns ONE row; go only if verdict is 'OK'.
-- OK = screen_events exists and is owned by the role running this, and nothing this file creates exists yet.
-- Reads only; prints counts only.
select
  case
    when to_regclass('public.screen_events') is not null
     and to_regclass('auth.users') is not null
     and (select relowner from pg_class where oid = to_regclass('public.screen_events')) = (select oid from pg_roles where rolname = current_user)
     and to_regclass('public.mail_intake_user_counts') is null
     and to_regclass('public.mail_intake_global_counts') is null
     and to_regclass('public.screen_events_delivery_digest_idx') is null
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'screen_events' and column_name = 'delivery_digest')
     and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname in ('claim_mail_intake', 'log_screen_event'))
    then 'OK' else 'FAILED'
  end as verdict,
  (select count(*) from public.screen_events) as screen_event_rows;
