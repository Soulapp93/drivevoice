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

-- ============================================================
-- 5) ÉTAT DE CONVERSATION ET IDEMPOTENCE REALTIME
--    Les écritures passent par les routes serveur avec la service role.
-- ============================================================
create table if not exists public.conversation_baskets (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null unique,
  restaurant_id   uuid not null references public.restaurants(id) on delete cascade,
  snapshot        jsonb not null default '{}'::jsonb,
  status          text not null default 'editing',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_conversation_baskets_restaurant
  on public.conversation_baskets (restaurant_id);

create table if not exists public.conversation_tool_calls (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null,
  restaurant_id   uuid not null references public.restaurants(id) on delete cascade,
  call_id         text not null,
  tool_name       text not null,
  result          jsonb not null,
  created_at      timestamptz not null default now(),
  unique (conversation_id, call_id)
);

create index if not exists idx_conversation_tool_calls_restaurant
  on public.conversation_tool_calls (restaurant_id);

create table if not exists public.orders (
  id                uuid primary key default gen_random_uuid(),
  restaurant_id     uuid not null references public.restaurants(id) on delete restrict,
  conversation_id   uuid,
  idempotency_key   text not null unique,
  hubrise_order_id  text,
  ref               text not null,
  source            text not null default 'voice',
  status            text not null default 'pending',
  total             numeric not null default 0,
  items             jsonb not null default '[]'::jsonb,
  created_at        timestamptz not null default now()
);

alter table public.orders add column if not exists conversation_id uuid;
alter table public.orders add column if not exists idempotency_key text;
alter table public.orders add column if not exists items jsonb not null default '[]'::jsonb;
alter table public.orders add column if not exists total numeric not null default 0;
alter table public.orders add column if not exists source text not null default 'voice';
alter table public.orders add column if not exists status text not null default 'pending';
create unique index if not exists idx_orders_idempotency_key
  on public.orders (idempotency_key)
  where idempotency_key is not null;

alter table public.conversation_baskets enable row level security;
alter table public.conversation_tool_calls enable row level security;
alter table public.orders enable row level security;

alter table public.restaurant_hubrise_connections enable row level security;

drop policy if exists "restaurant_hubrise_connections_open" on public.restaurant_hubrise_connections;

-- ============================================================
-- 6) updated_at automatique
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

drop trigger if exists trg_conversation_baskets_updated on public.conversation_baskets;
create trigger trg_conversation_baskets_updated before update on public.conversation_baskets
  for each row execute function public.set_updated_at();

-- ============================================================
-- 7) SÉCURITÉ (Row Level Security)
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

-- Les tables de catalogue restent en mode compatibilité avec le back-office
-- existant tant que son parcours d'authentification n'est pas migré.
-- Les tables de panier, d'idempotence et les jetons HubRise n'ont aucune
-- politique client : elles ne sont accessibles que par les routes serveur.
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
