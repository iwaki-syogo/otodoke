-- Run immediately after the migration, as the database owner, in one session.
-- Tests use two temporary auth users without an address. Every test write, including the
-- users and their choices, is undone by a caught private exception (OTRBK).
-- The result alone survives in a session setting. The last SELECT is the only result set:
-- its verdict is authoritative; no verdict or an SQL error also means FAILED.
-- No mail is sent, no Claude call is made, and no existing person's choice is changed.

-- Reset the result first: rerunning after an error must never reuse an earlier OK.
do $$ begin perform set_config('otodoke.verify_ai_reading', 'FAILED: behaviour did not finish', false); end $$;

do $$
declare
  v_user uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_decision text;
  v_decided_at timestamptz;
  v_version text;
  v_value text;
  v_count integer;
  v_refused boolean;
  v_fail text[] := array[]::text[];
  v_result text;
begin
  begin
    insert into auth.users(id) values (v_user), (v_other);
    insert into public.ai_reading_consents(user_id, decision, text_version)
      values (v_other, 'declined', 'other-version') returning decided_at into v_decided_at;
    if v_decided_at is distinct from now() then v_fail := array_append(v_fail, 'table_default_server_time'); end if;

    -- Exercise the table as its owner: the RPC's own validation must not hide a loosened CHECK.
    -- Each accepted probe is rolled back too, so it cannot cause a later primary-key failure.
    foreach v_value in array array['unexpected', '', 'GRANTED', 'yes'] loop
      v_refused := false;
      begin
        insert into public.ai_reading_consents(user_id, decision, text_version) values (v_user, v_value, 'v1');
        raise exception using errcode = 'OTPRB', message = 'undo an accepted table probe';
      exception
        when check_violation then v_refused := true;
        when sqlstate 'OTPRB' then null;
      end;
      if not v_refused then v_fail := array_append(v_fail, 'table_invalid_decision_insert_refused'); end if;
      v_refused := false;
      begin
        update public.ai_reading_consents set decision = v_value where user_id = v_other;
        raise exception using errcode = 'OTPRB', message = 'undo an accepted table probe';
      exception
        when check_violation then v_refused := true;
        when sqlstate 'OTPRB' then null;
      end;
      if not v_refused then v_fail := array_append(v_fail, 'table_invalid_decision_update_refused'); end if;
    end loop;
    v_refused := false;
    begin
      insert into public.ai_reading_consents(user_id, decision, text_version) values (v_user, null, 'v1');
      raise exception using errcode = 'OTPRB', message = 'undo an accepted table probe';
    exception
      when not_null_violation then v_refused := true;
      when sqlstate 'OTPRB' then null;
    end;
    if not v_refused then v_fail := array_append(v_fail, 'table_null_decision_insert_refused'); end if;
    v_refused := false;
    begin
      update public.ai_reading_consents set decision = null where user_id = v_other;
      raise exception using errcode = 'OTPRB', message = 'undo an accepted table probe';
    exception
      when not_null_violation then v_refused := true;
      when sqlstate 'OTPRB' then null;
    end;
    if not v_refused then v_fail := array_append(v_fail, 'table_null_decision_update_refused'); end if;

    perform set_config('request.jwt.claim.sub', v_user::text, true);
    perform set_config('role', 'authenticated', true);
    select c.decision, c.decided_at into v_decision, v_decided_at from public.set_ai_reading('granted', 'v1') c;
    if v_decision is distinct from 'granted' or v_decided_at is null or v_decided_at < now() or v_decided_at > clock_timestamp() then
      v_fail := array_append(v_fail, 'grant_return_and_server_time');
    end if;
    select count(*) into v_count from public.ai_reading_consents where user_id in (v_user, v_other);
    if v_count <> 1 then v_fail := array_append(v_fail, 'rls_hides_other_user'); end if;
    select c.text_version into v_version from public.ai_reading_consents c where c.user_id = v_user;
    if v_version is distinct from 'v1' then v_fail := array_append(v_fail, 'text_version_stored'); end if;

    v_refused := false;
    begin
      insert into public.ai_reading_consents(user_id, decision, text_version) values (v_user, 'granted', 'forged');
    exception when insufficient_privilege then v_refused := true; end;
    if not v_refused then v_fail := array_append(v_fail, 'direct_insert_refused'); end if;
    v_refused := false;
    begin
      update public.ai_reading_consents set decided_at = '2000-01-01' where user_id = v_user;
    exception when insufficient_privilege then v_refused := true; end;
    if not v_refused then v_fail := array_append(v_fail, 'direct_update_refused'); end if;
    v_refused := false;
    begin
      delete from public.ai_reading_consents where user_id = v_user;
    exception when insufficient_privilege then v_refused := true; end;
    if not v_refused then v_fail := array_append(v_fail, 'direct_delete_refused'); end if;

    foreach v_value in array array[null::text, '', 'yes', 'GRANTED'] loop
      v_refused := false;
      begin
        perform public.set_ai_reading(v_value, 'v1');
      exception when invalid_parameter_value then v_refused := true; end;
      if not v_refused then v_fail := array_append(v_fail, 'invalid_decision_refused'); end if;
    end loop;
    foreach v_value in array array[null::text, '', '   '] loop
      v_refused := false;
      begin
        perform public.set_ai_reading('granted', v_value);
      exception when invalid_parameter_value then v_refused := true; end;
      if not v_refused then v_fail := array_append(v_fail, 'missing_version_refused'); end if;
    end loop;

    select c.decision into v_decision from public.set_ai_reading('declined', 'v1') c;
    if v_decision is distinct from 'declined' then v_fail := array_append(v_fail, 'withdrawal'); end if;
    select c.decision into v_decision from public.set_ai_reading('granted', 'future-version') c;
    select c.text_version into v_version from public.ai_reading_consents c where c.user_id = v_user;
    if v_decision is distinct from 'granted' or v_version is distinct from 'future-version' then
      v_fail := array_append(v_fail, 'grant_again_and_future_version');
    end if;

    -- Even authenticated cannot use the function without a user in its JWT.
    perform set_config('request.jwt.claim.sub', '', true);
    v_refused := false;
    begin
      perform public.set_ai_reading('granted', 'v1');
    exception when insufficient_privilege then v_refused := true; end;
    if not v_refused then v_fail := array_append(v_fail, 'missing_user_refused'); end if;

    perform set_config('role', 'anon', true);
    perform set_config('request.jwt.claim.sub', v_user::text, true);
    v_refused := false;
    begin
      perform public.set_ai_reading('granted', 'v1');
    exception when insufficient_privilege then v_refused := true; end;
    if not v_refused then v_fail := array_append(v_fail, 'anon_cannot_use_forged_subject'); end if;
    v_refused := false;
    begin
      perform 1 from public.ai_reading_consents;
    exception when insufficient_privilege then v_refused := true; end;
    if not v_refused then v_fail := array_append(v_fail, 'anon_cannot_read'); end if;

    perform set_config('role', 'service_role', true);
    v_refused := false;
    begin
      perform public.set_ai_reading('granted', 'v1');
    exception when insufficient_privilege then v_refused := true; end;
    if not v_refused then v_fail := array_append(v_fail, 'service_role_cannot_decide'); end if;

    perform set_config('role', 'none', true);
    select c.decision, c.text_version into v_decision, v_version
      from public.ai_reading_consents c where c.user_id = v_other;
    if v_decision is distinct from 'declined' or v_version is distinct from 'other-version' then
      v_fail := array_append(v_fail, 'other_user_unchanged');
    end if;
    update public.ai_reading_consents set decided_at = '2000-01-01' where user_id = v_user;
    perform set_config('role', 'authenticated', true);
    perform set_config('request.jwt.claim.sub', v_user::text, true);
    select c.decided_at into v_decided_at from public.set_ai_reading('declined', 'v1') c;
    if v_decided_at is null or v_decided_at < now() or v_decided_at > clock_timestamp() then v_fail := array_append(v_fail, 'upsert_uses_server_time'); end if;

    -- Hard deletion is what the shared deleteAuthUser helper requests; only that user's choice goes.
    perform set_config('role', 'none', true);
    delete from auth.users where id = v_user;
    if exists (select 1 from public.ai_reading_consents where user_id = v_user)
      or not exists (select 1 from public.ai_reading_consents where user_id = v_other) then
      v_fail := array_append(v_fail, 'account_deletion_cascade_only_owner');
    end if;

    raise exception using errcode = 'OTRBK', message = 'undo the verify writes';
  exception
    when sqlstate 'OTRBK' then null;
    when others then v_fail := array_append(v_fail, 'sqlstate_' || sqlstate);
  end;
  v_result := case when cardinality(v_fail) = 0 then 'OK' else 'FAILED: ' || array_to_string(v_fail, ', ') end;
  perform set_config('otodoke.verify_ai_reading', v_result, false);
