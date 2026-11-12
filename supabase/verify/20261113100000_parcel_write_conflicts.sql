-- One final verdict row. Requires C and A followed by this migration.
-- All behaviour writes are synthetic and rolled back. Does not send anything.
do $$
declare
  v_user uuid:=gen_random_uuid(); v_mail uuid:=gen_random_uuid(); v_run uuid:=gen_random_uuid();
  v_parcel uuid; v_old jsonb; v_snapshot jsonb; v_saved jsonb; v_verdict text; v_version timestamptz;
  v_fail text:=''; v_count bigint;
  v_values jsonb:='{"shop":"Synthetic shop","order_number":"ORDER-12345678","status":"ordered","total_amount":1000}';
  v_items jsonb:='[{"name":"Synthetic item","quantity":1,"unit_price":1000,"evidence":"Synthetic"}]';
begin
  begin
    insert into auth.users(id) values(v_user);
    insert into public.emails(id,user_id,processing_status,processing_run_id,processing_lease_until)
      values(v_mail,v_user,'pending',v_run,clock_timestamp()+interval '360 seconds');
    -- Email -> this user's candidate key, just as the owning RPCs.
    perform 1 from public.emails e where e.id=v_mail for update;
    perform set_config('otodoke.parcel_owner',v_user::text,true);
    perform public.lock_parcel_owner(v_user);
    v_snapshot:=public.mail_parcel_snapshot(v_user);
    select c.verdict,c.parcel_id into v_verdict,v_parcel from public.create_mail_parcel(v_snapshot,v_values,v_items,v_mail,v_run) c;
    if v_verdict is distinct from 'ok' or v_parcel is null then v_fail:=v_fail||' create'; end if;
    select count(*) into v_count from public.parcel_items i where i.parcel_id=v_parcel and i.user_id=v_user;
    if v_count<>1 then v_fail:=v_fail||' initial_items'; end if;
    select c.verdict into v_verdict from public.create_mail_parcel(v_snapshot,v_values,v_items,v_mail,v_run) c;
    if v_verdict is distinct from 'retry' then v_fail:=v_fail||' stale_create'; end if;
    if (select count(*) from public.parcels p where p.user_id=v_user)<>1 then v_fail:=v_fail||' duplicate_created'; end if;
    v_old:=public.mail_parcel_snapshot(v_user);
    update public.parcel_items i set name='Changed item' where i.parcel_id=v_parcel;
    select p.updated_at into v_version from public.parcels p where p.id=v_parcel;
    select u.verdict into v_verdict from public.update_mail_parcel(v_old,v_parcel,v_version,'{"status":"shipped"}',null,v_items,v_mail,v_run) u;
    if v_verdict is distinct from 'retry' then v_fail:=v_fail||' changed_items'; end if;
    v_snapshot:=public.mail_parcel_snapshot(v_user);
    select u.verdict,u.parcel_row into v_verdict,v_saved from public.update_mail_parcel(v_snapshot,v_parcel,v_version,
      '{"status":"delivered","received_at":"2026-11-02T00:00:00Z","expected_window_start":"12:34"}',null,v_items,v_mail,v_run) u;
    if v_verdict is distinct from 'ok' or v_saved->>'status' is distinct from 'delivered'
      or (v_saved->>'received_at')::timestamptz is distinct from '2026-11-02T00:00:00Z'::timestamptz
      or (v_saved->>'expected_window_start')::time is distinct from '12:34'::time then v_fail:=v_fail||' typed_update_readback'; end if;
    select u.verdict into v_verdict from public.update_mail_parcel(public.mail_parcel_snapshot(v_user),v_parcel,v_version-interval '1 microsecond','{"status":"shipped"}',null,'[]',v_mail,v_run) u;
    if v_verdict is distinct from 'retry' then v_fail:=v_fail||' stale_update'; end if;
    update public.parcels p set category='beauty',category_source='user' where p.id=v_parcel;
    v_snapshot:=public.mail_parcel_snapshot(v_user);
    select p.updated_at into v_version from public.parcels p where p.id=v_parcel;
    if to_regclass('public.parcel_receipt_undos') is null then
      select u.verdict,u.parcel_row into v_verdict,v_saved from public.update_mail_parcel(v_snapshot,v_parcel,v_version,'{}','{"category":"hobby","category_source":"auto"}',v_items,v_mail,v_run) u;
      if v_verdict is distinct from 'ok' or v_saved->>'category' is distinct from 'beauty' then v_fail:=v_fail||' user_category'; end if;
    else
      -- 130000 makes an empty mail merge advance the parcel version. now() is constant inside this
      -- verifier's one transaction, so the version cannot advance here: that guard must refuse the call
      -- (run-received-receipts.mjs covers the advance across separate transactions).
      begin
        perform 1 from public.update_mail_parcel(v_snapshot,v_parcel,v_version,'{}','{"category":"hobby","category_source":"auto"}',v_items,v_mail,v_run);
        v_fail:=v_fail||' user_category_empty_merge_accepted';
      exception when insufficient_privilege then
        if sqlerrm is distinct from 'mail confirmation did not advance the parcel version' then raise; end if;
      end;
    end if;
    -- A non-empty merge must still keep the person's category, whichever migrations are applied.
    v_snapshot:=public.mail_parcel_snapshot(v_user);
    select p.updated_at into v_version from public.parcels p where p.id=v_parcel;
    select u.verdict,u.parcel_row into v_verdict,v_saved from public.update_mail_parcel(v_snapshot,v_parcel,v_version,'{"shop":"Synthetic shop renamed"}','{"category":"hobby","category_source":"auto"}',v_items,v_mail,v_run) u;
    if v_verdict is distinct from 'ok' or v_saved->>'category' is distinct from 'beauty' or v_saved->>'shop' is distinct from 'Synthetic shop renamed' then v_fail:=v_fail||' user_category_nonempty'; end if;
    select count(*) into v_count from public.parcel_items i where i.parcel_id=v_parcel;
    if v_count<>1 then v_fail:=v_fail||' duplicate_items'; end if;
    update public.emails e set processing_lease_until=clock_timestamp()-interval '1 second' where e.id=v_mail;
    begin
      perform public.create_mail_parcel(public.mail_parcel_snapshot(v_user),v_values,v_items,v_mail,v_run);
      v_fail:=v_fail||' expired_owner';
    exception when insufficient_privilege then null;
    end;
    delete from auth.users where id=v_user;
    if exists(select 1 from public.parcels where user_id=v_user)
      or exists(select 1 from public.emails where user_id=v_user)
      or exists(select 1 from public.parcel_items where user_id=v_user) then v_fail:=v_fail||' account_cascade'; end if;
    raise exception using errcode='OTRBK',message='undo parcel verifier writes';
  exception when sqlstate 'OTRBK' then null;
  when others then v_fail:=v_fail||' SQLSTATE='||sqlstate||' '||sqlerrm;
  end;
  perform set_config('otodoke.verify_parcel_conflicts',case when v_fail='' then 'OK' else 'FAILED:'||v_fail end,false);
