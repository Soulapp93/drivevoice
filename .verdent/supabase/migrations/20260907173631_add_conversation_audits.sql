create table if not exists public.conversation_audits (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null unique,
  restaurant_id text not null,
  started_at timestamptz,
  ended_at timestamptz not null default now(),
  messages jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_conversation_audits_restaurant
  on public.conversation_audits (restaurant_id, created_at desc);

alter table public.conversation_audits enable row level security;