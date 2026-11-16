-- Plan A (an older mail must not move a status the person decided): the time a person last changed a
-- parcel's status, and the mail gateway's permission to write it.
--
-- 1. public.parcels.status_set_by_person_at (null = the person never decided it; existing rows stay null,
--    so they behave exactly as before).
-- 2. BEFORE INSERT OR UPDATE trigger parcels_status_set_by_person. For the signed-in role (current_user =
--    'authenticated', what PostgREST uses for the Web and iOS) an UPDATE that changes status stamps now();
--    any other UPDATE keeps the old value; an INSERT stores null. Whatever value such a client sends for the
--    column is ignored, so a person cannot write it directly (authenticated has a table-wide UPDATE grant,
--    so the trigger is what closes the column). It always returns NEW: returning OLD from a BEFORE UPDATE
--    trigger silently discards the whole write.
--    Not stamped, on purpose: INSERT (a typed-in parcel's first choice yields to a real mail), service_role
--    mail writes (update_mail_parcel, mail_run_write) and the security definer functions
--    mark_parcels_received / restore_parcel_receipts (current_user is their owner, not authenticated; a
--    receipt is already protected by received_at and its receipt journal).
-- 3. mail_run_write_without_sample_fence (the body the public mail_run_write wraps; renamed there by
--    20261113110000) is replaced by its 20261113100000 text with ONE change: 'status_set_by_person_at' joins
--    the parcels column allowlist, so the twin merge can carry the time. Owner and ACL are kept.
--
-- Before:   supabase/verify/20261117120000_parcel_status_set_by_person.before.sql
-- After:    supabase/verify/20261117120000_parcel_status_set_by_person.sql
-- Rollback: supabase/rollback/20261117120000_parcel_status_set_by_person.down.sql
-- Applied only with the owner's YES (it sits in supabase/migrations/ with the other unapplied files until then).

begin;

do $$
declare v_src text;
begin
  select prosrc into v_src from pg_proc where oid = to_regprocedure('public.mail_run_write_without_sample_fence(uuid,uuid,text,text,jsonb,jsonb)');
  if v_src is null or to_regclass('public.parcels') is null
    or not exists (select 1 from pg_proc where oid = to_regprocedure('public.mail_run_write_without_sample_fence(uuid,uuid,text,text,jsonb,jsonb)')
                   and prosecdef and proconfig is not distinct from array['search_path=""'])
    or (position($q$'check_dismissed_at','received_at']$q$ in v_src) = 0 and position($q$'received_at','status_set_by_person_at']$q$ in v_src) = 0) then
    raise exception 'parcel status set by person: mail_run_write_without_sample_fence is not the 20261113100000 body; review before applying' using errcode = '55000';
  end if;
end $$;

alter table public.parcels add column if not exists status_set_by_person_at timestamptz;

create or replace function public.parcels_status_set_by_person()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user is distinct from 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.status_set_by_person_at := null;
  elsif new.status is distinct from old.status then
    new.status_set_by_person_at := now();
  else
    new.status_set_by_person_at := old.status_set_by_person_at;
  end if;
  return new;
end $$;

drop trigger if exists parcels_status_set_by_person on public.parcels;
create trigger parcels_status_set_by_person before insert or update on public.parcels
  for each row execute function public.parcels_status_set_by_person();

create or replace function public.mail_run_write_without_sample_fence(
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
  if p_table in ('parcels','parcel_items') then perform public.lock_parcel_owner(v_mail.user_id);
  else perform set_config('otodoke.parcel_owner',v_mail.user_id::text,true); end if;
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
      'needs_review','last_email_at','category','category_source','source','check_dismissed_at','received_at','status_set_by_person_at'];
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
