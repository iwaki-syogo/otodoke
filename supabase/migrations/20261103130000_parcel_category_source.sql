-- category: spending category of the parcel, set by the reading (Claude) or by the user.
-- category_source: who set the category. 'user' is never overwritten automatically.
-- source: where the parcel came from. 'manual' = the user typed it in; 'mail' = built from mails.
alter table public.parcels
  add column category text null,
  add column category_source text null,
  add column source text not null default 'mail';
alter table public.parcels
  add constraint parcels_category_check check (category is null or category in ('food','daily','hobby','fashion','electronics','beauty','other')),
  add constraint parcels_category_source_check check (category_source is null or category_source in ('auto','user')),
  add constraint parcels_source_check check (source in ('mail','manual'));
