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

--   6. the policy's own expression is (user_id = auth.uid()) for select, and it really holds: as
--      'authenticated' with a made-up user id, no key row is visible and an insert is refused
--      (a NOTICE "user_keys RLS: OK (...)", or an exception "... FAILED: ...").
-- Step 6 writes nothing: its block is undone by raising the private code 'OTRBK'.

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

-- 6. The expression, not just the name: "using (true)" would print the same name and roles above.
select policyname, cmd, roles, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'user_keys';

-- 6. Behaviour (negative controls): as the API role of a signed-in user who owns nothing.
do $$
declare
  v_total bigint;
  v_seen bigint := -1;
  v_insert_refused boolean := false;
begin
  select count(*) into v_total from public.user_keys;
  begin
    perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000ff', true);
    perform set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-0000000000ff","role":"authenticated"}', true);
    perform set_config('role', 'authenticated', true);
    select count(*) into v_seen from public.user_keys;
    begin
      insert into public.user_keys (user_id, key_id, public_key, wrapped_private_key, wrap_iv, kdf_salt, kdf_iterations, challenge_hash)
      values ('00000000-0000-4000-8000-0000000000ff', repeat('e', 32), repeat('A', 86) || '==', repeat('A', 120), repeat('A', 16), repeat('A', 22) || '==', 600000, repeat('0', 64));
    exception when insufficient_privilege then
      v_insert_refused := true;
    end;
    raise exception using errcode = 'OTRBK', message = 'undo the role and settings';
  exception when sqlstate 'OTRBK' then
    null; -- rolled back: the role and the claims are as before
  end;
  if current_user = 'authenticated' then
    raise exception 'user_keys RLS FAILED: the role was not put back';
  end if;
  if v_seen <> 0 or not v_insert_refused then
    raise exception 'user_keys RLS FAILED: rows seen by a stranger=% (of %), insert refused=%', v_seen, v_total, v_insert_refused;
  end if;
  raise notice 'user_keys RLS: OK (a stranger sees 0 of % rows and cannot insert; all undone)', v_total;
end $$;
