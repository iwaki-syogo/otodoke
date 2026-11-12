-- Stop/drain writers and deploy the prior matching app before rollback.
-- Removing these guards restores the former creation/update races. No data is merged/deleted.
begin;
set local lock_timeout='5s';
do $$
declare v_count integer; x record;
begin
  if to_regclass('public.sample_generations') is not null then
    raise exception 'parcel rollback requires sample generation rollback first' using errcode='55000';
  end if;
  if exists(select 1 from pg_trigger where tgrelid='auth.users'::regclass and tgname='parcel_candidate_owner_delete' and not tgisinternal)
    and not ((select rolsuper from pg_roles where rolname=current_user)
      or pg_has_role(current_user,(select relowner from pg_class where oid='auth.users'::regclass),'USAGE')) then
    raise exception 'parcel rollback requires the auth.users owner to remove its callback' using errcode='55000';
  end if;
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('lock_parcel_candidates','mail_parcel_snapshot','create_mail_parcel','update_mail_parcel','ensure_mail_parcel_items');
  if v_count not in (0,5) then raise exception 'parcel rollback: partial parcel gateways' using errcode='55000'; end if;
  if v_count=5 then
    for x in select * from (values
      ('lock_parcel_candidates()','e9aef24709226d459d89eac8d85e2464'),
      ('mail_parcel_snapshot(uuid)','93b25c57e72edd8476fa87b9276daaca'),
      ('create_mail_parcel(jsonb,jsonb,jsonb,uuid,uuid)','ab89b9744cb0d227c817be76e6ea354d'),
      ('update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)','4c13f09288c69d8492563b176948efba'),
      ('ensure_mail_parcel_items(uuid,timestamptz,jsonb,uuid,uuid)','3257efac3e652297308d7e2d45ef481a'),
      ('mail_run_write(uuid,uuid,text,text,jsonb,jsonb)','3757d8a83849ed61c14ebfc75ae4685d')
    ) m(signature,body_hash) loop
      if not exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.'||x.signature)
        and md5(p.prosrc)=x.body_hash and p.prosecdef and p.proconfig=array['search_path=""']
        and p.proowner=(select relowner from pg_class where oid='public.emails'::regclass)
        and (select count(*)=2 and bool_and(a.grantor=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable
          and a.grantee in (p.proowner,'service_role'::regrole::oid)) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) then
        raise exception 'parcel rollback: gateway changed; review its rollback: %',x.signature using errcode='55000';
      end if;
    end loop;
    if not exists(select 1 from pg_trigger where tgrelid='auth.users'::regclass and tgname='parcel_candidate_owner_delete'
      and tgtype=11 and tgenabled='O' and tgfoid=to_regprocedure('public.lock_parcel_candidates()') and tgqual is null and tgnargs=0 and not tgisinternal)
      or (select count(*) from pg_trigger where tgname in ('parcels_candidate_owner','parcel_items_candidate_owner')
        and tgtype=31 and tgenabled='O' and tgfoid=to_regprocedure('public.lock_parcel_candidates()') and tgqual is null and tgattr=''::int2vector and tgnargs=0 and not tgisinternal
        and tgrelid=case tgname when 'parcels_candidate_owner' then 'public.parcels'::regclass else 'public.parcel_items'::regclass end)<>2 then
      raise exception 'parcel rollback: owner callbacks changed' using errcode='55000';
    end if;
    if (select count(*) from pg_trigger where tgname in ('parcels_candidate_write_lock','parcel_items_candidate_write_lock')
      and tgtype=62 and tgenabled='O' and tgfoid=to_regprocedure('public.lock_parcel_candidates()') and tgqual is null and tgattr=''::int2vector and tgnargs=0 and not tgisinternal
      and tgrelid=case tgname when 'parcels_candidate_write_lock' then 'public.parcels'::regclass else 'public.parcel_items'::regclass end)<>2 then
      raise exception 'parcel rollback: statement callbacks changed' using errcode='55000';
    end if;
  elsif exists(select 1 from pg_trigger where tgname in ('parcel_candidate_owner_delete','parcels_candidate_owner','parcel_items_candidate_owner','parcels_candidate_write_lock','parcel_items_candidate_write_lock') and not tgisinternal) then
    raise exception 'parcel rollback: partial rolled-back callbacks' using errcode='55000';
  elsif not exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb)')
    and md5(p.prosrc)='09f1ab05ad5ccac3c31a8f5512dc9c0c'
    and p.proargnames=array['p_email_id','p_run_id','p_table','p_operation','p_values','p_filters']
    and pg_get_function_result(p.oid)='jsonb' and p.pronargdefaults=0
    and p.prosecdef and p.proconfig=array['search_path=""']
    and p.proowner=(select relowner from pg_class where oid='public.emails'::regclass)
    and (select count(*)=2 and bool_and(a.grantor=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable
      and a.grantee in (p.proowner,'service_role'::regrole::oid)) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)) then
    raise exception 'parcel rollback: expected restored cost gateway is missing or changed' using errcode='55000';
  end if;
