-- Run as the migration owner right after 20261113140000 (and after re-applying it). Read the LAST result row's verdict column.
-- What the 130000 and 120000 verify files check, in the form 140000 leaves: 140000 wraps the daily purge once more, so their
-- direct-composition checks read FAILED after 140000 although nothing they guard changed. This file follows the extra wrapper
-- (purge_old_screen_events -> ..._before_cleared_mail_marks -> ..._before_receipt_retention) and checks everything else as they do.
-- After the 140000 rollback, use the 130000 and 120000 verify files again (this one then reads FAILED). Runtime rows are rolled back.
-- Mail no-op version advancement requires separate transactions; run-received-receipts.mjs tests it.
begin;
create temporary table receipt_runtime_checks(failures text[]) on commit drop;
do $$
declare
  v_user uuid:=gen_random_uuid(); v_other uuid:=gen_random_uuid(); v_parcel uuid:=gen_random_uuid();
  v_deleted uuid:=gen_random_uuid(); v_token uuid; v_result record; v_fail text[]:=array[]::text[];
  v_receipt public.parcel_receipt_undos%rowtype; v_count integer; v_state text; v_expiry timestamptz;
begin
  begin
    insert into auth.users(id) values(v_user),(v_other);
    -- One owner per transaction: synthetic parcel DML joins the same private P1 scope.
    perform public.lock_sample_owner(v_user);
    perform public.lock_parcel_owner(v_user);
    insert into public.parcels(id,user_id,shop,status,received_at) values(v_parcel,v_user,'Synthetic receipt shop','delivered',null);
    perform set_config('request.jwt.claim.sub',v_user::text,true);
    select * into v_result from public.mark_parcels_received(array[v_parcel]);
    v_token:=v_result.receipt_id;
    if v_result.outcome is distinct from 'written' or v_result.previous_status is distinct from 'delivered'
      or v_result.previous_received_at is not null or v_token is null then v_fail:=array_append(v_fail,'database_prestate'); end if;
    select * into v_receipt from public.parcel_receipt_undos where parcel_id=v_parcel;
    if v_receipt.receipt_id is distinct from v_token or v_receipt.expires_at is distinct from v_receipt.created_at+public.parcel_receipt_retention() then
      v_fail:=array_append(v_fail,'journal_readback_retention'); end if;
    v_expiry:=v_receipt.expires_at;
    select * into v_result from public.mark_parcels_received(array[v_parcel,v_parcel]);
    if v_result.outcome is distinct from 'already_received' or v_result.receipt_id is not null then v_fail:=array_append(v_fail,'receive_replay'); end if;
    select count(*) into v_count from public.parcel_receipt_undos where parcel_id=v_parcel;
    if v_count<>1 or not exists(select 1 from public.parcel_receipt_undos where parcel_id=v_parcel and expires_at=v_expiry) then v_fail:=array_append(v_fail,'bounded_journal_no_extension'); end if;

    perform set_config('request.jwt.claim.sub',v_other::text,true);
    -- An API request gets its own transaction. Within this existing owner transaction a
    -- different JWT must fail before taking another owner's U/G; the runner tests separate requests.
    begin
      perform * from public.restore_parcel_receipts(jsonb_build_array(jsonb_build_object('id',v_parcel,'receipt_id',v_token,'status','shipped')));
      v_fail:=array_append(v_fail,'transaction_owner_switch_accepted');
    exception when insufficient_privilege then
      if sqlerrm is distinct from 'parcel transaction owner cannot change' then raise; end if;
    end;
    perform set_config('request.jwt.claim.sub',v_user::text,true);
    select * into v_result from public.restore_parcel_receipts(jsonb_build_array(jsonb_build_object('id',v_parcel,'receipt_id',gen_random_uuid())));
    if v_result.outcome is distinct from 'changed' then v_fail:=array_append(v_fail,'wrong_token'); end if;
    select * into v_result from public.restore_parcel_receipts(jsonb_build_array(jsonb_build_object('id',v_parcel,'receipt_id',v_token,'status','shipped')));
    if v_result.outcome is distinct from 'restored' or not exists(select 1 from public.parcels where id=v_parcel and status='delivered' and received_at is null) then
      v_fail:=array_append(v_fail,'restore_database_prestate'); end if;
    select * into v_result from public.restore_parcel_receipts(jsonb_build_array(jsonb_build_object('id',v_parcel,'receipt_id',v_token)));
    if v_result.outcome is distinct from 'restored' or not exists(select 1 from public.parcel_receipt_undos where parcel_id=v_parcel and expires_at=v_expiry) then
      v_fail:=array_append(v_fail,'undo_replay_no_extension'); end if;
    update public.parcel_receipt_undos set expires_at=clock_timestamp() where parcel_id=v_parcel;
    select * into v_result from public.restore_parcel_receipts(jsonb_build_array(jsonb_build_object('id',v_parcel,'receipt_id',v_token)));
    if v_result.outcome is distinct from 'failed' then v_fail:=array_append(v_fail,'expired_undo_replay'); end if;

    -- now() is constant in this DO. Synthesize a different expected version for the CAS check.
    select * into v_result from public.mark_parcels_received(array[v_parcel]); v_token:=v_result.receipt_id;
    update public.parcel_receipt_undos set written_updated_at=written_updated_at-interval '1 microsecond' where parcel_id=v_parcel;
    select * into v_result from public.restore_parcel_receipts(jsonb_build_array(jsonb_build_object('id',v_parcel,'receipt_id',v_token)));
    if v_result.outcome is distinct from 'changed' or not exists(select 1 from public.parcels where id=v_parcel and received_at is not null) then v_fail:=array_append(v_fail,'version_cas'); end if;

    begin
      perform * from public.mark_parcels_received(array_fill(v_parcel,array[201]));
      v_fail:=array_append(v_fail,'raw_mark_bound');
    exception when sqlstate '22023' then null; end;
    begin
      perform * from public.mark_parcels_received(array_fill(v_parcel,array[200,200]));
      v_fail:=array_append(v_fail,'multidimensional_bound');
    exception when sqlstate '22023' then null; end;
    begin
      perform * from public.restore_parcel_receipts((select jsonb_agg(jsonb_build_object('id',v_parcel,'receipt_id',v_token)) from generate_series(1,201)));
      v_fail:=array_append(v_fail,'raw_undo_bound');
    exception when sqlstate '22023' then null; end;

    update public.parcel_receipt_undos set expires_at=clock_timestamp() where parcel_id=v_parcel;
    perform public.purge_expired_parcel_receipts();
    if exists(select 1 from public.parcel_receipt_undos where parcel_id=v_parcel) then v_fail:=array_append(v_fail,'physical_expiry'); end if;
    perform public.clear_all_parcels(v_user);
    if exists(select 1 from public.parcel_receipt_undos where user_id=v_user) then v_fail:=array_append(v_fail,'clear_cascade'); end if;
    select * into v_result from public.restore_parcel_receipts(jsonb_build_array(jsonb_build_object('id',v_parcel,'receipt_id',v_token)));
    if v_result.outcome is distinct from 'changed' then v_fail:=array_append(v_fail,'cleared_undo'); end if;
    insert into public.parcels(id,user_id,shop,status) values(v_deleted,v_user,'Synthetic delete shop','shipped');
    perform * from public.mark_parcels_received(array[v_deleted]);
    delete from auth.users where id=v_user;
    if exists(select 1 from public.parcel_receipt_undos where user_id=v_user) then v_fail:=array_append(v_fail,'account_cascade'); end if;
    raise exception using errcode='P7501',message='rollback synthetic receipt verification';
  exception when sqlstate 'P7501' then null;
    when others then get stacked diagnostics v_state=returned_sqlstate; v_fail:=array_append(v_fail,'runtime_'||v_state);
  end;
  insert into receipt_runtime_checks values(v_fail);
