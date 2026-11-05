-- Undo supabase/pending/20261106130000_mail_sealed_after_processing.sql (moved to supabase/migrations/ when applied).
-- Kept outside supabase/migrations/ so `supabase db push` never picks it up. Run by hand only.
-- Run this first if incoming mail starts failing with "a read mail must be sealed or dropped".
-- Nothing stored is changed.

drop trigger emails_refuse_plaintext_after_reading on public.emails;
drop function public.emails_refuse_plaintext_after_reading();
