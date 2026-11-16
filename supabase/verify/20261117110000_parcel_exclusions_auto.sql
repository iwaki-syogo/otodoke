-- Read-only check, run as the migration owner right after 20261117110000. No row contents are read.
-- One result row: verdict (OK or FAILED), then each check (t/f), then the number of seen-time rows.
with checks as (
  select
    to_regclass('public.excluded_seen') is not null as table_exists,
    coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.excluded_seen')),false) as rls_on,
    -- the person can read the table and never write it; the server can write
    not has_table_privilege('anon','public.excluded_seen','SELECT')
      and has_table_privilege('authenticated','public.excluded_seen','SELECT')
      and not has_table_privilege('authenticated','public.excluded_seen','INSERT')
      and not has_table_privilege('authenticated','public.excluded_seen','UPDATE')
      and not has_table_privilege('authenticated','public.excluded_seen','DELETE')
      and not has_table_privilege('authenticated','public.excluded_seen','TRUNCATE')
      and has_table_privilege('service_role','public.excluded_seen','INSERT') as table_privileges,
    -- the five user functions and restore_parcel: security definer, pinned search_path, authenticated only
    (select count(*)=6 and bool_and(p.prosecdef and p.proconfig=array['search_path=""']
        and has_function_privilege('authenticated',p.oid,'EXECUTE')
        and not has_function_privilege('anon',p.oid,'EXECUTE')
        and not has_function_privilege('service_role',p.oid,'EXECUTE'))
      from pg_proc p where p.oid in (to_regprocedure('public.has_open_auto_exclusion()'),to_regprocedure('public.mark_auto_excluded_seen(timestamptz)'),
        to_regprocedure('public.excluded_parcels_unseen()'),to_regprocedure('public.auto_exclusion_would_start(uuid)'),
        to_regprocedure('public.restore_parcel(uuid)'),to_regprocedure('public.exclude_parcel(uuid)'))) as user_functions_ok,
    -- the ingestion function: service role only, takes the owner locks in order
    (select p.prosecdef and p.proconfig=array['search_path=""'] and has_function_privilege('service_role',p.oid,'EXECUTE')
        and not has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('anon',p.oid,'EXECUTE')
        and strpos(p.prosrc,'lock_sample_owner')>0 and strpos(p.prosrc,'lock_sample_owner')<strpos(p.prosrc,'lock_parcel_owner')
        and strpos(p.prosrc,'lock_parcel_owner')<strpos(p.prosrc,'insert into')
      from pg_proc p where p.oid=to_regprocedure('public.mark_rule_exclusion(uuid,uuid,text,text)')) as rule_writer_ok,
    -- stage-1 shapes did not move
    pg_get_function_result(to_regprocedure('public.exclude_parcel(uuid)'))='text' as exclude_returns_text,
    (select cardinality(proargnames)=11 from pg_proc where oid=to_regprocedure('public.excluded_parcels()')) as excluded_parcels_11_columns,
    -- the read-only functions are not volatile writers
    (select bool_and(p.provolatile='s') from pg_proc p where p.oid in (to_regprocedure('public.has_open_auto_exclusion()'),
      to_regprocedure('public.excluded_parcels_unseen()'),to_regprocedure('public.auto_exclusion_would_start(uuid)'))) as readers_stable
), counts as (
  select coalesce((select count(*) from public.excluded_seen),0) as seen_rows
)
select case when coalesce(table_exists and rls_on and table_privileges and user_functions_ok and rule_writer_ok
    and exclude_returns_text and excluded_parcels_11_columns and readers_stable,false) then 'OK' else 'FAILED' end as verdict,
  checks.*, counts.seen_rows from checks cross join counts;
