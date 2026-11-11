-- Verify after 20261112180000 and 20261112181000, as the database owner, in one session.
-- Uses two synthetic auth users with no address; all writes are undone by OTRBK. The last
-- result's verdict is authoritative. No result, an SQL error or FAILED means stop.
-- Sequential behaviour and catalog checks do not prove a two-session race: also exercise that
-- on a temporary database. The RPCs serialize on the same consent row (UPSERT / FOR UPDATE).
do $$ begin perform set_config('otodoke.verify_ai_consent_auto', 'FAILED: behaviour did not finish', false); end $$;

do $$
declare
  v_user uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_grant timestamptz;
  v_declined timestamptz;
  v_regrant timestamptz;
  v_version_change timestamptz;
  v_at timestamptz;
  v_before timestamptz;
  v_decision text;
  v_role text;
  v_refused boolean;
  v_fail text[] := array[]::text[];
begin
  begin
    insert into auth.users(id) values (v_user), (v_other);
    insert into public.ai_reading_consents(user_id, decision, text_version) values (v_other, 'granted', 'other-version');
    insert into public.ai_consent_read_runs(user_id, consent_decided_at) values (v_other, now());

    -- Every app role is denied direct access to the private journal, service_role included.
    foreach v_role in array array['anon', 'authenticated', 'service_role'] loop
      perform set_config('role', v_role, true);
      perform set_config('request.jwt.claim.sub', v_user::text, true);
      v_refused := false;
      begin
        perform 1 from public.ai_consent_read_runs;
      exception when insufficient_privilege then v_refused := true; end;
      if not v_refused then v_fail := array_append(v_fail, v_role || '_journal_select_refused'); end if;
      v_refused := false;
      begin
        insert into public.ai_consent_read_runs(user_id, consent_decided_at) values (v_user, now());
      exception when insufficient_privilege then v_refused := true; end;
      if not v_refused then v_fail := array_append(v_fail, v_role || '_journal_insert_refused'); end if;
      v_refused := false;
      begin
        update public.ai_consent_read_runs set consent_decided_at = now() where user_id = v_other;
      exception when insufficient_privilege then v_refused := true; end;
      if not v_refused then v_fail := array_append(v_fail, v_role || '_journal_update_refused'); end if;
      v_refused := false;
      begin
        delete from public.ai_consent_read_runs where user_id = v_other;
      exception when insufficient_privilege then v_refused := true; end;
      if not v_refused then v_fail := array_append(v_fail, v_role || '_journal_delete_refused'); end if;
      if v_role <> 'service_role' then
        v_refused := false;
        begin
          perform public.claim_ai_reading_backlog(v_user, now());
        exception when insufficient_privilege then v_refused := true; end;
        if not v_refused then v_fail := array_append(v_fail, v_role || '_claim_refused'); end if;
      end if;
      perform set_config('role', 'none', true);
    end loop;

    perform set_config('role', 'service_role', true);
    if public.claim_ai_reading_backlog(v_user, now()) is distinct from false
      or public.claim_ai_reading_backlog(null, now()) is distinct from false
      or public.claim_ai_reading_backlog(v_user, null) is distinct from false then
      v_fail := array_append(v_fail, 'missing_or_undecided_claim_false');
    end if;

    perform set_config('role', 'authenticated', true);
    v_before := clock_timestamp();
    select c.decision, c.decided_at into v_decision, v_grant from public.set_ai_reading('granted', 'v1') c;
    if v_decision is distinct from 'granted' or v_grant < v_before or v_grant > clock_timestamp() or v_grant is null then
      v_fail := array_append(v_fail, 'grant_server_time');
    end if;
    select c.decided_at into v_at from public.set_ai_reading('granted', 'v1') c;
    if v_at is distinct from v_grant then v_fail := array_append(v_fail, 'same_grant_time_preserved'); end if;

    perform set_config('role', 'service_role', true);
    if public.claim_ai_reading_backlog(v_user, v_grant) is distinct from true then v_fail := array_append(v_fail, 'first_claim_true'); end if;
    if public.claim_ai_reading_backlog(v_user, v_grant) is distinct from false then v_fail := array_append(v_fail, 'second_claim_false'); end if;
    if public.claim_ai_reading_backlog(v_user, v_grant - interval '1 microsecond') is distinct from false then v_fail := array_append(v_fail, 'old_timestamp_claim_false'); end if;

    -- A second process can receive the same grant response after the first process has claimed.
    perform set_config('role', 'authenticated', true);
    select c.decided_at into v_at from public.set_ai_reading('granted', 'v1') c;
    if v_at is distinct from v_grant then v_fail := array_append(v_fail, 'repeated_grant_after_claim_time_preserved'); end if;
    perform set_config('role', 'service_role', true);
    if public.claim_ai_reading_backlog(v_user, v_at) is distinct from false then v_fail := array_append(v_fail, 'repeated_grant_after_claim_false'); end if;

    perform set_config('role', 'authenticated', true);
    select c.decision, c.decided_at into v_decision, v_declined from public.set_ai_reading('declined', 'v1') c;
    if v_decision is distinct from 'declined' or v_declined <= v_grant then v_fail := array_append(v_fail, 'cancel_advances_timestamp'); end if;
    select c.decided_at into v_at from public.set_ai_reading('declined', 'v1') c;
    if v_at is distinct from v_declined then v_fail := array_append(v_fail, 'same_decline_time_preserved'); end if;
    perform set_config('role', 'service_role', true);
    if public.claim_ai_reading_backlog(v_user, v_grant) is distinct from false
      or public.claim_ai_reading_backlog(v_user, v_declined) is distinct from false then
      v_fail := array_append(v_fail, 'cancelled_claim_false');
    end if;

    perform set_config('role', 'authenticated', true);
    select c.decided_at into v_regrant from public.set_ai_reading('granted', 'v1') c;
    if v_regrant is null or v_regrant <= v_declined then v_fail := array_append(v_fail, 'regrant_advances_timestamp'); end if;
    perform set_config('role', 'service_role', true);
    if public.claim_ai_reading_backlog(v_user, v_grant) is distinct from false then v_fail := array_append(v_fail, 'old_grant_after_regrant_false'); end if;
    if public.claim_ai_reading_backlog(v_user, v_regrant) is distinct from true then v_fail := array_append(v_fail, 'regrant_claim_true'); end if;
    if public.claim_ai_reading_backlog(v_user, v_regrant) is distinct from false then v_fail := array_append(v_fail, 'regrant_second_claim_false'); end if;

    perform set_config('role', 'authenticated', true);
    select c.decided_at into v_version_change from public.set_ai_reading('granted', 'future-version') c;
    if v_version_change is null or v_version_change <= v_regrant then v_fail := array_append(v_fail, 'version_change_advances_timestamp'); end if;
    perform set_config('role', 'service_role', true);
    if public.claim_ai_reading_backlog(v_user, v_regrant) is distinct from false then v_fail := array_append(v_fail, 'old_version_claim_false'); end if;
    if public.claim_ai_reading_backlog(v_user, v_version_change) is distinct from true then v_fail := array_append(v_fail, 'future_version_claim_true'); end if;

    perform set_config('role', 'none', true);
    if (select count(*) from public.ai_consent_read_runs where user_id = v_user) <> 1
      or (select consent_decided_at from public.ai_consent_read_runs where user_id = v_user) is distinct from v_version_change then
      v_fail := array_append(v_fail, 'one_latest_claim_per_user');
    end if;
    if not exists (select 1 from public.ai_reading_consents where user_id = v_other and decision = 'granted' and text_version = 'other-version')
      or not exists (select 1 from public.ai_consent_read_runs where user_id = v_other and consent_decided_at = now()) then
      v_fail := array_append(v_fail, 'other_user_unchanged');
    end if;
    delete from auth.users where id = v_user;
    if exists (select 1 from public.ai_consent_read_runs where user_id = v_user)
      or exists (select 1 from public.ai_reading_consents where user_id = v_user)
      or not exists (select 1 from public.ai_consent_read_runs where user_id = v_other) then
      v_fail := array_append(v_fail, 'account_deletion_cascade_only_owner');
    end if;

    raise exception using errcode = 'OTRBK', message = 'undo the verify writes';
  exception
    when sqlstate 'OTRBK' then null;
    when others then v_fail := array_append(v_fail, 'sqlstate_' || sqlstate);
  end;
  perform set_config('otodoke.verify_ai_consent_auto', case when cardinality(v_fail) = 0 then 'OK' else 'FAILED: ' || array_to_string(v_fail, ', ') end, false);
