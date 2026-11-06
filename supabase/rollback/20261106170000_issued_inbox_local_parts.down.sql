-- Undo supabase/migrations/20261106170000_issued_inbox_local_parts.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never picks it up. Run by hand only.
--
-- Afterwards the local part of a deleted account can be given out again (by chance, or claimed on
-- purpose by whoever knows it). The registry's rows are lost with the table; applying the
-- migration again registers only the addresses in use at that time.

drop trigger inbox_addresses_issue_local_part on public.inbox_addresses;
drop function public.inbox_addresses_issue_local_part();
drop table public.issued_inbox_local_parts;
