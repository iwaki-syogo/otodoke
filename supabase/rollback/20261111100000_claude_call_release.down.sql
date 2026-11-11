-- Undo supabase/pending/20261111100000_claude_call_release.sql (or supabase/migrations/ once it has moved).
-- Kept outside supabase/migrations/ so `supabase db push` never picks it up. Run by hand only.
--
-- claim_claude_call is untouched by that file and stays. Code that has the new functions in mind
-- (src/lib/claude-usage.ts) finds claim_claude_call_v2 missing (PGRST202) and uses claim_claude_call
-- as before; a refused call then no longer gives its allowance back.
-- The calls >= 0 check goes too. Every step checks first: run twice, or on a database the file never
-- reached, it changes nothing the second time. Run the file in one go (psql -f, or supabase db query -f).

begin;
set local lock_timeout = '5s';

drop function if exists public.release_claude_call(bigint, uuid);
drop function if exists public.claim_claude_call_v2(uuid, integer, integer);
drop table if exists public.claude_call_claims;
alter table public.claude_usage_daily drop constraint if exists claude_usage_daily_calls_nonneg;

commit;
