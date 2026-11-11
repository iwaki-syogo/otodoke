-- "The person said they received it": parcels.received_at, apart from status = 'delivered'.
--
-- Why: status = 'delivered' means the delivery is done (a mail said so, or the person marked it).
-- It is not a statement that the person has the parcel in hand. The app now lists a delivered
-- parcel under 配達済み until the person says 受け取った; only then does it move to 受け取り済み.
-- received_at holds that statement. null = not said.
--
-- The trigger parcels_received_at keeps the two honest for writers that do not know the column
-- (an app build from before this file), and is never the only thing the app relies on: the
-- current app writes received_at itself, in the same update as the status.
--   - A signed-in person's session (current_user = 'authenticated') sets status to 'delivered'
--     (an insert, or an update from another status) and leaves received_at null: received_at = now().
--     An old build's swipe on 届いた is that case, and it is exactly "the person said so".
--   - The status changes from 'delivered' to anything else, by any role: received_at = null.
--     A parcel that is no longer delivered cannot have been received.
--   - The server (service_role: the mail processing) setting 'delivered' leaves received_at as it
--     is. A mail says "delivered", never "the person has it".
--   - An update that keeps 'delivered' does not touch received_at: clearing it (受け取っていない)
--     or setting it is the writer's own.
--
-- Telling the roles apart: current_user, not the request.jwt.claims setting. PostgREST runs each
-- request after SET LOCAL ROLE <the role of the JWT> (authenticated, service_role), so current_user
-- is that role inside this trigger. The function is SECURITY INVOKER on purpose (a SECURITY DEFINER
-- function would see its owner here). The claims setting is request data the caller's session
-- carries. A connection of the owner (the migration itself, the SQL editor, supabase db query) is
-- neither role: it never sets received_at (the demotion rule above still applies).
--
-- The trigger returns NEW on every path. In a BEFORE UPDATE trigger, "return old" writes the old row
-- over the update with no error and with row_count 1, so the status change itself would be lost.
--
-- Existing data: every parcel that is 'delivered' now is marked received (received_at = updated_at),
-- because until now delivered was the only state and the page "届いた荷物" held all of them. This is
-- done only on the run that adds the column, so running the file again never marks a parcel that
-- the person has not received.
--
-- updated_at: the backfill UPDATE would fire parcels_set_updated_at and move updated_at of every
-- delivered row to now. The Web and iOS forms write with "where updated_at = <the value read>", so
-- a form open across the migration would be refused once ("open it again"). The trigger is
-- switched off for the backfill and on again (ALTER TABLE ... DISABLE TRIGGER is transactional),
-- so updated_at does not move. This takes a SHARE ROW EXCLUSIVE lock on parcels (writes wait,
-- reads do not) for the length of the backfill; lock_timeout is 5 s. The statement needs the
-- table's owner, which the migration's role is.
--
-- Permissions and RLS: nothing to change. authenticated and service_role have table-level
-- privileges on parcels, not column-level ones, and "own parcels" is a row policy. The new column
-- is writable by the owner of the row, as status is.
--
-- One transaction. Re-runnable.
-- Before: supabase/verify/20261112100000_parcel_received_at.before.sql
-- After:  supabase/verify/20261112100000_parcel_received_at.sql
-- Rollback: supabase/rollback/20261112100000_parcel_received_at.down.sql
-- Apply this file BEFORE the app that reads received_at is deployed (select * would still work
-- without it, but the 受け取り済み page filters on the column).

begin;
set local lock_timeout = '5s';

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'parcels' and column_name = 'received_at') then
    alter table public.parcels add column received_at timestamptz;
    -- Everything delivered so far counts as received. updated_at stays as it is (see the header).
    alter table public.parcels disable trigger parcels_set_updated_at;
    update public.parcels set received_at = updated_at where status = 'delivered';
    alter table public.parcels enable trigger parcels_set_updated_at;
  end if;
end $$;

create or replace function public.parcels_received_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'delivered' and new.received_at is null and current_user = 'authenticated' then
      new.received_at := now();
    end if;
    return new;
  end if;

  -- UPDATE
  if old.status = 'delivered' and new.status is distinct from 'delivered' then
    new.received_at := null;
  elsif new.status = 'delivered' and old.status is distinct from 'delivered' and new.received_at is null and current_user = 'authenticated' then
    new.received_at := now();
  end if;
  return new;
end $$;

drop trigger if exists parcels_received_at on public.parcels;
create trigger parcels_received_at before insert or update on public.parcels
  for each row execute function public.parcels_received_at();

commit;
