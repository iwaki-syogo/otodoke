-- Read-only check, run as the migration owner right after 20261117100000. No row contents are read.
-- One result row: verdict (OK or FAILED), then each check (t/f).
with checks as (
  select
    to_regclass('public.parcel_exclusions') is not null as table_exists,
    coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.parcel_exclusions')),false) as rls_on,
    -- the hiding policy is RESTRICTIVE, select-only, for authenticated
    exists(select 1 from pg_policies where schemaname='public' and tablename='parcels' and policyname='hide excluded parcels'
      and permissive='RESTRICTIVE' and cmd='SELECT' and roles=array['authenticated']::name[]) as hide_is_restrictive,
    -- the table's own policy never reads parcels (the two would read each other)
    exists(select 1 from pg_policies where schemaname='public' and tablename='parcel_exclusions' and policyname='own parcel exclusions'
      and permissive='PERMISSIVE' and cmd='SELECT' and qual not like '%parcels%') as own_policy_plain,
    -- the user session can only read the table
    not has_table_privilege('anon','public.parcel_exclusions','SELECT')
      and has_table_privilege('authenticated','public.parcel_exclusions','SELECT')
      and not has_table_privilege('authenticated','public.parcel_exclusions','INSERT')
      and not has_table_privilege('authenticated','public.parcel_exclusions','UPDATE')
      and not has_table_privilege('authenticated','public.parcel_exclusions','DELETE')
      and not has_table_privilege('authenticated','public.parcel_exclusions','TRUNCATE')
      and has_table_privilege('service_role','public.parcel_exclusions','INSERT') as table_privileges,
    -- the three functions: security definer, owner-pinned search_path, executable by authenticated only
    (select count(*)=3 and bool_and(p.prosecdef and p.proconfig=array['search_path=""']
        and has_function_privilege('authenticated',p.oid,'EXECUTE')
        and not has_function_privilege('anon',p.oid,'EXECUTE')
        and not has_function_privilege('service_role',p.oid,'EXECUTE'))
      from pg_proc p where p.oid in (to_regprocedure('public.exclude_parcel(uuid)'),to_regprocedure('public.restore_parcel(uuid)'),to_regprocedure('public.excluded_parcels()'))) as functions_ok,
    exists(select 1 from pg_trigger t where t.tgrelid=to_regclass('public.parcel_exclusions') and t.tgname='parcel_exclusion_owner_check' and not t.tgisinternal) as owner_check_trigger,
    -- the two writers take the sample-owner lock before the parcel-owner lock
    (select strpos(p.prosrc,'lock_sample_owner')>0 and strpos(p.prosrc,'lock_sample_owner')<strpos(p.prosrc,'lock_parcel_owner')
      from pg_proc p where p.oid=to_regprocedure('public.exclude_parcel(uuid)')) as exclude_lock_order,
    (select strpos(p.prosrc,'lock_sample_owner')>0 and strpos(p.prosrc,'lock_sample_owner')<strpos(p.prosrc,'lock_parcel_owner')
      from pg_proc p where p.oid=to_regprocedure('public.restore_parcel(uuid)')) as restore_lock_order,
    -- the two receipt functions skip marked rows (four conditions in total)
    (select (length(a.prosrc)-length(replace(a.prosrc,'public.parcel_exclusions e where e.parcel_id=p.id','')))/length('public.parcel_exclusions e where e.parcel_id=p.id')=2
      and (length(b.prosrc)-length(replace(b.prosrc,'public.parcel_exclusions e where e.parcel_id=p.id','')))/length('public.parcel_exclusions e where e.parcel_id=p.id')=2
      and not has_function_privilege('anon',a.oid,'EXECUTE') and has_function_privilege('authenticated',a.oid,'EXECUTE')
      and not has_function_privilege('anon',b.oid,'EXECUTE') and has_function_privilege('authenticated',b.oid,'EXECUTE')
      from pg_proc a, pg_proc b where a.oid=to_regprocedure('public.mark_parcels_received(uuid[])') and b.oid=to_regprocedure('public.restore_parcel_receipts(jsonb)')) as receipt_functions_skip_marked
), counts as (
  select coalesce((select count(*) from public.parcel_exclusions),0) as marks
)
select case when coalesce(table_exists and rls_on and hide_is_restrictive and own_policy_plain and table_privileges and functions_ok
    and owner_check_trigger and exclude_lock_order and restore_lock_order and receipt_functions_skip_marked,false) then 'OK' else 'FAILED' end as verdict,
  checks.*, counts.marks from checks cross join counts;
