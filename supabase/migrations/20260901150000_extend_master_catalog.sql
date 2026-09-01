-- Extension du schéma multi-tenant : catalogues maîtres nationaux

-- Enseignes nationales (Burger King France, Quick France, KFC France)
create table if not exists public.master_brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  short text not null unique,
  color text not null default '#000000',
  soft text not null default '#ffffff',
  status text not null default 'Brouillon' check (status in ('Publié', 'Brouillon', 'Archivé')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Produits du catalogue maître national
-- JSONB utilisés pour les structures complexes (variants, options, ingrédients, modifiers)
create table if not exists public.master_products (
  id uuid primary key default gen_random_uuid(),
  master_brand_id uuid not null references public.master_brands(id) on delete cascade,
  product_id text not null,
  name text not null,
  detail text not null default '',
  category text not null,
  subcategory text,
  price numeric(10,2) not null default 0 check (price >= 0),
  pos_code text,
  emoji text not null default '🍽️',
  image_url text,
  available boolean not null default true,
  product_type text not null default 'simple',
  variants jsonb not null default '[]'::jsonb,
  option_groups jsonb not null default '[]'::jsonb,
  ingredients jsonb not null default '[]'::jsonb,
  ingredient_settings jsonb not null default '[]'::jsonb,
  modifiers jsonb not null default '[]'::jsonb,
  slug text,
  meat_filter text,
  badges jsonb not null default '[]'::jsonb,
  display_order integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (master_brand_id, product_id)
);

-- Super-admins : peuvent gérer les catalogues maîtres et les restaurants de tous les tenants
create table if not exists public.super_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Lien entre un restaurant et sa marque maître (optionnel, utilisé pour le clonage)
alter table public.restaurants
  add column if not exists master_brand_id uuid references public.master_brands(id) on delete set null;

-- Index utiles
create index if not exists master_products_master_brand_id_idx on public.master_products(master_brand_id);
create index if not exists master_products_category_idx on public.master_products(category);
create index if not exists restaurants_master_brand_id_idx on public.restaurants(master_brand_id);

-- Fonction : est-ce un super-admin ?
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.super_admins
    where user_id = auth.uid()
  );
$$;

-- Fonction : clone le catalogue maître actif d'une marque vers un restaurant
-- Si le restaurant a déjà des produits, seuls les produits manquants sont ajoutés
-- (les adaptations locales existantes ne sont pas écrasées)
create or replace function public.clone_master_catalog(target_restaurant_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_brand_id uuid;
begin
  select master_brand_id into target_brand_id
  from public.restaurants
  where id = target_restaurant_id;

  if target_brand_id is null then
    raise exception 'Ce restaurant n''est rattaché à aucune marque maître.';
  end if;

  insert into public.restaurant_products (
    restaurant_id,
    product_id,
    name,
    detail,
    category,
    subcategory,
    price,
    pos_code,
    emoji,
    image_url,
    available,
    product_type,
    variants,
    option_groups,
    ingredients,
    ingredient_settings,
    modifiers,
    slug,
    meat_filter,
    badges,
    display_order
  )
  select
    target_restaurant_id,
    mp.product_id,
    mp.name,
    mp.detail,
    mp.category,
    mp.subcategory,
    mp.price,
    mp.pos_code,
    mp.emoji,
    mp.image_url,
    mp.available,
    mp.product_type,
    mp.variants,
    mp.option_groups,
    mp.ingredients,
    mp.ingredient_settings,
    mp.modifiers,
    mp.slug,
    mp.meat_filter,
    mp.badges,
    mp.display_order
  from public.master_products mp
  where mp.master_brand_id = target_brand_id
    and mp.available = true
  on conflict (restaurant_id, product_id) do nothing;
end;
$$;

-- Mise à jour automatique de updated_at
-- Déclenchée sur master_brands et master_products (les tables existantes ont déjà leur propre logique)
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_updated_at_master_brands on public.master_brands;
create trigger set_updated_at_master_brands
  before update on public.master_brands
  for each row execute function public.set_updated_at();

drop trigger if exists set_updated_at_master_products on public.master_products;
create trigger set_updated_at_master_products
  before update on public.master_products
  for each row execute function public.set_updated_at();

-- RLS
alter table public.master_brands enable row level security;
alter table public.master_products enable row level security;
alter table public.super_admins enable row level security;

-- Super-admins : lecture/écriture complète sur les catalogues maîtres
-- Tout utilisateur authentifié peut lire les marques et produits publiés (nécessaire à l'inscription publique)
create policy "super admins can manage master brands"
  on public.master_brands for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

create policy "super admins can manage master products"
  on public.master_products for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- Lecture publique limitée aux catalogues publiés (pour l'inscription et la découverte)
create policy "anyone can read published master brands"
  on public.master_brands for select
  using (status = 'Publié');

create policy "anyone can read published master products"
  on public.master_products for select
  using (exists (
    select 1 from public.master_brands
    where id = master_products.master_brand_id and status = 'Publié'
  ));

-- Super-admins : gestion des super-admins
create policy "super admins can manage super admins"
  on public.super_admins for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

-- Restaurants : mise à jour du master_brand_id réservée aux admins de l'organisation
-- (la policy existante sur restaurants autorise déjà les membres de l'org)
-- On ajoute une vérification pour empêcher les non-super-admins de lier un restaurant
-- à une marque maître en brouillon.
create policy "restaurant master brand link must be published"
  on public.restaurants for update
  using (public.is_org_member(organization_id))
  with check (
    public.is_org_member(organization_id)
    and (
      master_brand_id is null
      or public.is_super_admin()
      or exists (
        select 1 from public.master_brands where id = master_brand_id and status = 'Publié'
      )
    )
  );
