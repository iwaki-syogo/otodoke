-- ordered_at is the calendar date (JST) read from the mail, not an instant.
-- Keeping it as `date` avoids UTC/JST off-by-one when grouping by month.
alter table public.parcels
  alter column ordered_at type date
  using (ordered_at at time zone 'Asia/Tokyo')::date;
