-- Receipt undo is bound to the database state before/after this press, never stale UI props.
-- Lock order: auth owner U -> generation G -> sorted emails E -> consent C (skipped here) -> candidate L -> parcels R -> receipt.
-- Requires actually applied 110000, consent storage 120000 and consent claim 121000.
-- Provisional candidate-lock seams await P1; this migration is not release-ready until integrated.
begin;
set local lock_timeout='5s';
do $$
declare v_applied integer;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null
    or not exists(select 1 from pg_attribute where attrelid=to_regclass('supabase_migrations.schema_migrations') and attname='version' and not attisdropped) then
    raise exception 'receipt prerequisites require actual migration history' using errcode='55000';
  end if;
  execute $history$select count(distinct version::text) from supabase_migrations.schema_migrations
    where version::text in ('20261113110000','20261113120000','20261113121000')$history$ into v_applied;
  if v_applied<>3 or not (
    to_regprocedure('public.lock_sample_owner(uuid)') is not null
    and to_regprocedure('public.update_mail_parcel_without_sample_fence(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)') is not null
    and to_regprocedure('public.ai_consent_waiting_retention()') is not null
    and to_regprocedure('public.purge_expired_consent_waiting_mail()') is not null
    and to_regprocedure('public.set_ai_reading_before_consent_storage(text,text)') is not null
    and to_regprocedure('public.assert_claude_claim_consent(uuid)') is not null
    and to_regprocedure('public.purge_old_screen_events()') is not null
    and exists(select 1 from pg_attribute where attrelid=to_regclass('public.emails') and attname='consent_waiting_until' and not attisdropped)
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.claim_claude_call(uuid,integer,integer)') and prosrc like '%public.assert_claude_claim_consent(p_user_id)%')
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.claim_claude_call_v2(uuid,integer,integer)') and prosrc like '%public.assert_claude_claim_consent(p_user_id)%')
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.set_ai_reading(text,text)')
      and prosrc like '%perform public.lock_sample_owner(v_user);%perform id from public.emails where user_id=v_user order by id for update;%public.set_ai_reading_before_consent_storage(p_decision,p_text_version)%')
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.update_mail_parcel(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid)')
      and prosrc like '%perform public.lock_sample_owner(v_user_id);%public.update_mail_parcel_without_sample_fence(%')
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.lock_sample_owner(uuid)')
      and prosrc like '%from auth.users where id=p_user_id for key share;%from public.sample_generations where user_id = p_user_id for update;%')
    and exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events()')
      and (prosrc like '%public.purge_expired_consent_waiting_mail()%'
        or (prosrc like '%public.purge_old_screen_events_before_receipt_retention()%'
          and exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events_before_receipt_retention()')
            and prosrc like '%public.purge_expired_consent_waiting_mail()%'))))
  ) then
    raise exception 'received receipts require applied 110000, consent 120000 and consent claim 121000 prerequisites' using errcode='55000';
  end if;
end $$;

