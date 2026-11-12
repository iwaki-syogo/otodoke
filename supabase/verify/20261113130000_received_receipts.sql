-- Run as the migration owner immediately after 130000. Runtime rows are rolled back.
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
    select * into v_result from public.restore_parcel_receipts(jsonb_build_array(jsonb_build_object('id',v_parcel,'receipt_id',v_token,'status','shipped')));
    if v_result.outcome is distinct from 'changed' then v_fail:=array_append(v_fail,'other_owner'); end if;
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
      and exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events()')
        and prosrc like '%v_count:=public.purge_old_screen_events_before_receipt_retention();%return v_count+public.purge_expired_parcel_receipts();%') as existing_daily_composition,
    (select count(*)=3 and bool_and(prosecdef or proname='parcel_receipt_retention') from pg_proc where oid in
      (to_regprocedure('public.parcel_receipt_retention()'),to_regprocedure('public.purge_expired_parcel_receipts()'),to_regprocedure('public.purge_old_screen_events_before_receipt_retention()')))
      and not exists(select 1 from pg_proc p,unnest(array['anon','authenticated','service_role']) r where p.oid in
        (to_regprocedure('public.parcel_receipt_retention()'),to_regprocedure('public.purge_expired_parcel_receipts()'),to_regprocedure('public.purge_old_screen_events_before_receipt_retention()'))
        and has_function_privilege(r,p.oid,'EXECUTE')) as expiry_helpers_private,
    failures from receipt_runtime_checks
)
select case when journal_rls and journal_private and authenticated_only and one_per_parcel and owner_index and core_private
  and bounded_expiry and expiry_policy and existing_daily_composition and expiry_helpers_private and cardinality(failures)=0 then 'OK' else 'FAILED' end as verdict,checks.* from checks;
commit;
