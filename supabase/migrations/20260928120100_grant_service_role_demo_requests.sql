-- La migration 20260926170100_demo_requests_restricted_access a révoqué tous les
-- privilèges sur demo_requests, y compris pour service_role, empêchant les routes
-- serveur de l'admin (qui utilisent la clé service_role) de lire/modifier la table.
grant select, update on public.demo_requests to service_role;
