-- Parcel candidate writes are serialized only inside short database transactions.
-- Lock order: owning email row -> this user's 62803 candidate lock -> parcel/items rows.
-- Never acquire a different email/generation lock while holding 62803. A later
-- generation/reset feature must use the same order; auth-user cascades may still
-- deadlock and must surface 40P01 (rollback), never a successful/empty result.
-- No order-number UNIQUE constraint or SQL copy of JavaScript matching rules.
-- Re-runnable. Stop old writers and drain requests before applying/deploying.
begin;
set local lock_timeout='5s';

do $$ begin
  if to_regclass('public.sample_generations') is not null then
    raise exception 'parcel conflicts must be applied before sample generation' using errcode='55000';
  end if;
  if not coalesce(has_table_privilege(current_user,to_regclass('auth.users'),'TRIGGER'),false)
    or current_user is distinct from (select tableowner from pg_tables where schemaname='public' and tablename='emails') then
    raise exception 'parcel conflicts require the application owner and TRIGGER privilege on auth.users' using errcode='55000';
  end if;
  if exists(select 1 from pg_trigger where tgrelid='auth.users'::regclass and tgname='parcel_candidate_owner_delete' and not tgisinternal
    and (tgfoid is distinct from to_regprocedure('public.lock_parcel_candidates()') or tgtype<>11 or tgenabled<>'O' or tgqual is not null or tgnargs<>0)) then
    raise exception 'parcel conflicts: Auth callback changed; review before applying' using errcode='55000';
  end if;
end $$;

create or replace function public.lock_parcel_candidates() returns trigger
language plpgsql security definer set search_path='' as $$
declare
  v_owner uuid;
  v_context text := nullif(current_setting('otodoke.parcel_owner',true),'');
  v_header text := coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-otodoke-sample-user';
begin
  if tg_table_schema='auth' and tg_table_name='users' and tg_op='DELETE' then
    if v_context is not null and v_context is distinct from old.id::text then
      raise exception 'parcel transaction owner cannot change' using errcode='42501';
    end if;
    perform set_config('otodoke.parcel_owner',old.id::text,true);
    perform id from public.emails where user_id=old.id order by id for update;
    perform pg_catalog.pg_advisory_xact_lock(62803,pg_catalog.hashtext(old.id::text));
    return old;
  end if;
  if tg_level='ROW' then
    if v_context is null then raise exception 'parcel write requires an explicit owner scope' using errcode='55000'; end if;
    if (tg_op<>'INSERT' and old.user_id::text is distinct from v_context)
      or (tg_op<>'DELETE' and new.user_id::text is distinct from v_context) then
      raise exception 'parcel row does not match its transaction owner' using errcode='42501';
    end if;
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_op='TRUNCATE' then raise exception 'parcel truncate requires drained maintenance' using errcode='55000'; end if;
  if current_setting('role',true)='authenticated' then
    v_owner := auth.uid();
    if v_header is not null and v_header is distinct from v_owner::text then
      raise exception 'parcel header owner must match authenticated user' using errcode='42501';
    end if;
  else
    if v_context is not null and v_header is not null and v_context is distinct from v_header then
      raise exception 'parcel header and transaction owner differ' using errcode='42501';
    end if;
    v_owner := coalesce(v_context,v_header)::uuid;
  end if;
  if v_owner is null then raise exception 'parcel write requires an explicit owner scope' using errcode='55000'; end if;
  if v_context is not null and v_context is distinct from v_owner::text then
    raise exception 'parcel transaction owner cannot change' using errcode='42501';
  end if;
  perform set_config('otodoke.parcel_owner',v_owner::text,true);
  perform pg_catalog.pg_advisory_xact_lock(62803,pg_catalog.hashtext(v_owner::text));
  return null; -- statement trigger: no row is suppressed or replaced
