-- Undo supabase/migrations/20261112100000_parcel_received_at.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never picks it up. Run by hand only.
--
-- The column goes with what it held: who had said 受け取った, and when, is lost and cannot be made
-- again (a delivered parcel then reads as it did before: all of them are 届いた). Deploy the
-- app from before received_at first, or the app that reads the column fails on it.
-- Every step checks first: run twice, or on a database the file never reached, it changes nothing
-- the second time. Run the file in one go (psql -f, or supabase db query -f).
-- Locks: dropping the column takes an AccessExclusiveLock on parcels for a moment. lock_timeout is
-- 5 s: then this fails, changes nothing, and is run again later.

begin;
set local lock_timeout = '5s';

drop trigger if exists parcels_received_at on public.parcels;
drop function if exists public.parcels_received_at();
alter table public.parcels drop column if exists received_at;

commit;
