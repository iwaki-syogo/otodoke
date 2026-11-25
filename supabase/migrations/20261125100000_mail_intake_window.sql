-- A per-day intake allowance for the two kinds of incoming mail that are not stored as unread:
-- Gmail's forwarding confirmation (stored as already read) and the row a screened-out mail leaves in screen_events.
-- The unread storage allowance of store_mail_run does not count either of them.
--
-- 1. public.mail_intake_user_counts / public.mail_intake_global_counts: how many of each kind came in on a JST day and
--    how many bytes, per user and across all users. Counts only (no mail content). Rows older than yesterday are removed
--    by the next claim of the same kind (of the same user, for the user rows); a user's rows go with the account.
-- 2. public.claim_mail_intake(user, kind, bytes, limits) -> 'ok' | 'user_intake_limit' | 'global_intake_limit'.
--    One transaction: the owner's Auth row (KEY SHARE), then the user's row, then the global row, each FOR UPDATE.
--    It never touches emails, generations, consents or parcels, so it adds no edge to the U-G-E-C-L-R order.
-- 3. public.screen_events.delivery_digest (per-user SHA-256 of the decision and the mail's Message-ID or provider ID,
--    never the ID itself) with a unique index, and public.log_screen_event(user, event, limits) ->
--    'logged' | 'duplicate' | 'user_intake_limit' | 'global_intake_limit': the same delivery is logged once, and a new
--    one only within the allowance. A refused event changes nothing (the counts are not taken).
--
-- Both functions: SECURITY DEFINER, search_path '', EXECUTE for service_role only.
-- Safe to apply twice. Applied as the owner of public.screen_events; this file never changes OWNER or GRANT of
-- anything it did not create.
-- Before:   supabase/verify/20261125100000_mail_intake_window.before.sql
-- After:    supabase/verify/20261125100000_mail_intake_window.sql
-- Rollback: supabase/rollback/20261125100000_mail_intake_window.down.sql
--           (then supabase/verify/20261125100000_mail_intake_window.rolled-back.sql)
-- Order: this database change can go before or after the Web that calls it. That Web falls back to the earlier
-- behaviour while the functions are missing (PostgREST PGRST202).
begin;
set local lock_timeout = '5s';

do $intake_gate$
begin
  if to_regclass('public.screen_events') is null or to_regclass('auth.users') is null then
    raise exception 'mail intake window: public.screen_events and auth.users must exist' using errcode = '55000';
  end if;
  if (select relowner from pg_class where oid = 'public.screen_events'::regclass) is distinct from (select oid from pg_roles where rolname = current_user) then
    raise exception 'mail intake window: run as the owner of public.screen_events; review before applying' using errcode = '55000';
  end if;
  -- A table of these names that this file did not make (different columns) stops it before any change.
  if (to_regclass('public.mail_intake_user_counts') is not null and not exists (
        select 1 from information_schema.columns where table_schema = 'public' and table_name = 'mail_intake_user_counts' and column_name = 'bytes'))
     or (to_regclass('public.mail_intake_global_counts') is not null and not exists (
        select 1 from information_schema.columns where table_schema = 'public' and table_name = 'mail_intake_global_counts' and column_name = 'bytes')) then
    raise exception 'mail intake window: an unexpected table already has this name' using errcode = '55000';
  end if;
end $intake_gate$;

create table if not exists public.mail_intake_user_counts (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind    text not null check (kind in ('forwarding_confirmation', 'screen_event')),
  day     date not null,
  count   integer not null default 0 check (count >= 0),
  bytes   bigint not null default 0 check (bytes >= 0),
  primary key (user_id, kind, day)
);
create table if not exists public.mail_intake_global_counts (
  kind  text not null check (kind in ('forwarding_confirmation', 'screen_event')),
  day   date not null,
  count integer not null default 0 check (count >= 0),
  bytes bigint not null default 0 check (bytes >= 0),
  primary key (kind, day)
);
alter table public.mail_intake_user_counts enable row level security;
alter table public.mail_intake_global_counts enable row level security;
-- No policy and no grant: only the two functions below read or write them.
revoke all on public.mail_intake_user_counts, public.mail_intake_global_counts from public, anon, authenticated, service_role;

alter table public.screen_events add column if not exists delivery_digest bytea;
create unique index if not exists screen_events_delivery_digest_idx on public.screen_events(user_id, delivery_digest);

