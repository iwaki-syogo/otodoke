-- Read only. Run the day after applying supabase/migrations/20261106180000_screen_events_daily_purge.sql
-- (the job runs every day at 18:30 GMT = 03:30 JST). Returns ONE row; go on only if its verdict is
-- 'OK'. No row (an error) counts as FAILED: `supabase db query --linked -f` returns only the last
-- result and exits 0 even on an error.
--
--   last_status         the last run of the job: must be 'succeeded'
--   last_message        what it returned (pg_cron's own words, e.g. "1 row")
--   last_start          when it ran (UTC): must be within the last day
--   old_unmarked_left   unmarked rows older than 15 days: must be 0 (the daily run removes them once
--                       14 days old; the extra day covers the time since the last run)
with last_run as (
  select d.status, d.return_message, d.start_time
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
  where j.jobname = 'otodoke-purge-old-screen-events'
  order by d.start_time desc
  limit 1
),
left_over as (
  select count(*) as old_unmarked_left
  from public.screen_events
  where created_at < now() - interval '15 days' and flagged_at is null
)
select
  case when r.status = 'succeeded' and r.start_time > now() - interval '1 day' and l.old_unmarked_left = 0 then 'OK' else 'FAILED' end as verdict,
  r.status as last_status,
  r.return_message as last_message,
  r.start_time as last_start,
  l.old_unmarked_left
from left_over l
left join last_run r on true;
