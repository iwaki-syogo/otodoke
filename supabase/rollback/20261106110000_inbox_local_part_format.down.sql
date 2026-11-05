-- Undo supabase/migrations/20261106110000_inbox_local_part_format.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never picks it up. Run by hand only.

alter table public.inbox_addresses drop constraint inbox_addresses_local_part_format;
