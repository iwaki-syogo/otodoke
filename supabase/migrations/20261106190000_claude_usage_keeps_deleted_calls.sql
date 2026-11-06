-- Deleting an account keeps that day's count of Claude calls, with no user on it.
--
-- Why (review R3-1): the app-wide daily limit is the sum of the day's rows of claude_usage_daily
-- (claim_claude_call, 20261102110000). Those rows referenced auth.users with on delete cascade, so
-- deleting an account (設定「アカウントを削除」) took that account's calls out of the day's sum. An
-- account made, used up to its own limit and deleted, again and again, never brought the app to its
-- global limit.
--
-- How: user_id may be null, and the reference becomes on delete set null. A deleted account's rows
-- stay with no user id: their calls still count towards the day's sum, and nothing in them names
-- the account. The primary key (user_id, day) becomes a unique constraint on the same columns: a
-- primary key cannot hold a null, and nulls are distinct, so the rows of several accounts deleted
-- on one day do not collide.
--
-- claim_claude_call is not changed (still security definer, search_path '', execute for
-- service_role only): its insert always names a user, its `on conflict (user_id, day)` finds the
-- unique constraint as it found the key, the per-user limit reads that user's row as before, and
-- the global sum reads every row of the day, now including the ones with no user.
--
-- Nothing removes old days (as before). A row with no user holds a date and a count only.
-- Told in /privacy (src/app/privacy/page.tsx, 保存の期間と消し方). The referential action runs as
-- the table's owner, so Supabase Auth deleting a user needs no grant here (checked on Postgres 17
-- with a role that has none, on 2026-11-06).
--
-- Re-runnable: each step checks what is there. Independent of the code.
-- After applying: supabase/verify/20261106190000_claude_usage_keeps_deleted_calls.sql
-- Rollback:       supabase/rollback/20261106190000_claude_usage_keeps_deleted_calls.down.sql

do $$
declare
  r record;
begin
  -- The same uniqueness as the key, before the key goes.
  if not exists (select 1 from pg_constraint where conrelid = 'public.claude_usage_daily'::regclass and conname = 'claude_usage_daily_user_day_key') then
    alter table public.claude_usage_daily add constraint claude_usage_daily_user_day_key unique (user_id, day);
  end if;
  -- The primary key, whatever it is named.
  for r in select conname from pg_constraint where conrelid = 'public.claude_usage_daily'::regclass and contype = 'p' loop
    execute format('alter table public.claude_usage_daily drop constraint %I', r.conname);
  end loop;
  -- Every reference to auth.users, whatever it is named: replaced by the one below.
  for r in
    select conname from pg_constraint
    where conrelid = 'public.claude_usage_daily'::regclass and contype = 'f' and confrelid = 'auth.users'::regclass
  loop
    execute format('alter table public.claude_usage_daily drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.claude_usage_daily alter column user_id drop not null;

alter table public.claude_usage_daily
  add constraint claude_usage_daily_user_id_fkey foreign key (user_id) references auth.users(id) on delete set null;
