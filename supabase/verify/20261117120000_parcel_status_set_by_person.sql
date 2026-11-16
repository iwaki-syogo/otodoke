-- Run right after applying 20261117120000_parcel_status_set_by_person.sql (before: ...before.sql).
-- Returns ONE row: verdict first ('OK' only when every check column is t), then the checks, then a count.
-- Rollback: supabase/rollback/20261117120000_parcel_status_set_by_person.down.sql. Reads only.
select
  case when c.col and c.trg and c.fn_ok and c.gateway then 'OK' else 'FAILED' end as verdict,
  c.col, c.trg, c.fn_ok, c.gateway,
  (select count(*) from public.parcels where status_set_by_person_at is not null) as stamped_rows
from (select
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'parcels'
          and column_name = 'status_set_by_person_at' and data_type = 'timestamp with time zone' and is_nullable = 'YES') as col,
  exists (select 1 from pg_trigger where tgrelid = 'public.parcels'::regclass and tgname = 'parcels_status_set_by_person' and tgenabled = 'O'
          and tgtype & 1 = 1 and tgtype & 2 = 2 and tgtype & 4 = 4 and tgtype & 16 = 16) as trg,   -- row, before, insert, update
  exists (select 1 from pg_proc where oid = to_regprocedure('public.parcels_status_set_by_person()') and proconfig is not distinct from array['search_path=""']
          and not prosecdef and position('return new' in prosrc) > 0 and position('return old' in prosrc) = 0) as fn_ok,
  exists (select 1 from pg_proc where oid = to_regprocedure('public.mail_run_write_without_sample_fence(uuid,uuid,text,text,jsonb,jsonb)')
          and prosecdef and proconfig is not distinct from array['search_path=""'] and position($q$'received_at','status_set_by_person_at']$q$ in prosrc) > 0) as gateway
) c;
