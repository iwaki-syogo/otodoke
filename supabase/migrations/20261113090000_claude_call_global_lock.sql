-- Serialize paid-call claims by JST day, and fence mail storage and processing.
-- Apply only after the matching .before.sql verdict is OK. Re-runnable.
-- Every owned mail mutation locks the email row before checking its run and lease.
begin;
set local lock_timeout = '5s';

create or replace function public.claim_claude_call(p_user_id uuid, p_user_limit integer, p_global_limit integer)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_calls integer;
  v_before integer;
begin
  if p_user_id is null or p_user_limit is null or p_global_limit is null then
    raise exception 'claim_claude_call: missing argument' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(62801, v_day - date '2000-01-01');
  select coalesce(calls, 0) into v_calls from public.claude_usage_daily where user_id = p_user_id and day = v_day;
  if coalesce(v_calls, 0) >= p_user_limit then return 'user_limit'; end if;
  if (select coalesce(sum(calls), 0) from public.claude_usage_daily where day = v_day) >= p_global_limit then
    return 'global_limit';
  end if;
  v_before := coalesce(v_calls, 0);
  insert into public.claude_usage_daily as u (user_id, day, calls) values (p_user_id, v_day, 1)
    on conflict (user_id, day) do update set calls = u.calls + 1 returning calls into v_calls;
  if v_calls is distinct from v_before + 1 then raise exception 'claim counter did not change as requested'; end if;
  return 'ok';
end $$;

create or replace function public.claim_claude_call_v2(p_user_id uuid, p_user_limit integer, p_global_limit integer)
returns table (verdict text, claim_id bigint)
language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_verdict text;
  v_id bigint;
begin
  -- The v1 function owns the common day lock and both limit checks. Its xact lock
  -- remains held until this function's ledger insert and the transaction finish.
  v_verdict := public.claim_claude_call(p_user_id, p_user_limit, p_global_limit);
  if v_verdict <> 'ok' then return query select v_verdict, null::bigint; return; end if;
  insert into public.claude_call_claims(user_id, day) values (p_user_id, v_day) returning id into v_id;
  if v_id is null then raise exception 'claim was not recorded'; end if;
  -- Prune only released/expired ledger rows without waiting on a different day.
  delete from public.claude_call_claims where id in (
    select id from public.claude_call_claims where day < v_day - 1 order by id limit 500 for update skip locked
  );
  return query select 'ok'::text, v_id;
end $$;