end $$;
drop trigger if exists parcels_candidate_write_lock on public.parcels;
create trigger parcels_candidate_write_lock before insert or update or delete or truncate on public.parcels
for each statement execute function public.lock_parcel_candidates();
drop trigger if exists parcels_candidate_owner on public.parcels;
create trigger parcels_candidate_owner before insert or update or delete on public.parcels
for each row execute function public.lock_parcel_candidates();
drop trigger if exists parcel_items_candidate_owner on public.parcel_items;
create trigger parcel_items_candidate_owner before insert or update or delete on public.parcel_items
for each row execute function public.lock_parcel_candidates();
create or replace trigger parcel_candidate_owner_delete before delete on auth.users
for each row execute function public.lock_parcel_candidates();
drop trigger if exists parcel_items_candidate_write_lock on public.parcel_items;
create trigger parcel_items_candidate_write_lock before insert or update or delete or truncate on public.parcel_items
for each statement execute function public.lock_parcel_candidates();

-- A scalar JSON value is not cut by PostgREST's row cap. Called under 62803 by
-- creation; names are a multiset because matching uses names, not item ids/counts.
create or replace function public.mail_parcel_snapshot(p_user_id uuid) returns jsonb
language sql security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'updated_at',p.updated_at,'item_names',
    (select coalesce(jsonb_agg(i.name order by i.name collate "C"),'[]'::jsonb)
      from public.parcel_items i where i.parcel_id=p.id and i.user_id=p_user_id)) order by p.id),'[]'::jsonb)
  from public.parcels p where p.user_id=p_user_id;
$$;

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
  if nullif(current_setting('otodoke.parcel_owner',true),'') is not null and exists(
    select 1 from public.emails where id=p_email_id and user_id::text is distinct from current_setting('otodoke.parcel_owner',true)) then
    raise exception 'parcel transaction owner cannot change' using errcode='42501';
  end if;
  select * into v_mail from public.emails where id = p_email_id for update;
  if v_mail.id is null or v_mail.processing_run_id is distinct from p_run_id or p_run_id is null
      or v_mail.processing_status <> 'pending' or v_mail.processing_lease_until is null or v_mail.processing_lease_until <= clock_timestamp() then
    raise exception 'mail run no longer owns the lease' using errcode = '42501';
  end if;
  perform set_config('otodoke.parcel_owner',v_mail.user_id::text,true);
  if p_table in ('parcels','parcel_items') then perform pg_catalog.pg_advisory_xact_lock(62803,pg_catalog.hashtext(v_mail.user_id::text)); end if;
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


create or replace function public.create_mail_parcel(
  p_snapshot jsonb, p_values jsonb, p_items jsonb, p_email_id uuid default null, p_run_id uuid default null
) returns table(verdict text,parcel_id uuid)
language plpgsql security definer set search_path='' as $$
declare
  v_mail public.emails%rowtype;
  v_expected jsonb; v_current jsonb; v_rows jsonb; v_id uuid; v_items jsonb; v_item_count bigint;
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
  perform set_config('otodoke.parcel_owner',v_mail.user_id::text,true);
  perform pg_catalog.pg_advisory_xact_lock(62803,pg_catalog.hashtext(v_mail.user_id::text));
  if p_snapshot is null or jsonb_typeof(p_snapshot)<>'array' or p_items is null or jsonb_typeof(p_items)<>'array' then
    raise exception 'parcel snapshot/items must be complete arrays' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_snapshot) s where s->>'id' is null or s->>'updated_at' is null or jsonb_typeof(s->'item_names') is distinct from 'array')
    or (select count(*) from jsonb_array_elements(p_snapshot)) <> (select count(distinct s->>'id') from jsonb_array_elements(p_snapshot) s) then
    return query select 'retry'::text,null::uuid; return;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',(s->>'id')::uuid,'updated_at',(s->>'updated_at')::timestamptz,
    'item_names',(select coalesce(jsonb_agg(n order by n collate "C"),'[]'::jsonb) from jsonb_array_elements_text(s->'item_names') n))
    order by (s->>'id')::uuid),'[]'::jsonb) into v_expected from jsonb_array_elements(p_snapshot) s;
  v_current := public.mail_parcel_snapshot(v_mail.user_id);
  if v_current is distinct from v_expected then return query select 'retry'::text,null::uuid; return; end if;
  v_rows := public.mail_run_write(p_email_id,p_run_id,'parcels','insert',p_values,'[]');
  if jsonb_typeof(v_rows) is distinct from 'array' or jsonb_array_length(v_rows) <> 1 or v_rows->0->>'id' is null then
    raise exception 'parcel creation returned no saved row';
  end if;
  v_id := (v_rows->0->>'id')::uuid;
  select coalesce(jsonb_agg(i || jsonb_build_object('parcel_id',v_id)),'[]'::jsonb) into v_items from jsonb_array_elements(p_items) i;
  if jsonb_array_length(v_items)>0 then
    v_rows := public.mail_run_write(p_email_id,p_run_id,'parcel_items','insert',v_items,'[]');
    if jsonb_array_length(v_rows) is distinct from jsonb_array_length(p_items) then raise exception 'parcel items were not saved'; end if;
    select count(*) into v_item_count from public.parcel_items i where i.parcel_id=v_id and i.user_id=v_mail.user_id;
    if v_item_count <> jsonb_array_length(p_items) then raise exception 'parcel item readback failed'; end if;
  end if;
  return query select 'ok'::text,v_id;
