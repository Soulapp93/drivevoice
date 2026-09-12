-- Fonction RPC utilisée par la Edge Function pour lire ses secrets de manière sécurisée.
drop function if exists public.get_edge_function_secrets(text);

create or replace function public.get_edge_function_secrets(p_function_name text)
returns json
language plpgsql
security definer
as $$
declare
  result jsonb;
begin
  select secrets into result
  from private.edge_function_secrets
  where function_name = p_function_name;

  if result is null then
    return null;
  end if;

  return result::json;
end;
$$;

-- Seule la service_role peut exécuter cette fonction (Edge Functions utilisent service_role par défaut).
revoke all on function public.get_edge_function_secrets(text) from anon, authenticated;
grant execute on function public.get_edge_function_secrets(text) to service_role;