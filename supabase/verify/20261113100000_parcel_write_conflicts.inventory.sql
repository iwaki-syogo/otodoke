-- Read-only counts for a HUMAN review of existing duplicates. OK means inventory
-- was read, never that an order-only duplicate is safe to merge. No ids/bodies/shops printed.
-- Different shipments and marketplace order numbers can legitimately share a number.
with numbered as (
  select user_id,shop_key,shop,order_number,tracking_number,count(*) as rows
  from public.parcels where order_number is not null
  group by user_id,shop_key,shop,order_number,tracking_number
), orders as (
  select user_id,order_number,count(*) as rows,count(distinct tracking_number) as trackings
  from public.parcels where order_number is not null group by user_id,order_number
), reads as (
  select user_id,parcel_id,count(*) as readings from public.extractions where parcel_id is not null group by user_id,parcel_id
)
select 'OK' as verdict,
  (select count(*) from numbered where rows>1) as identical_number_shop_tracking_groups_to_review,
  (select count(*) from orders where rows>1) as repeated_order_groups_to_review,
  (select count(*) from orders where rows>1 and trackings>1) as repeated_order_groups_with_different_tracking,
  (select count(*) from reads where readings>1000) as parcels_requiring_multiple_read_pages,
  (select count(*) from public.parcels p where not exists(select 1 from public.extractions x where x.parcel_id=p.id and x.user_id=p.user_id)) as parcels_without_saved_readings;
