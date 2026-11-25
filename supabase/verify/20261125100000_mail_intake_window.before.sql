-- Run BEFORE applying 20261125100000_mail_intake_window.sql, as the role that will apply it.
-- Returns ONE row: verdict first ('OK' only when every check column is t), then the checks, then a count.
-- Go only if verdict is 'OK'. Missing output, an SQL error or FAILED means stop.
--   owns_screen_events:     this role owns public.screen_events (the migration runs as that owner).
--   can_lock_auth_user_rows: this role, which will own the new SECURITY DEFINER functions, has schema auth USAGE,
--                           SELECT(id) and UPDATE on at least one column of auth.users (column grants and inherited
--                           grants count). Without them every claim fails at run time.
--   can_reference_auth_users: REFERENCES(id) on auth.users, for the new tables' foreign keys.
--   nothing_yet:            nothing this file creates exists yet.
-- Reads only; prints a count only.
with checks as (
  select
    coalesce(to_regclass('public.screen_events') is not null and to_regclass('auth.users') is not null
      and (select relowner from pg_class where oid = to_regclass('public.screen_events')) = (select oid from pg_roles where rolname = current_user),
      false) as owns_screen_events,
    coalesce(has_schema_privilege(current_user, to_regnamespace('auth'), 'USAGE')
      and has_column_privilege(current_user, to_regclass('auth.users'), 'id', 'SELECT')
      and has_any_column_privilege(current_user, to_regclass('auth.users'), 'UPDATE'), false) as can_lock_auth_user_rows,
    coalesce(has_column_privilege(current_user, to_regclass('auth.users'), 'id', 'REFERENCES'), false) as can_reference_auth_users,
    (to_regclass('public.mail_intake_user_counts') is null
      and to_regclass('public.mail_intake_global_counts') is null
      and to_regclass('public.mail_intake_claims') is null
      and to_regclass('public.screen_events_delivery_digest_idx') is null
      and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'screen_events' and column_name = 'delivery_digest')
      and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname = 'public' and p.proname in ('claim_mail_intake', 'log_screen_event'))) as nothing_yet
)
select
  case when owns_screen_events and can_lock_auth_user_rows and can_reference_auth_users and nothing_yet then 'OK' else 'FAILED' end as verdict,
  owns_screen_events, can_lock_auth_user_rows, can_reference_auth_users, nothing_yet,
  (select count(*) from public.screen_events) as screen_event_rows
from checks;
