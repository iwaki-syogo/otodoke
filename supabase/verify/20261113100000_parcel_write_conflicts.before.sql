-- Read-only inventory before a combined C -> A -> B1 deployment is allowed.
-- This file does not require A's columns/functions: native rows are inspected as JSON.
-- Stop incoming/re-read/demo writers and drain their 300-second requests first.
with checks as (
  select (select count(*) from public.parcels) as parcel_rows,
    (select count(*) from public.parcel_items) as item_rows,
    (select count(*) from public.emails e where e.processing_status='pending' and
      (e.created_at>clock_timestamp()-interval '300 seconds' or
        (to_jsonb(e)->>'processing_lease_until')::timestamptz>clock_timestamp())) as possibly_active_rows,
    (select count(*) from public.parcels p where p.updated_at is null) as missing_versions,
    to_regprocedure('public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb)') is not null as dependency_a_already_present,
    coalesce(has_table_privilege(current_user,to_regclass('auth.users'),'TRIGGER'),false) as can_create_auth_delete_trigger,
    current_user=(select tableowner from pg_tables where schemaname='public' and tablename='emails') as migration_owner_matches_existing,
    to_regclass('public.sample_generations') is null as sample_generation_absent,
    not exists(select 1 from pg_trigger where tgrelid='auth.users'::regclass and tgname='parcel_candidate_owner_delete'
      and (tgfoid is distinct from to_regprocedure('public.lock_parcel_candidates()') or tgtype<>11 or tgenabled<>'O' or tgqual is not null or tgnargs<>0)) as auth_callback_ok
)
select case when possibly_active_rows=0 and missing_versions=0 and can_create_auth_delete_trigger
  and migration_owner_matches_existing and sample_generation_absent and auth_callback_ok then 'OK' else 'FAILED' end as verdict,checks.* from checks;
