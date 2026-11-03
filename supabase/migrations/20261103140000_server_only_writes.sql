-- Narrow what a signed-in user can write directly.
--
-- Why: the init migration gave all five tables a `for all` policy, so a user session could
-- insert, update and delete rows in tables only the server writes (parcel_items, extractions,
-- emails). Foreign keys are checked regardless of RLS, so a user could also insert rows that
-- point at another account's parcel_id.
--
-- From the user session the app only writes:
--   - parcels          (src/app/app/parcel-actions.ts and the other parcel actions)
--   - inbox_addresses  (src/lib/inbox.ts: select, then insert once)
-- Everything else is written by the server with the service role, which bypasses RLS.
-- parcels is left as it is. PUBLIC is not touched.
--
-- Deleting a parcel still cascades to parcel_items and sets extractions.parcel_id to null:
-- referential actions do not go through the user's grants or policies.
--
-- Rollback: supabase/rollback/20261103140000_server_only_writes.down.sql

-- parcel_items, extractions, emails: read only for the user.
revoke all on public.parcel_items from authenticated;
grant select on public.parcel_items to authenticated;
grant all on public.parcel_items to service_role;
drop policy "own parcel items" on public.parcel_items;
create policy "own parcel items" on public.parcel_items for select to authenticated using (user_id = auth.uid());

revoke all on public.extractions from authenticated;
grant select on public.extractions to authenticated;
grant all on public.extractions to service_role;
drop policy "own extractions" on public.extractions;
create policy "own extractions" on public.extractions for select to authenticated using (user_id = auth.uid());

revoke all on public.emails from authenticated;
grant select on public.emails to authenticated;
grant all on public.emails to service_role;
drop policy "own emails" on public.emails;
create policy "own emails" on public.emails for select to authenticated using (user_id = auth.uid());

-- inbox_addresses: the user reads their address and creates it once; never changes or removes it.
revoke all on public.inbox_addresses from authenticated;
grant select, insert on public.inbox_addresses to authenticated;
grant all on public.inbox_addresses to service_role;
drop policy "own inbox address" on public.inbox_addresses;
create policy "own inbox address" on public.inbox_addresses for select to authenticated using (user_id = auth.uid());
create policy "own inbox address insert" on public.inbox_addresses for insert to authenticated with check (user_id = auth.uid());

-- After applying, rows whose user_id disagrees with the row they point at (each should be 0):
--
--   select count(*) from public.extractions x join public.parcels p on p.id = x.parcel_id where x.user_id <> p.user_id;
--   select count(*) from public.parcel_items i join public.parcels p on p.id = i.parcel_id where i.user_id <> p.user_id;
--   select count(*) from public.extractions x join public.emails e on e.id = x.email_id where x.user_id <> e.user_id;
