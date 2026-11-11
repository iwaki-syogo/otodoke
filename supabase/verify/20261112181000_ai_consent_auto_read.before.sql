-- Read-only preflight, also used after the auto-read rollback. One final verdict result.
-- The base consent migration may be pending in the same initial push, or already present.
-- A partial base installation, an existing journal, or an existing claim function means stop.
with checks as (
  select
    to_regclass('auth.users') is not null and to_regprocedure('auth.uid()') is not null as auth_ok,
    (select count(*) = 3 from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) as roles_ok,
    case
      when to_regclass('public.ai_reading_consents') is null and to_regprocedure('public.set_ai_reading(text,text)') is null then 'pending_with_base_migration'
      when to_regclass('public.ai_reading_consents') is not null and to_regprocedure('public.set_ai_reading(text,text)') is not null then 'present'
      else 'partial'
    end as base_state,
    to_regclass('public.ai_consent_read_runs') is null as journal_absent,
    to_regprocedure('public.claim_ai_reading_backlog(uuid,timestamptz)') is null as claim_absent
)
select checks.*,
  case when auth_ok and roles_ok and base_state <> 'partial' and journal_absent and claim_absent then 'OK' else 'FAILED' end as verdict
from checks;
