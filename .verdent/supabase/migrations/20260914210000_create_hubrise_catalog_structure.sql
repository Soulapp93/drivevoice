create table if not exists public.restaurant_hubrise_catalogs (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  hubrise_catalog_id text not null,
  catalog_name text,
  catalog_data jsonb not null default '{}',
  variants jsonb not null default '[]',
  deals jsonb not null default '[]',
  discounts jsonb not null default '[]',
  charges jsonb not null default '[]',
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.restaurant_products
  add column if not exists product_type text not null default 'sku',
  add column if not exists catalog_ref text,
  add column if not exists parent_ref text,
  add column if not exists rules jsonb not null default '{}',
  add column if not exists price_by_variant jsonb not null default '{}',
  add column if not exists "optionGroups" jsonb default '[]';

create index if not exists idx_restaurant_products_catalog_ref
  on public.restaurant_products (restaurant_id, catalog_ref);

create index if not exists idx_restaurant_products_product_type
  on public.restaurant_products (restaurant_id, product_type);

alter table public.restaurant_hubrise_catalogs enable row level security;