end $$;
with checks as (
  select
    exists(select 1 from pg_class where oid=to_regclass('public.parcel_receipt_undos') and relrowsecurity) as journal_rls,
    not has_table_privilege('anon','public.parcel_receipt_undos','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('authenticated','public.parcel_receipt_undos','SELECT,INSERT,UPDATE,DELETE')
      and not has_table_privilege('service_role','public.parcel_receipt_undos','SELECT,INSERT,UPDATE,DELETE') as journal_private,
    (select count(*)=2 and bool_and(prosecdef and proconfig is not distinct from array['search_path=""']
      and has_function_privilege('authenticated',oid,'EXECUTE') and not has_function_privilege('anon',oid,'EXECUTE')
      and not has_function_privilege('service_role',oid,'EXECUTE')) from pg_proc where oid in
      (to_regprocedure('public.mark_parcels_received(uuid[])'),to_regprocedure('public.restore_parcel_receipts(jsonb)'))) as authenticated_only,
    exists(select 1 from pg_index where indrelid='public.parcel_receipt_undos'::regclass and indisunique and indisprimary) as one_per_parcel,
    exists(select 1 from pg_indexes where schemaname='public' and tablename='parcel_receipt_undos' and indexname='parcel_receipt_undos_user_id_idx') as owner_index,
    not has_function_privilege('authenticated','public.update_mail_parcel_without_sample_fence(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)','EXECUTE')
      and not has_function_privilege('service_role','public.update_mail_parcel_without_sample_fence(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)','EXECUTE') as core_private,
    exists(select 1 from pg_indexes where schemaname='public' and tablename='parcel_receipt_undos' and indexname='parcel_receipt_undos_expiry_idx')
      and (select count(*)=2 from pg_attribute where attrelid='public.parcel_receipt_undos'::regclass and attname in ('created_at','expires_at') and attnotnull and not attisdropped) as bounded_expiry,
    public.parcel_receipt_retention()=interval '24 hours' as expiry_policy,
    exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events_before_receipt_retention()')
      and prosrc like '%public.purge_expired_consent_waiting_mail()%')
      and exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events_before_cleared_mail_marks()')
        and prosrc like '%v_count:=public.purge_old_screen_events_before_receipt_retention();%return v_count+public.purge_expired_parcel_receipts();%')
      and exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events()')
        and prosrc like '%v_count:=public.purge_old_screen_events_before_cleared_mail_marks();%return v_count+public.purge_expired_cleared_mail_marks();%') as existing_daily_composition,
    (select count(*)=3 and bool_and(prosecdef or proname='parcel_receipt_retention') from pg_proc where oid in
      (to_regprocedure('public.parcel_receipt_retention()'),to_regprocedure('public.purge_expired_parcel_receipts()'),to_regprocedure('public.purge_old_screen_events_before_receipt_retention()')))
      and not exists(select 1 from pg_proc p,unnest(array['anon','authenticated','service_role']) r where p.oid in
        (to_regprocedure('public.parcel_receipt_retention()'),to_regprocedure('public.purge_expired_parcel_receipts()'),to_regprocedure('public.purge_old_screen_events_before_receipt_retention()'))
        and has_function_privilege(r,p.oid,'EXECUTE')) as expiry_helpers_private,
    (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lock_parcel_owner')
      and exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.lock_parcel_owner(uuid)')
        and md5(p.prosrc)='cba30ab8864f4e637cdd74bb913e2f43' and p.proargnames=array['p_user'] and p.pronargdefaults=0 and not p.proisstrict
        and pg_get_function_result(p.oid)='void' and p.prosecdef and p.proconfig=array['search_path=""']
        and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('service_role',p.oid,'EXECUTE')
        and p.proowner=(select relowner from pg_class where oid=to_regclass('public.emails'))
        and (select count(*)=1 and bool_and(a.grantor=p.proowner and a.grantee=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable)
          from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) as shared_owner_helper_ok,
    coalesce((select oid from pg_roles where rolname=current_user)=(select relowner from pg_class where oid=to_regclass('public.emails')),false)
      and coalesce(has_schema_privilege((select relowner from pg_class where oid=to_regclass('public.emails')),to_regnamespace('auth'),'USAGE')
        and has_column_privilege((select relowner from pg_class where oid=to_regclass('public.emails')),to_regclass('auth.users'),'id','SELECT')
        and has_any_column_privilege((select relowner from pg_class where oid=to_regclass('public.emails')),to_regclass('auth.users'),'UPDATE'),false)
      and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('mark_parcels_received','restore_parcel_receipts','update_mail_parcel_without_sample_fence','update_mail_parcel','lock_sample_owner','parcel_receipt_retention','purge_expired_parcel_receipts','purge_old_screen_events','purge_old_screen_events_before_receipt_retention')
        and (p.proowner is distinct from (select relowner from pg_class where oid=to_regclass('public.emails'))
          or not (select count(*)=case when p.proname in ('mark_parcels_received','restore_parcel_receipts','update_mail_parcel') then 2 else 1 end
            and bool_and(a.grantor=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable and
              (a.grantee=p.proowner or coalesce(a.grantee=case when p.proname in ('mark_parcels_received','restore_parcel_receipts') then 'authenticated'::regrole::oid
                when p.proname='update_mail_parcel' then 'service_role'::regrole::oid else null::oid end,false)))
            from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)))
      and not exists(select 1 from pg_class where oid=to_regclass('public.parcel_receipt_undos')
        and relowner is distinct from (select relowner from pg_class where oid=to_regclass('public.emails'))) as receipt_execution_owner_ok,
    not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.prosrc ~* 'pg_(try_)?advisory(_xact)?_lock(_shared)?[[:space:]]*\([[:space:]]*62803[[:space:]]*,[[:space:]]*0[[:space:]]*\)') as no_global_candidate_lock,
    (select count(*)=3 and bool_and(prosrc like case when proname='update_mail_parcel_without_sample_fence'
      then '%perform public.lock_parcel_owner(v_mail.user_id);%' else '%perform public.lock_parcel_owner(v_user);%' end)
      from pg_proc where oid in(to_regprocedure('public.mark_parcels_received(uuid[])'),to_regprocedure('public.restore_parcel_receipts(jsonb)'),
        to_regprocedure('public.update_mail_parcel_without_sample_fence(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)'))) as receipt_owner_calls_ok,
    -- From the 120000 verify:
    exists(select 1 from pg_attribute where attrelid='public.emails'::regclass and attname='consent_waiting_until'
      and atttypid='timestamptz'::regtype and not attisdropped) as expiry_column,
    exists(select 1 from pg_trigger where tgrelid='public.emails'::regclass and tgname='emails_consent_waiting_marker'
      and not tgisinternal and tgenabled='O') as final_write_marker,
    exists(select 1 from pg_proc where oid=to_regprocedure('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)')
      and prosrc like '%filter (where consent_waiting_until is null)%'
      and prosrc like '%v_old.consent_waiting_until <= v_now%'
      and prosrc like '%consent_wait_expired%') as isolated_expiring_intake,
    -- After 140000: the daily purge -> the 130000 body kept as ..._before_cleared_mail_marks -> the body kept by 130000, which calls it.
    exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events()')
      and prosrc like '%public.purge_old_screen_events_before_cleared_mail_marks()%')
      and exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events_before_cleared_mail_marks()')
        and prosrc like '%public.purge_old_screen_events_before_receipt_retention()%')
      and exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events_before_receipt_retention()')
        and prosrc like '%public.purge_expired_consent_waiting_mail()%') as existing_purge_extended,
    (select count(*)=1 from cron.job where jobname='otodoke-purge-old-screen-events'
      and command='select public.purge_old_screen_events()' and schedule='30 18 * * *' and active) as same_daily_job,
    (select count(*)=8 and bool_and(p.proconfig is not distinct from array['search_path=""']
      and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
      and not has_function_privilege('service_role',p.oid,'EXECUTE'))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in (
        'ai_consent_waiting_retention','mark_consent_waiting_mail','expire_consent_waiting_row','purge_expired_consent_waiting_mail',
        'store_mail_run_before_consent_storage','set_ai_reading_before_consent_storage','purge_old_screen_events_before_consent_storage',
        'store_mail_run_without_sample_fence')) as private_helpers,
    has_function_privilege('authenticated','public.set_ai_reading(text,text)','EXECUTE')
      and not has_function_privilege('anon','public.set_ai_reading(text,text)','EXECUTE')
      and not has_function_privilege('service_role','public.set_ai_reading(text,text)','EXECUTE') as consent_acl,
    not exists(select 1 from public.emails e where e.body_state='plain' and e.processing_status<>'processed'
      and coalesce(e.provider_email_id,'') not like 'demo:%' and coalesce(e.classification,'')<>'forwarding_confirmation'
      and e.consent_waiting_until is null
      and not exists(select 1 from public.ai_reading_consents c where c.user_id=e.user_id and c.decision='granted')) as undecided_declined_backfilled,
    failures from receipt_runtime_checks
), inventory as (
  select count(*) filter(where consent_waiting_until is not null) as isolated_waiting_mails,
    count(*) filter(where consent_waiting_until<=clock_timestamp()) as expiry_candidates_next_daily_sweep
  from public.emails where body_state='plain' and processing_status<>'processed'
)
select case when journal_rls and journal_private and authenticated_only and one_per_parcel and owner_index and core_private
  and bounded_expiry and expiry_policy and existing_daily_composition and expiry_helpers_private and shared_owner_helper_ok and receipt_execution_owner_ok and no_global_candidate_lock and receipt_owner_calls_ok and cardinality(failures)=0
  and expiry_column and final_write_marker and isolated_expiring_intake and existing_purge_extended
  and same_daily_job and private_helpers and consent_acl and undecided_declined_backfilled then 'OK' else 'FAILED' end as verdict,
  checks.*,inventory.* from checks cross join inventory;
commit;
