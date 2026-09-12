-- Fonction RPC utilisée par la Edge Function pour lire ses secrets de manière sécurisée.
create or replace function private.get_edge_function_secrets(p_function_name text)
returns jsonb
language sql
security definer
as $$
  select secrets
  from private.edge_function_secrets
  where function_name = p_function_name;
$$;

-- Seule la service_role peut exécuter cette fonction (Edge Functions utilisent service_role par défaut).
revoke all on function private.get_edge_function_secrets(text) from anon, authenticated;
grant execute on function private.get_edge_function_secrets(text) to service_role;