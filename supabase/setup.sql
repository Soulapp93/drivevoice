-- ============================================================
-- DriveVoice — Installation Supabase
-- Projet : pfnwodwpefugpcynykga
-- ------------------------------------------------------------
-- À exécuter UNE SEULE FOIS dans : Supabase Dashboard → SQL Editor
-- Ce script crée le schéma multi-tenant (enseignes, catalogues
-- maîtres, restaurants) et active la sécurité RLS.
-- ============================================================

-- Extension nécessaire pour gen_random_uuid()
create extension if not exists "pgcrypto";

-- ============================================================
-- 1) ENSEIGNES MAÎTRES (Burger King, Quick, KFC…)
-- ============================================================
create table if not exists public.master_brands (
  id            uuid primary key default gen_random_uuid(),
  brand_key     text unique not null,           -- 'bk' | 'quick' | 'kfc'
  name          text not null,
  short         text,
  color         text,
  soft          text,
  version       integer not null default 1,
  status        text not null default 'Publié',  -- Publié | Brouillon | Archivé
  restaurants   integer not null default 0,
  updated       text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============================================================
-- 2) PRODUITS MAÎTRES (catalogue national par enseigne)
--    La fiche complète du produit est stockée en JSONB (data)
--    pour préserver la structure riche (variants, options, etc.)
-- ============================================================
create table if not exists public.master_products (
  id            uuid primary key default gen_random_uuid(),
  brand_id      uuid not null references public.master_brands(id) on delete cascade,
  product_id    text not null,                  -- identifiant logique stable
  name          text,
  category      text,
  price         numeric,
  available     boolean not null default true,
  display_order integer not null default 0,
  data          jsonb not null default '{}'::jsonb,  -- CatalogProduct complet
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (brand_id, product_id)
);

create index if not exists idx_master_products_brand on public.master_products (brand_id);
create index if not exists idx_master_products_category on public.master_products (brand_id, category);

-- ============================================================
-- 3) RESTAURANTS (multi-tenant, rattachés à une enseigne)
-- ============================================================
create table if not exists public.restaurants (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid references auth.users(id) on delete cascade,
  brand_id      uuid references public.master_brands(id) on delete set null,
  name          text not null,
  code          text,
  city          text,
  address       text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ============================================================
-- 4) PRODUITS LOCAUX D'UN RESTAURANT
--    Copie/adaptation locale du catalogue maître (prix, dispo)
-- ============================================================
create table if not exists public.restaurant_products (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  product_id    text not null,
  name          text,
  category      text,
  price         numeric,
  available     boolean not null default true,
  display_order integer not null default 0,
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (restaurant_id, product_id)
);

create index if not exists idx_restaurant_products_restaurant on public.restaurant_products (restaurant_id);
create index if not exists idx_restaurants_owner on public.restaurants (owner_id);

-- Connexion HubRise par établissement. Les tokens doivent être chiffrés
-- avant leur stockage par la route serveur OAuth.
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

create index if not exists idx_hubrise_connections_restaurant on public.restaurant_hubrise_connections (restaurant_id);

alter table public.restaurant_hubrise_connections enable row level security;

drop policy if exists "restaurant_hubrise_connections_open" on public.restaurant_hubrise_connections;
create policy "restaurant_hubrise_connections_open" on public.restaurant_hubrise_connections
  for all to anon, authenticated using (true) with check (true);

-- ============================================================
-- 5) updated_at automatique
-- ============================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists trg_master_brands_updated on public.master_brands;
create trigger trg_master_brands_updated before update on public.master_brands
  for each row execute function public.set_updated_at();

drop trigger if exists trg_master_products_updated on public.master_products;
create trigger trg_master_products_updated before update on public.master_products
  for each row execute function public.set_updated_at();

drop trigger if exists trg_restaurants_updated on public.restaurants;
create trigger trg_restaurants_updated before update on public.restaurants
  for each row execute function public.set_updated_at();

drop trigger if exists trg_restaurant_products_updated on public.restaurant_products;
create trigger trg_restaurant_products_updated before update on public.restaurant_products
  for each row execute function public.set_updated_at();

drop trigger if exists trg_restaurant_hubrise_connections_updated on public.restaurant_hubrise_connections;
create trigger trg_restaurant_hubrise_connections_updated before update on public.restaurant_hubrise_connections
  for each row execute function public.set_updated_at();

-- ============================================================
-- 6) SÉCURITÉ (Row Level Security)
--    ⚠️ Phase actuelle : pas encore d'authentification.
--    Les politiques ci-dessous autorisent la lecture ET l'écriture
--    (nécessaire au back-office). À verrouiller dès la mise en
--    place de l'authentification (phase suivante).
-- ============================================================
alter table public.master_brands        enable row level security;
alter table public.master_products      enable row level security;
alter table public.restaurants          enable row level security;
alter table public.restaurant_products  enable row level security;
alter table public.restaurant_hubrise_connections enable row level security;

-- Politique permissive temporaire (lecture + écriture) pour anon & authenticated
do $$
declare t text;
begin
  foreach t in array array['master_brands','master_products','restaurants','restaurant_products']
  loop
    execute format('drop policy if exists "%s_open" on public.%I', t, t);
    execute format(
      'create policy "%s_open" on public.%I for all to anon, authenticated using (true) with check (true)',
      t, t
    );
  end loop;
end $$;

-- ============================================================
-- FIN. Vérifie dans Table Editor que les 4 tables existent.
-- ============================================================
