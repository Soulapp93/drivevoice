-- Audits de conversations vocales : stockage du transcript et de l'usage OpenAI.

create table if not exists public.conversation_audits (
  id uuid primary key default gen_random_uuid(),
  conversation_id text not null,
  restaurant_id uuid references public.restaurants(id) on delete cascade,
  started_at timestamptz,
  ended_at timestamptz not null default now(),
  messages jsonb not null default '[]'::jsonb,
  usage jsonb,
  created_at timestamptz not null default now()
);

comment on table public.conversation_audits is 'Audits des conversations vocales : transcript et usage OpenAI par restaurant.';

alter table public.conversation_audits enable row level security;

create policy "conversation_audits_select"
  on public.conversation_audits
  for select
  using (public.can_access_restaurant(restaurant_id));

-- service_role est utilisé par l'API /api/conversations/audit pour insérer les audits.
create policy "conversation_audits_insert_service_role"
  on public.conversation_audits
  for insert
  with check (true);

grant select on public.conversation_audits to authenticated;
grant select, insert, update, delete on public.conversation_audits to service_role;

-- Index pour accélérer les requêtes par restaurant et par période.
create index if not exists idx_conversation_audits_restaurant_id on public.conversation_audits(restaurant_id);
create index if not exists idx_conversation_audits_ended_at on public.conversation_audits(ended_at);
