-- Remember which mail a user cleared, so a later delivery of the same mail is not stored or read again.
-- Requires the eight migrations through 20261113130000.
-- Apply inside the closed, drained window of 11/14 (intake, clears, key writers stopped). The body itself does not rewrite rows; see apply-k-migration.md section 2.
-- Apply as the existing application owner (the owner of public.emails); the gate below never repairs OWNER or GRANT.
-- Marks keep only a per-user SHA-256 digest (never the ID, body, subject or sender) for 35 days.
-- Before/verify/rollback files share this migration's basename. Read their final column named verdict.
begin;
set local lock_timeout='5s';

-- Owner gate: run as the existing application owner, and every function this file replaces or calls must still be
-- owned by it with the ACL it had before this file. Stop with nothing changed (55000); never repair OWNER or GRANT here.
do $cleared_owner_gate$
declare v_owner oid := (select relowner from pg_class where oid=to_regclass('public.emails'));
begin
  if v_owner is null or (select oid from pg_roles where rolname=current_user) is distinct from v_owner
    or exists(select 1 from (values
        ('public.clear_all_parcels(uuid)',true),
        ('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)',false),
        ('public.purge_old_screen_events()',false),
        ('public.lock_sample_owner(uuid)',false),
        ('public.expire_consent_waiting_row(uuid,timestamptz)',false),
        ('public.purge_old_screen_events_before_receipt_retention()',false)) f(sig,service_ok)
      where not exists(select 1 from pg_proc p where p.oid=to_regprocedure(f.sig) and p.proowner=v_owner
        and (select count(*)=case when f.service_ok then 2 else 1 end
            and bool_and(a.grantor=v_owner and a.privilege_type='EXECUTE' and not a.is_grantable
              and (a.grantee=v_owner or (f.service_ok and a.grantee='service_role'::regrole::oid)))
            and (not f.service_ok or bool_or(a.grantee='service_role'::regrole::oid))
          from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a))) then
    raise exception 'cleared mail marks: run as the application owner; the replaced functions and their helpers must keep their owner and ACL; review before applying' using errcode='55000';
  end if;
end $cleared_owner_gate$;

do $$
declare v_applied integer;
begin
  if to_regclass('supabase_migrations.schema_migrations') is null
    or not exists(select 1 from pg_attribute where attrelid=to_regclass('supabase_migrations.schema_migrations') and attname='version' and not attisdropped) then
    raise exception 'cleared mail marks require actual migration history' using errcode='55000';
  end if;
  execute $history$select count(distinct version::text) from supabase_migrations.schema_migrations
    where version::text in ('20261112180000','20261112181000','20261113090000','20261113100000','20261113110000','20261113120000','20261113121000','20261113130000')$history$ into v_applied;
  if v_applied<>8 or exists(select 1 from supabase_migrations.schema_migrations where version::text='20261113140000')
    or to_regclass('public.cleared_mail_marks') is not null
    -- No function of a name this file creates, with any arguments.
    or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
      ('cleared_mail_mark_retention','cleared_mail_mark_clock_margin','purge_expired_cleared_mail_marks','purge_old_screen_events_before_cleared_mail_marks'))
    -- The functions replaced or renamed here still have the settings they were made with: CREATE OR REPLACE would drop a later ALTER.
    or exists(select 1 from (values ('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)'),
        ('public.clear_all_parcels(uuid)'),('public.purge_old_screen_events()')) f(sig)
      where not exists(select 1 from pg_proc p where p.oid=to_regprocedure(f.sig) and p.prosecdef
        and p.proconfig is not distinct from array['search_path=""'] and p.prolang=(select oid from pg_language where lanname='plpgsql')))
    or to_regprocedure('public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb)') is null
    or not exists(select 1 from pg_proc where oid=to_regprocedure('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)')
      and md5(prosrc)='9ed12b79795f6d3123c91c6d8194969f')
    or not exists(select 1 from pg_proc where oid=to_regprocedure('public.clear_all_parcels(uuid)') and md5(prosrc)='b3677950b80f58e46ba5903775e66cb5')
    or not exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events()') and md5(prosrc)='ca8e1192d5a430d1ada0681e9a9e6b36')
    or to_regprocedure('public.purge_old_screen_events_before_receipt_retention()') is null
    or to_regprocedure('public.lock_sample_owner(uuid)') is null
    or to_regprocedure('public.ai_consent_waiting_retention()') is null then
    raise exception 'cleared mail marks require the eight migrations through 130000, unchanged (bodies and settings), and no earlier application of this one' using errcode='55000';
  end if;
end $$;

