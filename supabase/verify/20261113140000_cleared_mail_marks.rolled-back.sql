-- Read-only check that 20261113140000 is rolled back. Run it after the 140000 rollback and BEFORE the 130000 rollback.
-- No mail contents, IDs or environment values are read or printed. The LAST statement is the only result:
-- a column named verdict (OK or FAILED), then each check (t/f).
select case when table_gone and new_functions_gone and alias_gone and daily_purge_is_130000 and one_daily_purge
    and store_core_is_120000 and clear_is_110000 and restored_settings_owner_acl and same_daily_job then 'OK' else 'FAILED' end as verdict,
  checks.*
from (select
  to_regclass('public.cleared_mail_marks') is null as table_gone,
  not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname in ('cleared_mail_mark_retention','cleared_mail_mark_clock_margin','purge_expired_cleared_mail_marks')) as new_functions_gone,
  not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
    and p.proname='purge_old_screen_events_before_cleared_mail_marks') as alias_gone,
  exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events()')
    and md5(prosrc)='ca8e1192d5a430d1ada0681e9a9e6b36') as daily_purge_is_130000,
  (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='purge_old_screen_events') as one_daily_purge,
  exists(select 1 from pg_proc where oid=to_regprocedure('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)')
    and md5(prosrc)='9ed12b79795f6d3123c91c6d8194969f') as store_core_is_120000,
  exists(select 1 from pg_proc where oid=to_regprocedure('public.clear_all_parcels(uuid)')
    and md5(prosrc)='b3677950b80f58e46ba5903775e66cb5') as clear_is_110000,
  -- The three restored functions as 140000 found them: security definer, empty search_path, plpgsql, owned by the application
  -- owner, and the ACL the migration's owner gate requires (owner only; plus service_role on clear_all_parcels; no grant option).
  coalesce((select count(*)=3 and bool_and(coalesce(p.prosecdef and p.proconfig is not distinct from array['search_path=""']
      and p.prolang=(select oid from pg_language where lanname='plpgsql')
      and p.proowner=(select relowner from pg_class where oid=to_regclass('public.emails'))
      and (select count(*)=case when f.service then 2 else 1 end
          and bool_and(a.grantor=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable
            and (a.grantee=p.proowner or (f.service and a.grantee='service_role'::regrole::oid)))
          and (not f.service or bool_or(a.grantee='service_role'::regrole::oid))
        from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),false))
    from (values ('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)',false),
      ('public.clear_all_parcels(uuid)',true),('public.purge_old_screen_events()',false)) f(sig,service)
    join pg_proc p on p.oid=to_regprocedure(f.sig)),false) as restored_settings_owner_acl,
  (select count(*)=1 from cron.job where jobname='otodoke-purge-old-screen-events'
    and command='select public.purge_old_screen_events()' and schedule='30 18 * * *' and active) as same_daily_job
) checks;