create or replace function public.release_claude_call(p_claim_id bigint, p_user_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_day date;
  v_before integer;
  v_after integer;
  v_released timestamptz;
begin
  if p_claim_id is null or p_user_id is null then
    raise exception 'release_claude_call: expected a claim id and a user' using errcode = '22023';
  end if;
  -- Read the immutable day without a row lock, then acquire day -> claim -> usage,
  -- the same order as claims. Two concurrent releases still decrement only once.
  select day into v_day from public.claude_call_claims where id = p_claim_id and user_id = p_user_id;
  if not found then return 0; end if;
  perform pg_catalog.pg_advisory_xact_lock(62801, v_day - date '2000-01-01');
  update public.claude_call_claims set released_at = now()
    where id = p_claim_id and user_id = p_user_id and day = v_day and released_at is null returning released_at into v_released;
  if not found then return 0; end if;
  if v_released is null then raise exception 'release was not recorded as requested'; end if;
  select calls into v_before from public.claude_usage_daily where user_id = p_user_id and day = v_day for update;
  if coalesce(v_before, 0) <= 0 then return 0; end if;
  update public.claude_usage_daily set calls = calls - 1 where user_id = p_user_id and day = v_day returning calls into v_after;
  if v_after is distinct from v_before - 1 then raise exception 'release did not change the count as requested'; end if;
  return 1;
end $$;

alter table public.emails add column if not exists processing_run_id uuid;
alter table public.emails add column if not exists processing_lease_until timestamptz;
create index if not exists emails_unread_storage_idx on public.emails(user_id) where body_state = 'plain' and processing_status <> 'processed';

-- One fixed-size notice per account, never one row per rejected delivery. No mail
-- subject, body, sender or provider identifier is retained after quota rejection.
create table if not exists public.mail_intake_notices (
  user_id uuid primary key references auth.users(id) on delete cascade,
  limited_at timestamptz not null default now(),
  reason text not null check (reason in ('user_storage_limit', 'global_storage_limit'))
);
alter table public.mail_intake_notices enable row level security;
revoke all on public.mail_intake_notices from public, anon, authenticated;
grant select, delete on public.mail_intake_notices to authenticated;
grant all on public.mail_intake_notices to service_role;
drop policy if exists "own intake notice" on public.mail_intake_notices;
create policy "own intake notice" on public.mail_intake_notices for select to authenticated using (user_id = auth.uid());
drop policy if exists "dismiss own intake notice" on public.mail_intake_notices;
create policy "dismiss own intake notice" on public.mail_intake_notices for delete to authenticated using (user_id = auth.uid());

-- Store/take over a mail and reserve its actual unread storage in one transaction.
-- Limits are server configuration, not caller-supplied values from a user session.
create or replace function public.store_mail_run(
  p_user_id uuid, p_email_id uuid, p_run_id uuid, p_columns jsonb,
  p_expected_created_at timestamptz, p_limits jsonb
) returns table (verdict text, email_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  v_old public.emails%rowtype;
  v_row public.emails%rowtype;
  v_expected public.emails%rowtype;
  v_seen_id uuid;
  v_seen_status text;
  v_now timestamptz := clock_timestamp();
  v_exists boolean;
  v_user_count bigint; v_global_count bigint;
  v_user_bytes bigint; v_global_bytes bigint; v_bytes bigint;
  v_reason text;
begin
  if p_user_id is null or p_email_id is null or p_run_id is null or jsonb_typeof(p_columns) <> 'object' then
    raise exception 'store_mail_run: missing argument' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_object_keys(p_columns) k where k not in (
    'provider_email_id','message_id','from_address','from_name','subject','sent_at','text_body','html_body',
    'from_domain','classification','processing_status','error','forwarding_confirm_url','body_state','body_envelope'
  )) then raise exception 'store_mail_run: unsupported column' using errcode = '22023'; end if;
  if p_limits is null or exists (select 1 from unnest(array['user_count','global_count','user_bytes','global_bytes']) k
    where coalesce((p_limits->>k)::bigint, 0) <= 0) then
    raise exception 'store_mail_run: invalid storage limits' using errcode = '22023';
  end if;
  -- All intake transactions share this lock, including brand-new users/rows.
  perform pg_catalog.pg_advisory_xact_lock(62802, 0);
  select * into v_old from public.emails where id = p_email_id and user_id = p_user_id for update;
  v_exists := found;
  v_now := clock_timestamp();
  if v_exists then
    if v_old.processing_status = 'processed' then return query select 'duplicate'::text, p_email_id; return; end if;
    if v_old.processing_status = 'pending' and coalesce(v_old.processing_lease_until, v_old.created_at + interval '180 seconds') > v_now then
      return query select 'busy'::text, p_email_id; return;
    end if;
    if v_old.created_at is distinct from p_expected_created_at then return query select 'busy'::text, p_email_id; return; end if;
  elsif p_expected_created_at is not null then
    return query select 'busy'::text, p_email_id; return;
  end if;
  if not v_exists and p_columns->>'provider_email_id' is not null then
    select id,processing_status into v_seen_id,v_seen_status from public.emails
      where user_id=p_user_id and provider_email_id=p_columns->>'provider_email_id' limit 1;
    if found then
      return query select case when v_seen_status='processed' then 'duplicate' else 'busy' end,v_seen_id;
      return;
    end if;
  end if;
  v_row := jsonb_populate_record(null::public.emails, p_columns);
  -- A re-read keeps its exact stored body; it is not a second incoming delivery.
  -- The caller has read these columns already and the version check above fences them.
  v_bytes := octet_length(coalesce(v_row.subject,'')) + octet_length(coalesce(v_row.from_address,''))
    + octet_length(coalesce(v_row.from_name,'')) + octet_length(coalesce(v_row.text_body,'')) + octet_length(coalesce(v_row.html_body,''));
  select count(*), coalesce(sum(octet_length(coalesce(subject,'')) + octet_length(coalesce(from_address,''))
    + octet_length(coalesce(from_name,'')) + octet_length(coalesce(text_body,'')) + octet_length(coalesce(html_body,''))),0),
    count(*) filter (where user_id = p_user_id), coalesce(sum(octet_length(coalesce(subject,'')) + octet_length(coalesce(from_address,''))
    + octet_length(coalesce(from_name,'')) + octet_length(coalesce(text_body,'')) + octet_length(coalesce(html_body,''))) filter (where user_id = p_user_id),0)
    into v_global_count, v_global_bytes, v_user_count, v_user_bytes
    from public.emails where body_state = 'plain' and processing_status <> 'processed' and id <> p_email_id;
  -- Existing rows may predate a lowered ceiling. Re-reading the same body is an
  -- exit, not a fresh allocation; larger replacements still need room.
  if coalesce(v_row.processing_status,'pending') <> 'processed' and coalesce(v_row.body_state,'plain') = 'plain' and (not v_exists or v_bytes > octet_length(coalesce(v_old.subject,'')) + octet_length(coalesce(v_old.from_address,''))
      + octet_length(coalesce(v_old.from_name,'')) + octet_length(coalesce(v_old.text_body,'')) + octet_length(coalesce(v_old.html_body,''))) then
    if v_user_count + 1 > (p_limits->>'user_count')::bigint or v_user_bytes + v_bytes > (p_limits->>'user_bytes')::bigint then v_reason := 'user_storage_limit';
    elsif v_global_count + 1 > (p_limits->>'global_count')::bigint or v_global_bytes + v_bytes > (p_limits->>'global_bytes')::bigint then v_reason := 'global_storage_limit'; end if;
  end if;
  if v_reason is not null then
    insert into public.mail_intake_notices(user_id, reason, limited_at) values (p_user_id, v_reason, v_now)
      on conflict (user_id) do update set reason = excluded.reason, limited_at = excluded.limited_at;
    return query select v_reason, p_email_id; return;
  end if;
  if v_exists then
    update public.emails set provider_email_id = v_row.provider_email_id, message_id = v_row.message_id,
      from_address = v_row.from_address, from_name = v_row.from_name, subject = v_row.subject, sent_at = v_row.sent_at,
      text_body = v_row.text_body, html_body = v_row.html_body, from_domain = v_row.from_domain,
      classification = v_row.classification, processing_status = v_row.processing_status, error = null,
      forwarding_confirm_url = v_row.forwarding_confirm_url, body_state = coalesce(v_row.body_state,'plain'), body_envelope = v_row.body_envelope,
      created_at = v_now, processing_run_id = p_run_id, processing_lease_until = v_now + interval '360 seconds'
      where id = p_email_id and user_id = p_user_id;
  else
    insert into public.emails(id,user_id,provider_email_id,message_id,from_address,from_name,subject,sent_at,text_body,html_body,from_domain,
      classification,processing_status,error,forwarding_confirm_url,body_state,body_envelope,created_at,processing_run_id,processing_lease_until)
    values (p_email_id,p_user_id,v_row.provider_email_id,v_row.message_id,v_row.from_address,v_row.from_name,v_row.subject,v_row.sent_at,
      v_row.text_body,v_row.html_body,v_row.from_domain,v_row.classification,v_row.processing_status,null,v_row.forwarding_confirm_url,
      coalesce(v_row.body_state,'plain'),v_row.body_envelope,v_now,p_run_id,v_now + interval '360 seconds');
  end if;
  v_expected := v_row;
  select * into v_row from public.emails where id = p_email_id;
  if row(v_row.processing_run_id,v_row.processing_lease_until,v_row.created_at,v_row.processing_status,
      v_row.subject,v_row.from_address,v_row.from_name,v_row.text_body,v_row.html_body,v_row.body_state,v_row.body_envelope)
    is distinct from row(p_run_id,v_now+interval '360 seconds',v_now,v_expected.processing_status,
      v_expected.subject,v_expected.from_address,v_expected.from_name,v_expected.text_body,v_expected.html_body,coalesce(v_expected.body_state,'plain'),v_expected.body_envelope) then
    raise exception 'store_mail_run: mail was not stored as requested';
  end if;
  return query select 'ok'::text, p_email_id;
exception when unique_violation then
  -- The Message-ID won a concurrent insert; the other run owns it.
  return query select 'busy'::text, p_email_id;
end $$;

-- A narrow service-only mutation gateway. The server's existing parcel rules
-- remain in TypeScript. Each mutation checks the lease under the same email row
-- lock as takeover, preventing a delayed old run from modifying any parcel data.
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

revoke all on function public.claim_claude_call(uuid,integer,integer), public.claim_claude_call_v2(uuid,integer,integer), public.release_claude_call(bigint,uuid),
  public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb), public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb) from public, anon, authenticated;
grant execute on function public.claim_claude_call(uuid,integer,integer), public.claim_claude_call_v2(uuid,integer,integer), public.release_claude_call(bigint,uuid),
  public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb), public.mail_run_write(uuid,uuid,text,text,jsonb,jsonb) to service_role;
commit;
