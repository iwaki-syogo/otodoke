-- Every day, remove what the free screen kept about the mail it threw away, once it is 14 days old.
--
-- Why (review E-5): the subject of a dropped mail is kept 14 days (disclosed in 設定 and README),
-- but the pipeline removes a user's old rows only when that user gets another screened mail
-- (src/lib/pipeline.ts logScreenEvent). A user whose mail stopped coming kept them for good. This
-- removes everyone's old rows once a day. The pipeline's own removal stays as it is.
--
-- Kept: rows the user marked 「これは荷物」 (flagged_at): the pipeline reads them to know the
-- sender. 「外す」 in 設定 unmarks them, and they then go like the others. A mark on a shared mail
-- domain (gmail.com, xxx.plala.or.jp, ...) counts as no mark (review R3-4): the code never makes
-- or honours one (src/lib/screen-senders.ts), so the person cannot see or remove it in 設定.
--
-- 🚨 Apply after the G2 code (src/lib/screen-senders.ts and its callers) is in production. The code
-- before it marks shared domains and honours those marks: applied first, the one-off clearing below
-- would be undone by the next press, and those marks would act until they are 14 days old.
--
-- Also, once, when applied:
--   1. The subject of a mail the second look kept (decision 'rescued') is cleared. Such a mail is
--      read and sealed, so its subject must not stay here in plaintext; the code stopped writing it
--      (599c926), the rows written before that still have it.
--   2. Marks on shared mail domains are cleared: unmarked, their rows follow the 14-day rule.
--
-- public.is_shared_mail_domain() holds the lists of src/lib/screen-senders.ts (SHARED_MAIL_DOMAINS
-- exactly, SHARED_MAIL_DOMAIN_SUFFIXES with every subdomain), checked against them by
-- src/lib/__tests__/screen-senders-migration.test.ts.
--
-- Supabase Cron (pg_cron), as installed by https://supabase.com/docs/guides/cron/install . A job
-- runs as the role that scheduled it (the migration's role, which owns public.screen_events).
-- Schedules are in GMT (pg_cron's default): '30 18 * * *' is every day at 03:30 JST.
-- cron.schedule with the name of an existing job replaces that job, so applying this again is safe.
--
-- Before applying (read only): supabase/verify/20261106180000_screen_events_daily_purge.before.sql
-- After applying:              supabase/verify/20261106180000_screen_events_daily_purge.sql
-- The day after:               supabase/verify/20261106180000_screen_events_daily_purge.after-first-run.sql
-- Rollback: supabase/rollback/20261106180000_screen_events_daily_purge.down.sql (the two one-off
-- changes cannot be undone; nothing else depends on them).

create extension if not exists pg_cron with schema pg_catalog;

grant usage on schema cron to postgres;
grant all privileges on all tables in schema cron to postgres;

-- A domain many people have their own address on: listed exactly, or under a listed provider.
-- The same rule as isSharedMailDomain in src/lib/screen-senders.ts.
create or replace function public.is_shared_mail_domain(p_domain text) returns boolean
language sql
immutable
set search_path = ''
as $$
  select d in (
    -- shared-mail-domains:start
    'gmail.com', 'googlemail.com', 'yahoo.co.jp', 'ymail.ne.jp', 'yahoo.com', 'icloud.com',
    'me.com', 'mac.com', 'outlook.com', 'outlook.jp', 'hotmail.com', 'hotmail.co.jp', 'live.com',
    'live.jp', 'msn.com', 'aol.com', 'proton.me', 'protonmail.com', 'docomo.ne.jp', 'ezweb.ne.jp',
    'au.com', 'softbank.ne.jp', 'i.softbank.jp', 'yahoo.ne.jp', 'ymobile.ne.jp', 'uqmobile.jp',
    'rakumail.jp', 'nifty.com', 'ybb.ne.jp', 'excite.co.jp', 'auone.jp', 'mineo.jp', 'disney.ne.jp',
    'pdx.ne.jp', 'duck.com'
    -- shared-mail-domains:end
  )
  or exists (
    select 1
    from unnest(array[
    -- shared-mail-domain-suffixes:start
    'plala.or.jp', 'ocn.ne.jp', 'so-net.ne.jp', 'biglobe.ne.jp', 'auone-net.jp', 'dion.ne.jp',
    'odn.ne.jp', 'eonet.ne.jp', 'hi-ho.ne.jp', 'asahi-net.or.jp', 'zaq.ne.jp', 'home.ne.jp'
    -- shared-mail-domain-suffixes:end
    ]) as s
    where d = s or right(d, length(s) + 1) = '.' || s
  )
  from (select lower(rtrim(trim(coalesce(p_domain, '')), '.')) as d) as x;
$$;

revoke all on function public.is_shared_mail_domain(text) from public, anon, authenticated;

-- Removes rows older than 14 days that are not marked (a mark on a shared domain is no mark).
-- Returns how many it removed.
create or replace function public.purge_old_screen_events() returns integer
language sql
set search_path = ''
as $$
  with removed as (
    delete from public.screen_events
    where created_at < now() - interval '14 days'
      and (flagged_at is null or public.is_shared_mail_domain(from_domain))
    returning 1
  )
  select count(*)::integer from removed;
$$;

-- Only the schedule (and the owner) runs it.
revoke all on function public.purge_old_screen_events() from public, anon, authenticated;

-- Once: a rescued mail keeps no subject here.
update public.screen_events
set subject = null
where decision is distinct from 'dropped'
  and subject is not null;

-- Once: no mark on a shared mail domain.
update public.screen_events
set flagged_at = null
where flagged_at is not null
  and public.is_shared_mail_domain(from_domain);

select cron.schedule('otodoke-purge-old-screen-events', '30 18 * * *', 'select public.purge_old_screen_events()');
