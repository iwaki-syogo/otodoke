-- Undo supabase/migrations/20261103140000_server_only_writes.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never picks it up. Run by hand only.
--
-- Puts back the init state: `for all` policies on the four tables, and the default grants the
-- init migration relied on (Supabase gives authenticated all privileges on new public tables).
-- To undo both new migrations, run this file first, then 20261103130000_parcel_category_source.down.sql.

drop policy "own parcel items" on public.parcel_items;
create policy "own parcel items" on public.parcel_items for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant all on public.parcel_items to authenticated;

drop policy "own extractions" on public.extractions;
create policy "own extractions" on public.extractions for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant all on public.extractions to authenticated;

drop policy "own emails" on public.emails;
create policy "own emails" on public.emails for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant all on public.emails to authenticated;

drop policy "own inbox address insert" on public.inbox_addresses;
drop policy "own inbox address" on public.inbox_addresses;
create policy "own inbox address" on public.inbox_addresses for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant all on public.inbox_addresses to authenticated;
