-- "This is not a parcel": a mark that hides a parcel from the person without deleting it.
-- The mark lives in its own table. A RESTRICTIVE select policy on parcels hides every marked
-- row from the user session (list, calendar, spend, detail), so no client needs to change.
-- The user session never writes the table: three SECURITY DEFINER functions do, and the
-- server (service role) writes it directly.
-- Lock order of the two writers (same as ingestion): auth owner U -> generation G -> parcel owner L -> parcel row.
-- Emails are only read (no row lock), so no email lock is taken.
-- mark_parcels_received / restore_parcel_receipts are replaced only to skip marked rows; their bodies are
-- otherwise byte-for-byte the 130000 ones (the gate pins this).
-- Rollback: supabase/rollback/20261117100000_parcel_exclusions.down.sql
begin;
set local lock_timeout='5s';

do $exclusions_gate$
declare
  v_owner oid := (select relowner from pg_class where oid=to_regclass('public.emails'));
  v_added constant text := ' and not exists(select 1 from public.parcel_exclusions e where e.parcel_id=p.id)';
begin
  if to_regclass('supabase_migrations.schema_migrations') is null
    or not exists(select 1 from pg_attribute where attrelid=to_regclass('supabase_migrations.schema_migrations') and attname='version' and not attisdropped) then
    raise exception 'parcel exclusions require actual migration history' using errcode='55000';
  end if;
  if (select count(distinct version::text) from supabase_migrations.schema_migrations where version::text in ('20261113130000','20261113140000'))<>2 then
    raise exception 'parcel exclusions require applied 130000 and 140000' using errcode='55000';
  end if;
  if v_owner is null or (select oid from pg_roles where rolname=current_user) is distinct from v_owner then
    raise exception 'parcel exclusions must be applied as the existing application owner' using errcode='55000';
  end if;
  if not (
    to_regprocedure('public.lock_sample_owner(uuid)') is not null
    and to_regprocedure('public.lock_parcel_owner(uuid)') is not null
    and to_regprocedure('public.is_shared_mail_domain(text)') is not null
    and to_regprocedure('public.clear_all_parcels(uuid)') is not null
    and exists(select 1 from pg_attribute where attrelid=to_regclass('public.emails') and attname='from_domain' and not attisdropped)
    and exists(select 1 from pg_attribute where attrelid=to_regclass('public.emails') and attname='sample_generation' and not attisdropped)
    and exists(select 1 from pg_attribute where attrelid=to_regclass('public.parcels') and attname='source' and not attisdropped)
    and exists(select 1 from pg_attribute where attrelid=to_regclass('public.extractions') and attname='result' and not attisdropped)
  ) then
    raise exception 'parcel exclusions prerequisite objects are missing' using errcode='55000';
  end if;
  -- The two functions replaced here: one each, owned by the application owner, executable by authenticated only,
  -- and either the 130000 body or that body plus exactly the four added conditions.
  if exists(select 1 from (values ('mark_parcels_received','266c7b11c6af28f28aa06cd435315db8'),('restore_parcel_receipts','19d60a59dcb759c1f51b55d507d1dec8')) f(name,body_md5)
    where (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=f.name)<>1
      or not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=f.name
        and p.proowner=v_owner and p.prosecdef and p.proconfig=array['search_path=""']
        and md5(replace(p.prosrc,v_added,''))=f.body_md5
        and (select count(*)=2 and bool_and(a.grantor=p.proowner and a.privilege_type='EXECUTE' and not a.is_grantable
            and a.grantee in (p.proowner,'authenticated'::regrole::oid))
          from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a))) then
    raise exception 'receipt functions changed since 130000; review before applying' using errcode='55000';
  end if;
  -- Nothing of this name may already exist in another shape.
  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and ((p.proname='exclude_parcel' and p.oid is distinct from to_regprocedure('public.exclude_parcel(uuid)'))
        or (p.proname='restore_parcel' and p.oid is distinct from to_regprocedure('public.restore_parcel(uuid)'))
        or (p.proname='excluded_parcels' and p.oid is distinct from to_regprocedure('public.excluded_parcels()'))
        or (p.proname in ('exclude_parcel','restore_parcel','excluded_parcels') and p.proowner is distinct from v_owner)))
    or (to_regclass('public.parcel_exclusions') is not null
      and (select relowner from pg_class where oid=to_regclass('public.parcel_exclusions')) is distinct from v_owner) then
    raise exception 'parcel exclusion names already exist in another shape' using errcode='55000';
  end if;
