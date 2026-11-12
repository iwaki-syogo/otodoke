-- Stop/drain paid reads first. Roll this back AFTER 130000 and BEFORE 120000 and all earlier migrations.
-- Restores exact prior v1/v2 entry bodies; counters/ledger/choices/results are preserved.
-- Pipeline's early permission guard remains, but per-claim cancellation protection is lost.
begin;
set local lock_timeout='5s';
-- Gate: stop with nothing changed (55000) if 130000 is still applied. Order: 130000 -> 121000 -> 120000.
do $$ begin
  if to_regclass('public.parcel_receipt_undos') is not null or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('mark_parcels_received','restore_parcel_receipts','purge_expired_parcel_receipts',
      'parcel_receipt_retention','purge_old_screen_events_before_receipt_retention')) then
    raise exception '%', 'rollback order: 20261113130000 (received receipts) is still applied; roll it back first' using errcode='55000';
  end if;
end $$;
do $$
declare v_count integer;
begin
  select count(*) into v_count from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('claim_claude_call_before_consent_guard','claim_claude_call_v2_before_consent_guard');
  if v_count not in (0,2) then raise exception 'Claude consent rollback: partial prior entries; stop and inspect' using errcode='55000'; end if;
  if v_count=2 then
    drop function public.claim_claude_call(uuid,integer,integer);
    alter function public.claim_claude_call_before_consent_guard(uuid,integer,integer) rename to claim_claude_call;
    drop function public.claim_claude_call_v2(uuid,integer,integer);
    alter function public.claim_claude_call_v2_before_consent_guard(uuid,integer,integer) rename to claim_claude_call_v2;
  end if;
end $$;
revoke all on function public.claim_claude_call(uuid,integer,integer),public.claim_claude_call_v2(uuid,integer,integer)
from public,anon,authenticated,service_role;
grant execute on function public.claim_claude_call(uuid,integer,integer),public.claim_claude_call_v2(uuid,integer,integer) to service_role;
drop function if exists public.assert_claude_claim_consent(uuid);
commit;
