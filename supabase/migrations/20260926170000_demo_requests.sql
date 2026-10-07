create table if not exists public.demo_requests (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text not null,
  phone text not null,
  restaurant_name text not null,
  restaurant_count integer not null check (restaurant_count between 1 and 10000),
  role text not null,
  message text not null,
  received_at timestamptz not null default now()
);

create index if not exists idx_demo_requests_received_at
  on public.demo_requests (received_at desc);

alter table public.demo_requests enable row level security;

revoke all on table public.demo_requests from anon, authenticated;
grant select, insert on table public.demo_requests to service_role;
