-- Read only. Run against production BEFORE applying
-- supabase/pending/20261106130000_mail_sealed_after_processing.sql (moved to supabase/migrations/ when applied), with the sealing code
-- already deployed. Prints counts only, never a subject, an address or a body.
--
-- Replace DEPLOYED_AT below with the time the sealing code went live (from Vercel), e.g.
-- '2026-11-07 12:00:00+09'. Then send a test mail (or load the sample) once and run this.
--
-- Go only if:
--   - written_plain_after_deploy is 0 (the new code seals or drops every mail it reads), and
--   - sealed_after_deploy + dropped_after_deploy > 0 (the new code has really read a mail).
-- Rows from before the deploy may still be 'plain'; the trigger does not touch them.

with since as (select timestamptz 'DEPLOYED_AT' as t)
select
  count(*) filter (where e.processing_status = 'processed' and e.body_state = 'plain'
                     and coalesce(e.message_id, '') not like 'demo:%') as written_plain_after_deploy,
  count(*) filter (where e.processing_status = 'processed' and e.body_state = 'plain'
                     and coalesce(e.message_id, '') like 'demo:%'
                     and exists (select 1 from public.user_keys k where k.user_id = e.user_id and k.activated_at is not null and k.retired_at is null)) as sample_plain_with_key_after_deploy,
  count(*) filter (where e.body_state = 'sealed') as sealed_after_deploy,
  count(*) filter (where e.body_state = 'dropped') as dropped_after_deploy
from public.emails e, since
where e.created_at >= since.t;

-- After applying: the trigger is there and enabled ('O').
select tgname, tgenabled from pg_trigger
where tgrelid = 'public.emails'::regclass and tgname = 'emails_refuse_plaintext_after_reading';
