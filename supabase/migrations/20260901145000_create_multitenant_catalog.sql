create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.organization_members (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'admin', 'member')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  brand text not null,
  code text,
  timezone text not null default 'Europe/Paris',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.restaurant_members (
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'manager' check (role in ('manager', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (restaurant_id, user_id)
);

create table if not exists public.restaurant_products (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
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
  unique (restaurant_id, product_id)
);

create or replace function public.is_org_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.organization_members
    where organization_id = target_org and user_id = auth.uid()
  );
$$;

create or replace function public.is_restaurant_member(target_restaurant uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.restaurant_members
    where restaurant_id = target_restaurant and user_id = auth.uid()
  ) or exists (
    select 1
    from public.restaurants r
    join public.organization_members m on m.organization_id = r.organization_id
    where r.id = target_restaurant and m.user_id = auth.uid()
  );
$$;

alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.restaurants enable row level security;
alter table public.restaurant_members enable row level security;
alter table public.restaurant_products enable row level security;

create policy "members can read organizations"
  on public.organizations for select
  using (public.is_org_member(id));

create policy "members can read organization members"
  on public.organization_members for select
  using (public.is_org_member(organization_id));

create policy "organization admins can manage restaurants"
  on public.restaurants for all
  using (public.is_org_member(organization_id))
  with check (public.is_org_member(organization_id));

create policy "restaurant members can read memberships"
  on public.restaurant_members for select
  using (public.is_restaurant_member(restaurant_id));

create policy "restaurant members can read products"
  on public.restaurant_products for select
  using (public.is_restaurant_member(restaurant_id));

create policy "restaurant editors can write products"
  on public.restaurant_products for insert
  with check (public.is_restaurant_member(restaurant_id));

create policy "restaurant editors can update products"
  on public.restaurant_products for update
  using (public.is_restaurant_member(restaurant_id))
  with check (public.is_restaurant_member(restaurant_id));

create policy "restaurant editors can delete products"
  on public.restaurant_products for delete
  using (public.is_restaurant_member(restaurant_id));

create index if not exists restaurants_organization_id_idx on public.restaurants(organization_id);
create index if not exists restaurant_products_restaurant_id_idx on public.restaurant_products(restaurant_id);