create or replace function public.claim_mail_intake(p_user_id uuid, p_kind text, p_bytes bigint, p_limits jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_day date := (pg_catalog.clock_timestamp() at time zone 'Asia/Tokyo')::date;
  v_user_count bigint; v_user_bytes bigint; v_global_count bigint; v_global_bytes bigint;
  v_count integer; v_bytes bigint;
begin
  if jsonb_typeof(p_limits) is distinct from 'object'
     or (select count(*) from jsonb_each(p_limits) e
          where e.key in ('user_count', 'user_bytes', 'global_count', 'global_bytes')
            and jsonb_typeof(e.value) = 'number' and (e.value #>> '{}') ~ '^[0-9]+$') <> 4 then
    raise exception 'claim_mail_intake: limits must be four whole numbers' using errcode = '22023';
  end if;
  v_user_count := (p_limits->>'user_count')::bigint; v_user_bytes := (p_limits->>'user_bytes')::bigint;
  v_global_count := (p_limits->>'global_count')::bigint; v_global_bytes := (p_limits->>'global_bytes')::bigint;
  if p_user_id is null or p_kind is null or p_kind not in ('forwarding_confirmation', 'screen_event')
     or p_bytes is null or p_bytes < 0 or least(v_user_count, v_user_bytes, v_global_count, v_global_bytes) < 1 then
    raise exception 'claim_mail_intake: bad argument' using errcode = '22023';
  end if;
  -- Auth deletion holds this row before its cascade reaches the counts: take the parent first.
  perform id from auth.users where id = p_user_id for key share;
  if not found then raise exception 'mail intake owner no longer exists' using errcode = '23503'; end if;

  insert into public.mail_intake_user_counts(user_id, kind, day) values (p_user_id, p_kind, v_day) on conflict do nothing;
  select count, bytes into v_count, v_bytes from public.mail_intake_user_counts
    where user_id = p_user_id and kind = p_kind and day = v_day for update;
  if v_count + 1 > v_user_count or v_bytes + p_bytes > v_user_bytes then return 'user_intake_limit'; end if;

  insert into public.mail_intake_global_counts(kind, day) values (p_kind, v_day) on conflict do nothing;
  select count, bytes into v_count, v_bytes from public.mail_intake_global_counts
    where kind = p_kind and day = v_day for update;
  if v_count + 1 > v_global_count or v_bytes + p_bytes > v_global_bytes then return 'global_intake_limit'; end if;

  update public.mail_intake_user_counts set count = count + 1, bytes = bytes + p_bytes
    where user_id = p_user_id and kind = p_kind and day = v_day;
  update public.mail_intake_global_counts set count = count + 1, bytes = bytes + p_bytes
    where kind = p_kind and day = v_day;
  -- Older than yesterday: no longer needed. Only rows of this kind, which this transaction's locks already serialize.
  delete from public.mail_intake_user_counts where user_id = p_user_id and kind = p_kind and day < v_day - 1;
  delete from public.mail_intake_global_counts where kind = p_kind and day < v_day - 1;
  return 'ok';
end $$;

create or replace function public.log_screen_event(p_user_id uuid, p_event jsonb, p_limits jsonb)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_decision text := p_event->>'decision';
  v_subject text; v_domain text; v_reason text; v_key text := p_event->>'delivery_key';
  v_digest bytea; v_verdict text;
begin
  if p_user_id is null or jsonb_typeof(p_event) is distinct from 'object' or v_decision is null or v_decision not in ('dropped', 'rescued') then
    raise exception 'log_screen_event: bad argument' using errcode = '22023';
  end if;
  -- The subject is kept only for a dropped mail (a rescued one is read and sealed), as before.
  v_subject := case when v_decision = 'dropped' then left(p_event->>'subject', 200) end;
  v_domain := left(p_event->>'from_domain', 253);
  v_reason := left(p_event->>'reason', 100);
  if nullif(v_key, '') is not null then
    v_digest := pg_catalog.sha256(convert_to(p_user_id::text || chr(10) || 'screen_event' || chr(10) || v_decision || chr(10) || v_key, 'UTF8'));
    if exists (select 1 from public.screen_events where user_id = p_user_id and delivery_digest = v_digest) then return 'duplicate'; end if;
  end if;
  v_verdict := public.claim_mail_intake(p_user_id, 'screen_event',
    octet_length(coalesce(v_subject, '')) + octet_length(coalesce(v_domain, '')) + octet_length(coalesce(v_reason, '')), p_limits);
  if v_verdict <> 'ok' then return v_verdict; end if;
  insert into public.screen_events(user_id, from_domain, subject, decision, reason, delivery_digest)
    values (p_user_id, v_domain, v_subject, v_decision, v_reason, v_digest);
  return 'logged';
exception when unique_violation then
  -- The same delivery logged by a concurrent request: its count is given back with this subtransaction.
  return 'duplicate';
end $$;

revoke all on function public.claim_mail_intake(uuid, text, bigint, jsonb), public.log_screen_event(uuid, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_mail_intake(uuid, text, bigint, jsonb), public.log_screen_event(uuid, jsonb, jsonb) to service_role;

commit;
