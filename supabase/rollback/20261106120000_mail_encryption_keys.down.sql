-- Undo supabase/migrations/20261106120000_mail_encryption_keys.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never picks it up. Run by hand only.
--
-- Undo 20261106130000_mail_sealed_after_processing.down.sql first if that one was applied.
--
-- Before running it with the new code in production, put the old code back first: the new code
-- reads and writes these columns and would fail every mail.
--
-- This throws away every sealed copy (body_envelope) and every user key. Mails already sealed
-- or dropped keep no subject, sender or body anywhere: their parcels stay, the original mail
-- does not come back. Count what would be lost first:
--
--   select body_state, count(*) from public.emails group by body_state;

drop index if exists public.emails_user_plain_idx;
alter table public.emails
  drop constraint emails_body_closed_has_no_plaintext,
  drop constraint emails_body_sealed_has_envelope,
  drop constraint emails_body_state;
alter table public.emails
  drop column forwarding_confirm_url,
  drop column from_domain,
  drop column body_state,
  drop column body_envelope;

drop table public.user_keys;
