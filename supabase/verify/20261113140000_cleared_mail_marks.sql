-- Read-only check after applying 20261113140000. The LAST statement is the only result:
-- a column named verdict (OK or FAILED), then each check (t/f), then informational counts (no values or IDs).
-- SQL and concurrency behavior still require tests/postgres/run-cleared-mail-marks.mjs.
with checks as (
  select
    (select count(*)=6 and bool_and(case a.attname
        when 'user_id' then a.atttypid='uuid'::regtype when 'kind' then a.atttypid='text'::regtype
        when 'digest' then a.atttypid='bytea'::regtype when 'reason' then a.atttypid='text'::regtype
        when 'marked_at' then a.atttypid='timestamptz'::regtype when 'expires_at' then a.atttypid='timestamptz'::regtype else false end and a.attnotnull)
      from pg_attribute a where a.attrelid=to_regclass('public.cleared_mail_marks') and a.attnum>0 and not a.attisdropped) as table_columns,
    exists(select 1 from pg_constraint where conrelid=to_regclass('public.cleared_mail_marks') and contype='p'
      and (select array_agg(a.attname::text order by k.ord) from unnest(conkey) with ordinality k(attnum,ord)
        join pg_attribute a on a.attrelid=conrelid and a.attnum=k.attnum)=array['user_id','kind','digest']) as primary_key,
    exists(select 1 from pg_constraint where conrelid=to_regclass('public.cleared_mail_marks') and contype='f'
      and confrelid=to_regclass('auth.users') and confdeltype='c') as owner_fk_cascade,
    (select count(*)=2 from pg_constraint where conrelid=to_regclass('public.cleared_mail_marks') and contype='c'
      and (pg_get_constraintdef(oid) like '%provider_email_id%message_id%' or pg_get_constraintdef(oid) like '%clear_all%')) as value_checks,
    exists(select 1 from pg_indexes where schemaname='public' and tablename='cleared_mail_marks' and indexdef like '%(expires_at)%') as expiry_index,
    coalesce((select relrowsecurity from pg_class where oid=to_regclass('public.cleared_mail_marks')),false)
      and not exists(select 1 from pg_policy where polrelid=to_regclass('public.cleared_mail_marks')) as rls_without_policy,
    not has_table_privilege('anon','public.cleared_mail_marks','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege('authenticated','public.cleared_mail_marks','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      and not has_table_privilege('service_role','public.cleared_mail_marks','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') as table_private,
    (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='store_mail_run')
      and (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='store_mail_run_without_sample_fence')
      and (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='clear_all_parcels')
      and (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='purge_old_screen_events')
      and (select count(*)=1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='purge_expired_cleared_mail_marks') as one_of_each,
    -- Each row's condition is false, never NULL: bool_and skips a NULL row (a RESET search_path gives proconfig NULL).
    (select count(*)=4 and bool_and(coalesce(p.proconfig is not distinct from array['search_path=""'] and not has_function_privilege('anon',p.oid,'EXECUTE')
        and not has_function_privilege('authenticated',p.oid,'EXECUTE') and not has_function_privilege('service_role',p.oid,'EXECUTE'),false))
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in
        ('cleared_mail_mark_retention','cleared_mail_mark_clock_margin','purge_expired_cleared_mail_marks','purge_old_screen_events_before_cleared_mail_marks')) as helpers_private,
    has_function_privilege('service_role','public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb)','EXECUTE')
      and has_function_privilege('service_role','public.clear_all_parcels(uuid)','EXECUTE')
      and not has_function_privilege('anon','public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb)','EXECUTE')
      and not has_function_privilege('authenticated','public.store_mail_run(uuid,uuid,uuid,jsonb,timestamptz,jsonb)','EXECUTE')
      and not has_function_privilege('anon','public.clear_all_parcels(uuid)','EXECUTE')
      and not has_function_privilege('authenticated','public.clear_all_parcels(uuid)','EXECUTE')
      and not has_function_privilege('service_role','public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)','EXECUTE')
      and not has_function_privilege('service_role','public.purge_old_screen_events()','EXECUTE') as entry_acl,
    public.cleared_mail_mark_retention()=interval '35 days' and public.cleared_mail_mark_clock_margin()=interval '120 seconds' as constants,
    exists(select 1 from pg_proc where oid=to_regprocedure('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)')
      and prosrc like '%public.cleared_mail_marks%' and prosrc like '%x-otodoke-delivery-created-at%' and prosrc like '%''duplicate''%'
      and position('public.cleared_mail_marks' in prosrc) < position('from public.emails' || chr(10) || '      where user_id=p_user_id and provider_email_id=' in prosrc)) as store_checks_marks_first,
    exists(select 1 from pg_proc where oid=to_regprocedure('public.clear_all_parcels(uuid)')
      and prosrc like '%insert into public.cleared_mail_marks%' and prosrc like '%not like ''demo:%' and prosrc like '%order by d.kind, d.digest%'
      and position('insert into public.cleared_mail_marks' in prosrc) < position('delete from public.emails where' in prosrc)) as clear_marks_before_delete,
    exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events()')
      and prosrc like '%public.purge_old_screen_events_before_cleared_mail_marks()%' and prosrc like '%public.purge_expired_cleared_mail_marks()%')
      and exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_old_screen_events_before_cleared_mail_marks()')
        and md5(prosrc)='ca8e1192d5a430d1ada0681e9a9e6b36')
      and exists(select 1 from pg_proc where oid=to_regprocedure('public.purge_expired_cleared_mail_marks()')
        and prosrc like '%for update skip locked%' and prosrc like '%limit 10000%') as daily_purge_composed,
    -- The bodies the rollback accepts (its gate checks the same md5s): a later change to one reads FAILED here too.
    (select count(*)=5 and bool_and(coalesce(md5(p.prosrc)=f.body,false))
      from (values
        ('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)','be7af8ed6fc977c295dc2a02b9b3c3d7'),
        ('public.clear_all_parcels(uuid)','7f01239da961c4a877fea92788067f15'),
        ('public.purge_old_screen_events()','7748a3a410eccd04cf2b811e3a568de2'),
        ('public.purge_expired_cleared_mail_marks()','b4430bd1176b93f6f65f64c5d20e9472'),
        ('public.purge_old_screen_events_before_cleared_mail_marks()','ca8e1192d5a430d1ada0681e9a9e6b36')) f(sig,body)
      left join pg_proc p on p.oid=to_regprocedure(f.sig)) as bodies_as_applied,
    (select count(*)=1 from cron.job where jobname='otodoke-purge-old-screen-events'
      and command='select public.purge_old_screen_events()' and schedule='30 18 * * *' and active) as same_daily_job,
    -- Full check of everything this migration creates or replaces: owner = application owner (owner of public.emails),
    -- security definer as intended, empty search_path, language. A row that cannot be judged (NULL) is false.
    (select count(*)=7 and bool_and(coalesce(p.oid is not null and p.proowner=(select relowner from pg_class where oid=to_regclass('public.emails'))
        and p.prosecdef=f.definer and p.proconfig is not distinct from array['search_path=""']
        and p.prolang=(select oid from pg_language where lanname=f.lang),false))
      from (values
        ('public.cleared_mail_mark_retention()',false,'sql'),
        ('public.cleared_mail_mark_clock_margin()',false,'sql'),
        ('public.purge_expired_cleared_mail_marks()',true,'plpgsql'),
        ('public.purge_old_screen_events()',true,'plpgsql'),
        ('public.purge_old_screen_events_before_cleared_mail_marks()',true,'plpgsql'),
        ('public.clear_all_parcels(uuid)',true,'plpgsql'),
        ('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)',true,'plpgsql')) f(sig,definer,lang)
      left join pg_proc p on p.oid=to_regprocedure(f.sig)) as functions_owner_definer_path,
    -- ACL, the same condition as the rollback's owner gate (so OK here means that gate opens): exactly one EXECUTE entry
    -- for the owner (plus one for service_role on clear_all_parcels), each granted by the owner, none with grant option.
    -- anon, authenticated and PUBLIC hold nothing, also through role membership.
    (select count(*)=9 and bool_and(coalesce(p.oid is not null
        and p.proowner=(select relowner from pg_class where oid=to_regclass('public.emails'))
        and (select count(*)=case when f.service then 2 else 1 end
            and bool_and(a.grantor=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable
              and (a.grantee=p.proowner or (f.service and a.grantee='service_role'::regrole::oid)))
            and (not f.service or bool_or(a.grantee='service_role'::regrole::oid))
          from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a)
        and not has_function_privilege('anon',p.oid,'EXECUTE') and not has_function_privilege('authenticated',p.oid,'EXECUTE')
        and has_function_privilege('service_role',p.oid,'EXECUTE')=f.service,false))
      from (values
        ('public.cleared_mail_mark_retention()',false),
        ('public.cleared_mail_mark_clock_margin()',false),
        ('public.purge_expired_cleared_mail_marks()',false),
        ('public.purge_old_screen_events()',false),
        ('public.purge_old_screen_events_before_cleared_mail_marks()',false),
        ('public.clear_all_parcels(uuid)',true),
        ('public.store_mail_run_without_sample_fence(uuid,uuid,uuid,jsonb,timestamptz,jsonb)',false),
        ('public.lock_sample_owner(uuid)',false),
        ('public.expire_consent_waiting_row(uuid,timestamptz)',false)) f(sig,service)
      left join pg_proc p on p.oid=to_regprocedure(f.sig)) as functions_acl_exact,
    -- Table: owned by the application owner; no table or column grant to anyone else (PUBLIC, anon, authenticated, service_role included).
    coalesce((select c.relowner=(select relowner from pg_class where oid=to_regclass('public.emails'))
        and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee<>c.relowner)
        and not exists(select 1 from pg_attribute t where t.attrelid=c.oid and t.attacl is not null)
      from pg_class c where c.oid=to_regclass('public.cleared_mail_marks')),false) as table_owner_acl_exact
), inventory as (
  select count(*) as marks_total, count(*) filter (where expires_at<=clock_timestamp()) as marks_expired,
    count(*) filter (where kind='provider_email_id') as marks_provider_id, count(*) filter (where kind='message_id') as marks_message_id
  from public.cleared_mail_marks
)
select case when table_columns and primary_key and owner_fk_cascade and value_checks and expiry_index and rls_without_policy and table_private
  and one_of_each and helpers_private and entry_acl and constants and store_checks_marks_first and clear_marks_before_delete
  and daily_purge_composed and bodies_as_applied and same_daily_job and functions_owner_definer_path and functions_acl_exact and table_owner_acl_exact then 'OK' else 'FAILED' end as verdict,
  checks.*, inventory.* from checks cross join inventory;
