-- Run against production right after applying
-- supabase/migrations/20261106150000_activate_user_key_checked.sql. Leaves nothing behind: the
-- one block that writes (step 2) undoes all of it before it ends. Prints settings and OK/FAILED
-- lines only, never a key or a mail.
--
-- Expected:
--   1. activate_user_key_checked: security definer, search_path='', execute for service_role only
--   2. a NOTICE "activate_user_key_checked: OK (...)". It raises "... FAILED: ..." instead when
--      the function lets a stale screen through, refuses the right expectation, or skips the hash.

-- 1
select p.proname, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef as security_definer, p.proconfig as settings,
       has_function_privilege('anon', p.oid, 'execute') as anon_exec,
       has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
       has_function_privilege('service_role', p.oid, 'execute') as service_role_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'activate_user_key_checked';

-- 2. Behaviour, with negative controls. On one account that has no key yet (or any account), a
-- throwaway pending key is added and the function is called four ways; then everything is undone
-- by raising the private code 'OTRBK' inside the block, which rolls the block back.
do $$
declare
  v_user uuid;
  v_current text;
  v_wrong text;
  v_stale_refused boolean := false;
  v_bad_hash_refused boolean := false;
  v_right_accepted boolean := false;
  v_retired_ok boolean := false;
begin
  select u.id into v_user from auth.users u
  where not exists (select 1 from public.user_keys k where k.user_id = u.id) limit 1;
  if v_user is null then
    select u.id into v_user from auth.users u limit 1;
  end if;
  if v_user is null then
    raise notice 'activate_user_key_checked: skipped (no account yet)';
    return;
  end if;
  select key_id into v_current from public.user_keys where user_id = v_user and activated_at is not null and retired_at is null;
  -- A stale screen: it expects the opposite of what is true (a key when there is none, or none).
  v_wrong := case when v_current is null then repeat('f', 32) else null end;

  begin
    insert into public.user_keys (user_id, key_id, public_key, wrapped_private_key, wrap_iv, kdf_salt, kdf_iterations, challenge_hash)
    values (v_user, repeat('e', 32), repeat('A', 86) || '==', repeat('A', 120), repeat('A', 16), repeat('A', 22) || '==', 600000, repeat('0', 64));

    -- Negative control 1: the stale expectation is refused, and nothing changes.
    begin
      perform public.activate_user_key_checked(v_user, repeat('e', 32), repeat('0', 64), v_wrong);
    exception when others then
      v_stale_refused := sqlerrm like '%the key in use changed%';
    end;

    -- Negative control 2: the right expectation with a wrong hash is refused (P0002).
    begin
      perform public.activate_user_key_checked(v_user, repeat('e', 32), repeat('1', 64), v_current);
    exception when sqlstate 'P0002' then
      v_bad_hash_refused := true;
    end;

    -- Positive control: the right expectation and hash put it in use, the old one (if any) retired.
    begin
      v_right_accepted := public.activate_user_key_checked(v_user, repeat('e', 32), repeat('0', 64), v_current) = repeat('e', 32);
      v_retired_ok := (select count(*) from public.user_keys where user_id = v_user and activated_at is not null and retired_at is null) = 1
                  and (v_current is null or exists (select 1 from public.user_keys where user_id = v_user and key_id = v_current and retired_at is not null));
    exception when others then
      v_right_accepted := false;
    end;

    raise exception using errcode = 'OTRBK', message = 'undo the verify writes';
  exception when sqlstate 'OTRBK' then
    null; -- rolled back: the throwaway key and the activation are gone
  end;

  if exists (select 1 from public.user_keys where user_id = v_user and key_id = repeat('e', 32)) then
    raise exception 'activate_user_key_checked FAILED: the throwaway key was not undone';
  end if;
  if not (v_stale_refused and v_bad_hash_refused and v_right_accepted and v_retired_ok) then
    raise exception 'activate_user_key_checked FAILED: stale_refused=% bad_hash_refused=% right_accepted=% retired_ok=%',
      v_stale_refused, v_bad_hash_refused, v_right_accepted, v_retired_ok;
  end if;
  raise notice 'activate_user_key_checked: OK (stale screen refused, wrong hash refused, right one accepted; all undone)';
end $$;
