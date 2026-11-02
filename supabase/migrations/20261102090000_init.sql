-- Otodoke initial schema.
-- Every row belongs to one user (auth.users). RLS is on for all tables; the
-- inbound webhook writes with the service role, everything else goes through
-- the user session.

create extension if not exists pgcrypto;

-- One receiving address per user: <local_part>@<INBOUND_DOMAIN>
create table public.inbox_addresses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  local_part  text not null unique,
  created_at  timestamptz not null default now()
);
create unique index inbox_addresses_user_idx on public.inbox_addresses(user_id);

-- Raw forwarded emails as received. Unrelated mails are deleted after
-- classification, so this table holds order-related mails only.
create table public.emails (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  provider_email_id  text,                 -- Resend email_id
  message_id         text,                 -- RFC 5322 Message-ID of the original mail
  from_address       text,
  from_name          text,
  subject            text,
  received_at        timestamptz not null default now(),
  sent_at            timestamptz,          -- Date header of the original mail
  text_body          text,
  html_body          text,
  classification     text,                 -- order | shipping | delivery | cancel | unrelated | unknown
  processing_status  text not null default 'pending', -- pending | processed | discarded | failed
  error              text,
  created_at         timestamptz not null default now()
);
create index emails_user_received_idx on public.emails(user_id, received_at desc);
create unique index emails_user_message_idx on public.emails(user_id, message_id) where message_id is not null;

-- One parcel = one order (or one shipment of an order). Updated as new mails arrive.
create table public.parcels (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  shop                  text not null,           -- display name, e.g. Amazon.co.jp
  shop_key              text,                    -- normalized: amazon | rakuten | ocn | lensapple | irisplaza | other
  order_number          text,
  title                 text,                    -- short display title (first item + 他n点)
  status                text not null default 'ordered', -- ordered | shipped | out_for_delivery | delivered | cancelled | unknown
  ordered_at            timestamptz,
  expected_date         date,
  expected_window_start time,
  expected_window_end   time,
  expected_text         text,                    -- phrasing as written in the mail
  carrier               text,
  tracking_number       text,
  tracking_url          text,
  requires_presence     boolean,                 -- true = someone must be home (置き配不可 / 対面); null = unknown
  presence_evidence     text,
  total_amount          integer,                 -- JPY
  needs_review          boolean not null default false,
  last_email_at         timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index parcels_user_expected_idx on public.parcels(user_id, expected_date);
create index parcels_user_order_idx on public.parcels(user_id, shop_key, order_number);
create index parcels_user_tracking_idx on public.parcels(user_id, tracking_number) where tracking_number is not null;

create table public.parcel_items (
  id          uuid primary key default gen_random_uuid(),
  parcel_id   uuid not null references public.parcels(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  quantity    integer,
  unit_price  integer,
  evidence    text,
  created_at  timestamptz not null default now()
);
create index parcel_items_parcel_idx on public.parcel_items(parcel_id);

-- What Claude extracted from each mail, with evidence. Links a mail to the parcel it updated.
create table public.extractions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  email_id    uuid not null references public.emails(id) on delete cascade,
  parcel_id   uuid references public.parcels(id) on delete set null,
  model       text not null,
  result      jsonb not null,            -- full structured output (fields + evidence + confidence)
  confidence  numeric(3,2),
  created_at  timestamptz not null default now()
);
create index extractions_email_idx on public.extractions(email_id);
create index extractions_parcel_idx on public.extractions(parcel_id);

-- updated_at maintenance
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger parcels_set_updated_at before update on public.parcels
  for each row execute function public.set_updated_at();

-- Row Level Security: a user sees only their own rows.
alter table public.inbox_addresses enable row level security;
alter table public.emails          enable row level security;
alter table public.parcels         enable row level security;
alter table public.parcel_items    enable row level security;
alter table public.extractions     enable row level security;

create policy "own inbox address"  on public.inbox_addresses for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own emails"         on public.emails          for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own parcels"        on public.parcels         for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own parcel items"   on public.parcel_items    for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own extractions"    on public.extractions     for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- anon gets nothing; the inbound webhook uses the service role, which bypasses RLS.
revoke all on all tables in schema public from anon;
