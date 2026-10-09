-- La route API publique de demande de démonstration insère les lignes avec la clé
-- service_role (createClient côté serveur). La migration 20260926170100 a révoqué
-- tous les privilèges sur demo_requests puis n'a accordé INSERT qu'au rôle anon,
-- laissant service_role sans droit d'insertion et provoquant l'échec du formulaire
-- avec l'erreur "permission denied for table demo_requests".
grant insert on public.demo_requests to service_role;