end $$;

create or replace function public.ensure_mail_parcel_items(
  p_parcel_id uuid, p_expected_updated_at timestamptz, p_items jsonb, p_email_id uuid default null, p_run_id uuid default null
) returns table(verdict text)
language plpgsql security definer set search_path='' as $$
declare
  v_mail public.emails%rowtype; v_parcel public.parcels%rowtype;
  v_items jsonb; v_rows jsonb; v_count bigint;
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
  perform set_config('otodoke.parcel_owner',v_mail.user_id::text,true);
  perform pg_catalog.pg_advisory_xact_lock(62803,pg_catalog.hashtext(v_mail.user_id::text));
  if p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'parcel items must be an array' using errcode='22023'; end if;
  select * into v_parcel from public.parcels where id=p_parcel_id and user_id=v_mail.user_id for update;
  if not found or p_expected_updated_at is null or v_parcel.updated_at is distinct from p_expected_updated_at then
    return query select 'retry'::text; return;
  end if;
  select count(*) into v_count from public.parcel_items where parcel_id=p_parcel_id and user_id=v_mail.user_id;
  if v_count=0 and jsonb_array_length(p_items)>0 then
    select jsonb_agg(i || jsonb_build_object('parcel_id',p_parcel_id)) into v_items from jsonb_array_elements(p_items) i;
    v_rows := public.mail_run_write(p_email_id,p_run_id,'parcel_items','insert',v_items,'[]');
    if jsonb_array_length(v_rows) is distinct from jsonb_array_length(p_items) then raise exception 'parcel items were not saved'; end if;
    select count(*) into v_count from public.parcel_items where parcel_id=p_parcel_id and user_id=v_mail.user_id;
    if v_count <> jsonb_array_length(p_items) then raise exception 'parcel item readback failed'; end if;
  end if;
  return query select 'ok'::text;
end $$;

create or replace function public.update_mail_parcel(
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
  perform set_config('otodoke.parcel_owner',v_mail.user_id::text,true);
  perform pg_catalog.pg_advisory_xact_lock(62803,pg_catalog.hashtext(v_mail.user_id::text));
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

revoke all on function public.lock_parcel_candidates(), public.mail_parcel_snapshot(uuid),
  public.create_mail_parcel(jsonb,jsonb,jsonb,uuid,uuid), public.update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid), public.ensure_mail_parcel_items(uuid,timestamptz,jsonb,uuid,uuid) from public,anon,authenticated;
grant execute on function public.lock_parcel_candidates(), public.mail_parcel_snapshot(uuid),
  public.create_mail_parcel(jsonb,jsonb,jsonb,uuid,uuid), public.update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid), public.ensure_mail_parcel_items(uuid,timestamptz,jsonb,uuid,uuid) to service_role;
commit;
