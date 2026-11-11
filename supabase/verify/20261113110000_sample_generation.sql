-- Read-only post-application checks; every verdict must be true.
select 'four write fences', count(*) = 4 from pg_trigger
where tgname = 'sample_generation_fence' and not tgisinternal and tgenabled = 'O';
select 'sample metadata backfilled', not exists (
  select 1 from public.emails where provider_email_id like 'demo:%' and sample_generation is null
);
select 'private generation state', not has_table_privilege('anon', 'public.sample_generations', 'SELECT')
  and not has_table_privilege('authenticated', 'public.sample_generations', 'SELECT')
  and not has_table_privilege('service_role', 'public.sample_generations', 'UPDATE');
select 'only service role can begin and clear', bool_and(
  has_function_privilege('service_role', p.oid, 'EXECUTE')
  and not has_function_privilege('anon', p.oid, 'EXECUTE')
  and not has_function_privilege('authenticated', p.oid, 'EXECUTE')
) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('begin_sample_load', 'clear_all_parcels', 'receive_sample_parcels');
select 'core gateways and helpers private', bool_and(not has_function_privilege('service_role', p.oid, 'EXECUTE')
  and not has_function_privilege('anon', p.oid, 'EXECUTE')
  and not has_function_privilege('authenticated', p.oid, 'EXECUTE'))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('store_mail_run_without_sample_fence', 'mail_run_write_without_sample_fence', 'lock_sample_owner', 'assert_sample_generation', 'fence_sample_write');
select 'service gateways secure', bool_and(p.prosecdef and 'search_path=""' = any(p.proconfig)
  and pg_get_userbyid(p.proowner) = (select tableowner from pg_tables where schemaname = 'public' and tablename = 'sample_generations'))
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname in ('begin_sample_load', 'clear_all_parcels', 'receive_sample_parcels', 'store_mail_run', 'mail_run_write');
