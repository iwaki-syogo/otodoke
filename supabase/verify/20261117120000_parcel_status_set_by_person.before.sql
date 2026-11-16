-- Run BEFORE applying 20261117120000_parcel_status_set_by_person.sql. Returns ONE row; go only if verdict is 'OK'.
-- OK = parcels exists without status_set_by_person_at and without its trigger, and the mail gateway body is still
-- the 20261113100000 one (allowlist ends in received_at). Reads only; prints counts only.
select
  case
    when to_regclass('public.parcels') is not null
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'parcels' and column_name = 'status_set_by_person_at')
     and not exists (select 1 from pg_trigger where tgrelid = 'public.parcels'::regclass and tgname = 'parcels_status_set_by_person')
     and exists (select 1 from pg_proc where oid = to_regprocedure('public.mail_run_write_without_sample_fence(uuid,uuid,text,text,jsonb,jsonb)')
                 and prosecdef and proconfig is not distinct from array['search_path=""'] and position($q$'check_dismissed_at','received_at']$q$ in prosrc) > 0)
    then 'OK' else 'FAILED'
  end as verdict,
  (select count(*) from public.parcels) as total_rows;
