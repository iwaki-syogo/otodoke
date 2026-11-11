-- Undo supabase/migrations/20261112020000_claude_call_release.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never picks it up. Run by hand only.
--
-- claim_claude_call is untouched by that file and stays. Code that has the new functions in mind
-- (src/lib/claude-usage.ts) finds claim_claude_call_v2 missing (PGRST202) and uses claim_claude_call
-- as before; a refused call then no longer gives its allowance back.
-- The calls >= 0 check goes too. Every step checks first: run twice, or on a database the file never
-- reached, it changes nothing the second time. Run the file in one go (psql -f, or supabase db query -f).
-- Locks: drop table takes an AccessExclusiveLock on auth.users (the table's reference to it goes),
-- so everything that touches auth.users (sign-in, getUser, sign-up) waits while this transaction
-- holds it. lock_timeout is 5 s: then this fails, changes nothing, and is run again later.

begin;
set local lock_timeout = '5s';

drop function if exists public.release_claude_call(bigint, uuid);
drop function if exists public.claim_claude_call_v2(uuid, integer, integer);
drop table if exists public.claude_call_claims;
alter table public.claude_usage_daily drop constraint if exists claude_usage_daily_calls_nonneg;

commit;
