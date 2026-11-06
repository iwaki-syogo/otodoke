-- Run against production right after applying
-- supabase/migrations/20261106170000_issued_inbox_local_parts.sql. Leaves nothing behind: the one
-- block that writes undoes all of it before it ends (it raises the private code 'OTRBK', which
-- rolls the block back). While it runs, one existing address row is changed and put back inside
-- that block; nobody else sees the change. It prints counts and settings only, never an address.
--
-- `supabase db query --linked -f` shows only the last statement's result and exits 0 even when a
-- statement fails, so everything ends in one row whose `verdict` is OK or FAILED: <what>.
--
-- Expected (one row):
--   unregistered   0        every address in use is in the registry
--   trigger_ok     true     inbox_addresses_issue_local_part: enabled (O), before insert or
--                           update of local_part, for each row
--   function_ok    true     security definer, search_path="", no execute for anon/authenticated
--   registry_ok    true     RLS on; nothing for anon/authenticated; service_role may read only
--   behaviour      ok       on one existing address row:
--                             1. a change to a value never given out goes through and registers it
--                             2. negative control: changing it back to the value it had is refused
--                                (23505, by the registry's primary key)
--                             3. as after an account deletion: the row goes, and a new row with
--                                the value from 1 is refused (23505, by the registry)
--                             4. a new row with another fresh value goes through and registers it
--                             5. a second row for that user is refused by the table's own index,
--                                and its value is not left in the registry
--                           then everything is undone, and checked to be.
--   verdict        OK       (OK, behaviour not tried: when there is no address yet)

do $$
declare
  v_alphabet constant text := 'abcdefghjkmnpqrstuvwxyz23456789';
  v_fresh text[] := array[]::text[];
  v_value text;
  v_row record;
  v_constraint text;
  v_result text := 'FAILED: the behaviour block did not finish';
begin
  if to_regclass('public.issued_inbox_local_parts') is null then
    perform set_config('otodoke.verify_issued_unregistered', 'no registry table', false);
    perform set_config('otodoke.verify_issued_behaviour', 'FAILED: no registry table', false);
    return;
  end if;
  perform set_config('otodoke.verify_issued_unregistered',
    (select count(*) from public.inbox_addresses a
     where not exists (select 1 from public.issued_inbox_local_parts r where r.local_part = a.local_part))::text, false);

  -- Three made-up values of the right shape, never given out and not in use.
  while coalesce(array_length(v_fresh, 1), 0) < 3 loop
    select string_agg(substr(v_alphabet, 1 + floor(random() * 31)::int, 1), '') into v_value from generate_series(1, 10);
    if not exists (select 1 from public.issued_inbox_local_parts where local_part = v_value)
       and not exists (select 1 from public.inbox_addresses where local_part = v_value)
       and not v_value = any (v_fresh) then
      v_fresh := v_fresh || v_value;
    end if;
  end loop;

  select id, user_id, local_part into v_row from public.inbox_addresses order by created_at limit 1;
  if v_row.id is null then
    perform set_config('otodoke.verify_issued_behaviour', 'not tried (no address yet)', false);
    return;
  end if;

  begin
    -- 1
    update public.inbox_addresses set local_part = v_fresh[1] where id = v_row.id;
    if not exists (select 1 from public.issued_inbox_local_parts where local_part = v_fresh[1]) then
      v_result := 'FAILED: a changed address was not registered';
      raise exception using errcode = 'OTRBK';
    end if;
    -- 2
    begin
      update public.inbox_addresses set local_part = v_row.local_part where id = v_row.id;
      v_result := 'FAILED: an address given out before was taken again by a change';
      raise exception using errcode = 'OTRBK';
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from 'issued_inbox_local_parts_pkey' then
        v_result := 'FAILED: the change back was refused by ' || coalesce(v_constraint, 'no constraint') || ', not the registry';
        raise exception using errcode = 'OTRBK';
      end if;
    end;
    -- 3
    delete from public.inbox_addresses where id = v_row.id;
    begin
      insert into public.inbox_addresses (user_id, local_part) values (v_row.user_id, v_fresh[1]);
      v_result := 'FAILED: a deleted address was given out again';
      raise exception using errcode = 'OTRBK';
    exception when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint is distinct from 'issued_inbox_local_parts_pkey' then
        v_result := 'FAILED: the deleted address was refused by ' || coalesce(v_constraint, 'no constraint') || ', not the registry';
        raise exception using errcode = 'OTRBK';
      end if;
    end;
    -- 4
    insert into public.inbox_addresses (user_id, local_part) values (v_row.user_id, v_fresh[2]);
    if not exists (select 1 from public.issued_inbox_local_parts where local_part = v_fresh[2]) then
      v_result := 'FAILED: a new address was not registered';
      raise exception using errcode = 'OTRBK';
    end if;
    -- 5
    begin
      insert into public.inbox_addresses (user_id, local_part) values (v_row.user_id, v_fresh[3]);
      v_result := 'FAILED: a second address for one user was accepted';
      raise exception using errcode = 'OTRBK';
    exception when unique_violation then
      null;
    end;
    if exists (select 1 from public.issued_inbox_local_parts where local_part = v_fresh[3]) then
      v_result := 'FAILED: a refused insert left its value in the registry';
      raise exception using errcode = 'OTRBK';
    end if;
    v_result := 'ok';
    raise exception using errcode = 'OTRBK';
  exception when sqlstate 'OTRBK' then
    null; -- rolled back
  end;

  if v_result = 'ok' and (
       not exists (select 1 from public.inbox_addresses where id = v_row.id and local_part = v_row.local_part)
       or exists (select 1 from public.issued_inbox_local_parts where local_part = any (v_fresh))) then
    v_result := 'FAILED: the verify writes were not undone';
  end if;
  perform set_config('otodoke.verify_issued_behaviour', v_result, false);
end $$;

with
  trig as (
    select t.tgenabled = 'O'
       and pg_get_triggerdef(t.oid) like 'CREATE TRIGGER inbox_addresses_issue_local_part BEFORE INSERT OR UPDATE OF local_part ON public.inbox_addresses FOR EACH ROW EXECUTE FUNCTION %inbox_addresses_issue_local_part()' as ok
    from pg_trigger t
    where t.tgrelid = 'public.inbox_addresses'::regclass and t.tgname = 'inbox_addresses_issue_local_part' and not t.tgisinternal
  ),
  fn as (
    select p.prosecdef
       and p.proconfig = array['search_path=""']
       and not has_function_privilege('anon', p.oid, 'execute')
       and not has_function_privilege('authenticated', p.oid, 'execute') as ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'inbox_addresses_issue_local_part'
  ),
  reg as (
    select c.relrowsecurity
       and not has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate, references, trigger')
       and not has_table_privilege('authenticated', c.oid, 'select, insert, update, delete, truncate, references, trigger')
       and has_table_privilege('service_role', c.oid, 'select')
       and not has_table_privilege('service_role', c.oid, 'insert, update, delete, truncate') as ok
    from pg_class c
    where c.oid = to_regclass('public.issued_inbox_local_parts')
  ),
  r as (
    select current_setting('otodoke.verify_issued_unregistered', true) as unregistered,
           (select ok from trig) as trigger_ok,
           (select ok from fn) as function_ok,
           (select ok from reg) as registry_ok,
           current_setting('otodoke.verify_issued_behaviour', true) as behaviour
  )
select unregistered, trigger_ok, function_ok, registry_ok, behaviour,
       case
         when unregistered is distinct from '0' then 'FAILED: addresses in use missing from the registry: ' || coalesce(unregistered, 'not counted')
         when trigger_ok is not true then 'FAILED: the trigger is missing, disabled or not before insert or update of local_part'
         when function_ok is not true then 'FAILED: the trigger function is not security definer with search_path="", closed to anon/authenticated'
         when registry_ok is not true then 'FAILED: the registry is not RLS on, closed to anon/authenticated and read only for service_role'
         when behaviour = 'not tried (no address yet)' then 'OK, behaviour not tried: no address yet'
         when behaviour is distinct from 'ok' then coalesce(behaviour, 'FAILED: the behaviour block did not run')
         else 'OK'
       end as verdict
from r;