end $$;
with checks as (
  select
    (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lock_parcel_owner')
      and exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.lock_parcel_owner(uuid)')
        and md5(p.prosrc)='cba30ab8864f4e637cdd74bb913e2f43' and p.proargnames=array['p_user'] and p.pronargdefaults=0 and not p.proisstrict
        and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('service_role',p.oid,'EXECUTE')
        and pg_get_function_result(p.oid)='void' and p.prosecdef and p.proconfig=array['search_path=""']
        and p.proowner=(select relowner from pg_class where oid='public.emails'::regclass)
        and (select count(*)=1 and bool_and(a.grantor=p.proowner and a.grantee=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable)
          from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) as shared_owner_helper_ok,
    not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.prosrc ~* 'pg_(try_)?advisory(_xact)?_lock(_shared)?[[:space:]]*\([[:space:]]*62803[[:space:]]*,[[:space:]]*0[[:space:]]*\)') as no_global_candidate_lock,
    (select count(*)=5 and bool_and(p.prosecdef and p.proconfig=array['search_path=""']
      and not has_function_privilege('anon',p.oid,'execute') and not has_function_privilege('authenticated',p.oid,'execute')
      and has_function_privilege('service_role',p.oid,'execute')) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in ('lock_parcel_candidates','mail_parcel_snapshot','create_mail_parcel','update_mail_parcel','ensure_mail_parcel_items')) as functions_ok,
    (select count(*)=2 and bool_and(t.tgtype=62 and t.tgenabled='O' and t.tgfoid=to_regprocedure('public.lock_parcel_candidates()')
      and t.tgrelid=case t.tgname when 'parcels_candidate_write_lock' then 'public.parcels'::regclass else 'public.parcel_items'::regclass end
      and t.tgqual is null and t.tgattr=''::int2vector and t.tgnargs=0) from pg_trigger t
      where t.tgname in ('parcels_candidate_write_lock','parcel_items_candidate_write_lock') and not t.tgisinternal) as statement_locks_ok,
    (select count(*)=2 and bool_and(t.tgtype=31 and t.tgenabled='O' and t.tgfoid=to_regprocedure('public.lock_parcel_candidates()')
      and t.tgrelid=case t.tgname when 'parcels_candidate_owner' then 'public.parcels'::regclass else 'public.parcel_items'::regclass end
      and t.tgqual is null and t.tgattr=''::int2vector and t.tgnargs=0)
      from pg_trigger t where t.tgname in ('parcels_candidate_owner','parcel_items_candidate_owner') and not t.tgisinternal) as row_owners_ok,
    (select count(*)=1 and bool_and(t.tgtype=11 and t.tgenabled='O' and t.tgqual is null and t.tgnargs=0 and t.tgfoid=case when to_regclass('public.sample_generations') is null
      then to_regprocedure('public.lock_parcel_candidates()') else to_regprocedure('public.prelock_sample_owner_delete()') end)
      from pg_trigger t where t.tgrelid='auth.users'::regclass and t.tgname='parcel_candidate_owner_delete' and not t.tgisinternal) as auth_callback_ok,
    coalesce(current_setting('otodoke.verify_parcel_conflicts',true),'FAILED: behaviour did not run') as behaviour
)
select case when functions_ok and statement_locks_ok and row_owners_ok and auth_callback_ok and shared_owner_helper_ok
  and no_global_candidate_lock and behaviour='OK' then 'OK' else 'FAILED' end as verdict,checks.* from checks;
