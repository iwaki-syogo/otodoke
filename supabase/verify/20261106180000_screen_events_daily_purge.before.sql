-- Read only. Counts and a time, never a subject or a domain. Returns one row.
-- Run before applying supabase/migrations/20261106180000_screen_events_daily_purge.sql: what the
-- first daily run and the two one-off changes of that migration will touch.
--
--   first_run_removes      older than 14 days and not marked: the first daily run removes these
--   rescued_with_subject   a rescued mail's subject still here (rows from before 599c926): cleared
--                          when the migration is applied, whatever their age
--   shared_marks           marks on shared mail domains: cleared when applied; the rows then follow
--                          the 14-day rule (removed by the daily run once 14 days old)
--   marked_rows            every marked row, shared ones included (the daily run keeps the others)
--   oldest_unmarked        when the oldest unmarked row was written: the daily run removes nothing
--                          until that is 14 days ago
select
  count(*) filter (where created_at < now() - interval '14 days' and flagged_at is null) as first_run_removes,
  count(*) filter (where decision is distinct from 'dropped' and subject is not null) as rescued_with_subject,
  count(*) filter (where flagged_at is not null and lower(from_domain) in (
    -- shared-mail-domains:start
    'gmail.com', 'googlemail.com', 'yahoo.co.jp', 'ymail.ne.jp', 'yahoo.com', 'icloud.com',
    'me.com', 'mac.com', 'outlook.com', 'outlook.jp', 'hotmail.com', 'hotmail.co.jp', 'live.com',
    'live.jp', 'msn.com', 'aol.com', 'proton.me', 'protonmail.com', 'docomo.ne.jp', 'ezweb.ne.jp',
    'au.com', 'softbank.ne.jp', 'i.softbank.jp', 'yahoo.ne.jp', 'ymobile.ne.jp', 'uqmobile.jp',
    'rakumail.jp', 'nifty.com', 'biglobe.ne.jp', 'ocn.ne.jp', 'so-net.ne.jp', 'plala.or.jp'
    -- shared-mail-domains:end
  )) as shared_marks,
  count(*) filter (where flagged_at is not null) as marked_rows,
  min(created_at) filter (where flagged_at is null) as oldest_unmarked
from public.screen_events;
