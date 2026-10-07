create or replace function public.voice_tool_size_matches(p_configured_size text, p_selected_size text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select lower(btrim(p_configured_size)) = any(
    case lower(btrim(p_selected_size))
      when 'medium' then array['medium', 'm']::text[]
      when 'king size' then array['king size', 'king', 'l', 'xl']::text[]
      when 'extra' then array['extra', 'xxl', 'xl']::text[]
      else array[lower(btrim(p_selected_size))]::text[]
    end
  );
$$;

revoke all on function public.voice_tool_size_matches(text, text) from public, anon, authenticated;

create or replace function public.voice_tool_resolve_menu_item(
  p_restaurant_id uuid,
  p_product_id text,
  p_quantity integer,
  p_selections_json jsonb,
  p_item_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product record;
  v_groups jsonb := '[]'::jsonb;
  v_group jsonb;
  v_selection jsonb;
  v_candidate jsonb;
  v_option jsonb;
  v_rule jsonb;
  v_entry record;
  v_duplicate_count integer;
  v_group_name text;
  v_selection_name text;
  v_selected_size text;
  v_size_group_found boolean := false;
  v_customizations jsonb := '[]'::jsonb;
  v_price_delta numeric := 0;
  v_option_price numeric;
  v_min integer;
  v_max integer;
  v_selected_count integer;
  v_index integer;
  v_item jsonb;
begin
  if p_product_id is null or btrim(p_product_id) = '' then
    return jsonb_build_object('success', false, 'errorCode', 'INVALID_ARGUMENTS', 'message', 'L’identifiant produit est manquant.', 'retryable', false);
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 20 then
    return jsonb_build_object('success', false, 'errorCode', 'INVALID_QUANTITY', 'message', 'La quantité doit être comprise entre 1 et 20.', 'retryable', false);
  end if;
  if p_selections_json is not null and jsonb_typeof(p_selections_json) <> 'array' then
    return jsonb_build_object('success', false, 'errorCode', 'INVALID_OPTIONS', 'message', 'Les choix du produit sont invalides.', 'retryable', false);
  end if;

  select product_id, name, price, available, data
  into v_product
  from public.restaurant_products
  where restaurant_id = p_restaurant_id and product_id = p_product_id
  limit 1;

  if v_product is null then
    return jsonb_build_object('success', false, 'errorCode', 'PRODUCT_NOT_FOUND', 'message', 'Le produit demandé n’existe pas dans le catalogue officiel.', 'retryable', false);
  end if;
  if v_product.available = false then
    return jsonb_build_object('success', false, 'errorCode', 'PRODUCT_UNAVAILABLE', 'message', 'Le produit demandé est actuellement indisponible. Propose une alternative au client.', 'retryable', false);
  end if;

  if jsonb_typeof(v_product.data->'optionGroups') = 'array' then
    v_groups := v_product.data->'optionGroups';
  end if;
  p_selections_json := coalesce(p_selections_json, '[]'::jsonb);

  for v_selection in select value from jsonb_array_elements(p_selections_json) as selections(value) loop
    if jsonb_typeof(v_selection) <> 'object'
      or nullif(btrim(v_selection->>'group'), '') is null
      or jsonb_typeof(v_selection->'options') <> 'array' then
      return jsonb_build_object('success', false, 'errorCode', 'INVALID_OPTIONS', 'message', 'Un groupe d’options est invalide.', 'retryable', false);
    end if;
    select count(*) into v_duplicate_count
    from jsonb_array_elements(p_selections_json) as selections(value)
    where lower(value->>'group') = lower(v_selection->>'group');
    if v_duplicate_count > 1 then
      return jsonb_build_object('success', false, 'errorCode', 'INVALID_OPTIONS', 'message', 'Un même groupe d’options a été transmis plusieurs fois.', 'retryable', false);
    end if;
  end loop;

  for v_group in select value from jsonb_array_elements(v_groups) as groups(value) loop
    v_group_name := nullif(btrim(v_group->>'name'), '');
    if v_group_name is null then
      continue;
    end if;
    v_selection := null;
    for v_candidate in select value from jsonb_array_elements(p_selections_json) as selections(value) loop
      if lower(v_candidate->>'group') = lower(v_group_name) then
        v_selection := v_candidate;
        exit;
      end if;
    end loop;

    if v_group_name ilike '%taille%' then
      v_size_group_found := true;
      if v_selection is not null and jsonb_array_length(v_selection->'options') = 1 then
        v_selected_size := v_selection->'options'->>0;
      elsif v_selection is not null then
        return jsonb_build_object('success', false, 'errorCode', 'INVALID_OPTIONS', 'message', 'Choisis exactement une taille pour ce menu.', 'retryable', false);
      end if;
    end if;

    v_min := coalesce(nullif(v_group->>'min', '')::integer, case when coalesce((v_group->>'required')::boolean, false) then 1 else 0 end);
    v_max := coalesce(nullif(v_group->>'max', '')::integer, 1);
    v_rule := null;
    if v_selected_size is not null and jsonb_typeof(v_group->'rulesBySize') = 'object' then
      for v_entry in select key, value from jsonb_each(v_group->'rulesBySize') loop
        if public.voice_tool_size_matches(v_entry.key, v_selected_size) then
          v_rule := v_entry.value;
          exit;
        end if;
      end loop;
    end if;
    if v_rule is not null then
      v_min := coalesce(nullif(v_rule->>'min', '')::integer, case when coalesce((v_rule->>'required')::boolean, false) then 1 else 0 end);
      v_max := coalesce(nullif(v_rule->>'max', '')::integer, v_max);
    end if;

    v_selected_count := case when v_selection is null then 0 else jsonb_array_length(v_selection->'options') end;
    if v_selected_count < v_min then
      return jsonb_build_object('success', false, 'errorCode', 'REQUIRED_OPTIONS_MISSING', 'message', format('Le choix « %s » est obligatoire pour %s.', v_group_name, coalesce(v_selected_size, 'ce produit')), 'retryable', false);
    end if;
    if v_selected_count > v_max then
      return jsonb_build_object('success', false, 'errorCode', 'TOO_MANY_OPTIONS', 'message', format('Trop d’options ont été sélectionnées pour « %s ».', v_group_name), 'retryable', false);
    end if;

    if v_selection is not null then
      for v_index in 0 .. v_selected_count - 1 loop
        v_selection_name := nullif(btrim(v_selection->'options'->>v_index), '');
        if v_selection_name is null then
          return jsonb_build_object('success', false, 'errorCode', 'INVALID_OPTIONS', 'message', 'Une option sélectionnée est vide.', 'retryable', false);
        end if;
        select value into v_option
        from jsonb_array_elements(coalesce(v_group->'options', '[]'::jsonb)) as options(value)
        where lower(value->>'name') = lower(v_selection_name)
        limit 1;
        if v_option is null or v_option->>'available' = 'false' then
          return jsonb_build_object('success', false, 'errorCode', 'OPTION_UNAVAILABLE', 'message', format('L’option « %s » du groupe « %s » est indisponible.', v_selection_name, v_group_name), 'retryable', false);
        end if;
        if v_selected_size is not null and jsonb_typeof(v_option->'availableFor') = 'array'
          and not exists (
            select 1 from jsonb_array_elements_text(v_option->'availableFor') as sizes(value)
            where public.voice_tool_size_matches(value, v_selected_size)
          ) then
          return jsonb_build_object('success', false, 'errorCode', 'OPTION_UNAVAILABLE', 'message', format('L’option « %s » n’est pas disponible pour la taille %s.', v_selection_name, v_selected_size), 'retryable', false);
        end if;

        v_option_price := null;
        if v_selected_size is not null and jsonb_typeof(v_option->'priceDeltaBySize') = 'object' then
          for v_entry in select key, value from jsonb_each(v_option->'priceDeltaBySize') loop
            if public.voice_tool_size_matches(v_entry.key, v_selected_size) then
              v_option_price := v_entry.value::text::numeric;
              exit;
            end if;
          end loop;
        end if;
        v_price_delta := v_price_delta + coalesce(v_option_price, nullif(v_option->>'priceDelta', '')::numeric, 0);
        v_customizations := v_customizations || jsonb_build_array(v_group_name || ': ' || (v_option->>'name'));
      end loop;
    end if;
  end loop;

  if v_size_group_found and v_selected_size is null then
    return jsonb_build_object('success', false, 'errorCode', 'REQUIRED_OPTIONS_MISSING', 'message', 'La taille du menu doit être choisie.', 'retryable', false);
  end if;

  for v_selection in select value from jsonb_array_elements(p_selections_json) as selections(value) loop
    if not exists (
      select 1 from jsonb_array_elements(v_groups) as groups(value)
      where lower(groups.value->>'name') = lower(v_selection->>'group')
    ) then
      return jsonb_build_object('success', false, 'errorCode', 'INVALID_OPTIONS', 'message', format('Le groupe d’options « %s » n’existe pas pour ce produit.', v_selection->>'group'), 'retryable', false);
    end if;
  end loop;

  v_item := jsonb_build_object(
    'id', p_item_id,
    'productId', v_product.product_id,
    'name', v_product.name,
    'detail', coalesce(v_product.data->>'detail', ''),
    'price', v_product.price + v_price_delta,
    'quantity', p_quantity,
    'customizations', v_customizations
  );
  return jsonb_build_object('success', true, 'data', v_item);
end;
$$;

revoke all on function public.voice_tool_resolve_menu_item(uuid, text, integer, jsonb, text) from public, anon, authenticated;

create or replace function public.voice_tool_add_item(
  p_conversation_id uuid,
  p_restaurant_id uuid,
  p_product_id text,
  p_quantity integer,
  p_selections_json jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_resolved jsonb;
  v_new_item jsonb;
  v_snapshot jsonb;
  v_items jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_item jsonb;
  v_found boolean := false;
  v_index integer;
begin
  v_resolved := public.voice_tool_resolve_menu_item(p_restaurant_id, p_product_id, p_quantity, p_selections_json, p_product_id || '-' || gen_random_uuid()::text);
  if v_resolved->>'success' <> 'true' then
    return v_resolved;
  end if;
  v_new_item := v_resolved->'data';

  select snapshot into v_snapshot
  from public.conversation_baskets
  where conversation_id = p_conversation_id and restaurant_id = p_restaurant_id;
  if v_snapshot is not null and jsonb_typeof(v_snapshot->'items') = 'array' then
    v_items := v_snapshot->'items';
  end if;

  if jsonb_array_length(v_items) > 0 then
    for v_index in 0 .. jsonb_array_length(v_items) - 1 loop
      v_item := v_items->v_index;
      if v_item->>'productId' = p_product_id and v_item->'customizations' = v_new_item->'customizations' then
        if (v_item->>'quantity')::integer + p_quantity > 20 then
          return jsonb_build_object('success', false, 'errorCode', 'INVALID_QUANTITY', 'message', 'La quantité totale doit être comprise entre 1 et 20.', 'retryable', false);
        end if;
        v_items := jsonb_set(v_items, array[v_index::text, 'quantity'], to_jsonb((v_item->>'quantity')::integer + p_quantity));
        v_found := true;
        exit;
      end if;
    end loop;
  end if;
  if not v_found then
    v_items := v_items || jsonb_build_array(v_new_item);
  end if;

  if jsonb_array_length(v_items) > 0 then
    for v_index in 0 .. jsonb_array_length(v_items) - 1 loop
      v_item := v_items->v_index;
      v_total := v_total + ((v_item->>'price')::numeric * (v_item->>'quantity')::integer);
    end loop;
  end if;

  v_snapshot := jsonb_build_object('restaurantId', p_restaurant_id, 'items', v_items, 'total', v_total, 'status', 'editing');
  insert into public.conversation_baskets (conversation_id, restaurant_id, snapshot, status, updated_at)
  values (p_conversation_id, p_restaurant_id, v_snapshot, 'editing', now())
  on conflict (conversation_id) do update set snapshot = excluded.snapshot, status = 'editing', updated_at = now();
  return jsonb_build_object('success', true, 'data', v_snapshot);
end;
$$;

create or replace function public.voice_tool_update_order(
  p_conversation_id uuid,
  p_restaurant_id uuid,
  p_args_json jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_items_input jsonb;
  v_input jsonb;
  v_resolved jsonb;
  v_item jsonb;
  v_items jsonb := '[]'::jsonb;
  v_total numeric := 0;
  v_index integer;
  v_snapshot jsonb;
begin
  if p_args_json is null or jsonb_typeof(p_args_json->'items') <> 'array' or p_args_json->>'status' is null then
    return jsonb_build_object('success', false, 'errorCode', 'INVALID_ARGUMENTS', 'message', 'Les arguments du panier sont incomplets.', 'retryable', false);
  end if;
  v_items_input := p_args_json->'items';
  v_status := p_args_json->>'status';
  if v_status not in ('editing', 'ready_to_confirm', 'confirmed') then
    return jsonb_build_object('success', false, 'errorCode', 'INVALID_ARGUMENTS', 'message', 'Statut du panier non reconnu.', 'retryable', false);
  end if;

  if jsonb_array_length(v_items_input) > 0 then
    for v_index in 0 .. jsonb_array_length(v_items_input) - 1 loop
      v_input := v_items_input->v_index;
      v_resolved := public.voice_tool_resolve_menu_item(
        p_restaurant_id,
        v_input->>'product_id',
        nullif(v_input->>'quantity', '')::integer,
        coalesce(v_input->'selections', '[]'::jsonb),
        coalesce(v_input->>'product_id', 'item') || '-' || (v_index + 1)::text
      );
      if v_resolved->>'success' <> 'true' then
        return v_resolved;
      end if;
      v_item := v_resolved->'data';
      v_items := v_items || jsonb_build_array(v_item);
      v_total := v_total + ((v_item->>'price')::numeric * (v_item->>'quantity')::integer);
    end loop;
  end if;

  v_snapshot := jsonb_build_object('restaurantId', p_restaurant_id, 'items', v_items, 'total', v_total, 'status', v_status);
  insert into public.conversation_baskets (conversation_id, restaurant_id, snapshot, status, updated_at)
  values (p_conversation_id, p_restaurant_id, v_snapshot, v_status, now())
  on conflict (conversation_id) do update set snapshot = excluded.snapshot, status = excluded.status, updated_at = now();
  return jsonb_build_object('success', true, 'data', v_snapshot);
end;
$$;

create or replace function public.voice_tool_get_catalog(p_restaurant_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product record;
  v_catalog jsonb := '[]'::jsonb;
begin
  for v_product in
    select product_id, name, price, available, category, data
    from public.restaurant_products
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
      'mainProduct', coalesce(v_product.data->>'mainProduct', ''),
      'optionGroups', coalesce(v_product.data->'optionGroups', '[]'::jsonb)
    );
  end loop;
  return v_catalog;
end;
$$;

grant execute on function public.voice_tool_add_item(uuid, uuid, text, integer, jsonb) to anon, authenticated;
grant execute on function public.voice_tool_update_order(uuid, uuid, jsonb) to anon, authenticated;
grant execute on function public.voice_tool_get_catalog(uuid) to anon, authenticated;
