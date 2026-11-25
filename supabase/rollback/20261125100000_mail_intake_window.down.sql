-- Undo supabase/migrations/20261125100000_mail_intake_window.sql. Safe to run twice.
-- Removes the two functions, the two count tables, and screen_events.delivery_digest with its index.
-- The Web that calls these functions keeps working after this: it falls back to the earlier behaviour while they are
-- missing. Existing screen_events rows stay (only their digest goes).
-- Check afterwards: supabase/verify/20261125100000_mail_intake_window.rolled-back.sql.
begin;
set local lock_timeout = '5s';
drop function if exists public.log_screen_event(uuid, jsonb, jsonb);
drop function if exists public.claim_mail_intake(uuid, text, bigint, jsonb);
drop table if exists public.mail_intake_user_counts;
drop table if exists public.mail_intake_global_counts;
drop index if exists public.screen_events_delivery_digest_idx;
alter table public.screen_events drop column if exists delivery_digest;
commit;
