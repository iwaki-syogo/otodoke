-- Some shops promise a window of days ("10/23 - 10/31"). The parcel is late only after the last one.
alter table public.parcels add column expected_date_end date;
