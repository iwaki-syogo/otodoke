-- Run BEFORE applying supabase/migrations/20261112100000_parcel_received_at.sql.
-- Returns ONE row; go only if its verdict is 'OK'. No row (an error) counts as FAILED.
-- OK = parcels is there and has no received_at yet (the file adds the column and moves every
-- delivered parcel to received in the same run). Reads only; prints counts only.
select
  case
    when to_regclass('public.parcels') is not null
     and not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'parcels' and column_name in ('received_at', 'check_dismissed_at'))
     and exists (select 1 from pg_trigger where tgrelid = 'public.parcels'::regclass and tgname = 'parcels_set_updated_at' and tgenabled = 'O')
    then 'OK' else 'FAILED'
  end as verdict,
  (select count(*) from public.parcels where status = 'delivered') as delivered_rows,
  (select count(*) from public.parcels) as total_rows;
