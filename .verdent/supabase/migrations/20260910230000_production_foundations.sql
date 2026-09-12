create table if not exists public.restaurant_members (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'manager',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (restaurant_id, user_id)
);

create table if not exists public.order_sessions (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references public.restaurants(id) on delete cascade,
  external_order_id text,
  status text not null default 'in_progress',
  channel text not null default 'voice',
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_seconds integer,
  comprehension_score numeric(5,2),
  created_at timestamptz not null default now(),
  unique (restaurant_id, external_order_id)
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_session_id uuid not null references public.order_sessions(id) on delete cascade,
  product_id uuid,
  product_name text not null,
  quantity integer not null default 1,
  unit_price numeric(10,2),
  created_at timestamptz not null default now()
);

alter table public.restaurant_members enable row level security;
alter table public.order_sessions enable row level security;
alter table public.order_items enable row level security;

drop policy if exists restaurant_members_access on public.restaurant_members;
create policy restaurant_members_access on public.restaurant_members
  for all to authenticated
  using (
    user_id = auth.uid()
    or exists (select 1 from public.restaurant_members m where m.restaurant_id = restaurant_id and m.user_id = auth.uid() and m.active)
    or public.is_platform_admin()
  )
  with check (
    user_id = auth.uid()
    or public.is_platform_admin()
  );

drop policy if exists order_sessions_access on public.order_sessions;
create policy order_sessions_access on public.order_sessions
  for all to authenticated
  using (
    exists (select 1 from public.restaurant_members m where m.restaurant_id = order_sessions.restaurant_id and m.user_id = auth.uid() and m.active)
    or exists (select 1 from public.restaurants r where r.id = order_sessions.restaurant_id and r.owner_id = auth.uid())
    or public.is_platform_admin()
  )
  with check (
    exists (select 1 from public.restaurant_members m where m.restaurant_id = order_sessions.restaurant_id and m.user_id = auth.uid() and m.active)
    or exists (select 1 from public.restaurants r where r.id = order_sessions.restaurant_id and r.owner_id = auth.uid())
    or public.is_platform_admin()
  );

drop policy if exists order_items_access on public.order_items;
create policy order_items_access on public.order_items
  for all to authenticated
  using (
    exists (
      select 1
      from public.order_sessions s
      where s.id = order_items.order_session_id
        and (
          exists (select 1 from public.restaurant_members m where m.restaurant_id = s.restaurant_id and m.user_id = auth.uid() and m.active)
          or exists (select 1 from public.restaurants r where r.id = s.restaurant_id and r.owner_id = auth.uid())
          or public.is_platform_admin()
        )
    )
  )
  with check (
    exists (
      select 1
      from public.order_sessions s
      where s.id = order_items.order_session_id
        and (
          exists (select 1 from public.restaurant_members m where m.restaurant_id = s.restaurant_id and m.user_id = auth.uid() and m.active)
          or exists (select 1 from public.restaurants r where r.id = s.restaurant_id and r.owner_id = auth.uid())
          or public.is_platform_admin()
        )
    )
  );

create index if not exists idx_order_sessions_restaurant_created
  on public.order_sessions (restaurant_id, created_at desc);
create index if not exists idx_order_items_session
  on public.order_items (order_session_id);

notify pgrst, 'reload schema';