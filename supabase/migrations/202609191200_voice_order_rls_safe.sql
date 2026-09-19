-- DriveVoice : écritures serveur sécurisées malgré une RLS sans politique permissive.
-- Les tables `orders` et `conversation_baskets` ont relrowsecurity = true et aucune
-- politique pour le rôle anon. Tout écrit côté serveur passe donc par ces fonctions
-- SECURITY DEFINER, qui valident d'abord l'existence du restaurant.

create or replace function public.voice_tool_reserve_order(
  p_conversation_id uuid,
  p_restaurant_id uuid,
  p_idempotency_key text,
  p_ref text,
  p_items jsonb,
  p_total numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_ref text;
  v_hubrise_id text;
begin
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'RESTAURANT_UNKNOWN',
      'message', 'Restaurant inconnu.',
      'retryable', false
    );
  end if;

  if p_idempotency_key is null or p_idempotency_key = '' then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'INVALID_IDEMPOTENCY_KEY',
      'message', 'Clé d’idempotence manquante.',
      'retryable', false
    );
  end if;

  select o.status, o.ref, o.hubrise_order_id
    into v_status, v_ref, v_hubrise_id
    from public.orders o
   where o.idempotency_key = p_idempotency_key
   for update;

  if found then
    if v_status = 'sent' then
      return jsonb_build_object(
        'success', true,
        'status', 'already_sent',
        'ref', v_ref,
        'hubrise_order_id', coalesce(v_hubrise_id, '')
      );
    end if;
    if v_status = 'pending' then
      return jsonb_build_object('success', true, 'status', 'in_progress', 'ref', v_ref);
    end if;
    update public.orders
       set status = 'pending',
           ref = p_ref,
           items = p_items,
           total = p_total,
           conversation_id = p_conversation_id
     where idempotency_key = p_idempotency_key;
    return jsonb_build_object('success', true, 'status', 'reserved', 'ref', p_ref);
  end if;

  insert into public.orders (restaurant_id, conversation_id, idempotency_key, ref, source, status, total, items)
  values (p_restaurant_id, p_conversation_id, p_idempotency_key, p_ref, 'voice', 'pending', p_total, p_items);

  return jsonb_build_object('success', true, 'status', 'reserved', 'ref', p_ref);
end;
$$;

create or replace function public.voice_tool_finalize_order(
  p_idempotency_key text,
  p_status text,
  p_hubrise_order_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_status not in ('sent', 'failed') then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'INVALID_STATUS',
      'message', 'Statut de finalisation invalide.',
      'retryable', false
    );
  end if;

  update public.orders
     set status = p_status,
         hubrise_order_id = coalesce(p_hubrise_order_id, hubrise_order_id)
   where idempotency_key = p_idempotency_key;

  if not found then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'ORDER_NOT_FOUND',
      'message', 'Commande introuvable.',
      'retryable', false
    );
  end if;

  return jsonb_build_object('success', true);
end;
$$;

create or replace function public.voice_tool_request_human(
  p_conversation_id uuid,
  p_restaurant_id uuid,
  p_reason text default ''
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_snapshot jsonb;
begin
  if not exists (select 1 from public.restaurants r where r.id = p_restaurant_id) then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'RESTAURANT_UNKNOWN',
      'message', 'Restaurant inconnu.',
      'retryable', false
    );
  end if;

  select cb.snapshot into v_snapshot
    from public.conversation_baskets cb
   where cb.conversation_id = p_conversation_id;

  if v_snapshot is null then
    v_snapshot := jsonb_build_object(
      'restaurantId', p_restaurant_id,
      'items', '[]'::jsonb,
      'total', 0,
      'status', 'editing'
    );
  end if;

  insert into public.conversation_baskets (conversation_id, restaurant_id, snapshot, status, updated_at)
  values (p_conversation_id, p_restaurant_id, v_snapshot, 'human_requested', now())
  on conflict (conversation_id)
  do update set status = 'human_requested',
                updated_at = now();

  return jsonb_build_object(
    'success', true,
    'data', jsonb_build_object('transferred', true, 'reason', coalesce(p_reason, ''))
  );
end;
$$;

create or replace function public.voice_get_hubrise_access_token(p_restaurant_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text;
begin
  select hc.access_token into v_token
    from public.restaurant_hubrise_connections hc
   where hc.restaurant_id = p_restaurant_id
     and hc.connected = true
     and coalesce(hc.status, 'connected') <> 'revoked'
     and (hc.token_expires_at is null or hc.token_expires_at > now())
   order by hc.updated_at desc
   limit 1;
  return v_token;
end;
$$;
