create table if not exists public.restaurant_hubrise_connections (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  account_id text,
  location_id text not null,
  location_name text,
  access_token text not null,
  refresh_token text,
  catalog_id text,
  status text not null default 'connected',
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (restaurant_id),
  unique (location_id)
);

alter table public.restaurants add column if not exists owner_id uuid references auth.users(id) on delete cascade;
create index if not exists idx_restaurants_owner on public.restaurants (owner_id);

drop policy if exists "restaurants_owner_access" on public.restaurants;
create policy "restaurants_owner_access" on public.restaurants
  for all to authenticated using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

drop policy if exists "restaurant_products_owner_access" on public.restaurant_products;
create policy "restaurant_products_owner_access" on public.restaurant_products
  for all to authenticated
  using (exists (select 1 from public.restaurants r where r.id = restaurant_id and r.owner_id = auth.uid()))
  with check (exists (select 1 from public.restaurants r where r.id = restaurant_id and r.owner_id = auth.uid()));

create index if not exists idx_hubrise_connections_restaurant
  on public.restaurant_hubrise_connections (restaurant_id);

alter table public.restaurant_hubrise_connections enable row level security;

drop policy if exists "restaurant_hubrise_connections_open"
  on public.restaurant_hubrise_connections;

create policy "restaurant_hubrise_connections_open"
  on public.restaurant_hubrise_connections
  for all to anon, authenticated
  using (true) with check (true);