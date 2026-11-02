-- What the free pre-check threw away, so a wrong drop can be noticed and fixed.
-- The mail body is never stored here. Rows are deleted after 14 days unless the user flagged them.
create table public.screen_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  from_domain text,
  subject     text,
  decision    text not null,  -- dropped | rescued (the second check kept a mail the first would drop)
  reason      text,
  flagged_at  timestamptz     -- the user said this was a parcel mail
);
create index screen_events_user_idx on public.screen_events(user_id, created_at desc);
create index screen_events_flagged_idx on public.screen_events(user_id, from_domain) where flagged_at is not null;

alter table public.screen_events enable row level security;
create policy "own screen events" on public.screen_events for select to authenticated using (user_id = auth.uid());
revoke all on public.screen_events from public, anon;
revoke insert, update, delete on public.screen_events from authenticated;
grant select on public.screen_events to authenticated;
grant select, insert, update, delete on public.screen_events to service_role;
