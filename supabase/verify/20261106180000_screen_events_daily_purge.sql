-- Run right after applying supabase/migrations/20261106180000_screen_events_daily_purge.sql.
-- Returns ONE row; go only if its verdict is 'OK'. No row (an error) counts as FAILED:
-- `supabase db query --linked -f` returns only the last result, and exits 0 even on an error.
-- Prints counts and settings only, never a subject or a domain.
--
-- Leaves nothing behind: the block writes three throwaway rows, runs the purge, and undoes all of
-- it (rows and purge) by raising the private code 'OTRBK'. Only its result survives, in a setting
-- of this session (otodoke.verify_purge) that the last statement reads.
--
--   job_scheduled           the job is there, daily at 18:30 GMT (03:30 JST), active, running the purge
--   callers_refused         anon and authenticated cannot call the purge
--   rescued_with_subject    must be 0 (the one-off change cleared them)
--   shared_marks            must be 0 (the one-off change cleared them)
--   behaviour               'OK': a 15-day-old unmarked row went, a 15-day-old marked row and a
--                           13-day-old unmarked row stayed ('skipped: ...' when there is no account)
--   job_username            the role the job runs as (for the record)

do $$
declare
  v_user uuid;
  v_old uuid := gen_random_uuid();
  v_marked uuid := gen_random_uuid();
  v_recent uuid := gen_random_uuid();
  v_removed integer;
  v_old_gone boolean;
  v_marked_kept boolean;
  v_recent_kept boolean;
begin
  select u.id into v_user from auth.users u limit 1;
  if v_user is null then
    perform set_config('otodoke.verify_purge', 'skipped: no account yet', false);
    return;
  end if;
  begin
    insert into public.screen_events (id, user_id, created_at, from_domain, subject, decision, reason, flagged_at) values
      (v_old, v_user, now() - interval '15 days', 'verify.invalid', null, 'dropped', 'verify', null),
      (v_marked, v_user, now() - interval '15 days', 'verify.invalid', null, 'dropped', 'verify', now()),
      (v_recent, v_user, now() - interval '13 days', 'verify.invalid', null, 'dropped', 'verify', null);
    v_removed := public.purge_old_screen_events();
    v_old_gone := not exists (select 1 from public.screen_events where id = v_old);
    v_marked_kept := exists (select 1 from public.screen_events where id = v_marked);
    v_recent_kept := exists (select 1 from public.screen_events where id = v_recent);
    raise exception using errcode = 'OTRBK', message = 'undo the verify writes';
  exception when sqlstate 'OTRBK' then
    null; -- rolled back: the throwaway rows, and what the purge removed, are back as they were
  end;
  perform set_config('otodoke.verify_purge',
    case when v_old_gone and v_marked_kept and v_recent_kept and v_removed >= 1 then 'OK'
         else format('FAILED: old_gone=%s marked_kept=%s recent_kept=%s removed=%s', v_old_gone, v_marked_kept, v_recent_kept, v_removed) end,
    false);
end $$;

with checks as (
  select
    (select count(*) from cron.job
      where jobname = 'otodoke-purge-old-screen-events' and schedule = '30 18 * * *'
        and command = 'select public.purge_old_screen_events()' and active) = 1 as job_scheduled,
    not has_function_privilege('anon', 'public.purge_old_screen_events()', 'execute')
      and not has_function_privilege('authenticated', 'public.purge_old_screen_events()', 'execute') as callers_refused,
    (select count(*) from public.screen_events where decision is distinct from 'dropped' and subject is not null) as rescued_with_subject,
    (select count(*) from public.screen_events where flagged_at is not null and lower(from_domain) in (
      -- shared-mail-domains:start
      'gmail.com', 'googlemail.com', 'yahoo.co.jp', 'ymail.ne.jp', 'yahoo.com', 'icloud.com',
      'me.com', 'mac.com', 'outlook.com', 'outlook.jp', 'hotmail.com', 'hotmail.co.jp', 'live.com',
      'live.jp', 'msn.com', 'aol.com', 'proton.me', 'protonmail.com', 'docomo.ne.jp', 'ezweb.ne.jp',
      'au.com', 'softbank.ne.jp', 'i.softbank.jp', 'yahoo.ne.jp', 'ymobile.ne.jp', 'uqmobile.jp',
      'rakumail.jp', 'nifty.com', 'biglobe.ne.jp', 'ocn.ne.jp', 'so-net.ne.jp', 'plala.or.jp'
      -- shared-mail-domains:end
    )) as shared_marks,
    coalesce(current_setting('otodoke.verify_purge', true), 'FAILED: the behaviour block did not run') as behaviour,
    (select string_agg(username, ',') from cron.job where jobname = 'otodoke-purge-old-screen-events') as job_username
)
select
  case when job_scheduled and callers_refused and rescued_with_subject = 0 and shared_marks = 0
            and (behaviour = 'OK' or behaviour like 'skipped:%') then 'OK' else 'FAILED' end as verdict,
  checks.*
from checks;
