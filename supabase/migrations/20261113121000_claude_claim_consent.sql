-- Current consent is checked while its row is locked in the paid-claim transaction.
-- Requires 120000: its setter takes U -> G -> E before changing consent C.
-- Standalone: U -> G -> C -> 62801(day) -> counter/ledger.
-- Owned mail: U -> G -> E -> C -> 62801(day) -> counter/ledger (U/G re-entry only).
-- v2 core calls public v1; U/G/C are already held, never first acquired after C.
-- A completed claim releases these locks before the external HTTP request starts.
-- Release intentionally has no consent gate so a withdrawn user can get a refund.
-- Stop/drain writers before migration; before/verify/down share this basename.
begin;
set local lock_timeout='5s';

do $$ begin
  if to_regprocedure('public.lock_sample_owner(uuid)') is null
    or to_regprocedure('public.ai_consent_waiting_retention()') is null
    or to_regprocedure('public.set_ai_reading_before_consent_storage(text,text)') is null
    or not exists(select 1 from pg_proc where oid=to_regprocedure('public.set_ai_reading(text,text)')
      and md5(prosrc)='0d232f68c8eb0f71f60a1f55c40cb0b3'
      and prosrc like '%perform public.lock_sample_owner(v_user);%'
      and prosrc like '%public.set_ai_reading_before_consent_storage(p_decision,p_text_version)%')
    or to_regprocedure('public.claim_claude_call_v2_without_sample_fence(uuid,integer,integer)') is null then
    raise exception 'Claude consent claims require 120000 owner/mail-prefixed consent setter and existing quota gateways' using errcode='55000';
  end if;
end $$;

-- Store prior entry bodies unchanged. API roles must not bypass the new consent wrapper.
do $$ begin
  if to_regprocedure('public.claim_claude_call_before_consent_guard(uuid,integer,integer)') is null then
    alter function public.claim_claude_call(uuid,integer,integer) rename to claim_claude_call_before_consent_guard;
  end if;
  if to_regprocedure('public.claim_claude_call_v2_before_consent_guard(uuid,integer,integer)') is null then
    alter function public.claim_claude_call_v2(uuid,integer,integer) rename to claim_claude_call_v2_before_consent_guard;
  end if;
end $$;
revoke all on function public.claim_claude_call_before_consent_guard(uuid,integer,integer),
  public.claim_claude_call_v2_before_consent_guard(uuid,integer,integer) from public,anon,authenticated,service_role;

-- Caller already owns U/G (and E for owned mail). Nothing here acquires a parent
-- or generation after C. Errors reading the table propagate as database errors;
-- only an absent row or an explicit non-grant produces this exact denial.
create or replace function public.assert_claude_claim_consent(p_user_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare v_decision text;
begin
  select c.decision into v_decision from public.ai_reading_consents c where c.user_id=p_user_id for share;
  if not found or v_decision is distinct from 'granted' then
    raise exception 'ai_consent_required' using errcode='42501';
  end if;
end $$;
revoke all on function public.assert_claude_claim_consent(uuid) from public,anon,authenticated,service_role;

create or replace function public.claim_claude_call(p_user_id uuid,p_user_limit integer,p_global_limit integer)
returns text language plpgsql security definer set search_path='' as $$
begin
  if p_user_id is null or p_user_limit is null or p_global_limit is null then
    raise exception 'claim_claude_call: missing argument' using errcode='22023';
  end if;
  perform public.lock_sample_owner(p_user_id);
  perform public.assert_claude_claim_consent(p_user_id);
  return public.claim_claude_call_before_consent_guard(p_user_id,p_user_limit,p_global_limit);
end $$;

create or replace function public.claim_claude_call_v2(p_user_id uuid,p_user_limit integer,p_global_limit integer)
returns table(verdict text,claim_id bigint)
language plpgsql security definer set search_path='' as $$
begin
  if p_user_id is null or p_user_limit is null or p_global_limit is null then
    raise exception 'claim_claude_call: missing argument' using errcode='22023';
  end if;
  perform public.lock_sample_owner(p_user_id);
  perform public.assert_claude_claim_consent(p_user_id);
  return query select * from public.claim_claude_call_v2_before_consent_guard(p_user_id,p_user_limit,p_global_limit);
end $$;
revoke all on function public.claim_claude_call(uuid,integer,integer),public.claim_claude_call_v2(uuid,integer,integer)
from public,anon,authenticated,service_role;
grant execute on function public.claim_claude_call(uuid,integer,integer),public.claim_claude_call_v2(uuid,integer,integer) to service_role;
commit;
