-- Read-only preflight. No mail contents, IDs or environment values are read or printed.
-- Run after the 130000 verify, inside the closed, drained window of 11/14 (intake, clears, key writers stopped). The LAST statement is the only result:
-- a column named verdict (OK or FAILED), then each check (t/f), then informational counts.
with checks as (
  select
    to_regclass('supabase_migrations.schema_migrations') is not null as history_table,
    (select count(distinct version::text) from supabase_migrations.schema_migrations where version::text in
      ('20261112180000','20261112181000','20261113090000','20261113100000','20261113110000','20261113120000','20261113121000','20261113130000'))=8 as eight_applied,
    not exists(select 1 from supabase_migrations.schema_migrations where version::text='20261113140000') as not_yet_applied,
    -- No table, and no function of a name 140000 creates with any arguments (the migration gate checks the same).
    to_regclass('public.cleared_mail_marks') is null
      and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
        ('cleared_mail_mark_retention','cleared_mail_mark_clock_margin','purge_expired_cleared_mail_marks','purge_old_screen_events_before_cleared_mail_marks')) as no_leftovers,
    -- The three functions 140000 replaces or renames still have the settings they were made with (a later ALTER would be dropped).
    not exists(select 1 from (values ('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)'),
        ('public.clear_all_parcels(uuid)'),('public.purge_old_screen_events()')) f(sig)
      where not exists(select 1 from pg_proc p where p.oid=to_regprocedure(f.sig) and p.prosecdef
        and p.proconfig is not distinct from array['search_path=""'] and p.prolang=(select oid from pg_language where lanname='plpgsql'))) as settings_as_made,
    exists(select 1 from pg_proc where oid=to_regprocedure('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)')
      and md5(prosrc)='9ed12b79795f6d3123c91c6d8194969f') as store_core_is_120000,
    exists(select 1 from pg_proc where oid=to_regprocedure('public.clear_all_parcels(uuid)')
      and md5(prosrc)='b3677950b80f58e46ba5903775e66cb5') as clear_is_110000,
    exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events()')
      and md5(prosrc)='ca8e1192d5a430d1ada0681e9a9e6b36') as purge_is_130000,
    (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='store_mail_run') as one_store_entry,
    (select count(*)=1 from cron.job where jobname='otodoke-purge-old-screen-events'
      and command='select public.purge_old_screen_events()' and schedule='30 18 * * *' and active) as same_daily_job,
    to_regprocedure('public.lock_sample_owner(uuid)') is not null as owner_prefix,
    -- Same owner/ACL gate the migration opens with (run this as the role that will apply it).
    coalesce((select (select oid from pg_roles where rolname=current_user)=o.relowner
      and not exists(select 1 from (values
          ('public.clear_all_parcels(uuid)',true),
          ('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)',false),
          ('public.purge_old_screen_events()',false),
          ('public.lock_sample_owner(uuid)',false),
          ('public.expire_consent_waiting_row(uuid,timestamptz)',false),
          ('public.purge_old_screen_events_before_receipt_retention()',false)) f(sig,service_ok)
        where not exists(select 1 from pg_proc p where p.oid=to_regprocedure(f.sig) and p.proowner=o.relowner
          and (select count(*)=case when f.service_ok then 2 else 1 end
              and bool_and(a.grantor=o.relowner and a.privilege_type='EXECUTE' and not a.is_grantable
                and (a.grantee=o.relowner or (f.service_ok and a.grantee='service_role'::regrole::oid)))
              and (not f.service_ok or bool_or(a.grantee='service_role'::regrole::oid))
            from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)))
      from (select relowner from pg_class where oid=to_regclass('public.emails')) o),false) as owner_and_acl_gate
), inventory as (
  select count(*) filter (where provider_email_id is not null and provider_email_id not like 'demo:%') as marks_to_make_provider_id,
    count(*) filter (where message_id is not null and coalesce(provider_email_id,'') not like 'demo:%') as marks_to_make_message_id
  from public.emails
)
select case when history_table and eight_applied and not_yet_applied and no_leftovers and settings_as_made and store_core_is_120000 and clear_is_110000
  and purge_is_130000 and one_store_entry and same_daily_job and owner_prefix and owner_and_acl_gate then 'OK' else 'FAILED' end as verdict,
  checks.*, inventory.* from checks cross join inventory;