end $exclusions_gate$;

create table if not exists public.parcel_exclusions (
  parcel_id   uuid primary key references public.parcels(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('user','rule')),  -- user = the person pressed it / rule = automatic
  from_domain text,          -- emails.from_domain of the parcel's first mail (null if none)
  relevance   text,          -- extraction relevance of the parcel's first mail (null if none)
  counted     boolean not null default true,  -- false = never counted toward automatic marking (sample mail, shared domain)
  created_at  timestamptz not null default now()
);
create index if not exists parcel_exclusions_user_sender_idx
  on public.parcel_exclusions (user_id, from_domain, relevance) where kind = 'user' and counted;
create index if not exists parcel_exclusions_user_idx on public.parcel_exclusions (user_id, created_at desc);

-- parcels has no unique (id, user_id), so a composite foreign key is not possible. A trigger checks instead that the
-- mark's user_id is the parcel's owner (a mismatch would neither hide the parcel for its owner's count nor be found).
create or replace function public.parcel_exclusion_owner_check() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if not exists(select 1 from public.parcels p where p.id=new.parcel_id and p.user_id=new.user_id) then
    raise exception 'parcel exclusion owner must be the parcel owner' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.parcel_exclusion_owner_check() from public, anon, authenticated, service_role;
drop trigger if exists parcel_exclusion_owner_check on public.parcel_exclusions;
create trigger parcel_exclusion_owner_check before insert or update of parcel_id, user_id on public.parcel_exclusions
  for each row execute function public.parcel_exclusion_owner_check();

-- Only parcels is hidden. Its items, extractions and emails stay readable by the owner (intended).
-- A restrictive select policy also applies to update and delete, but only to writes that read the row
-- (WHERE or RETURNING); a hidden row is then neither changed nor removed (0 rows).
alter table public.parcel_exclusions enable row level security;
revoke all on public.parcel_exclusions from public, anon, authenticated, service_role;
grant select on public.parcel_exclusions to authenticated;   -- the restrictive policy below reads it with the user's rights
grant all on public.parcel_exclusions to service_role;

-- user_id = auth.uid() ONLY. It must never read parcels: the policy on parcels reads this table.
drop policy if exists "own parcel exclusions" on public.parcel_exclusions;
create policy "own parcel exclusions" on public.parcel_exclusions
  for select to authenticated using (user_id = auth.uid());

-- RESTRICTIVE: ANDed with the existing permissive "own parcels" for all. A permissive policy here would hide nothing.
drop policy if exists "hide excluded parcels" on public.parcels;
create policy "hide excluded parcels" on public.parcels
  as restrictive for select to authenticated
  using (not exists (select 1 from public.parcel_exclusions e where e.parcel_id = parcels.id));

create or replace function public.exclude_parcel(p_parcel_id uuid) returns text
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid; v_parcel public.parcels%rowtype; v_domain text; v_relevance text; v_sample uuid; v_counted boolean; v_done uuid;
begin
  v_user := auth.uid();
  if v_user is null then raise exception 'signed in owner required' using errcode='42501'; end if;
  if p_parcel_id is null then return 'gone'; end if;
  perform public.lock_sample_owner(v_user);
  perform public.lock_parcel_owner(v_user);
  select p.* into v_parcel from public.parcels p where p.id=p_parcel_id and p.user_id=v_user for update;
  if not found then return 'gone'; end if;
  if v_parcel.source='manual' then return 'manual'; end if;
  -- The first mail: the oldest extraction that points at this parcel. Mails are only read, never locked.
  -- Oldest by the mail's own sent_at (nulls last), ties by read time then id. A reading that says the reader is the
  -- sender (inbound = false with confidence >= 0.6, the isOutbound rule) is skipped.
  select e.from_domain, e.sample_generation, x.result->>'relevance' into v_domain, v_sample, v_relevance
    from public.extractions x join public.emails e on e.id=x.email_id
    where x.parcel_id=p_parcel_id and x.user_id=v_user
      and not ((x.result->'inbound'->>'value')='false'
        and coalesce(case when (x.result->'inbound'->>'confidence') ~ '^[0-9]+(\.[0-9]+)?$' then (x.result->'inbound'->>'confidence')::numeric end,0)>=0.6)
    order by e.sent_at asc nulls last, x.created_at, x.id limit 1;
  if not found then v_domain := null; v_relevance := null; v_sample := null; end if;
  -- No first mail, or no domain: nothing to count by, so never counted.
  v_counted := v_domain is not null and v_sample is null and not public.is_shared_mail_domain(v_domain);
  -- A mark by the person replaces an automatic one. A mark by the person that already exists stays as it is (still 'ok').
  insert into public.parcel_exclusions as x(parcel_id,user_id,kind,from_domain,relevance,counted)
    values (p_parcel_id,v_user,'user',v_domain,v_relevance,v_counted)
    on conflict (parcel_id) do update set kind='user',from_domain=excluded.from_domain,relevance=excluded.relevance,
      counted=excluded.counted,created_at=now() where x.kind='rule'
    returning x.parcel_id into v_done;
  return 'ok';
end $$;

create or replace function public.restore_parcel(p_parcel_id uuid) returns text
language plpgsql security definer set search_path='' as $$
declare v_user uuid; v_id uuid;
begin
  v_user := auth.uid();
  if v_user is null then raise exception 'signed in owner required' using errcode='42501'; end if;
  if p_parcel_id is null then return 'gone'; end if;
  perform public.lock_sample_owner(v_user);
  perform public.lock_parcel_owner(v_user);
  perform p.id from public.parcels p where p.id=p_parcel_id and p.user_id=v_user for update;
  if not found then return 'gone'; end if;
  delete from public.parcel_exclusions x where x.parcel_id=p_parcel_id and x.user_id=v_user returning x.parcel_id into v_id;
  if v_id is null then return 'gone'; end if;
  return 'ok';
end $$;

-- The person's marked parcels, newest mark first, with what a list row shows. Reads past the restrictive policy on purpose.
create or replace function public.excluded_parcels()
returns table(parcel_id uuid, kind text, excluded_at timestamptz, shop text, title text, status text, ordered_at date,
  expected_date date, total_amount integer, carrier text, item_names text[])
language plpgsql stable security definer set search_path='' as $$
declare v_user uuid;
begin
  v_user := auth.uid();
  if v_user is null then raise exception 'signed in owner required' using errcode='42501'; end if;
  return query
    select p.id, x.kind, x.created_at, p.shop, p.title, p.status, p.ordered_at, p.expected_date, p.total_amount, p.carrier,
      coalesce((select array_agg(i.name order by i.created_at, i.id) from public.parcel_items i where i.parcel_id=p.id),array[]::text[])
    from public.parcel_exclusions x join public.parcels p on p.id=x.parcel_id and p.user_id=x.user_id
    where x.user_id=v_user
    order by x.created_at desc, x.parcel_id;
end $$;

revoke all on function public.exclude_parcel(uuid), public.restore_parcel(uuid), public.excluded_parcels() from public, anon, authenticated, service_role;
grant execute on function public.exclude_parcel(uuid), public.restore_parcel(uuid), public.excluded_parcels() to authenticated;

-- mark_parcels_received / restore_parcel_receipts do not go through RLS: skip marked rows inside them.
-- Same bodies as 130000; the only change is the four ` and not exists(... parcel_exclusions ...)` conditions.
create or replace function public.mark_parcels_received(p_ids uuid[])
returns table(id uuid,outcome text,receipt_id uuid,received_at timestamptz,updated_at timestamptz,previous_status text,previous_received_at timestamptz)
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid; v_id uuid; v_before public.parcels%rowtype; v_after public.parcels%rowtype;
  v_receipt public.parcel_receipt_undos%rowtype; v_token uuid; v_now timestamptz; v_expires timestamptz;
begin
  -- Bound the raw body before owner/generation/email/advisory locks or deduplication.
  if p_ids is null or cardinality(p_ids)>200 or (cardinality(p_ids)>0 and array_ndims(p_ids)<>1) then
    raise exception 'receipt request must contain at most 200 ids' using errcode='22023';
  end if;
  if cardinality(p_ids)=0 then return; end if;
  if array_position(p_ids,null) is not null then raise exception 'null receipt id' using errcode='22023'; end if;
  v_user := auth.uid();
  if v_user is null then raise exception 'signed in owner required' using errcode='42501'; end if;
  perform public.lock_sample_owner(v_user);
  perform e.id from public.emails e where e.user_id=v_user order by e.id for update;
  perform public.lock_parcel_owner(v_user);
  perform p.id from public.parcels p where p.user_id=v_user and p.id=any(p_ids) and not exists(select 1 from public.parcel_exclusions e where e.parcel_id=p.id) order by p.id for update;
  for v_id in select distinct x from unnest(p_ids) x order by x loop
    select p.* into v_before from public.parcels p where p.id=v_id and p.user_id=v_user and not exists(select 1 from public.parcel_exclusions e where e.parcel_id=p.id);
    if not found or v_before.status='cancelled' or (v_before.received_at is not null and not isfinite(v_before.received_at)) then
      return query select v_id,'changed'::text,null::uuid,null::timestamptz,null::timestamptz,null::text,null::timestamptz;
      continue;
    end if;
    if v_before.received_at is not null then
      return query select v_id,'already_received'::text,null::uuid,null::timestamptz,null::timestamptz,null::text,null::timestamptz;
      continue;
    end if;
    v_now := clock_timestamp(); v_expires := v_now + public.parcel_receipt_retention(); v_token := gen_random_uuid();
    update public.parcels p set status='delivered',received_at=v_now
      where p.id=v_id and p.user_id=v_user and p.updated_at=v_before.updated_at returning p.* into v_after;
    if not found or v_after.status is distinct from 'delivered' or v_after.received_at is distinct from v_now or v_after.updated_at is null then
      raise exception 'received parcel was not stored as requested' using errcode='42501';
    end if;
    insert into public.parcel_receipt_undos as j(parcel_id,user_id,receipt_id,previous_status,previous_received_at,written_received_at,written_updated_at,created_at,expires_at)
      values(v_id,v_user,v_token,v_before.status,v_before.received_at,v_after.received_at,v_after.updated_at,v_now,v_expires)
      on conflict(parcel_id) do update set user_id=excluded.user_id,receipt_id=excluded.receipt_id,
        previous_status=excluded.previous_status,previous_received_at=excluded.previous_received_at,
        written_received_at=excluded.written_received_at,written_updated_at=excluded.written_updated_at,
        undone_at=null,undone_updated_at=null,created_at=excluded.created_at,expires_at=excluded.expires_at
      returning j.* into v_receipt;
    if v_receipt.receipt_id is distinct from v_token or v_receipt.user_id is distinct from v_user
      or v_receipt.previous_status is distinct from v_before.status or v_receipt.previous_received_at is distinct from v_before.received_at
      or v_receipt.written_received_at is distinct from v_after.received_at or v_receipt.written_updated_at is distinct from v_after.updated_at
      or v_receipt.undone_at is not null or v_receipt.undone_updated_at is not null
      or v_receipt.created_at is distinct from v_now or v_receipt.expires_at is distinct from v_expires then
      raise exception 'receipt journal was not stored as requested' using errcode='42501';
    end if;
    return query select v_id,'written'::text,v_token,v_after.received_at,v_after.updated_at,v_before.status,v_before.received_at;
  end loop;
end $$;

create or replace function public.restore_parcel_receipts(p_receipts jsonb)
returns table(id uuid,outcome text)
language plpgsql security definer set search_path='' as $$
declare
  v_user uuid; v_key record; v_parcel public.parcels%rowtype; v_after public.parcels%rowtype;
  v_receipt public.parcel_receipt_undos%rowtype; v_journal public.parcel_receipt_undos%rowtype; v_now timestamptz;
begin
  if p_receipts is null or jsonb_typeof(p_receipts)<>'array' then raise exception 'undo receipts must be an array' using errcode='22023'; end if;
  if jsonb_array_length(p_receipts)>200 then raise exception 'undo request must contain at most 200 receipts' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_receipts) k where jsonb_typeof(k)<>'object'
    or jsonb_typeof(k->'id') is distinct from 'string' or jsonb_typeof(k->'receipt_id') is distinct from 'string'
    or k->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or k->>'receipt_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'invalid undo receipt' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_receipts) k group by (k->>'id')::uuid having count(distinct (k->>'receipt_id')::uuid)>1) then
    raise exception 'conflicting undo receipts' using errcode='22023';
  end if;
  if jsonb_array_length(p_receipts)=0 then return; end if;
  v_user := auth.uid();
  if v_user is null then raise exception 'signed in owner required' using errcode='42501'; end if;
  perform public.lock_sample_owner(v_user);
  perform e.id from public.emails e where e.user_id=v_user order by e.id for update;
  perform public.lock_parcel_owner(v_user);
  perform p.id from public.parcels p where p.user_id=v_user
    and p.id in(select (k->>'id')::uuid from jsonb_array_elements(p_receipts) k) and not exists(select 1 from public.parcel_exclusions e where e.parcel_id=p.id) order by p.id for update;
  for v_key in select distinct (k->>'id')::uuid as parcel_id,(k->>'receipt_id')::uuid as token from jsonb_array_elements(p_receipts) k order by parcel_id loop
    select p.* into v_parcel from public.parcels p where p.id=v_key.parcel_id and p.user_id=v_user and not exists(select 1 from public.parcel_exclusions e where e.parcel_id=p.id);
    -- Read the CURRENT journal only after R. A newer receive may have replaced its token.
    select j.* into v_receipt from public.parcel_receipt_undos j where j.parcel_id=v_key.parcel_id and j.user_id=v_user for update;
    if v_parcel.id is null then return query select v_key.parcel_id,'changed'::text; continue; end if;
    if v_receipt.parcel_id is null then return query select v_key.parcel_id,'failed'::text; continue; end if;
    if v_receipt.receipt_id is distinct from v_key.token then return query select v_key.parcel_id,'changed'::text; continue; end if;
    if v_receipt.expires_at<=clock_timestamp() then
      return query select v_key.parcel_id,'failed'::text; continue;
    end if;
    if v_receipt.undone_at is not null then
      if v_parcel.updated_at is not distinct from v_receipt.undone_updated_at
        and v_parcel.status is not distinct from v_receipt.previous_status and v_parcel.received_at is not distinct from v_receipt.previous_received_at then
        return query select v_key.parcel_id,'restored'::text;
      else return query select v_key.parcel_id,'changed'::text; end if;
      continue;
    end if;
    if v_parcel.status<>'delivered' or v_parcel.received_at is distinct from v_receipt.written_received_at
      or v_parcel.updated_at is distinct from v_receipt.written_updated_at then
      return query select v_key.parcel_id,'changed'::text; continue;
    end if;
    update public.parcels p set status=v_receipt.previous_status,
      received_at=case when v_receipt.previous_status='delivered' and v_receipt.previous_received_at is null then '-infinity'::timestamptz else v_receipt.previous_received_at end
      where p.id=v_key.parcel_id and p.user_id=v_user and p.updated_at=v_receipt.written_updated_at returning p.* into v_after;
    if not found or v_after.status is distinct from v_receipt.previous_status or v_after.received_at is distinct from v_receipt.previous_received_at then
      raise exception 'undo parcel was not stored as requested' using errcode='42501';
    end if;
    v_now := clock_timestamp();
    update public.parcel_receipt_undos j set undone_at=v_now,undone_updated_at=v_after.updated_at
      where j.parcel_id=v_key.parcel_id and j.receipt_id=v_key.token returning j.* into v_journal;
    if not found or v_journal.undone_at is distinct from v_now or v_journal.undone_updated_at is distinct from v_after.updated_at then
      raise exception 'undo receipt was not stored as requested' using errcode='42501';
    end if;
    return query select v_key.parcel_id,'restored'::text;
  end loop;
end $$;

revoke all on function public.mark_parcels_received(uuid[]),public.restore_parcel_receipts(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.mark_parcels_received(uuid[]),public.restore_parcel_receipts(jsonb) to authenticated;

commit;