end $$;
drop trigger if exists parcel_candidate_owner_delete on auth.users;
drop trigger if exists parcels_candidate_write_lock on public.parcels;
drop trigger if exists parcel_items_candidate_write_lock on public.parcel_items;
drop trigger if exists parcels_candidate_owner on public.parcels;
drop trigger if exists parcel_items_candidate_owner on public.parcel_items;
drop function if exists public.update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid);
drop function if exists public.create_mail_parcel(jsonb,jsonb,jsonb,uuid,uuid);
drop function if exists public.ensure_mail_parcel_items(uuid,timestamptz,jsonb,uuid,uuid);
drop function if exists public.mail_parcel_snapshot(uuid);
drop function if exists public.lock_parcel_candidates();
create or replace function public.mail_run_write(
  p_email_id uuid, p_run_id uuid, p_table text, p_operation text, p_values jsonb, p_filters jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_mail public.emails%rowtype;
  v_allow text[];
  v_keys text[];
  v_columns text; v_selected text; v_set text;
  v_where text; v_filter jsonb; v_method text; v_args jsonb;
  v_key text; v_item jsonb; v_rows jsonb := '[]'; v_result jsonb;
begin
  select * into v_mail from public.emails where id = p_email_id for update;
  if not found or v_mail.processing_run_id is distinct from p_run_id or p_run_id is null
      or v_mail.processing_status <> 'pending' or v_mail.processing_lease_until is null or v_mail.processing_lease_until <= clock_timestamp() then
    raise exception 'mail run no longer owns the lease' using errcode = '42501';
  end if;
  if p_operation = 'claim' then
    if p_table = 'claim_claude_call_v2' then
      select jsonb_agg(to_jsonb(c)) into v_rows from public.claim_claude_call_v2(v_mail.user_id,(p_values->>'p_user_limit')::integer,(p_values->>'p_global_limit')::integer) c;
      return v_rows;
    elsif p_table = 'claim_claude_call' then
      return to_jsonb(public.claim_claude_call(v_mail.user_id,(p_values->>'p_user_limit')::integer,(p_values->>'p_global_limit')::integer));
    end if;
    raise exception 'unsupported owned claim' using errcode = '22023';
  end if;
  if p_operation is null or p_operation not in ('insert','update','delete') then raise exception 'unsupported mail operation' using errcode = '22023'; end if;
  case p_table
    when 'emails' then
      if p_operation = 'insert' then raise exception 'store mail through store_mail_run'; end if;
      v_allow := array['classification','processing_status','error','subject','from_name','from_address','text_body','html_body','body_state','body_envelope','forwarding_confirm_url'];
    when 'extractions' then v_allow := array['user_id','email_id','parcel_id','model','result','confidence'];
    when 'parcel_items' then v_allow := array['user_id','parcel_id','name','quantity','unit_price','evidence'];
    when 'parcels' then v_allow := array['user_id','shop','shop_key','order_number','title','status','ordered_at','expected_date','expected_date_end','expected_text',
      'expected_window_start','expected_window_end','carrier','tracking_number','tracking_url','requires_presence','presence_evidence','total_amount',
      'needs_review','last_email_at','category','category_source','source','check_dismissed_at','received_at'];
    else raise exception 'unsupported mail table' using errcode = '22023';
  end case;
  v_where := format('t.user_id = %L::uuid', v_mail.user_id);
  if p_table = 'emails' then v_where := v_where || format(' and t.id = %L::uuid', p_email_id); end if;
  for v_filter in select * from jsonb_array_elements(coalesce(p_filters,'[]')) loop
    v_method := v_filter->>'method'; v_args := v_filter->'args'; v_key := v_args->>0;
    if v_method = 'or' then
      if v_key = 'source.neq.manual,total_amount.is.null' and p_table = 'parcels' then
        v_where := v_where || ' and (t.source <> ''manual'' or t.total_amount is null)';
      elsif v_key = 'category_source.is.null,category_source.neq.user' and p_table = 'parcels' then
        v_where := v_where || ' and (t.category_source is null or t.category_source <> ''user'')';
      else raise exception 'unsupported mail or filter' using errcode = '22023'; end if;
    elsif v_method = 'eq' and v_key in ('id','user_id','email_id','parcel_id','updated_at','created_at','processing_status') then
      v_where := v_where || format(' and t.%I = (jsonb_populate_record(null::public.%I,%L::jsonb)).%I', v_key,p_table,jsonb_build_object(v_key,v_args->1)::text,v_key);
    elsif v_method = 'in' and v_key in ('id','email_id','parcel_id') and jsonb_typeof(v_args->1) = 'array' then
      v_where := v_where || format(' and to_jsonb(t)->%L in (select value from jsonb_array_elements(%L::jsonb))', v_key, (v_args->1)::text);
    else raise exception 'unsupported mail filter' using errcode = '22023'; end if;
  end loop;
  if p_operation = 'delete' then
    execute format('with changed as (delete from public.%I t where %s returning t.*) select coalesce(jsonb_agg(to_jsonb(changed)),''[]''::jsonb) from changed', p_table,v_where) into v_rows;
    return v_rows;
  end if;
  for v_item in select * from jsonb_array_elements(case when jsonb_typeof(p_values) = 'array' then p_values else jsonb_build_array(p_values) end) loop
    if jsonb_typeof(v_item) <> 'object' then raise exception 'mail values must be objects'; end if;
    if exists (select 1 from jsonb_object_keys(v_item) k where not k = any(v_allow)) then raise exception 'unsupported mail column' using errcode = '22023'; end if;
    if v_item ? 'user_id' and (v_item->>'user_id')::uuid is distinct from v_mail.user_id then raise exception 'mail user mismatch' using errcode = '42501'; end if;
    if p_table = 'extractions' and v_item ? 'email_id' and (v_item->>'email_id')::uuid is distinct from p_email_id then raise exception 'mail id mismatch' using errcode = '42501'; end if;
    if p_operation = 'insert' then v_item := v_item || jsonb_build_object('user_id',v_mail.user_id); end if;
    select array_agg(k order by k) into v_keys from jsonb_object_keys(v_item) k;
    select string_agg(format('%I', k),','), string_agg(format('r.%I', k),','), string_agg(format('%I = r.%I',k,k),',')
      into v_columns,v_selected,v_set from unnest(v_keys) k;
    if p_operation = 'insert' then
      execute format('with changed as (insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I,$1) r returning *) select coalesce(jsonb_agg(to_jsonb(changed)),''[]''::jsonb) from changed',p_table,v_columns,v_selected,p_table) into v_result using v_item;
    else
      execute format('with changed as (update public.%I t set %s from jsonb_populate_record(null::public.%I,$1) r where %s returning t.*) select coalesce(jsonb_agg(to_jsonb(changed)),''[]''::jsonb) from changed',p_table,v_set,p_table,v_where) into v_result using v_item;
    end if;
    v_rows := v_rows || v_result;
  end loop;
  return v_rows;
end $$;

commit;
