create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  hubrise_order_id text,
  ref text not null,
  source text not null default 'voice',
  status text not null default 'draft',
  total numeric(10,2) not null default 0,
  items jsonb default '[]',
  customer jsonb default '{}',
  conversation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_orders_restaurant on public.orders (restaurant_id);
create index if not exists idx_orders_ref on public.orders (ref);

alter table public.orders enable row level security;

drop policy if exists "orders_restaurant_access" on public.orders;
create policy "orders_restaurant_access" on public.orders
  for all to authenticated
  using (restaurant_id in (select restaurant_id from public.restaurant_members where user_id = auth.uid()))
  with check (restaurant_id in (select restaurant_id from public.restaurant_members where user_id = auth.uid()));
