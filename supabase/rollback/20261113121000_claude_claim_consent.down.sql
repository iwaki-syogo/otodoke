-- Stop/drain paid reads first. Roll this back BEFORE 120000 and all earlier migrations.
-- Restores exact prior v1/v2 entry bodies; counters/ledger/choices/results are preserved.
-- Pipeline's early permission guard remains, but per-claim cancellation protection is lost.
begin;
set local lock_timeout='5s';
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
