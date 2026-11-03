-- Undo supabase/migrations/20261103130000_parcel_category_source.sql.
-- Kept outside supabase/migrations/ so `supabase db push` never picks it up. Run by hand only.
-- Run 20261103140000_server_only_writes.down.sql first when undoing both.
-- Drops the stored categories and the manual-parcel marker: manual parcels become ordinary rows.

alter table public.parcels
  drop constraint parcels_category_check,
  drop constraint parcels_category_source_check,
  drop constraint parcels_source_check;
alter table public.parcels
  drop column category,
  drop column category_source,
  drop column source;
