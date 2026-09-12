-- Ajoute les colonnes manquantes pour stocker l'état de connexion HubRise.
alter table public.restaurant_hubrise_connections
  add column if not exists connected boolean not null default false,
  add column if not exists token_expires_at timestamptz,
  add column if not exists account_name text,
  add column if not exists catalog_sync_enabled boolean not null default true,
  alter column location_id drop not null;

-- Met à jour les enregistrements existants pour refléter le statut connecté.
update public.restaurant_hubrise_connections
  set connected = true
  where status = 'connected' and connected = false;