-- Read only. Run against production before applying
-- supabase/migrations/20261106110000_inbox_local_part_format.sql.
--
-- `violating` must be 0. Otherwise adding the constraint fails: look at those rows first (the
-- second query lists them without printing whole addresses) and decide what to do with them.

select
  count(*) as total,
  count(*) filter (where local_part !~ '^[abcdefghjkmnpqrstuvwxyz23456789]{10}$') as violating
from public.inbox_addresses;

select user_id, length(local_part) as length, left(local_part, 3) as starts_with, created_at
from public.inbox_addresses
where local_part !~ '^[abcdefghjkmnpqrstuvwxyz23456789]{10}$'
order by created_at;