create table if not exists public.parcel_receipt_undos (
  parcel_id uuid primary key references public.parcels(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  receipt_id uuid not null unique,
  previous_status text not null,
  previous_received_at timestamptz,
  written_received_at timestamptz not null,
  written_updated_at timestamptz not null,
  undone_at timestamptz,
  undone_updated_at timestamptz,
  created_at timestamptz not null,
  expires_at timestamptz not null
);
create index if not exists parcel_receipt_undos_user_id_idx on public.parcel_receipt_undos(user_id);
create index if not exists parcel_receipt_undos_expiry_idx on public.parcel_receipt_undos(expires_at);
alter table public.parcel_receipt_undos enable row level security;
revoke all on public.parcel_receipt_undos from public,anon,authenticated,service_role;

-- Single behavioral retention constant. Neither already-received nor undo/replay extends it.
create or replace function public.parcel_receipt_retention() returns interval
language sql immutable set search_path='' as $$ select interval '24 hours'; $$;
revoke all on function public.parcel_receipt_retention() from public,anon,authenticated,service_role;

create or replace function public.mark_parcels_received(p_ids uuid[])
returns table(id uuid,outcome text,receipt_id uuid,received_at timestamptz,updated_at timestamptz,previous_status text,previous_received_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid; v_id uuid; v_before public.parcels%rowtype; v_after public.parcels%rowtype;
  v_receipt public.parcel_receipt_undos%rowtype; v_token uuid; v_now timestamptz; v_expires timestamptz;
begin
  -- Bound the raw body before owner/generation/email/advisory locks or deduplication.
  if p_ids is null or cardinality(p_ids)>200 or (cardinality(p_ids)>0 and array_ndims(p_ids)<>1) then
    raise exception 'receipt request must contain at most 200 ids' using errcode='22023';
  end if;
  if cardinality(p_ids)=0 then return; end if;
  if array_position(p_ids,null) is not null then raise exception 'null receipt id' using errcode='22023'; end if;
  v_user := auth.uid();
  if v_user is null then raise exception 'signed in owner required' using errcode='42501'; end if;
  perform public.lock_sample_owner(v_user);
  perform e.id from public.emails e where e.user_id=v_user order by e.id for update;
  -- P1_OWNER_LOCK_SEAM: owner=v_user; provisional fixed key, replace with the shared owner helper before release.
  perform pg_catalog.pg_advisory_xact_lock(62803,0);
  perform p.id from public.parcels p where p.user_id=v_user and p.id=any(p_ids) order by p.id for update;
  for v_id in select distinct x from unnest(p_ids) x order by x loop
    select p.* into v_before from public.parcels p where p.id=v_id and p.user_id=v_user;
    if not found or v_before.status='cancelled' or (v_before.received_at is not null and not isfinite(v_before.received_at)) then
      return query select v_id,'changed'::text,null::uuid,null::timestamptz,null::timestamptz,null::text,null::timestamptz;
      continue;
    end if;
    if v_before.received_at is not null then
      return query select v_id,'already_received'::text,null::uuid,null::timestamptz,null::timestamptz,null::text,null::timestamptz;
      continue;
    end if;
    v_now := clock_timestamp(); v_expires := v_now + public.parcel_receipt_retention(); v_token := gen_random_uuid();
    update public.parcels p set status='delivered',received_at=v_now
      where p.id=v_id and p.user_id=v_user and p.updated_at=v_before.updated_at returning p.* into v_after;
    if not found or v_after.status is distinct from 'delivered' or v_after.received_at is distinct from v_now or v_after.updated_at is null then
      raise exception 'received parcel was not stored as requested' using errcode='42501';
    end if;
    insert into public.parcel_receipt_undos as j(parcel_id,user_id,receipt_id,previous_status,previous_received_at,written_received_at,written_updated_at,created_at,expires_at)
      values(v_id,v_user,v_token,v_before.status,v_before.received_at,v_after.received_at,v_after.updated_at,v_now,v_expires)
      on conflict(parcel_id) do update set user_id=excluded.user_id,receipt_id=excluded.receipt_id,
        previous_status=excluded.previous_status,previous_received_at=excluded.previous_received_at,
        written_received_at=excluded.written_received_at,written_updated_at=excluded.written_updated_at,
        undone_at=null,undone_updated_at=null,created_at=excluded.created_at,expires_at=excluded.expires_at
      returning j.* into v_receipt;
    if v_receipt.receipt_id is distinct from v_token or v_receipt.user_id is distinct from v_user
      or v_receipt.previous_status is distinct from v_before.status or v_receipt.previous_received_at is distinct from v_before.received_at
      or v_receipt.written_received_at is distinct from v_after.received_at or v_receipt.written_updated_at is distinct from v_after.updated_at
      or v_receipt.undone_at is not null or v_receipt.undone_updated_at is not null
      or v_receipt.created_at is distinct from v_now or v_receipt.expires_at is distinct from v_expires then
      raise exception 'receipt journal was not stored as requested' using errcode='42501';
    end if;
    return query select v_id,'written'::text,v_token,v_after.received_at,v_after.updated_at,v_before.status,v_before.received_at;
  end loop;
end $$;

create or replace function public.restore_parcel_receipts(p_receipts jsonb)
returns table(id uuid,outcome text)
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid; v_key record; v_parcel public.parcels%rowtype; v_after public.parcels%rowtype;
  v_receipt public.parcel_receipt_undos%rowtype; v_journal public.parcel_receipt_undos%rowtype; v_now timestamptz;
begin
  if p_receipts is null or jsonb_typeof(p_receipts)<>'array' then raise exception 'undo receipts must be an array' using errcode='22023'; end if;
  if jsonb_array_length(p_receipts)>200 then raise exception 'undo request must contain at most 200 receipts' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_receipts) k where jsonb_typeof(k)<>'object'
    or jsonb_typeof(k->'id') is distinct from 'string' or jsonb_typeof(k->'receipt_id') is distinct from 'string'
    or k->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or k->>'receipt_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'invalid undo receipt' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_receipts) k group by (k->>'id')::uuid having count(distinct (k->>'receipt_id')::uuid)>1) then
    raise exception 'conflicting undo receipts' using errcode='22023';
  end if;
  if jsonb_array_length(p_receipts)=0 then return; end if;
  v_user := auth.uid();
  if v_user is null then raise exception 'signed in owner required' using errcode='42501'; end if;
  perform public.lock_sample_owner(v_user);
  perform e.id from public.emails e where e.user_id=v_user order by e.id for update;
  -- P1_OWNER_LOCK_SEAM: owner=v_user; provisional fixed key, replace with the shared owner helper before release.
  perform pg_catalog.pg_advisory_xact_lock(62803,0);
  perform p.id from public.parcels p where p.user_id=v_user
    and p.id in(select (k->>'id')::uuid from jsonb_array_elements(p_receipts) k) order by p.id for update;
  for v_key in select distinct (k->>'id')::uuid as parcel_id,(k->>'receipt_id')::uuid as token from jsonb_array_elements(p_receipts) k order by parcel_id loop
    select p.* into v_parcel from public.parcels p where p.id=v_key.parcel_id and p.user_id=v_user;
    -- Read the CURRENT journal only after R. A newer receive may have replaced its token.
    select j.* into v_receipt from public.parcel_receipt_undos j where j.parcel_id=v_key.parcel_id and j.user_id=v_user for update;
    if v_parcel.id is null then return query select v_key.parcel_id,'changed'::text; continue; end if;
    if v_receipt.parcel_id is null then return query select v_key.parcel_id,'failed'::text; continue; end if;
    if v_receipt.receipt_id is distinct from v_key.token then return query select v_key.parcel_id,'changed'::text; continue; end if;
    if v_receipt.expires_at<=clock_timestamp() then
      return query select v_key.parcel_id,'failed'::text; continue;
    end if;
    if v_receipt.undone_at is not null then
      if v_parcel.updated_at is not distinct from v_receipt.undone_updated_at
        and v_parcel.status is not distinct from v_receipt.previous_status and v_parcel.received_at is not distinct from v_receipt.previous_received_at then
        return query select v_key.parcel_id,'restored'::text;
      else return query select v_key.parcel_id,'changed'::text; end if;
      continue;
    end if;
    if v_parcel.status<>'delivered' or v_parcel.received_at is distinct from v_receipt.written_received_at
      or v_parcel.updated_at is distinct from v_receipt.written_updated_at then
      return query select v_key.parcel_id,'changed'::text; continue;
    end if;
    update public.parcels p set status=v_receipt.previous_status,
      received_at=case when v_receipt.previous_status='delivered' and v_receipt.previous_received_at is null then '-infinity'::timestamptz else v_receipt.previous_received_at end
      where p.id=v_key.parcel_id and p.user_id=v_user and p.updated_at=v_receipt.written_updated_at returning p.* into v_after;
    if not found or v_after.status is distinct from v_receipt.previous_status or v_after.received_at is distinct from v_receipt.previous_received_at then
      raise exception 'undo parcel was not stored as requested' using errcode='42501';
    end if;
    v_now := clock_timestamp();
    update public.parcel_receipt_undos j set undone_at=v_now,undone_updated_at=v_after.updated_at
      where j.parcel_id=v_key.parcel_id and j.receipt_id=v_key.token returning j.* into v_journal;
    if not found or v_journal.undone_at is distinct from v_now or v_journal.undone_updated_at is distinct from v_after.updated_at then
      raise exception 'undo receipt was not stored as requested' using errcode='42501';
    end if;
    return query select v_key.parcel_id,'restored'::text;
  end loop;
end $$;

revoke all on function public.mark_parcels_received(uuid[]),public.restore_parcel_receipts(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.mark_parcels_received(uuid[]),public.restore_parcel_receipts(jsonb) to authenticated;
create or replace function public.update_mail_parcel_without_sample_fence(
  p_snapshot jsonb, p_parcel_id uuid, p_expected_updated_at timestamptz, p_values jsonb, p_category jsonb, p_items jsonb,
  p_email_id uuid default null, p_run_id uuid default null
) returns table(verdict text,parcel_id uuid,parcel_row jsonb)
language plpgsql security definer set search_path='' as $$
declare
  v_mail public.emails%rowtype; v_parcel public.parcels%rowtype; v_expected_row public.parcels%rowtype;
  v_expected jsonb; v_current jsonb; v_rows jsonb; v_saved jsonb; v_changes jsonb; v_verdict text; v_noop boolean;
begin
  select * into v_mail from public.emails where id=p_email_id for update;
  -- P1_OWNER_LOCK_SEAM: owner=v_mail.user_id; provisional fixed key, shared helper integration pending.
  perform pg_catalog.pg_advisory_xact_lock(62803,0);
  if v_mail.id is null or p_run_id is null or v_mail.processing_run_id is distinct from p_run_id
    or v_mail.processing_status <> 'pending' or v_mail.processing_lease_until is null
    or v_mail.processing_lease_until <= clock_timestamp() then
    raise exception 'mail run no longer owns the lease' using errcode='42501';
  end if;
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
  -- Even an older delivered mail with an empty merge is a new confirmation of this parcel.
  -- Advance the version before returning, so an undo cannot demote it while evidence is saving.
  v_noop := v_changes = '{}'::jsonb;
  if v_noop then v_changes := jsonb_build_object('shop',v_parcel.shop); end if;
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
  if v_noop and (v_saved->>'updated_at')::timestamptz is not distinct from v_parcel.updated_at then
    raise exception 'mail confirmation did not advance the parcel version' using errcode='42501';
  end if;
  select e.verdict into v_verdict from public.ensure_mail_parcel_items(p_parcel_id,(v_saved->>'updated_at')::timestamptz,p_items,p_email_id,p_run_id) e;
  if v_verdict is distinct from 'ok' then raise exception 'parcel first items were not saved'; end if;
  return query select 'ok'::text,p_parcel_id,v_saved;
end $$;
revoke all on function public.update_mail_parcel_without_sample_fence(jsonb,uuid,timestamptz,jsonb,jsonb,jsonb,uuid,uuid) from public,anon,authenticated,service_role;
-- Preserve the existing consent purge exactly and append journal deletion LAST. No cron is added.
do $$ begin
  if to_regprocedure('public.purge_old_screen_events_before_receipt_retention()') is null then
    alter function public.purge_old_screen_events() rename to purge_old_screen_events_before_receipt_retention;
  end if;
end $$;
revoke all on function public.purge_old_screen_events_before_receipt_retention() from public,anon,authenticated,service_role;

create or replace function public.purge_expired_parcel_receipts() returns integer
language plpgsql security definer set search_path='' as $$
declare v_now timestamptz:=clock_timestamp(); v_count integer;
begin
  -- Child journal rows only: never acquire U/G/E/C/L/parcel locks after this final phase.
  delete from public.parcel_receipt_undos j where j.expires_at<=v_now;
  get diagnostics v_count=row_count;
  if exists(select 1 from public.parcel_receipt_undos j where j.expires_at<=v_now) then
    raise exception 'expired receipt journals were not removed' using errcode='42501';
  end if;
  return v_count;
end $$;
revoke all on function public.purge_expired_parcel_receipts() from public,anon,authenticated,service_role;

create or replace function public.purge_old_screen_events() returns integer
language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  v_count:=public.purge_old_screen_events_before_receipt_retention();
  return v_count+public.purge_expired_parcel_receipts();
end $$;
revoke all on function public.purge_old_screen_events() from public,anon,authenticated,service_role;

commit;
