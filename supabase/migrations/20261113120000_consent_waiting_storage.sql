-- Bound consent waiting per owner, isolated from the active global unread pool.
-- Requires 20261113110000 and the existing daily screen-event purge; no new cron.
-- Stop/drain mail/sample/parcel writers before applying. Auth can remain active:
-- the migration takes all existing U -> G before its email DDL/backfill (E).
-- Waiting mail retains its arrival-based deadline after grant/decline/retry.
-- Before/verify/rollback files share this migration's basename. Read their final verdict.
begin;
set local lock_timeout='5s';

do $$ begin
  if to_regprocedure('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)') is null
    or to_regprocedure('public.lock_sample_owner(uuid)') is null
    or to_regprocedure('public.purge_old_screen_events()') is null then
    raise exception 'consent waiting storage requires sample-generation gateways and the existing daily purge' using errcode='55000';
  end if;
end $$;

-- U -> G -> E, including the one-off backfill. Never take an Auth parent after email DDL.
do $$ begin
  perform id from auth.users order by id for key share;
  perform user_id from public.sample_generations order by user_id for update;
end $$;
lock table public.emails in access exclusive mode;
alter table public.emails add column if not exists consent_waiting_until timestamptz;
create index if not exists emails_consent_waiting_expiry_idx on public.emails(consent_waiting_until,user_id)
  where body_state='plain' and processing_status<>'processed' and consent_waiting_until is not null;

-- The only behavioral retention constant. Web text is checked against this function.
create or replace function public.ai_consent_waiting_retention() returns interval
language sql immutable set search_path='' as $$ select interval '14 days'; $$;
revoke all on function public.ai_consent_waiting_retention() from public,anon,authenticated,service_role;

-- This is the final write boundary: stored arrival time and the first waiting deadline
-- cannot be extended by a retry, a new consent choice, a key operation or another writer.
create or replace function public.mark_consent_waiting_mail() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' then
    new.received_at := old.received_at;
    if old.consent_waiting_until is not null then
      new.consent_waiting_until := old.consent_waiting_until;
    end if;
  end if;
  if new.consent_waiting_until is null and new.body_state='plain' and new.processing_status<>'processed'
    and coalesce(new.provider_email_id,'') not like 'demo:%'
    and coalesce(new.classification,'')<>'forwarding_confirmation'
    and (new.error in ('ai_consent_required','ai_consent_unknown')
      or not exists(select 1 from public.ai_reading_consents c where c.user_id=new.user_id and c.decision='granted')) then
    new.consent_waiting_until := new.received_at + public.ai_consent_waiting_retention();
  end if;
  return new;
end $$;
revoke all on function public.mark_consent_waiting_mail() from public,anon,authenticated,service_role;
drop trigger if exists emails_consent_waiting_marker on public.emails;
create trigger emails_consent_waiting_marker before insert or update on public.emails
for each row execute function public.mark_consent_waiting_mail();

-- Also covers previously waiting mail whose owner granted before this migration.
update public.emails e set consent_waiting_until=e.received_at + public.ai_consent_waiting_retention()
where e.consent_waiting_until is null and e.body_state='plain' and e.processing_status<>'processed'
  and coalesce(e.provider_email_id,'') not like 'demo:%'
  and coalesce(e.classification,'')<>'forwarding_confirmation'
  and (e.error in ('ai_consent_required','ai_consent_unknown')
    or not exists(select 1 from public.ai_reading_consents c where c.user_id=e.user_id and c.decision='granted'));

-- Caller owns U/G before entering. E serializes against every owned extraction write.
-- A partially stored result is a result the user already has: retain its FK and parcel,
-- but clear all mail content and use discarded (never processed/Claude-recovery proof).
create or replace function public.expire_consent_waiting_row(p_email_id uuid,p_now timestamptz) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_mail public.emails%rowtype;
begin
  select * into v_mail from public.emails where id=p_email_id for update;
  if not found or v_mail.consent_waiting_until is null or v_mail.consent_waiting_until>p_now
    or v_mail.body_state<>'plain' or v_mail.processing_status='processed'
    or (v_mail.processing_status='pending' and coalesce(v_mail.processing_lease_until,v_mail.created_at+interval '180 seconds')>p_now) then
    return false;
  end if;
  if exists(select 1 from public.extractions where email_id=p_email_id) then
    update public.emails set subject=null,from_address=null,from_name=null,text_body=null,html_body=null,
      body_envelope=null,body_state='dropped',processing_status='discarded',error='ai_consent_wait_expired',
      forwarding_confirm_url=null,processing_run_id=null,processing_lease_until=null
    where id=p_email_id;
    if not exists(select 1 from public.emails where id=p_email_id and body_state='dropped'
      and processing_status='discarded' and subject is null and from_address is null and from_name is null
      and text_body is null and html_body is null and body_envelope is null and processing_run_id is null and processing_lease_until is null) then
      raise exception 'expired consent mail content was not cleared as requested' using errcode='42501';
    end if;
  else
    delete from public.emails where id=p_email_id;
    if exists(select 1 from public.emails where id=p_email_id) then
      raise exception 'expired consent mail was not removed as requested' using errcode='42501';
    end if;
  end if;
  return true;
