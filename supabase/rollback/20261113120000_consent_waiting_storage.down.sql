-- Stop/drain mail/sample/parcel writers and the existing daily sweep first.
-- Roll this back AFTER 130000 and 121000, BEFORE 110000; restores its exact core and the prior consent/purge bodies.
-- It cannot recover mail contents already deleted by expiry. No choices/results/parcels removed.
-- The active global pool once again includes every plain unread mail after rollback.
begin;
set local lock_timeout='5s';
-- Gate: stop with nothing changed (55000) if 130000 or 121000 is still applied. Order: 130000 -> 121000 -> 120000.
do $$ begin
  if to_regclass('public.parcel_receipt_undos') is not null or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('mark_parcels_received','restore_parcel_receipts','purge_expired_parcel_receipts',
      'parcel_receipt_retention','purge_old_screen_events_before_receipt_retention')) then
    raise exception '%', 'rollback order: 20261113130000 (received receipts) is still applied; roll it back first' using errcode='55000';
  end if;
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
    ('assert_claude_claim_consent','claim_claude_call_before_consent_guard','claim_claude_call_v2_before_consent_guard')) then
    raise exception '%', 'rollback order: 20261113121000 (Claude consent claims) is still applied; roll it back first' using errcode='55000';
  end if;
end $$;
do $$ begin
  perform id from auth.users order by id for key share;
  perform user_id from public.sample_generations order by user_id for update;
end $$;
lock table public.emails in access exclusive mode;
do $$
declare v_count integer;
begin
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('store_mail_run_before_consent_storage','set_ai_reading_before_consent_storage','purge_old_screen_events_before_consent_storage');
  if v_count not in (0,3) then raise exception 'consent waiting rollback: partial prior bodies; stop and inspect' using errcode='55000'; end if;
  if v_count=3 then
    drop function public.purge_old_screen_events();
    alter function public.purge_old_screen_events_before_consent_storage() rename to purge_old_screen_events;
    drop function public.set_ai_reading(text,text);
    alter function public.set_ai_reading_before_consent_storage(text,text) rename to set_ai_reading;
    drop function public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb);
    alter function public.store_mail_run_before_consent_storage(uuid,uuid,uuid,jsonb,timestamptz,jsonb) rename to store_mail_run_without_sample_fence;
  end if;
end $$;
revoke all on function public.set_ai_reading(text,text) from public,anon,authenticated,service_role;
grant execute on function public.set_ai_reading(text,text) to authenticated;
revoke all on function public.purge_old_screen_events(),public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)
from public,anon,authenticated,service_role;
drop trigger if exists emails_consent_waiting_marker on public.emails;
drop function if exists public.purge_expired_consent_waiting_mail();
drop function if exists public.expire_consent_waiting_row(uuid,timestamptz);
drop function if exists public.mark_consent_waiting_mail();
drop function if exists public.ai_consent_waiting_retention();
alter table public.emails drop column if exists consent_waiting_until;
commit;
