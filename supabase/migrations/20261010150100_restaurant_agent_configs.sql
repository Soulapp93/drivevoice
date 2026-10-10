-- Configuration persistante de l'agent vocal par restaurant.
-- Cette table permet de synchroniser la configuration de l'agent entre
-- l'espace restaurant et le back-office DriveVoice.

create table if not exists public.restaurant_agent_configs (
  restaurant_id uuid primary key references public.restaurants(id) on delete cascade,
  welcome_message text not null default '',
  voice text not null default 'Marin — naturelle',
  tone text not null default 'Chaleureux et efficace',
  language text not null default 'Français',
  speech_rate numeric(4,2) not null default 1.00,
  knowledge_base jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

comment on table public.restaurant_agent_configs is 'Configuration persistante de l’agent vocal par restaurant.';

alter table public.restaurant_agent_configs enable row level security;

create policy "restaurant_agent_configs_select"
  on public.restaurant_agent_configs
  for select
  using (public.can_access_restaurant(restaurant_id));

create policy "restaurant_agent_configs_modify"
  on public.restaurant_agent_configs
  for all
  using (public.can_manage_restaurant(restaurant_id))
  with check (public.can_manage_restaurant(restaurant_id));

grant select, insert, update, delete on public.restaurant_agent_configs to service_role;
grant select on public.restaurant_agent_configs to authenticated;

-- Mise à jour automatique de updated_at
create or replace function public.set_restaurant_agent_config_updated_at()
returns trigger
language plpgsql
security definer
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger restaurant_agent_configs_updated_at
  before update on public.restaurant_agent_configs
  for each row
  execute function public.set_restaurant_agent_config_updated_at();
