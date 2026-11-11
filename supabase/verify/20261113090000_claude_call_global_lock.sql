-- Run immediately after migration. One final result row, verdict OK/FAILED.
-- Behaviour writes are rolled back by a private subtransaction exception. Nothing is sent.
-- This is serial smoke verification; tests/postgres/run-cost-guards.mjs also tests concurrency.
do $$
declare
  v_user uuid := gen_random_uuid();
  v_other uuid := gen_random_uuid();
  v_mail uuid := gen_random_uuid();
  v_run uuid := gen_random_uuid();
  v_next uuid := gen_random_uuid();
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_verdict text; v_claim bigint; v_n integer; v_total bigint;
  v_at timestamptz; v_expiry timestamptz; v_rows jsonb;
  v_cols jsonb := '{"processing_status":"pending","subject":"Synthetic order","text_body":"Synthetic body","from_address":"orders@example.test"}'::jsonb;
  v_limits jsonb := '{"user_count":1,"global_count":2147483647,"user_bytes":1048576,"global_bytes":9223372036854775807}'::jsonb;
  v_fail text := '';
begin
  begin
    -- Same lock order as production: intake -> mail -> day. Fresh synthetic users
    -- are rolled back, so no existing person's count/body/status is edited.
    perform pg_catalog.pg_advisory_xact_lock(62802,0);
    perform pg_catalog.pg_advisory_xact_lock(62801,v_day-date '2000-01-01');
    insert into auth.users(id) values(v_user),(v_other);
    select coalesce(sum(calls),0) into v_total from public.claude_usage_daily where day = v_day;
    select * into v_verdict,v_claim from public.claim_claude_call_v2(v_user,1,2147483647);
    if v_verdict is distinct from 'ok' or v_claim is null then v_fail := v_fail || ' v2_claim'; end if;
    if (select calls from public.claude_usage_daily where user_id=v_user and day=v_day) is distinct from 1 then v_fail := v_fail || ' v2_count'; end if;
    if public.claim_claude_call(v_user,1,2147483647) <> 'user_limit' then v_fail := v_fail || ' personal_limit'; end if;
    if public.claim_claude_call(v_other,0,2147483647) <> 'user_limit' then v_fail := v_fail || ' zero_limit_new_row'; end if;
    if exists(select 1 from public.claude_usage_daily where user_id=v_other and day=v_day) then v_fail := v_fail || ' refused_new_row'; end if;
    v_n := public.release_claude_call(v_claim,v_user);
    if v_n <> 1 or public.release_claude_call(v_claim,v_user) <> 0 then v_fail := v_fail || ' release_once'; end if;
    if (select coalesce(sum(calls),0) from public.claude_usage_daily where day=v_day) <> v_total then v_fail := v_fail || ' release_count'; end if;
    if public.claim_claude_call(v_other,10,2147483647) <> 'ok' then v_fail := v_fail || ' v1_claim'; end if;

    select verdict into v_verdict from public.store_mail_run(v_user,v_mail,v_run,v_cols,null,v_limits);
    if v_verdict is distinct from 'ok' then v_fail := v_fail || ' intake'; end if;
    select created_at,processing_lease_until into v_at,v_expiry from public.emails where id=v_mail;
    if v_expiry is null or v_expiry-v_at <> interval '360 seconds' then v_fail := v_fail || ' lease_budget'; end if;
    select verdict into v_verdict from public.store_mail_run(v_user,gen_random_uuid(),gen_random_uuid(),v_cols,null,v_limits);
    if v_verdict is distinct from 'user_storage_limit' then v_fail := v_fail || ' intake_limit'; end if;
    select verdict into v_verdict from public.store_mail_run(v_user,gen_random_uuid(),gen_random_uuid(),v_cols,null,v_limits);
    if (select count(*) from public.mail_intake_notices where user_id=v_user) <> 1 then v_fail := v_fail || ' notice_bounded'; end if;

    update public.emails set created_at = clock_timestamp()-interval '181 seconds' where id=v_mail returning created_at into v_at;
    select verdict into v_verdict from public.store_mail_run(v_user,v_mail,v_next,v_cols,v_at,v_limits);
    if v_verdict is distinct from 'busy' then v_fail := v_fail || ' live_181_seconds'; end if;
    update public.emails set processing_lease_until=clock_timestamp()-interval '1 second' where id=v_mail;
    select verdict into v_verdict from public.store_mail_run(v_user,v_mail,v_next,v_cols,v_at,v_limits);
    if v_verdict is distinct from 'ok' then v_fail := v_fail || ' expired_recovery'; end if;
    begin
      perform public.mail_run_write(v_mail,v_run,'emails','update','{"error":"old owner"}','[]');
      v_fail := v_fail || ' stale_writer_accepted';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.mail_run_write(v_mail,v_run,'claim_claude_call_v2','claim','{"p_user_limit":30,"p_global_limit":2147483647}','[]');
      v_fail := v_fail || ' stale_claim_accepted';
    exception when insufficient_privilege then null;
    end;
    v_rows := public.mail_run_write(v_mail,v_next,'emails','update','{"error":"verified"}','[]');
    if jsonb_array_length(v_rows) <> 1 or (select error from public.emails where id=v_mail) is distinct from 'verified' then v_fail := v_fail || ' owned_write'; end if;
    raise exception using errcode='OTRBK',message='undo verification writes';
  exception when sqlstate 'OTRBK' then null;
  when others then v_fail := v_fail || ' SQLSTATE=' || sqlstate || ' ' || sqlerrm;
  end;
  perform set_config('otodoke.verify_cost_guards',case when v_fail='' then 'OK' else 'FAILED:'||v_fail end,false);
end $$;

with checks as (
  select
    (select count(*)=5 and bool_and(p.prosecdef and p.proconfig=array['search_path=""']
      and not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute')
      and has_function_privilege('service_role',p.oid,'execute'))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
      ('claim_claude_call','claim_claude_call_v2','release_claude_call','store_mail_run','mail_run_write')) as functions_ok,
    (select relrowsecurity from pg_class where oid=to_regclass('public.mail_intake_notices')) is true
      and not has_table_privilege('anon','public.mail_intake_notices','select,insert,update,delete')
      and has_table_privilege('authenticated','public.mail_intake_notices','select')
      and not has_table_privilege('authenticated','public.mail_intake_notices','insert,update') as notice_rls_ok,
    (select count(*)=2 from information_schema.columns where table_schema='public' and table_name='emails' and column_name in ('processing_run_id','processing_lease_until')) as lease_columns_ok,
    coalesce(current_setting('otodoke.verify_cost_guards',true),'FAILED: behaviour did not run') as behaviour
)
select case when functions_ok and notice_rls_ok and lease_columns_ok and behaviour='OK' then 'OK' else 'FAILED' end as verdict, checks.* from checks;
