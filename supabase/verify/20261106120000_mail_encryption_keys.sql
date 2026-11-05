-- Read only. Run against production right after applying
-- supabase/migrations/20261106120000_mail_encryption_keys.sql. Prints counts and settings, never
-- a subject, an address or a body.
--
-- Expected:
--   1. user_keys exists with RLS on, and exactly one policy ("own keys", select, authenticated)
--   2. anon: no privilege on user_keys; authenticated: select only; service_role: select/insert/update/delete
--   3. emails has the four new columns and the three checks
--   4. every existing email is 'plain' (nothing has been sealed by the old code)
--   5. activate_user_key: security definer, search_path='', execute for service_role only

-- 1
select c.relname, c.relrowsecurity as rls_on,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = 'user_keys') as policies,
       (select string_agg(p.policyname || ':' || p.cmd || ':' || array_to_string(p.roles, '/'), ', ') from pg_policies p where p.schemaname = 'public' and p.tablename = 'user_keys') as policy_list
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = 'user_keys';

-- 2
select r.role,
       has_table_privilege(r.role, 'public.user_keys', 'select') as can_select,
       has_table_privilege(r.role, 'public.user_keys', 'insert') as can_insert,
       has_table_privilege(r.role, 'public.user_keys', 'update') as can_update,
       has_table_privilege(r.role, 'public.user_keys', 'delete') as can_delete
from (values ('anon'), ('authenticated'), ('service_role')) as r(role);

-- 3
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'emails'
  and column_name in ('body_envelope', 'body_state', 'from_domain', 'forwarding_confirm_url')
order by column_name;

select conname from pg_constraint
where conrelid = 'public.emails'::regclass
  and conname in ('emails_body_state', 'emails_body_sealed_has_envelope', 'emails_body_closed_has_no_plaintext')
order by conname;

-- 4
select body_state, processing_status, count(*) from public.emails group by 1, 2 order by 1, 2;

-- 5
select p.proname, p.prosecdef as security_definer, p.proconfig as settings,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
       has_function_privilege('service_role', p.oid, 'execute') as service_role_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'activate_user_key';
