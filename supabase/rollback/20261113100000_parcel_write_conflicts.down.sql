-- Stop/drain writers and deploy the prior matching app before rollback.
-- Removing these guards restores the former creation/update races. No data is merged/deleted.
begin;
set local lock_timeout='5s';
drop trigger if exists parcels_candidate_write_lock on public.parcels;
drop trigger if exists parcel_items_candidate_write_lock on public.parcel_items;
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
