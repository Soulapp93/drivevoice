alter table public.restaurants add column if not exists siret text;
alter table public.restaurants add column if not exists brand_name text;
alter table public.restaurants add column if not exists phone text;
alter table public.restaurants add column if not exists manager_name text;
alter table public.restaurants add column if not exists manager_email text;
alter table public.restaurants add column if not exists manager_role text;

create table if not exists public.platform_admins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  full_name text not null,
  role text not null default 'admin',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.restaurant_invitations (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  email text not null,
  full_name text,
  role text not null,
  status text not null default 'pending',
  invited_at timestamptz not null default now(),
  accepted_at timestamptz
);

create table if not exists public.restaurant_orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  external_order_id text,
  status text not null default 'received',
  total numeric,
  created_at timestamptz not null default now()
);

create index if not exists idx_restaurant_orders_restaurant_created
  on public.restaurant_orders (restaurant_id, created_at desc);

alter table public.platform_admins enable row level security;
alter table public.restaurant_invitations enable row level security;
alter table public.restaurant_orders enable row level security;

drop policy if exists platform_admins_authenticated on public.platform_admins;
create policy platform_admins_authenticated on public.platform_admins
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists restaurant_orders_owner_access on public.restaurant_orders;
create policy restaurant_orders_owner_access on public.restaurant_orders
  for all to authenticated
  using (exists (select 1 from public.restaurants r where r.id = restaurant_id and r.owner_id = auth.uid()))
  with check (exists (select 1 from public.restaurants r where r.id = restaurant_id and r.owner_id = auth.uid()));

drop policy if exists restaurant_invitations_owner_access on public.restaurant_invitations;
create policy restaurant_invitations_owner_access on public.restaurant_invitations
  for all to authenticated
  using (exists (select 1 from public.restaurants r where r.id = restaurant_id and r.owner_id = auth.uid()))
  with check (exists (select 1 from public.restaurants r where r.id = restaurant_id and r.owner_id = auth.uid()));