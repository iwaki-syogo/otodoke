-- "This is not a parcel", stage 2: the automatic mark, the "seen" time behind the list-bottom row, and a restore that can be pressed twice.
-- Nothing of stage 1 changes shape: exclude_parcel stays `returns text`, excluded_parcels() keeps its 11 columns
-- (first-stage Web and iOS read them by name). New things are only added beside them:
--   table  excluded_seen                        one "seen until" time per person
--   user   has_open_auto_exclusion()            is there an automatic, not yet arrived, not yet seen mark (boolean, no count)
--   user   mark_auto_excluded_seen(timestamptz) writes the seen time (least(now()), never goes back)
--   user   excluded_parcels_unseen()            read-only: kind, created_at and unseen per mark (the 11 columns stay as they are)
--   user   auto_exclusion_would_start(uuid)     read-only: would the next mail of this pressed group be marked automatically
--   server mark_rule_exclusion(...)             ingestion only (service role): one statement that looks at the parcel row as it is now
-- restore_parcel is replaced (same signature and type): a parcel of the person's own that has no mark is now 'ok'
-- (pressing "put back" twice), and 'gone' means only "no such parcel of yours".
-- Lock order of the new writer: auth owner U -> generation G (lock_sample_owner) -> parcel owner L (lock_parcel_owner), the same as exclude_parcel.
-- update_mail_parcel and create_mail_parcel take the same L, so a mark and an ingestion update always line up.
-- Rollback: supabase/rollback/20261117110000_parcel_exclusions_auto.down.sql (put the Web back to the stage-1 build first;
-- it also removes the automatic marks, kind='rule', so nothing stays hidden without the list-bottom row; the pressed marks stay)
-- The server (service role) writes parcel_exclusions directly (insert/update/delete), not through mail_run_write: this is the one
-- exception to "server writes go through the gate"; the table is not part of the gateway's table list.
-- Applying together with the earlier migration in one `db push`: the gate below needs 20261117100000 in the migration history.
-- If it stops here with 55000 before that row is written, check the state and run `db push` once more.
begin;
set local lock_timeout='5s';

do $auto_gate$
declare
  v_owner oid := (select relowner from pg_class where oid=to_regclass('public.emails'));
begin
  if to_regclass('supabase_migrations.schema_migrations') is null
    or not exists(select 1 from pg_attribute where attrelid=to_regclass('supabase_migrations.schema_migrations') and attname='version' and not attisdropped) then
    raise exception 'parcel exclusions auto require actual migration history' using errcode='55000';
  end if;
  if not exists(select 1 from supabase_migrations.schema_migrations where version::text='20261117100000') then
    raise exception 'parcel exclusions auto require applied 20261117100000' using errcode='55000';
  end if;
  if v_owner is null or (select oid from pg_roles where rolname=current_user) is distinct from v_owner then
    raise exception 'parcel exclusions auto must be applied as the existing application owner' using errcode='55000';
  end if;
  if not (
    to_regclass('public.parcel_exclusions') is not null
    and to_regprocedure('public.lock_sample_owner(uuid)') is not null
    and to_regprocedure('public.lock_parcel_owner(uuid)') is not null
    and to_regprocedure('public.exclude_parcel(uuid)') is not null
    and to_regprocedure('public.restore_parcel(uuid)') is not null
    and to_regprocedure('public.excluded_parcels()') is not null
    and exists(select 1 from pg_attribute where attrelid=to_regclass('public.parcels') and attname='expected_text' and not attisdropped)
    and exists(select 1 from pg_attribute where attrelid=to_regclass('public.parcels') and attname='requires_presence' and not attisdropped)
  ) then
    raise exception 'parcel exclusions auto prerequisite objects are missing' using errcode='55000';
  end if;
  -- Stage 1 must still be in its stage-1 shape: exclude_parcel returns text, excluded_parcels keeps its 11 columns.
  if pg_get_function_result(to_regprocedure('public.exclude_parcel(uuid)')) is distinct from 'text'
    or (select cardinality(p.proargnames) from pg_proc p where p.oid=to_regprocedure('public.excluded_parcels()')) is distinct from 11 then
    raise exception 'stage 1 functions changed shape; review before applying' using errcode='55000';
  end if;
  -- restore_parcel is either the stage-1 body or (a re-run) this migration's own body.
  if not exists(select 1 from pg_proc p where p.oid=to_regprocedure('public.restore_parcel(uuid)') and p.proowner=v_owner
    and p.prosecdef and p.proconfig=array['search_path=""']
    and (md5(p.prosrc)='23fe0c7677e6e01af5a2ba6f0cbb00ad' or p.prosrc like '%-- stage2: an unmarked parcel of the person is ok%')) then
    raise exception 'restore_parcel changed since stage 1; review before applying' using errcode='55000';
  end if;
  -- Nothing of the new names may already exist in another shape.
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and ((p.proname='has_open_auto_exclusion' and p.oid is distinct from to_regprocedure('public.has_open_auto_exclusion()'))
        or (p.proname='mark_auto_excluded_seen' and p.oid is distinct from to_regprocedure('public.mark_auto_excluded_seen(timestamptz)'))
        or (p.proname='excluded_parcels_unseen' and p.oid is distinct from to_regprocedure('public.excluded_parcels_unseen()'))
        or (p.proname='auto_exclusion_would_start' and p.oid is distinct from to_regprocedure('public.auto_exclusion_would_start(uuid)'))
        or (p.proname='mark_rule_exclusion' and p.oid is distinct from to_regprocedure('public.mark_rule_exclusion(uuid,uuid,text,text)'))
        or (p.proname in ('has_open_auto_exclusion','mark_auto_excluded_seen','excluded_parcels_unseen','auto_exclusion_would_start','mark_rule_exclusion')
          and p.proowner is distinct from v_owner)))
    or (to_regclass('public.excluded_seen') is not null
      and (select relowner from pg_class where oid=to_regclass('public.excluded_seen')) is distinct from v_owner) then
    raise exception 'parcel exclusion auto names already exist in another shape' using errcode='55000';
  end if;