end $$;
revoke all on function public.expire_consent_waiting_row(uuid,timestamptz) from public,anon,authenticated,service_role;

-- Keep the exact prior bodies for a reversible rollback. These are owner-only helpers.
do $$ begin
  if to_regprocedure('public.store_mail_run_before_consent_storage(uuid,uuid,uuid,jsonb,timestamptz,jsonb)') is null then
    alter function public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb) rename to store_mail_run_before_consent_storage;
  end if;
  if to_regprocedure('public.set_ai_reading_before_consent_storage(text,text)') is null then
    alter function public.set_ai_reading(text,text) rename to set_ai_reading_before_consent_storage;
  end if;
  if to_regprocedure('public.purge_old_screen_events_before_consent_storage()') is null then
    alter function public.purge_old_screen_events() rename to purge_old_screen_events_before_consent_storage;
  end if;
end $$;
revoke all on function public.store_mail_run_before_consent_storage(uuid,uuid,uuid,jsonb,timestamptz,jsonb),
  public.set_ai_reading_before_consent_storage(text,text), public.purge_old_screen_events_before_consent_storage()
from public,anon,authenticated,service_role;

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


revoke all on function public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb) from public,anon,authenticated,service_role;

-- Withdrawal keeps waiting mail until its original arrival deadline. This takes U/G/E
-- before the consent row, and neither touches a parcel nor holds locks across an API call.
create or replace function public.set_ai_reading(p_decision text,p_text_version text)
returns table(decision text,decided_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();
begin
  if v_user is null then raise exception 'set_ai_reading: a signed-in user is required' using errcode='42501'; end if;
  if p_decision is null or p_decision not in ('granted','declined') then raise exception 'set_ai_reading: invalid decision' using errcode='22023'; end if;
  if p_text_version is null or btrim(p_text_version)='' then raise exception 'set_ai_reading: a text version is required' using errcode='22023'; end if;
  perform public.lock_sample_owner(v_user);
  if p_decision='declined' then
    perform id from public.emails where user_id=v_user order by id for update;
    update public.emails set consent_waiting_until=received_at + public.ai_consent_waiting_retention()
    where user_id=v_user and consent_waiting_until is null and body_state='plain' and processing_status<>'processed'
      and coalesce(provider_email_id,'') not like 'demo:%' and coalesce(classification,'')<>'forwarding_confirmation';
  end if;
  return query select * from public.set_ai_reading_before_consent_storage(p_decision,p_text_version);
end $$;
revoke all on function public.set_ai_reading(text,text) from public,anon,authenticated,service_role;
grant execute on function public.set_ai_reading(text,text) to authenticated;

-- One sweep must acquire ALL U, then ALL G, then E. Taking U/G for the next owner
-- after deleting the previous owner's mail would invert the shared partial order.
-- Busy owners/rows are left for the next existing daily sweep, never waited on backwards.
create or replace function public.purge_expired_consent_waiting_mail() returns integer
language plpgsql security definer set search_path='' as $$
declare
  v_now timestamptz:=clock_timestamp();
  v_candidates uuid[]; v_owners uuid[]:='{}'; v_locked uuid[]:='{}';
  v_owner uuid; v_mail uuid; v_count integer:=0;
begin
  select array_agg(distinct user_id order by user_id) into v_candidates from public.emails
    where consent_waiting_until<=v_now and body_state='plain' and processing_status<>'processed';
  if v_candidates is null then return 0; end if;
  -- U: existing Auth parents first, in UUID order. A deleting parent is skipped.
  for v_owner in select id from auth.users where id=any(v_candidates) order by id for key share skip locked loop
    v_owners:=array_append(v_owners,v_owner);
  end loop;
  -- G: all generations before any email lock. An in-flight read/clear is skipped.
  insert into public.sample_generations(user_id) select unnest(v_owners) on conflict(user_id) do nothing;
  for v_owner in select user_id from public.sample_generations where user_id=any(v_owners) order by user_id for update skip locked loop
    v_locked:=array_append(v_locked,v_owner);
  end loop;
  -- E: expiry rechecked while holding the row; active leases are not taken away.
  for v_mail in select id from public.emails where user_id=any(v_locked) and consent_waiting_until<=v_now
    and body_state='plain' and processing_status<>'processed'
    and not (processing_status='pending' and coalesce(processing_lease_until,created_at+interval '180 seconds')>v_now)
    order by user_id,id for update skip locked loop
    if public.expire_consent_waiting_row(v_mail,v_now) then v_count:=v_count+1; end if;
  end loop;
  return v_count;
end $$;
revoke all on function public.purge_expired_consent_waiting_mail() from public,anon,authenticated,service_role;

-- The same existing cron job still calls this name, with the same daily schedule.
create or replace function public.purge_old_screen_events() returns integer
language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  v_count:=public.purge_expired_consent_waiting_mail();
  return v_count+public.purge_old_screen_events_before_consent_storage();
end $$;
revoke all on function public.purge_old_screen_events() from public,anon,authenticated,service_role;
commit;
