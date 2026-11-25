-- Run right after applying 20261125100000_mail_intake_window.sql (before: ...before.sql), as the role that applied it.
-- First a probe: both functions are called as their real owner (SECURITY DEFINER) for a user that does not exist, so
-- each must take its Auth row lock and answer 'mail intake owner no longer exists' before writing anything. A missing
-- privilege, any other error or a normal return stops this file with an error.
-- Then ONE row: verdict first ('OK' only when every check column is t), then the checks, then counts.
-- Missing output, an SQL error or FAILED means stop.
-- Rollback: supabase/rollback/20261125100000_mail_intake_window.down.sql. Writes nothing.
do $intake_lock_probe$
declare
  v_probe uuid := pg_catalog.gen_random_uuid();
  v_limits jsonb := '{"user_count":1,"user_bytes":1,"global_count":1,"global_bytes":1}';
  v_call text;
begin
  while exists (select 1 from auth.users where id = v_probe) loop
    v_probe := pg_catalog.gen_random_uuid();
  end loop;
  foreach v_call in array array['claim', 'log'] loop
    begin
      if v_call = 'claim' then
        perform public.claim_mail_intake(v_probe, 'forwarding_confirmation', 0, v_limits, null);
      else
        perform public.log_screen_event(v_probe, '{"decision":"dropped"}'::jsonb, v_limits);
      end if;
      raise exception 'mail intake verification: % returned for a user that does not exist', v_call using errcode = '55000';
    exception
      when foreign_key_violation then
        if sqlerrm is distinct from 'mail intake owner no longer exists' then
          raise exception 'mail intake verification: Auth row-lock probe failed (%: unexpected answer)', v_call using errcode = '55000';
        end if;
      when sqlstate '55000' then raise;
      when others then
        raise exception 'mail intake verification: Auth row-lock probe failed (%: SQLSTATE %)', v_call, sqlstate using errcode = '55000';
    end;
  end loop;
end $intake_lock_probe$;

select
  case when c.tables and c.closed and c.digest and c.digest_index and c.claim_fn and c.log_fn and c.acl and c.owners then 'OK' else 'FAILED' end as verdict,
  c.tables, c.closed, c.digest, c.digest_index, c.claim_fn, c.log_fn, c.acl, c.owners,
  (select count(*) from public.mail_intake_user_counts) as user_count_rows,
  (select count(*) from public.mail_intake_global_counts) as global_count_rows,
  (select count(*) from public.mail_intake_claims) as claim_rows
from (select
  -- The three tables, with the columns the functions use, and the user rows tied to the account.
  (select count(*) = 13 from information_schema.columns where table_schema = 'public'
     and ((table_name = 'mail_intake_user_counts' and column_name in ('user_id', 'kind', 'day', 'count', 'bytes'))
       or (table_name = 'mail_intake_global_counts' and column_name in ('kind', 'day', 'count', 'bytes'))
       or (table_name = 'mail_intake_claims' and column_name in ('user_id', 'kind', 'delivery_digest', 'day')))
  ) and (select count(*) = 2 from pg_constraint where contype = 'f' and confrelid = 'auth.users'::regclass and confdeltype = 'c'
          and conrelid in ('public.mail_intake_user_counts'::regclass, 'public.mail_intake_claims'::regclass)) as tables,
  -- Row-level security on, no policy, and no table privilege for the API roles.
  (select bool_and(c2.relrowsecurity) and count(*) = 3 from pg_class c2 where c2.oid in
     ('public.mail_intake_user_counts'::regclass, 'public.mail_intake_global_counts'::regclass, 'public.mail_intake_claims'::regclass))
    and not exists (select 1 from pg_policy where polrelid in
     ('public.mail_intake_user_counts'::regclass, 'public.mail_intake_global_counts'::regclass, 'public.mail_intake_claims'::regclass))
    and not exists (select 1 from information_schema.role_table_grants where table_schema = 'public'
                    and table_name in ('mail_intake_user_counts', 'mail_intake_global_counts', 'mail_intake_claims')
                    and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')) as closed,
  exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'screen_events'
          and column_name = 'delivery_digest' and data_type = 'bytea' and is_nullable = 'YES') as digest,
  exists (select 1 from pg_index i where i.indexrelid = to_regclass('public.screen_events_delivery_digest_idx') and i.indisunique
          and i.indrelid = 'public.screen_events'::regclass and i.indnkeyatts = 2) as digest_index,
  -- Exactly the two functions of these names, with these signatures.
  exists (select 1 from pg_proc where oid = to_regprocedure('public.claim_mail_intake(uuid,text,bigint,jsonb,text)') and prosecdef
          and proconfig is not distinct from array['search_path=""'] and prorettype = 'text'::regtype
          and position('for key share' in prosrc) > 0 and position('for update' in prosrc) > 0
          and position('public.mail_intake_claims' in prosrc) > 0
          -- A claim older than yesterday is not taken as this delivery's place.
          and position('day >= v_day - 1' in prosrc) > 0 and position('do update set day = excluded.day' in prosrc) > 0) as claim_fn,
  exists (select 1 from pg_proc where oid = to_regprocedure('public.log_screen_event(uuid,jsonb,jsonb)') and prosecdef
          and proconfig is not distinct from array['search_path=""'] and prorettype = 'text'::regtype
          and position('public.claim_mail_intake(' in prosrc) > 0 and position('unique_violation' in prosrc) > 0)
    and (select count(*) = 2 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname in ('claim_mail_intake', 'log_screen_event')) as log_fn,
  -- EXECUTE: the owner and service_role only.
  (select bool_and(
      (select count(*) = 2 and bool_and(a.grantee in (p.proowner, 'service_role'::regrole::oid)) and bool_or(a.grantee = 'service_role'::regrole::oid)
         from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.privilege_type = 'EXECUTE'))
     from pg_proc p where p.oid in (to_regprocedure('public.claim_mail_intake(uuid,text,bigint,jsonb,text)'), to_regprocedure('public.log_screen_event(uuid,jsonb,jsonb)'))
  ) and (select count(*) = 2 from pg_proc p where p.oid in (to_regprocedure('public.claim_mail_intake(uuid,text,bigint,jsonb,text)'), to_regprocedure('public.log_screen_event(uuid,jsonb,jsonb)'))) as acl,
  -- Both owned by the owner of screen_events, which can lock auth.users rows (the probe above ran it for real).
  (select count(*) = 2 and bool_and(p.proowner = (select relowner from pg_class where oid = 'public.screen_events'::regclass)
      and coalesce(has_schema_privilege(p.proowner, to_regnamespace('auth'), 'USAGE')
        and has_column_privilege(p.proowner, to_regclass('auth.users'), 'id', 'SELECT')
        and has_any_column_privilege(p.proowner, to_regclass('auth.users'), 'UPDATE'), false))
     from pg_proc p where p.oid in (to_regprocedure('public.claim_mail_intake(uuid,text,bigint,jsonb,text)'), to_regprocedure('public.log_screen_event(uuid,jsonb,jsonb)'))
  ) as owners
) c;