end $$;

with checks as (
  select
    (select c.relrowsecurity from pg_class c where c.oid = to_regclass('public.ai_consent_read_runs')) is true as journal_rls_ok,
    (select count(*) = 2 and bool_and(a.attnotnull) from pg_attribute a
      where a.attrelid = to_regclass('public.ai_consent_read_runs') and a.attnum > 0 and not a.attisdropped) as journal_columns_ok,
    exists (select 1 from pg_constraint c where c.conrelid = to_regclass('public.ai_consent_read_runs')
      and c.contype = 'p' and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (user_id)') as one_run_per_user_ok,
    exists (select 1 from pg_constraint c where c.conrelid = to_regclass('public.ai_consent_read_runs')
      and c.contype = 'f' and c.confrelid = to_regclass('auth.users') and c.confdeltype = 'c' and c.convalidated) as cascade_ok,
    not coalesce(has_table_privilege('anon', to_regclass('public.ai_consent_read_runs'), 'select,insert,update,delete,truncate,references,trigger'), true)
      and not coalesce(has_table_privilege('authenticated', to_regclass('public.ai_consent_read_runs'), 'select,insert,update,delete,truncate,references,trigger'), true)
      and not coalesce(has_table_privilege('service_role', to_regclass('public.ai_consent_read_runs'), 'select,insert,update,delete,truncate,references,trigger'), true) as journal_private_ok,
    exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.claim_ai_reading_backlog(uuid,timestamptz)')
      and p.prosecdef and p.proconfig = array['search_path=""'] and not p.proretset
      and pg_get_function_result(p.oid) = 'boolean'
      and has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and pg_get_functiondef(p.oid) ~* 'for update') as claim_function_ok,
    exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.set_ai_reading(text,text)')
      and p.prosecdef and p.proconfig = array['search_path=""'] and p.proretset
      and pg_get_function_result(p.oid) = 'TABLE(decision text, decided_at timestamp with time zone)'
      and has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('service_role', p.oid, 'execute')) as setter_function_ok,
    coalesce(current_setting('otodoke.verify_ai_consent_auto', true), 'FAILED: behaviour did not run') as behaviour
)
select checks.*,
  case when journal_rls_ok and journal_columns_ok and one_run_per_user_ok and cascade_ok and journal_private_ok
    and claim_function_ok and setter_function_ok and behaviour = 'OK' then 'OK' else 'FAILED' end as verdict
from checks;
