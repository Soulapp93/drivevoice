-- DriveVoice — opérations de panier incrémentales pour l’agent vocal
-- Permet à l’agent d’ajouter, retirer ou modifier un article sans reconstruire tout le panier.

create or replace function voice_tool_add_item(
  p_conversation_id uuid,
  p_restaurant_id uuid,
  p_product_id text,
  p_quantity int,
  p_selections_json jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_product record;
  v_snapshot jsonb;
  v_items jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_found boolean := false;
  v_item jsonb;
  v_customizations jsonb := '[]'::jsonb;
  v_selection jsonb;
  v_option record;
  v_price_delta numeric := 0;
  v_price numeric;
  i int;
begin
  -- validation
  if p_product_id is null or p_product_id = '' then
    return jsonb_build_object('success', false, 'errorCode', 'INVALID_ARGUMENTS', 'message', 'L’identifiant produit est manquant.', 'retryable', false);
  end if;

  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    return jsonb_build_object('success', false, 'errorCode', 'INVALID_QUANTITY', 'message', 'La quantité doit être comprise entre 1 et 20.', 'retryable', false);
  end if;

  -- produit officiel
  select id, product_id, name, price, available, data
  into v_product
  from restaurant_products
  where restaurant_id = p_restaurant_id
    and product_id = p_product_id
  limit 1;

  if v_product is null then
    return jsonb_build_object('success', false, 'errorCode', 'PRODUCT_NOT_FOUND', 'message', 'Le produit demandé n’existe pas dans le catalogue officiel.', 'retryable', false);
  end if;

  if v_product.available = false then
    return jsonb_build_object('success', false, 'errorCode', 'PRODUCT_UNAVAILABLE', 'message', 'Le produit demandé est actuellement indisponible. Propose une alternative au client.', 'retryable', false);
  end if;

  -- panier existant
  select snapshot into v_snapshot
  from conversation_baskets
  where conversation_id = p_conversation_id
    and restaurant_id = p_restaurant_id;

  if v_snapshot is not null and jsonb_typeof(v_snapshot->'items') = 'array' then
    v_items := v_snapshot->'items';
  end if;

  -- résolution des customizations / options
  if p_selections_json is not null and jsonb_typeof(p_selections_json) = 'array' then
    for i in 0 .. jsonb_array_length(p_selections_json) - 1 loop
      v_selection := p_selections_json->i;
      -- recherche l’option dans data->optionGroups (structure flexible)
      select (opt->>'priceDelta')::numeric as price_delta, opt->>'name' as option_name
      into v_option
      from jsonb_array_elements(v_product.data->'optionGroups') grp,
           jsonb_array_elements(grp->'options') opt
      where lower(opt->>'name') = lower(v_selection->>'option')
      limit 1;

      if v_option.option_name is not null then
        v_customizations := v_customizations || jsonb_build_object('group', v_selection->>'group', 'option', v_option.option_name);
        v_price_delta := v_price_delta + coalesce(v_option.price_delta, 0);
      end if;
    end loop;
  end if;

  v_price := v_product.price + v_price_delta;

  -- fusion : si le produit existe déjà avec les mêmes customizations, incrémenter
  for i in 0 .. jsonb_array_length(v_items) - 1 loop
    v_item := v_items->i;
    if v_item->>'productId' = p_product_id and v_item->'customizations' = v_customizations then
      v_items := jsonb_set(
        v_items,
        array[i::text, 'quantity'],
        to_jsonb((v_item->>'quantity')::int + p_quantity)
      );
      v_found := true;
      exit;
    end if;
  end loop;

  if not v_found then
    v_items := v_items || jsonb_build_object(
      'id', p_product_id || '-' || (jsonb_array_length(v_items) + 1)::text,
      'productId', v_product.product_id,
      'name', v_product.name,
      'detail', coalesce(v_product.data->>'detail', ''),
      'price', v_price,
      'quantity', p_quantity,
      'customizations', v_customizations
    );
  end if;

  -- recalcul total
  for i in 0 .. jsonb_array_length(v_items) - 1 loop
    v_item := v_items->i;
    v_total := v_total + ((v_item->>'price')::numeric * (v_item->>'quantity')::int);
  end loop;

  v_snapshot := jsonb_build_object(
    'restaurantId', p_restaurant_id,
    'items', v_items,
    'total', v_total,
    'status', 'editing'
  );

  insert into conversation_baskets (conversation_id, restaurant_id, snapshot, status, updated_at)
  values (p_conversation_id, p_restaurant_id, v_snapshot, 'editing', now())
  on conflict (conversation_id)
  do update set snapshot = excluded.snapshot, status = 'editing', updated_at = now();

  return jsonb_build_object('success', true, 'data', v_snapshot);
end;
$$;

create or replace function voice_tool_remove_item(
  p_conversation_id uuid,
  p_restaurant_id uuid,
  p_product_id text,
  p_quantity int default null
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_snapshot jsonb;
  v_items jsonb := '[]'::jsonb;
  v_remaining jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_item jsonb;
  v_removed int := 0;
  i int;
begin
  if p_product_id is null or p_product_id = '' then
    return jsonb_build_object('success', false, 'errorCode', 'INVALID_ARGUMENTS', 'message', 'L’identifiant produit est manquant.', 'retryable', false);
  end if;

  select snapshot into v_snapshot
  from conversation_baskets
  where conversation_id = p_conversation_id
    and restaurant_id = p_restaurant_id;

  if v_snapshot is null or jsonb_typeof(v_snapshot->'items') <> 'array' then
    return jsonb_build_object('success', false, 'errorCode', 'BASKET_EMPTY', 'message', 'Le panier est vide.', 'retryable', false);
  end if;

  v_items := v_snapshot->'items';

  for i in 0 .. jsonb_array_length(v_items) - 1 loop
    v_item := v_items->i;
    if v_item->>'productId' = p_product_id and v_removed = 0 then
      declare
        v_current int := (v_item->>'quantity')::int;
        v_target int := least(coalesce(p_quantity, v_current), v_current);
      begin
        if v_target < v_current then
          v_remaining := v_remaining || jsonb_set(v_item, array['quantity'], to_jsonb(v_current - v_target));
        end if;
        v_removed := v_target;
      end;
    else
      v_remaining := v_remaining || v_item;
    end if;
  end loop;

  if v_removed = 0 then
    return jsonb_build_object('success', false, 'errorCode', 'ITEM_NOT_IN_BASKET', 'message', 'Cet article n’est pas dans le panier.', 'retryable', false);
  end if;

  for i in 0 .. jsonb_array_length(v_remaining) - 1 loop
    v_item := v_remaining->i;
    v_total := v_total + ((v_item->>'price')::numeric * (v_item->>'quantity')::int);
  end loop;

  v_snapshot := jsonb_build_object(
    'restaurantId', p_restaurant_id,
    'items', v_remaining,
    'total', v_total,
    'status', 'editing'
  );

  insert into conversation_baskets (conversation_id, restaurant_id, snapshot, status, updated_at)
  values (p_conversation_id, p_restaurant_id, v_snapshot, 'editing', now())
  on conflict (conversation_id)
  do update set snapshot = excluded.snapshot, status = 'editing', updated_at = now();

  return jsonb_build_object('success', true, 'data', v_snapshot);
end;
$$;

create or replace function voice_tool_set_item_quantity(
  p_conversation_id uuid,
  p_restaurant_id uuid,
  p_product_id text,
  p_quantity int
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_snapshot jsonb;
  v_items jsonb := '[]'::jsonb;
  v_remaining jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_item jsonb;
  v_found boolean := false;
  i int;
begin
  if p_product_id is null or p_product_id = '' then
    return jsonb_build_object('success', false, 'errorCode', 'INVALID_ARGUMENTS', 'message', 'L’identifiant produit est manquant.', 'retryable', false);
  end if;

  if p_quantity < 0 or p_quantity > 20 then
    return jsonb_build_object('success', false, 'errorCode', 'INVALID_QUANTITY', 'message', 'La quantité doit être comprise entre 0 et 20.', 'retryable', false);
  end if;

  select snapshot into v_snapshot
  from conversation_baskets
  where conversation_id = p_conversation_id
    and restaurant_id = p_restaurant_id;

  if v_snapshot is null or jsonb_typeof(v_snapshot->'items') <> 'array' then
    return jsonb_build_object('success', false, 'errorCode', 'BASKET_EMPTY', 'message', 'Le panier est vide.', 'retryable', false);
  end if;

  v_items := v_snapshot->'items';

  for i in 0 .. jsonb_array_length(v_items) - 1 loop
    v_item := v_items->i;
    if v_item->>'productId' = p_product_id then
      v_found := true;
      if p_quantity > 0 then
        v_remaining := v_remaining || jsonb_set(v_item, array['quantity'], to_jsonb(p_quantity));
      end if;
    else
      v_remaining := v_remaining || v_item;
    end if;
  end loop;

  if not v_found then
    return jsonb_build_object('success', false, 'errorCode', 'ITEM_NOT_IN_BASKET', 'message', 'Cet article n’est pas dans le panier.', 'retryable', false);
  end if;

  for i in 0 .. jsonb_array_length(v_remaining) - 1 loop
    v_item := v_remaining->i;
    v_total := v_total + ((v_item->>'price')::numeric * (v_item->>'quantity')::int);
  end loop;

  v_snapshot := jsonb_build_object(
    'restaurantId', p_restaurant_id,
    'items', v_remaining,
    'total', v_total,
    'status', 'editing'
  );

  insert into conversation_baskets (conversation_id, restaurant_id, snapshot, status, updated_at)
  values (p_conversation_id, p_restaurant_id, v_snapshot, 'editing', now())
  on conflict (conversation_id)
  do update set snapshot = excluded.snapshot, status = 'editing', updated_at = now();

  return jsonb_build_object('success', true, 'data', v_snapshot);
end;
$$;

grant execute on function voice_tool_add_item(uuid, uuid, text, int, jsonb) to anon;
grant execute on function voice_tool_remove_item(uuid, uuid, text, int) to anon;
grant execute on function voice_tool_set_item_quantity(uuid, uuid, text, int) to anon;
grant execute on function voice_tool_add_item(uuid, uuid, text, int, jsonb) to authenticated;
grant execute on function voice_tool_remove_item(uuid, uuid, text, int) to authenticated;
grant execute on function voice_tool_set_item_quantity(uuid, uuid, text, int) to authenticated;

-- Catalogue officiel d’un restaurant, utilisé pour construire les instructions de l’agent.
create or replace function voice_tool_get_catalog(p_restaurant_id uuid)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_product record;
  v_catalog jsonb := '[]'::jsonb;
begin
  for v_product in
    select product_id, name, price, available, category, data
    from restaurant_products
    where restaurant_id = p_restaurant_id
    order by display_order, name
  loop
    v_catalog := v_catalog || jsonb_build_object(
      'productId', v_product.product_id,
      'name', v_product.name,
      'price', v_product.price,
      'available', v_product.available,
      'category', v_product.category,
      'detail', coalesce(v_product.data->>'detail', ''),
      'optionGroups', coalesce(v_product.data->'optionGroups', '[]'::jsonb)
    );
  end loop;

  return v_catalog;
end;
$$;

grant execute on function voice_tool_get_catalog(uuid) to anon;
grant execute on function voice_tool_get_catalog(uuid) to authenticated;
