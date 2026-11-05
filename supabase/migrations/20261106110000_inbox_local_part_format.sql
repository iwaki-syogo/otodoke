-- Only addresses the app itself would generate can be stored in inbox_addresses.local_part.
--
-- Why: a signed-in user may insert their own row (20261103140000_server_only_writes.sql), and
-- local_part had no format check, so a user could claim a name like "support" or "info" on the
-- receiving domain and get mail meant for someone else.
--
-- The pattern is exactly what src/lib/inbox.ts generates: 10 characters from its ALPHABET
-- (lowercase, without 0/o/1/l/i). src/lib/__tests__/inbox-local-part.test.ts keeps the two in step.
--
-- Before applying, run supabase/verify/20261106110000_inbox_local_part_format.sql against
-- production: adding the constraint fails (and changes nothing) if any existing row breaks it.
--
-- Rollback: supabase/rollback/20261106110000_inbox_local_part_format.down.sql

alter table public.inbox_addresses
  add constraint inbox_addresses_local_part_format
  check (local_part ~ '^[abcdefghjkmnpqrstuvwxyz23456789]{10}$');