-- Only security-definer functions below touch this table.
create table public.cleared_mail_marks (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('provider_email_id','message_id')),
  digest bytea not null,
  reason text not null check (reason in ('clear_all')),
  marked_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (user_id, kind, digest)
);
create index cleared_mail_marks_expires_at_idx on public.cleared_mail_marks(expires_at);
alter table public.cleared_mail_marks enable row level security;
revoke all on table public.cleared_mail_marks from public, anon, authenticated, service_role;

create or replace function public.cleared_mail_mark_retention() returns interval
language sql immutable set search_path='' as $$ select interval '35 days'; $$;
create or replace function public.cleared_mail_mark_clock_margin() returns interval
language sql immutable set search_path='' as $$ select interval '120 seconds'; $$;
revoke all on function public.cleared_mail_mark_retention(), public.cleared_mail_mark_clock_margin() from public,anon,authenticated,service_role;

create or replace function public.clear_all_parcels(p_user_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_generation uuid; v_marked timestamptz := clock_timestamp();
begin
  perform public.lock_sample_owner(p_user_id);
  if p_user_id is null then raise exception 'missing clear owner' using errcode = '22023'; end if;
  insert into public.sample_generations(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select generation into v_generation from public.sample_generations where user_id = p_user_id for update;
  update public.sample_generations set generation = gen_random_uuid() where user_id = p_user_id returning generation into v_generation;
  perform id from public.emails where user_id=p_user_id order by id for update;
  -- Leave a digest-only mark of every real (non-sample) delivery being deleted, in this same transaction.
  -- In one fixed order (kind, digest), so two writers of the same marks never lock them in crossing orders.
  insert into public.cleared_mail_marks(user_id,kind,digest,reason,marked_at,expires_at)
  select p_user_id, d.kind, d.digest, 'clear_all', v_marked, v_marked + public.cleared_mail_mark_retention()
  from (select m.kind, pg_catalog.sha256(convert_to(p_user_id::text||chr(10)||m.kind||chr(10)||m.v,'UTF8')) as digest
    from (select 'provider_email_id'::text as kind, e.provider_email_id as v from public.emails e
        where e.user_id=p_user_id and e.provider_email_id is not null and e.provider_email_id not like 'demo:%'
      union select 'message_id'::text, e.message_id from public.emails e
        where e.user_id=p_user_id and e.message_id is not null and coalesce(e.provider_email_id,'') not like 'demo:%') m) d
  order by d.kind, d.digest
  on conflict (user_id,kind,digest) do update set marked_at=excluded.marked_at, expires_at=excluded.expires_at;
  delete from public.parcels where user_id = p_user_id;
  delete from public.emails where user_id = p_user_id;
  return v_generation;
end $$;

-- Same body as 120000 except the two marked blocks (provider ID before any row branch; Message-ID before the existing-provider-ID check).
create or replace function public.store_mail_run_without_sample_fence(
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
  v_waiting boolean;
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
  -- A cleared delivery (its provider ID marked) is a duplicate whether or not a row exists: it never takes over,
  -- discards or pays for a row kept after the clear. That row's own retry and a re-read carry an unmarked provider ID.
  if coalesce(p_columns->>'provider_email_id','') not like 'demo:%' and p_columns->>'provider_email_id' is not null
    and exists(select 1 from public.cleared_mail_marks m
      where m.user_id=p_user_id and m.kind='provider_email_id' and m.expires_at>v_now
        and m.digest=pg_catalog.sha256(convert_to(p_user_id::text||chr(10)||'provider_email_id'||chr(10)||(p_columns->>'provider_email_id'),'UTF8'))) then
    return query select 'duplicate'::text, p_email_id; return;
  end if;
  if v_exists then
    if v_old.processing_status = 'discarded' and v_old.error = 'ai_consent_wait_expired' then
      return query select 'consent_wait_expired'::text, p_email_id; return;
    end if;
    if v_old.processing_status = 'processed' then return query select 'duplicate'::text, p_email_id; return; end if;
    if v_old.processing_status = 'pending' and coalesce(v_old.processing_lease_until, v_old.created_at + interval '180 seconds') > v_now then
      return query select 'busy'::text, p_email_id; return;
    end if;
    if v_old.created_at is distinct from p_expected_created_at then return query select 'busy'::text, p_email_id; return; end if;
    if v_old.consent_waiting_until <= v_now and v_old.body_state = 'plain' then
      perform public.expire_consent_waiting_row(p_email_id, v_now);
      return query select 'consent_wait_expired'::text, p_email_id; return;
    end if;
  elsif p_expected_created_at is not null then
    return query select 'busy'::text, p_email_id; return;
  end if;
  -- A new row whose Message-ID was cleared and whose delivery was created before the clear is a duplicate too:
  -- stop before storage and any paid read. Only for a new row: an existing row with that Message-ID was stored
  -- after the clear, so the Message-ID no longer stands for cleared mail. An unreadable delivery time never blocks.
  if not v_exists and coalesce(p_columns->>'provider_email_id','') not like 'demo:%' then
    declare
      v_mark_at timestamptz; v_delivery timestamptz; v_header text;
    begin
      if p_columns->>'message_id' is not null then
        select m.marked_at into v_mark_at from public.cleared_mail_marks m
          where m.user_id=p_user_id and m.kind='message_id' and m.expires_at>v_now
            and m.digest=pg_catalog.sha256(convert_to(p_user_id::text||chr(10)||'message_id'||chr(10)||(p_columns->>'message_id'),'UTF8'));
        if found then
          begin
            v_header := (nullif(current_setting('request.headers',true),'')::jsonb)->>'x-otodoke-delivery-created-at';
            if v_header ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
              v_delivery := v_header::timestamptz;
            end if;
          exception when others then
            v_delivery := null;
          end;
          if v_delivery is not null and v_delivery < v_mark_at - public.cleared_mail_mark_clock_margin() then
            return query select 'duplicate'::text, p_email_id; return;
          end if;
        end if;
      end if;
    end;
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
  v_waiting := (v_exists and v_old.consent_waiting_until is not null) or (
    coalesce(v_row.provider_email_id,'') not like 'demo:%'
    and coalesce(v_row.classification,'') <> 'forwarding_confirmation'
    and not exists(select 1 from public.ai_reading_consents where user_id=p_user_id and decision='granted'));
  select count(*) filter (where consent_waiting_until is null), coalesce(sum(octet_length(coalesce(subject,'')) + octet_length(coalesce(from_address,''))
    + octet_length(coalesce(from_name,'')) + octet_length(coalesce(text_body,'')) + octet_length(coalesce(html_body,''))) filter (where consent_waiting_until is null),0),
    count(*) filter (where user_id = p_user_id), coalesce(sum(octet_length(coalesce(subject,'')) + octet_length(coalesce(from_address,''))
    + octet_length(coalesce(from_name,'')) + octet_length(coalesce(text_body,'')) + octet_length(coalesce(html_body,''))) filter (where user_id = p_user_id),0)
    into v_global_count, v_global_bytes, v_user_count, v_user_bytes
    from public.emails where body_state = 'plain' and processing_status <> 'processed' and id <> p_email_id;
  -- Existing rows may predate a lowered ceiling. Re-reading the same body is an
  -- exit, not a fresh allocation; larger replacements still need room.
  if coalesce(v_row.processing_status,'pending') <> 'processed' and coalesce(v_row.body_state,'plain') = 'plain' and (not v_exists or v_bytes > octet_length(coalesce(v_old.subject,'')) + octet_length(coalesce(v_old.from_address,''))
      + octet_length(coalesce(v_old.from_name,'')) + octet_length(coalesce(v_old.text_body,'')) + octet_length(coalesce(v_old.html_body,''))) then
    if v_user_count + 1 > (p_limits->>'user_count')::bigint or v_user_bytes + v_bytes > (p_limits->>'user_bytes')::bigint then v_reason := 'user_storage_limit';
    elsif not v_waiting and (v_global_count + 1 > (p_limits->>'global_count')::bigint or v_global_bytes + v_bytes > (p_limits->>'global_bytes')::bigint) then v_reason := 'global_storage_limit'; end if;
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

-- Expired marks go with the existing daily sweep; the cron job is unchanged.
do $$ begin
  if to_regprocedure('public.purge_old_screen_events_before_cleared_mail_marks()') is null then
    alter function public.purge_old_screen_events() rename to purge_old_screen_events_before_cleared_mail_marks;
  end if;
end $$;
revoke all on function public.purge_old_screen_events_before_cleared_mail_marks() from public,anon,authenticated,service_role;

create or replace function public.purge_expired_cleared_mail_marks() returns integer
language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  -- Child rows only: takes no Auth, generation or mail locks, and never waits for a mark row. A row a clear holds
  -- (it may be refreshing it) is skipped and goes with a later sweep. At most 10000 per run; the rest wait for the next day.
  with candidates as (
    select m.user_id, m.kind, m.digest from public.cleared_mail_marks m
      where m.expires_at<=clock_timestamp() order by m.expires_at limit 10000 for update skip locked)
  delete from public.cleared_mail_marks m using candidates c
    where m.user_id=c.user_id and m.kind=c.kind and m.digest=c.digest and m.expires_at<=clock_timestamp();
  get diagnostics v_count=row_count;
  return v_count;
end $$;
revoke all on function public.purge_expired_cleared_mail_marks() from public,anon,authenticated,service_role;

create or replace function public.purge_old_screen_events() returns integer
language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  v_count:=public.purge_old_screen_events_before_cleared_mail_marks();
  return v_count+public.purge_expired_cleared_mail_marks();
end $$;
revoke all on function public.purge_old_screen_events() from public,anon,authenticated,service_role;

commit;
