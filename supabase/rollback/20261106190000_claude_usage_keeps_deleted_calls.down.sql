-- Undo supabase/migrations/20261106190000_claude_usage_keeps_deleted_calls.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never picks it up. Run by hand only.
--
-- The rows of deleted accounts (no user id) cannot stand under a primary key: they are removed
-- first, so the day's sum loses their calls again, and deleting an account gives its calls back
-- to the global limit once more (review R3-1).

delete from public.claude_usage_daily where user_id is null;
alter table public.claude_usage_daily drop constraint claude_usage_daily_user_id_fkey;
alter table public.claude_usage_daily alter column user_id set not null;
alter table public.claude_usage_daily drop constraint claude_usage_daily_user_day_key;
alter table public.claude_usage_daily add constraint claude_usage_daily_pkey primary key (user_id, day);
alter table public.claude_usage_daily
  add constraint claude_usage_daily_user_id_fkey foreign key (user_id) references auth.users(id) on delete cascade;
