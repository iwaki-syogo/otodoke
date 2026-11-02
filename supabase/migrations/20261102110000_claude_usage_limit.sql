-- Daily count of paid Claude calls, per user. Only the server (service_role) touches it.
create table public.claude_usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null,
  calls   integer not null default 0,
  primary key (user_id, day)
);
create index claude_usage_daily_day_idx on public.claude_usage_daily(day);

alter table public.claude_usage_daily enable row level security;
revoke all on public.claude_usage_daily from public, anon, authenticated;
grant select, insert, update on public.claude_usage_daily to service_role;

-- Take one call from today's allowance. Returns 'ok', 'user_limit' or 'global_limit'.
create function public.claim_claude_call(p_user_id uuid, p_user_limit integer, p_global_limit integer)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_day date := (now() at time zone 'Asia/Tokyo')::date;
  v_calls integer;
begin
  if (select coalesce(sum(calls), 0) from public.claude_usage_daily where day = v_day) >= p_global_limit then
    return 'global_limit';
  end if;

  insert into public.claude_usage_daily as u (user_id, day, calls)
  values (p_user_id, v_day, 1)
  on conflict (user_id, day) do update
    set calls = u.calls + 1
    where u.calls < p_user_limit
  returning calls into v_calls;

  if v_calls is null then
    return 'user_limit';
  end if;
  return 'ok';
end;
$$;

revoke all on function public.claim_claude_call(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.claim_claude_call(uuid, integer, integer) to service_role;
