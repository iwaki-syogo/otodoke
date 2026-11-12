-- Roll back 20261113140000 FIRST. Full order: 140000 -> 130000 -> 121000 -> 120000 -> 110000.
-- Restores the exact 120000 store core, the 110000 clear_all_parcels and the 130000 daily purge.
-- Apply inside the closed, drained window of 11/14 (intake, clears, key writers stopped), as the existing application owner
-- (the owner of public.emails). Saved mail and parcels are untouched; all cleared-mail marks are dropped,
-- so mail cleared earlier can be stored and read again if it is delivered again.
begin;
set local lock_timeout='5s';
-- Gate: stop with nothing changed (55000) if a later change touched these bodies, or 130000 is already rolled back.
do $$ begin
  if to_regclass('public.parcel_receipt_undos') is null
    or to_regprocedure('public.purge_old_screen_events_before_receipt_retention()') is null then
    raise exception '%', 'rollback order: 20261113130000 (received receipts) must still be applied; roll back 140000 first' using errcode='55000';
  end if;
  if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname in ('cleared_mail_mark_retention','cleared_mail_mark_clock_margin','purge_expired_cleared_mail_marks','purge_old_screen_events_before_cleared_mail_marks'))<>4
    or to_regclass('public.cleared_mail_marks') is null then
    raise exception 'cleared mail marks rollback: partial or missing installation; stop and inspect' using errcode='55000';
  end if;
  if not exists(select 1 from pg_proc where oid=to_regprocedure('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)') and md5(prosrc)='be7af8ed6fc977c295dc2a02b9b3c3d7')
    or not exists(select 1 from pg_proc where oid=to_regprocedure('public.clear_all_parcels(uuid)') and md5(prosrc)='7f01239da961c4a877fea92788067f15')
    or not exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events()') and md5(prosrc)='7748a3a410eccd04cf2b811e3a568de2')
    or not exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_expired_cleared_mail_marks()') and md5(prosrc)='b4430bd1176b93f6f65f64c5d20e9472')
    or not exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events_before_cleared_mail_marks()') and md5(prosrc)='ca8e1192d5a430d1ada0681e9a9e6b36') then
    raise exception 'cleared mail marks rollback: a later change altered these bodies; review its rollback gate' using errcode='55000';
  end if;
  -- The functions replaced, renamed back or dropped here still have the settings 140000 gave or kept: CREATE OR REPLACE / DROP
  -- would lose a later ALTER, and the kept 130000 purge must come back as it was.
  if exists(select 1 from (values ('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)'),
      ('public.clear_all_parcels(uuid)'),('public.purge_old_screen_events()'),('public.purge_expired_cleared_mail_marks()'),
      ('public.purge_old_screen_events_before_cleared_mail_marks()')) f(sig)
    where not exists(select 1 from pg_proc p where p.oid=to_regprocedure(f.sig) and p.prosecdef
      and p.proconfig is not distinct from array['search_path=""'] and p.prolang=(select oid from pg_language where lanname='plpgsql'))) then
    raise exception 'cleared mail marks rollback: a later change altered the settings of these functions; review before rolling back' using errcode='55000';
  end if;
end $$;
-- Owner gate: same premise as the migration. Run as the application owner; everything restored or dropped here must still
-- be owned by it with the ACL 140000 left. Stop with nothing changed (55000); never repair OWNER or GRANT here.
do $cleared_owner_gate$
declare v_owner oid := (select relowner from pg_class where oid=to_regclass('public.emails'));
begin
  if v_owner is null or (select oid from pg_roles where rolname=current_user) is distinct from v_owner
    or exists(select 1 from (values
        ('public.clear_all_parcels(uuid)',true),
        ('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)',false),
        ('public.purge_old_screen_events()',false),
        ('public.purge_old_screen_events_before_cleared_mail_marks()',false),
        ('public.purge_expired_cleared_mail_marks()',false),
        ('public.cleared_mail_mark_retention()',false),
        ('public.cleared_mail_mark_clock_margin()',false),
        ('public.lock_sample_owner(uuid)',false),
        ('public.expire_consent_waiting_row(uuid,timestamptz)',false)) f(sig,service_ok)
      where not exists(select 1 from pg_proc p where p.oid=to_regprocedure(f.sig) and p.proowner=v_owner
        and (select count(*)=case when f.service_ok then 2 else 1 end
            and bool_and(a.grantor=v_owner and a.privilege_type='EXECUTE' and not a.is_grantable
              and (a.grantee=v_owner or (f.service_ok and a.grantee='service_role'::regrole::oid)))
            and (not f.service_ok or bool_or(a.grantee='service_role'::regrole::oid))
          from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)))
    or not exists(select 1 from pg_class c where c.oid=to_regclass('public.cleared_mail_marks') and c.relowner=v_owner) then
    raise exception 'cleared mail marks rollback: run as the application owner; the functions and table must keep their owner and ACL; review before rolling back' using errcode='55000';
  end if;
end $cleared_owner_gate$;
do $$ begin
  perform id from auth.users order by id for key share;
  perform user_id from public.sample_generations order by user_id for update;
end $$;

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

create or replace function public.clear_all_parcels(p_user_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_generation uuid;
begin
  perform public.lock_sample_owner(p_user_id);
  if p_user_id is null then raise exception 'missing clear owner' using errcode = '22023'; end if;
  insert into public.sample_generations(user_id) values (p_user_id) on conflict (user_id) do nothing;
  select generation into v_generation from public.sample_generations where user_id = p_user_id for update;
  update public.sample_generations set generation = gen_random_uuid() where user_id = p_user_id returning generation into v_generation;
  perform id from public.emails where user_id=p_user_id order by id for update;
  delete from public.parcels where user_id = p_user_id;
  delete from public.emails where user_id = p_user_id;
  return v_generation;
end $$;

drop function public.purge_old_screen_events();
alter function public.purge_old_screen_events_before_cleared_mail_marks() rename to purge_old_screen_events;
drop function public.purge_expired_cleared_mail_marks();
drop table public.cleared_mail_marks;
drop function public.cleared_mail_mark_retention();
drop function public.cleared_mail_mark_clock_margin();
commit;
