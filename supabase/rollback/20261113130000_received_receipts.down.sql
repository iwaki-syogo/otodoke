-- Roll back the app to its previous receipt contract in the same maintenance window.
-- Active undo keys cease to work. Parcel state is retained; no historical status is guessed.
begin;
set local lock_timeout='5s';
-- 110000 renames this private core back to its public ABI. Never recreate it after that rollback.
do $receipt_down_order$ begin
  if to_regprocedure('public.lock_sample_owner(uuid)') is null
    or to_regprocedure('public.update_mail_parcel_without_sample_fence(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)') is null then
    raise exception 'receipt rollback requires sample-generation core; roll back 130000 before 110000' using errcode='55000';
  end if;
end $receipt_down_order$;
-- Private helper and the standard application owner are prerequisites, never repaired here.
do $receipt_owner_gate$ begin
  if not (
    (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='lock_parcel_owner')
      and exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.lock_parcel_owner(uuid)')
        and md5(p.prosrc)='cba30ab8864f4e637cdd74bb913e2f43' and p.proargnames=array['p_user'] and p.pronargdefaults=0 and not p.proisstrict
        and pg_get_function_result(p.oid)='void' and p.prosecdef and p.proconfig=array['search_path=""']
        and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('service_role',p.oid,'EXECUTE')
        and p.proowner=(select relowner from pg_class where oid=to_regclass('public.emails'))
        and (select count(*)=1 and bool_and(a.grantor=p.proowner and a.grantee=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable)
          from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a))
    and (coalesce((select oid from pg_roles where rolname=current_user)=(select relowner from pg_class where oid=to_regclass('public.emails')),false)
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
        and relowner is distinct from (select relowner from pg_class where oid=to_regclass('public.emails'))))
    and (not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.prosrc ~* 'pg_(try_)?advisory(_xact)?_lock(_shared)?[[:space:]]*\([[:space:]]*62803[[:space:]]*,[[:space:]]*0[[:space:]]*\)'))
  ) then raise exception 'receipt owner helper or execution owner changed; review before applying' using errcode='55000'; end if;
end $receipt_owner_gate$;
do $$ begin
  if to_regprocedure('public.purge_old_screen_events_before_receipt_retention()') is not null then
    drop function public.purge_old_screen_events();
    alter function public.purge_old_screen_events_before_receipt_retention() rename to purge_old_screen_events;
  end if;
end $$;
drop function if exists public.purge_expired_parcel_receipts();
create or replace function public.update_mail_parcel_without_sample_fence(
  p_snapshot jsonb, p_parcel_id uuid, p_expected_updated_at timestamptz, p_values jsonb, p_category jsonb, p_items jsonb,
  p_email_id uuid default null, p_run_id uuid default null
) returns table(verdict text,parcel_id uuid,parcel_row jsonb)
language plpgsql security definer set search_path='' as $$
declare
  v_mail public.emails%rowtype; v_parcel public.parcels%rowtype; v_expected_row public.parcels%rowtype;
  v_expected jsonb; v_current jsonb; v_rows jsonb; v_saved jsonb; v_changes jsonb; v_verdict text;
begin
  if nullif(current_setting('otodoke.parcel_owner',true),'') is not null and exists(
    select 1 from public.emails where id=p_email_id and user_id::text is distinct from current_setting('otodoke.parcel_owner',true)) then
    raise exception 'parcel transaction owner cannot change' using errcode='42501';
  end if;
  select * into v_mail from public.emails where id=p_email_id for update;
  if v_mail.id is null or p_run_id is null or v_mail.processing_run_id is distinct from p_run_id
    or v_mail.processing_status <> 'pending' or v_mail.processing_lease_until is null
    or v_mail.processing_lease_until <= clock_timestamp() then
    raise exception 'mail run no longer owns the lease' using errcode='42501';
  end if;
  perform public.lock_parcel_owner(v_mail.user_id);
  if p_snapshot is null or jsonb_typeof(p_snapshot)<>'array' or p_items is null or jsonb_typeof(p_items)<>'array' then
    raise exception 'parcel snapshot/items must be complete arrays' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_snapshot) s where s->>'id' is null or s->>'updated_at' is null or jsonb_typeof(s->'item_names') is distinct from 'array')
    or (select count(*) from jsonb_array_elements(p_snapshot)) <> (select count(distinct s->>'id') from jsonb_array_elements(p_snapshot) s) then
    return query select 'retry'::text,null::uuid,null::jsonb; return;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',(s->>'id')::uuid,'updated_at',(s->>'updated_at')::timestamptz,
    'item_names',(select coalesce(jsonb_agg(n order by n collate "C"),'[]'::jsonb) from jsonb_array_elements_text(s->'item_names') n))
    order by (s->>'id')::uuid),'[]'::jsonb) into v_expected from jsonb_array_elements(p_snapshot) s;
  v_current := public.mail_parcel_snapshot(v_mail.user_id);
  if v_current is distinct from v_expected then return query select 'retry'::text,null::uuid,null::jsonb; return; end if;

  select * into v_parcel from public.parcels where id=p_parcel_id and user_id=v_mail.user_id for update;
  if not found or p_expected_updated_at is null or v_parcel.updated_at is distinct from p_expected_updated_at then
    return query select 'retry'::text,null::uuid,null::jsonb; return;
  end if;
  if p_values is null or jsonb_typeof(p_values)<>'object' or (p_category is not null and jsonb_typeof(p_category)<>'object') then
    raise exception 'parcel changes must be objects' using errcode='22023';
  end if;
  v_changes := p_values;
  -- Preserve the person's category exactly as the prior guarded writer does.
  if v_parcel.category_source is distinct from 'user' then v_changes := v_changes || coalesce(p_category,'{}'::jsonb); end if;
  if v_changes <> '{}'::jsonb then
    v_rows := public.mail_run_write(p_email_id,p_run_id,'parcels','update',v_changes,
      jsonb_build_array(jsonb_build_object('method','eq','args',jsonb_build_array('id',p_parcel_id)),
        jsonb_build_object('method','eq','args',jsonb_build_array('updated_at',p_expected_updated_at))));
    if jsonb_typeof(v_rows) is distinct from 'array' or jsonb_array_length(v_rows) <> 1 then raise exception 'parcel update returned no saved row'; end if;
    v_saved := v_rows->0;
    v_expected_row := jsonb_populate_record(null::public.parcels,v_changes);
    if exists(select 1 from jsonb_object_keys(v_changes) k where v_saved->k is distinct from to_jsonb(v_expected_row)->k) then
      raise exception 'parcel update was not stored as requested';
    end if;
  else v_saved := to_jsonb(v_parcel);
  end if;
  select e.verdict into v_verdict from public.ensure_mail_parcel_items(p_parcel_id,(v_saved->>'updated_at')::timestamptz,p_items,p_email_id,p_run_id) e;
  if v_verdict is distinct from 'ok' then raise exception 'parcel first items were not saved'; end if;
  return query select 'ok'::text,p_parcel_id,v_saved;
end $$;
revoke all on function public.update_mail_parcel_without_sample_fence(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid) from public,anon,authenticated,service_role;
drop function if exists public.restore_parcel_receipts(jsonb);
drop function if exists public.mark_parcels_received(uuid[]);
drop table if exists public.parcel_receipt_undos;
drop function if exists public.parcel_receipt_retention();
commit;
