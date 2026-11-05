-- Cap how often the app asks Supabase to send a login link.
--
-- Why: sign-up is open and the website's login action runs on Vercel, so Supabase Auth sees every
-- request from the login form coming from Vercel's addresses and its per-IP limit is shared by
-- everyone. The app checks this table before each send from the form: per address and per client IP.
-- This covers the website's form only: Supabase's /auth/v1/otp can be called directly with the
-- public anon key (the iOS app does), so the project-wide mail cap itself is guarded only by
-- Supabase-side settings or a CAPTCHA.
--
-- Only hashes are stored (SHA-256 hex of the lowercased address / of the client IP, computed in
-- src/lib/login-mail-limit.ts), never the raw values. Rows older than an hour are pruned on each call.
-- Only the server (service_role) calls the functions; users cannot read or write the table.
--
-- A send is claimed before Supabase is asked to send (so concurrent requests cannot all see room)
-- and released again when Supabase refuses: a mail that was never sent does not use up the
-- allowance. Supabase's own one-per-minute refusal would otherwise lock a person out after a few
-- presses while only one mail ever went out.
--
-- Rollback: supabase/rollback/20261106100000_login_mail_limit.down.sql

create table public.login_mail_sends (
  id         bigint generated always as identity primary key,
  email_hash text not null check (email_hash ~ '^[0-9a-f]{64}$'),
  ip_hash    text check (ip_hash ~ '^[0-9a-f]{64}$'),
  sent_at    timestamptz not null default now()
);
create index login_mail_sends_email_idx on public.login_mail_sends(email_hash, sent_at);
create index login_mail_sends_ip_idx on public.login_mail_sends(ip_hash, sent_at) where ip_hash is not null;
create index login_mail_sends_sent_at_idx on public.login_mail_sends(sent_at);

alter table public.login_mail_sends enable row level security;
revoke all on public.login_mail_sends from public, anon, authenticated;
grant select, insert, delete on public.login_mail_sends to service_role;

-- Take one login mail from the allowance. Returns one row: verdict 'ok' (recorded; go ahead and
-- send) with claim_id = the id of the recorded row, or verdict 'email_10m' / 'email_1h' (this
-- address had enough in the last 10 minutes / hour) or 'ip_1h' (this client IP had enough in the
-- last hour) with claim_id null. p_ip_hash may be null (no client IP): then only the address
-- limits apply. Nothing is recorded unless the verdict is 'ok'.
create function public.claim_login_mail(
  p_email_hash text,
  p_ip_hash text,
  p_email_10m_limit integer,
  p_email_1h_limit integer,
  p_ip_1h_limit integer
)
returns table (verdict text, claim_id bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_id bigint;
begin
  if p_email_hash is null or p_email_hash !~ '^[0-9a-f]{64}$'
     or (p_ip_hash is not null and p_ip_hash !~ '^[0-9a-f]{64}$') then
    raise exception 'claim_login_mail: expected SHA-256 hex hashes' using errcode = '22023';
  end if;

  -- One claim at a time per address and per IP, so concurrent requests cannot all see room.
  -- These are transaction-scoped and the check and the insert are in this one call, so the
  -- next caller for the same key gets the lock only after this row is committed and visible.
  -- Always address first, then IP, so two calls never wait on each other in a cycle.
  perform pg_advisory_xact_lock(hashtextextended('login_mail:email:' || p_email_hash, 0));
  if p_ip_hash is not null then
    perform pg_advisory_xact_lock(hashtextextended('login_mail:ip:' || p_ip_hash, 0));
  end if;

  -- Prune what no window looks at any more. SKIP LOCKED: never wait on another call's prune.
  delete from public.login_mail_sends
  where id in (
    select id from public.login_mail_sends
    where sent_at < v_now - interval '1 hour'
    order by id
    limit 500
    for update skip locked
  );

  if (select count(*) from public.login_mail_sends
      where email_hash = p_email_hash and sent_at > v_now - interval '10 minutes') >= p_email_10m_limit then
    return query select 'email_10m'::text, null::bigint;
    return;
  end if;
  if (select count(*) from public.login_mail_sends
      where email_hash = p_email_hash and sent_at > v_now - interval '1 hour') >= p_email_1h_limit then
    return query select 'email_1h'::text, null::bigint;
    return;
  end if;
  if p_ip_hash is not null and (select count(*) from public.login_mail_sends
      where ip_hash = p_ip_hash and sent_at > v_now - interval '1 hour') >= p_ip_1h_limit then
    return query select 'ip_1h'::text, null::bigint;
    return;
  end if;

  insert into public.login_mail_sends (email_hash, ip_hash, sent_at)
  values (p_email_hash, p_ip_hash, v_now)
  returning id into v_id;
  return query select 'ok'::text, v_id;
end;
$$;

revoke all on function public.claim_login_mail(text, text, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_login_mail(text, text, integer, integer, integer) to service_role;

-- Give back a claim whose mail was not sent (Supabase refused). Deletes only the row with this id,
-- and only if it belongs to this address hash, so a wrong id cannot free someone else's send.
-- Returns how many rows were deleted (1, or 0 when it was already pruned or released).
create function public.release_login_mail(
  p_claim_id bigint,
  p_email_hash text
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if p_claim_id is null or p_email_hash is null or p_email_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'release_login_mail: expected a claim id and a SHA-256 hex hash' using errcode = '22023';
  end if;

  delete from public.login_mail_sends
  where id = p_claim_id and email_hash = p_email_hash;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.release_login_mail(bigint, text) from public, anon, authenticated;
grant execute on function public.release_login_mail(bigint, text) to service_role;