end $auto_gate$;

-- One "seen until" time per person (the row at the bottom of the list disappears when the person has seen the automatic marks).
create table if not exists public.excluded_seen (
  user_id               uuid primary key references auth.users(id) on delete cascade,
  auto_excluded_seen_at timestamptz not null
);
alter table public.excluded_seen enable row level security;
revoke all on public.excluded_seen from public, anon, authenticated, service_role;
grant select on public.excluded_seen to authenticated;
grant all on public.excluded_seen to service_role;
drop policy if exists "own excluded seen" on public.excluded_seen;
create policy "own excluded seen" on public.excluded_seen for select to authenticated using (user_id = auth.uid());

-- Is there an automatic mark on a parcel that has not arrived yet and that the person has not seen? One boolean, never a count.
create or replace function public.has_open_auto_exclusion() returns boolean
language plpgsql stable security definer set search_path='' as $$
declare v_user uuid; v_seen timestamptz;
begin
  v_user := auth.uid();
  if v_user is null then raise exception 'signed in owner required' using errcode='42501'; end if;
  select s.auto_excluded_seen_at into v_seen from public.excluded_seen s where s.user_id=v_user;
  return exists(select 1 from public.parcel_exclusions x join public.parcels p on p.id=x.parcel_id and p.user_id=x.user_id
    where x.user_id=v_user and x.kind='rule' and p.status not in ('delivered','cancelled')
      and (v_seen is null or x.created_at>v_seen));
end $$;

-- Write the seen time. Called from the client after the list has been drawn. The time is what the screen read, so a mark made
-- after the read is not "seen"; a future time is rounded down to now(); an older time never moves it back.
create or replace function public.mark_auto_excluded_seen(p_seen_until timestamptz) returns text
language plpgsql security definer set search_path='' as $$
declare v_user uuid;
begin
  v_user := auth.uid();
  if v_user is null then raise exception 'signed in owner required' using errcode='42501'; end if;
  -- least() ignores null, so a missing time must not reach it (it would become now()).
  if p_seen_until is null or not isfinite(p_seen_until) then raise exception 'seen time required' using errcode='22023'; end if;
  insert into public.excluded_seen as s(user_id,auto_excluded_seen_at) values (v_user,least(p_seen_until,now()))
    on conflict (user_id) do update set auto_excluded_seen_at=greatest(s.auto_excluded_seen_at,excluded.auto_excluded_seen_at);
  return 'ok';
end $$;

