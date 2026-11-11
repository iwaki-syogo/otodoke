-- Run the file in one go only after stopping real-mail processing. This destroys recorded
-- choices; all accounts must decide again if the migration is reapplied. Keeping the new guard
-- deployed is safe: a missing table is unknown and cannot authorize a Claude call.
-- Never restore an old, unguarded server as a way of resuming real-mail processing.
-- Verify the absent state with supabase/verify/20261112180000_ai_reading_consent.before.sql.
begin;
set local lock_timeout = '5s';
drop function if exists public.set_ai_reading(text, text);
drop table if exists public.ai_reading_consents;
commit;