end $$;

with checks as (
  select
    (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.ai_reading_consents')) is true as rls_ok,
    (select count(*) = 4 and bool_and(a.attnotnull)
       from pg_attribute a where a.attrelid = to_regclass('public.ai_reading_consents') and a.attnum > 0 and not a.attisdropped) as columns_ok,
    exists (select 1 from pg_constraint c
      where c.conrelid = to_regclass('public.ai_reading_consents') and c.contype = 'p'
      and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (user_id)') as primary_key_ok,
    exists (select 1 from pg_constraint c
      where c.conrelid = to_regclass('public.ai_reading_consents') and c.contype = 'f'
      and c.confrelid = to_regclass('auth.users') and c.confdeltype = 'c' and c.convalidated) as cascade_ok,
    -- Presence check only; behaviour above requires the table itself to refuse invalid values.
    exists (select 1 from pg_constraint c
      where c.conrelid = to_regclass('public.ai_reading_consents') and c.contype = 'c' and c.convalidated
      and pg_get_constraintdef(c.oid) like '%granted%' and pg_get_constraintdef(c.oid) like '%declined%') as decision_check_ok,
    coalesce(has_table_privilege('authenticated', to_regclass('public.ai_reading_consents'), 'select'), false)
      and not coalesce(has_table_privilege('authenticated', to_regclass('public.ai_reading_consents'), 'insert,update,delete,truncate,references,trigger'), true)
      and not coalesce(has_table_privilege('anon', to_regclass('public.ai_reading_consents'), 'select,insert,update,delete,truncate,references,trigger'), true)
      and coalesce(has_table_privilege('service_role', to_regclass('public.ai_reading_consents'), 'select'), false)
      and not coalesce(has_table_privilege('service_role', to_regclass('public.ai_reading_consents'), 'insert,update,delete,truncate,references,trigger'), true) as table_privileges_ok,
    exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.set_ai_reading(text,text)')
      and p.prosecdef and p.proconfig = array['search_path=""'] and p.proretset
      and p.proargnames = array['p_decision', 'p_text_version', 'decision', 'decided_at']
      and pg_get_function_result(p.oid) = 'TABLE(decision text, decided_at timestamp with time zone)'
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')) as function_ok,
    coalesce(current_setting('otodoke.verify_ai_reading', true), 'FAILED: behaviour did not run') as behaviour
)
select checks.*,
  case when rls_ok and columns_ok and primary_key_ok and cascade_ok and decision_check_ok and table_privileges_ok and function_ok and behaviour = 'OK'
    then 'OK' else 'FAILED' end as verdict
from checks;
