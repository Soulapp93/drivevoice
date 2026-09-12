-- Ajoute les champs nécessaires à l'import HubRise dans le catalogue restaurant.
alter table public.restaurant_products
  add column if not exists hubrise_id text,
  add column if not exists sku_ref text,
  add column if not exists source text default 'manual',
  add column if not exists availability jsonb default '{}',
  add column if not exists options jsonb default '[]';

create unique index if not exists idx_restaurant_products_hubrise
  on public.restaurant_products (restaurant_id, hubrise_id)
  where hubrise_id is not null;