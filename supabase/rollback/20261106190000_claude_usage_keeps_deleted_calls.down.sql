-- Undo supabase/migrations/20261106190000_claude_usage_keeps_deleted_calls.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never picks it up. Run by hand only.
--
-- The rows of deleted accounts (no user id) cannot stand under a primary key: they are removed
-- first, so the day's sum loses their calls again, and deleting an account gives its calls back
-- to the global limit once more (review R3-1).
--
-- One transaction, and every step checks the state first (review R3-30): run twice, or one
-- statement at a time by hand, or on a database the migration never reached, it stops nowhere
-- halfway and a second run changes nothing. Before the migration and after this file the table
-- has the same three things: user_id not null, the primary key (user_id, day), and the reference
-- to auth.users that deletes the rows with the account.

begin;

delete from public.claude_usage_daily where user_id is null;

-- The reference that keeps the rows (on delete set null) goes. The cascading one it replaced had
-- the same name, so its action is checked too: on a second run the cascading one stays.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.claude_usage_daily'::regclass
      and conname = 'claude_usage_daily_user_id_fkey' and confdeltype <> 'c'
  ) then
    alter table public.claude_usage_daily drop constraint if exists claude_usage_daily_user_id_fkey;
  end if;
end $$;

-- Does nothing when the column is not null already.
alter table public.claude_usage_daily alter column user_id set not null;

-- The primary key comes back before the unique constraint that stood in for it goes.
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.claude_usage_daily'::regclass and contype = 'p') then
    alter table public.claude_usage_daily add constraint claude_usage_daily_pkey primary key (user_id, day);
  end if;
end $$;
alter table public.claude_usage_daily drop constraint if exists claude_usage_daily_user_day_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.claude_usage_daily'::regclass and contype = 'f' and confrelid = 'auth.users'::regclass
  ) then
    alter table public.claude_usage_daily
      add constraint claude_usage_daily_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
  end if;
end $$;

commit;
