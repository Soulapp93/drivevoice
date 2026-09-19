create or replace function voice_tool_update_order(
  p_conversation_id uuid,
  p_restaurant_id uuid,
  p_args_json jsonb
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_status text;
  v_items jsonb;
  v_item jsonb;
  v_product_id text;
  v_quantity int;
  v_product record;
  v_basket jsonb;
  v_total numeric := 0;
  v_basket_items jsonb := '[]'::jsonb;
begin
  -- validation de base
  if p_args_json is null or p_args_json->'items' is null or p_args_json->>'status' is null then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'INVALID_ARGUMENTS',
      'message', 'Les arguments du panier sont incomplets.',
      'retryable', false
    );
  end if;

  v_items := p_args_json->'items';
  v_status := p_args_json->>'status';

  if v_status not in ('editing', 'ready_to_confirm', 'confirmed') then
    return jsonb_build_object(
      'success', false,
      'errorCode', 'INVALID_ARGUMENTS',
      'message', 'Statut du panier non reconnu.',
      'retryable', false
    );
  end if;

  -- validation et construction du panier
  for i in 0 .. jsonb_array_length(v_items) - 1 loop
    v_item := v_items->i;
    v_product_id := v_item->>'product_id';
    v_quantity := (v_item->>'quantity')::int;

    if v_product_id is null or v_product_id = '' then
      return jsonb_build_object(
        'success', false,
        'errorCode', 'INVALID_ARGUMENTS',
        'message', 'Un article n’a pas d’identifiant produit valide.',
        'retryable', false
      );
    end if;

    if v_quantity is null or v_quantity < 1 or v_quantity > 20 then
      return jsonb_build_object(
        'success', false,
        'errorCode', 'INVALID_QUANTITY',
        'message', 'La quantité doit être comprise entre 1 et 20.',
        'retryable', false
      );
    end if;

    select id, product_id, name, price, available, data
    into v_product
    from restaurant_products
    where restaurant_id = p_restaurant_id
      and product_id = v_product_id
    limit 1;

    if v_product is null then
      return jsonb_build_object(
        'success', false,
        'errorCode', 'PRODUCT_NOT_FOUND',
        'message', 'Le produit demandé n’existe pas dans le catalogue officiel.',
        'retryable', false
      );
    end if;

    if v_product.available = false then
      return jsonb_build_object(
        'success', false,
        'errorCode', 'PRODUCT_UNAVAILABLE',
        'message', 'Le produit demandé est actuellement indisponible. Propose une alternative au client.',
        'retryable', false
      );
    end if;

    v_basket_items := v_basket_items || jsonb_build_object(
      'id', v_product_id || '-' || (jsonb_array_length(v_basket_items) + 1)::text,
      'productId', v_product.product_id,
      'name', v_product.name,
      'detail', coalesce(v_product.data->>'detail', ''),
      'price', v_product.price,
      'quantity', v_quantity,
      'customizations', '[]'::jsonb
    );

    v_total := v_total + (v_product.price * v_quantity);
  end loop;

  v_basket := jsonb_build_object(
    'restaurantId', p_restaurant_id,
    'items', v_basket_items,
    'total', v_total,
    'status', v_status
  );

  insert into conversation_baskets (conversation_id, restaurant_id, snapshot, status, updated_at)
  values (p_conversation_id, p_restaurant_id, v_basket, v_status, now())
  on conflict (conversation_id)
  do update set snapshot = excluded.snapshot, status = excluded.status, updated_at = now();

  return jsonb_build_object('success', true, 'data', v_basket);
end;
$$;

create or replace function voice_tool_get_basket(
  p_conversation_id uuid,
  p_restaurant_id uuid
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_snapshot jsonb;
begin
  select snapshot into v_snapshot
  from conversation_baskets
  where conversation_id = p_conversation_id
    and restaurant_id = p_restaurant_id;

  if v_snapshot is null then
    v_snapshot := jsonb_build_object(
      'restaurantId', p_restaurant_id,
      'items', '[]'::jsonb,
      'total', 0,
      'status', 'editing'
    );
  end if;

  return jsonb_build_object('success', true, 'data', v_snapshot);
end;
$$;

grant execute on function voice_tool_update_order(uuid, uuid, jsonb) to anon;
grant execute on function voice_tool_get_basket(uuid, uuid) to anon;
grant execute on function voice_tool_update_order(uuid, uuid, jsonb) to authenticated;
grant execute on function voice_tool_get_basket(uuid, uuid) to authenticated;