-- The 11 columns of excluded_parcels() stay as they are (excluded_at is the mark's created_at, kind is 'user' or 'rule').
-- What it cannot say - was the mark made after the person last looked - is here, read-only, one row per mark.
create or replace function public.excluded_parcels_unseen()
returns table(parcel_id uuid, kind text, created_at timestamptz, unseen boolean)
language plpgsql stable security definer set search_path='' as $$
declare v_user uuid; v_seen timestamptz;
begin
  v_user := auth.uid();
  if v_user is null then raise exception 'signed in owner required' using errcode='42501'; end if;
  select s.auto_excluded_seen_at into v_seen from public.excluded_seen s where s.user_id=v_user;
  return query
    select x.parcel_id, x.kind, x.created_at, (v_seen is null or x.created_at>v_seen)
    from public.parcel_exclusions x join public.parcels p on p.id=x.parcel_id and p.user_id=x.user_id
    where x.user_id=v_user
    order by x.created_at desc, x.parcel_id;
end $$;

-- Read-only: after the person pressed "not a parcel" on this parcel, will mail of the same group now be marked automatically?
-- True only when the person's own counted mark exists and: two or more counted marks of the person share its sender domain and kind of mail,
-- the kind is order or payment, the domain is not on the list of domains that are never marked automatically, and the person has no
-- unmarked parcel with a mail from that domain. What the database cannot see (a hand-forwarded mail, the person's own domain) is already
-- folded into `counted`, which is false then.
-- The list below is a copy of NO_AUTO_EXCLUDE_DOMAINS in src/lib/screen-senders.ts; src/lib/__tests__/no-auto-exclude-migration.test.ts keeps the two equal.
create or replace function public.auto_exclusion_would_start(p_parcel_id uuid) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare v_user uuid; v_domain text; v_relevance text;
begin
  v_user := auth.uid();
  if v_user is null then raise exception 'signed in owner required' using errcode='42501'; end if;
  if p_parcel_id is null then return false; end if;
  select x.from_domain, x.relevance into v_domain, v_relevance from public.parcel_exclusions x
    where x.parcel_id=p_parcel_id and x.user_id=v_user and x.kind='user' and x.counted;
  if not found or v_domain is null or v_relevance is null then return false; end if;
  if v_relevance not in ('order','payment') then return false; end if;
  -- never-auto-domains:start
  if v_domain = any(array['mail.yahoo.co.jp']) then return false; end if;
  -- never-auto-domains:end
  if (select count(*) from public.parcel_exclusions x where x.user_id=v_user and x.kind='user' and x.counted
      and x.from_domain=v_domain and x.relevance=v_relevance) < 2 then return false; end if;
  if exists(select 1 from public.parcels p where p.user_id=v_user
      and not exists(select 1 from public.parcel_exclusions e where e.parcel_id=p.id)
      and exists(select 1 from public.extractions r join public.emails m on m.id=r.email_id
        where r.parcel_id=p.id and r.user_id=v_user and m.from_domain=v_domain)) then return false; end if;
  return true;
end $$;

-- Ingestion only. The lock first (same as update_mail_parcel / create_mail_parcel), then ONE statement that reads the parcel row as it is
-- now: after a shipping mail updated the parcel (waited for by the lock) the statement inserts nothing. Returns the rows inserted (0 or 1).
-- counted is false: an automatic mark never counts toward the next automatic mark.
create or replace function public.mark_rule_exclusion(p_user uuid, p_parcel_id uuid, p_from_domain text, p_relevance text) returns integer
language plpgsql security definer set search_path='' as $$
declare v_rows integer;
begin
  if p_user is null or p_parcel_id is null then raise exception 'owner and parcel required' using errcode='22023'; end if;
  perform public.lock_sample_owner(p_user);
  perform public.lock_parcel_owner(p_user);
  insert into public.parcel_exclusions(parcel_id,user_id,kind,from_domain,relevance,counted)
    select p.id,p.user_id,'rule',p_from_domain,p_relevance,false from public.parcels p
    where p.id=p_parcel_id and p.user_id=p_user and p.source='mail' and p.status in ('unknown','ordered')
      and p.tracking_number is null and p.carrier is null and p.expected_date is null and p.expected_text is null
      and p.expected_window_start is null and p.expected_window_end is null and p.requires_presence is not true
    on conflict (parcel_id) do nothing;
  get diagnostics v_rows = row_count;
  return v_rows;
end $$;

-- stage2: an unmarked parcel of the person is ok (pressing "put back" twice); 'gone' = no such parcel of yours.
create or replace function public.restore_parcel(p_parcel_id uuid) returns text
language plpgsql security definer set search_path='' as $$
declare v_user uuid;
begin
  -- stage2: an unmarked parcel of the person is ok (pressing "put back" twice)
  v_user := auth.uid();
  if v_user is null then raise exception 'signed in owner required' using errcode='42501'; end if;
  if p_parcel_id is null then return 'gone'; end if;
  perform public.lock_sample_owner(v_user);
  perform public.lock_parcel_owner(v_user);
  perform p.id from public.parcels p where p.id=p_parcel_id and p.user_id=v_user for update;
  if not found then return 'gone'; end if;
  delete from public.parcel_exclusions x where x.parcel_id=p_parcel_id and x.user_id=v_user;
  return 'ok';
end $$;

revoke all on function public.has_open_auto_exclusion(), public.mark_auto_excluded_seen(timestamptz), public.excluded_parcels_unseen(),
  public.auto_exclusion_would_start(uuid), public.mark_rule_exclusion(uuid,uuid,text,text), public.restore_parcel(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.has_open_auto_exclusion(), public.mark_auto_excluded_seen(timestamptz), public.excluded_parcels_unseen(),
  public.auto_exclusion_would_start(uuid), public.restore_parcel(uuid) to authenticated;
grant execute on function public.mark_rule_exclusion(uuid,uuid,text,text) to service_role;

commit;
