-- Run right after applying 20261125100000_mail_intake_window.sql (before: ...before.sql).
-- Returns ONE row: verdict first ('OK' only when every check column is t), then the checks, then counts.
-- Rollback: supabase/rollback/20261125100000_mail_intake_window.down.sql. Reads only.
select
  case when c.tables and c.closed and c.digest and c.digest_index and c.claim_fn and c.log_fn and c.acl then 'OK' else 'FAILED' end as verdict,
  c.tables, c.closed, c.digest, c.digest_index, c.claim_fn, c.log_fn, c.acl,
  (select count(*) from public.mail_intake_user_counts) as user_count_rows,
  (select count(*) from public.mail_intake_global_counts) as global_count_rows
from (select
  -- Both tables, with the columns the functions use, and the user rows tied to the account.
  (select count(*) = 9 from information_schema.columns where table_schema = 'public'
     and ((table_name = 'mail_intake_user_counts' and column_name in ('user_id', 'kind', 'day', 'count', 'bytes'))
       or (table_name = 'mail_intake_global_counts' and column_name in ('kind', 'day', 'count', 'bytes')))
  ) and exists (select 1 from pg_constraint where conrelid = 'public.mail_intake_user_counts'::regclass and contype = 'f'
                and confrelid = 'auth.users'::regclass and confdeltype = 'c') as tables,
  -- Row-level security on, no policy, and no table privilege for the API roles.
  (select bool_and(c2.relrowsecurity) from pg_class c2 where c2.oid in ('public.mail_intake_user_counts'::regclass, 'public.mail_intake_global_counts'::regclass))
    and not exists (select 1 from pg_policy where polrelid in ('public.mail_intake_user_counts'::regclass, 'public.mail_intake_global_counts'::regclass))
    and not exists (select 1 from information_schema.role_table_grants where table_schema = 'public'
                    and table_name in ('mail_intake_user_counts', 'mail_intake_global_counts')
                    and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) as closed,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'screen_events'
          and column_name = 'delivery_digest' and data_type = 'bytea' and is_nullable = 'YES') as digest,
  exists (select 1 from pg_index i where i.indexrelid = to_regclass('public.screen_events_delivery_digest_idx') and i.indisunique
          and i.indrelid = 'public.screen_events'::regclass and i.indnkeyatts = 2) as digest_index,
  exists (select 1 from pg_proc where oid = to_regprocedure('public.claim_mail_intake(uuid,text,bigint,jsonb)') and prosecdef
          and proconfig is not distinct from array['search_path=""'] and prorettype = 'text'::regtype
          and position('for key share' in prosrc) > 0 and position('for update' in prosrc) > 0) as claim_fn,
  exists (select 1 from pg_proc where oid = to_regprocedure('public.log_screen_event(uuid,jsonb,jsonb)') and prosecdef
          and proconfig is not distinct from array['search_path=""'] and prorettype = 'text'::regtype
          and position('public.claim_mail_intake(' in prosrc) > 0 and position('unique_violation' in prosrc) > 0) as log_fn,
  -- EXECUTE: the owner and service_role only.
  (select bool_and(
      (select count(*) = 2 and bool_and(a.grantee in (p.proowner, 'service_role'::regrole::oid)) and bool_or(a.grantee = 'service_role'::regrole::oid)
         from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.privilege_type = 'EXECUTE'))
     from pg_proc p where p.oid in (to_regprocedure('public.claim_mail_intake(uuid,text,bigint,jsonb)'), to_regprocedure('public.log_screen_event(uuid,jsonb,jsonb)'))
  ) and (select count(*) = 2 from pg_proc p where p.oid in (to_regprocedure('public.claim_mail_intake(uuid,text,bigint,jsonb)'), to_regprocedure('public.log_screen_event(uuid,jsonb,jsonb)'))) as acl
) c;
