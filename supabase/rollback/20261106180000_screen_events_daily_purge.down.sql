-- Undo supabase/migrations/20261106180000_screen_events_daily_purge.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never picks it up. Run by hand only.
--
-- The job and the two functions go. The extension stays (Supabase may run other jobs with it).
-- The two one-off changes cannot be undone: the subjects of rescued mails were cleared, and the
-- marks on shared mail domains were removed. Afterwards old rows go only when their user gets
-- another screened mail (src/lib/pipeline.ts logScreenEvent), as before the migration.

select cron.unschedule('otodoke-purge-old-screen-events')
where exists (select 1 from cron.job where jobname = 'otodoke-purge-old-screen-events');
drop function if exists public.purge_old_screen_events();
drop function if exists public.is_shared_mail_domain(text);
