-- Sécurise les secrets spécifiques à la Edge Function HubRise OAuth.
-- Seule la service_role (Edge Function) peut lire ces valeurs grâce à RLS.
create schema if not exists private;

create table if not exists private.edge_function_secrets (
  function_name text primary key,
  secrets jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table private.edge_function_secrets enable row level security;

drop policy if exists service_role_only on private.edge_function_secrets;
create policy service_role_only on private.edge_function_secrets
  for all
  to service_role
  using (true)
  with check (true);

-- Insère / met à jour les secrets HubRise pour la fonction hubrise-oauth.
-- Remplacez ces valeurs par les vrais secrets de production après les tests.
insert into private.edge_function_secrets (function_name, secrets)
values (
  'hubrise-oauth',
  jsonb_build_object(
    'HUBRISE_CLIENT_ID', '428772282323.clients.hubrise.com',
    'HUBRISE_CLIENT_SECRET', '2fecd728c1d99d4bb8688684e547aaf8e570627ab686b19a075b1194890e8a5f',
    'HUBRISE_STATE_SECRET', 'drivevoice-hubrise-state-secret-demo-replace-in-production',
    'HUBRISE_REDIRECT_URI', 'https://1f22a1ba-5173-10-base.preview.verdent.ai/api/hubrise/callback'
  )
)
on conflict (function_name)
do update set
  secrets = excluded.secrets,
  updated_at = now();
