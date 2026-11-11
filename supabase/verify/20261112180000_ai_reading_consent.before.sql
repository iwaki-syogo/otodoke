-- Read-only preflight (also checks the state after rollback). One final result with a verdict.
-- An absent verdict, a query error, or FAILED means stop; a zero exit code is not proof.
-- Deliberately refuses an existing table/function: do not overwrite recorded choices on rerun.
with checks as (
  select
    to_regclass('auth.users') is not null as auth_users_ok,
    to_regprocedure('auth.uid()') is not null as auth_uid_ok,
    (select count(*) = 3 from pg_roles where rolname in ('anon', 'authenticated', 'service_role')) as roles_ok,
    to_regclass('public.ai_reading_consents') is null as table_absent,
    to_regprocedure('public.set_ai_reading(text,text)') is null as function_absent
)
select checks.*, case when auth_users_ok and auth_uid_ok and roles_ok and table_absent and function_absent then 'OK' else 'FAILED' end as verdict
from checks;
