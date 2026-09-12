import { createClient } from '@supabase/supabase-js';

const EDGE_FUNCTION_URL = 'https://pfnwodwpefugpcynykga.supabase.co/functions/v1/3f360453-88a3-432c-8d08-671a2a0f6e14';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return Response.redirect(new URL('/?tab=technical&hubrise=error&reason=' + encodeURIComponent(error), url.origin));
  }
  if (!code || !state) {
    return Response.redirect(new URL('/?tab=technical&hubrise=error&reason=missing_params', url.origin));
  }

  try {
    const res = await fetch(`${EDGE_FUNCTION_URL}?action=callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    });

    const data = await res.json().catch(() => ({ error: 'Réponse invalide de la fonction OAuth.' })) as { success?: boolean; restaurantId?: string; error?: string };

    if (!res.ok || !data.success) {
      console.error('[hubrise callback] Edge function error:', data.error);
      return Response.redirect(new URL('/?tab=technical&hubrise=error&reason=' + encodeURIComponent(data.error || 'oauth_failed'), url.origin));
    }

    return Response.redirect(new URL(`/?tab=technical&hubrise=connected&restaurantId=${encodeURIComponent(data.restaurantId || '')}`, url.origin));
  } catch (err) {
    console.error('[hubrise callback] Network error:', err);
    return Response.redirect(new URL('/?tab=technical&hubrise=error&reason=network_error', url.origin));
  }
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const body = await request.json().catch(() => ({})) as { restaurantId?: string; action?: string };
  const restaurantId = body.restaurantId || url.searchParams.get('restaurantId');
  const action = body.action || url.searchParams.get('action') || 'status';

  if (!restaurantId) {
    return Response.json({ error: 'restaurantId required' }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://pfnwodwpefugpcynykga.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || '',
  );

  if (action === 'sync_catalog') {
    const { data: conn, error: connError } = await supabase
      .from('restaurant_hubrise_connections')
      .select('access_token, status')
      .eq('restaurant_id', restaurantId)
      .single();

    if (connError || !conn) {
      return Response.json({ error: 'No HubRise connection found' }, { status: 404 });
    }

    try {
      const catalogRes = await fetch(`https://api.hubrise.com/v1/catalogs`, {
        headers: { 'X-Access-Token': conn.access_token },
      });
      if (!catalogRes.ok) throw new Error(`HubRise catalog error: ${await catalogRes.text()}`);
      const catalogs = await catalogRes.json() as { data?: Array<{ id: string; name?: string }> };
      const catalog = catalogs.data?.[0];
      if (!catalog) throw new Error('No catalog found for this location');

      const productsRes = await fetch(`https://api.hubrise.com/v1/catalogs/${catalog.id}/products`, {
        headers: { 'X-Access-Token': conn.access_token },
      });
      if (!productsRes.ok) throw new Error(`HubRise products error: ${await productsRes.text()}`);
      const products = await productsRes.json() as { data?: Array<{ id: string; name: string; price?: string; description?: string; category_id?: string; sku_ref?: string; image_url?: string; variations?: Array<{ price?: string; ref?: string }>; options?: Array<unknown>; availability?: unknown }> };

      let count = 0;
      for (const p of (products.data || [])) {
        const price = p.price ? parseFloat(p.price) / 100 : (p.variations?.[0]?.price ? parseFloat(p.variations[0].price) / 100 : 0);
        await supabase.from('restaurant_products').upsert({
          restaurant_id: restaurantId,
          hubrise_id: p.id,
          sku_ref: p.sku_ref || p.variations?.[0]?.ref || null,
          name: p.name,
          description: p.description || null,
          price,
          category_id: p.category_id || null,
          image_url: p.image_url || null,
          options: p.options || null,
          availability: p.availability || null,
          source: 'hubrise',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'restaurant_id,hubrise_id' });
        count++;
      }

      await supabase.from('restaurant_hubrise_connections').update({ last_sync_at: new Date().toISOString(), catalog_id: catalog.id, status: 'connected', last_error: null }).eq('restaurant_id', restaurantId);

      return Response.json({ success: true, productsImported: count, catalogId: catalog.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase.from('restaurant_hubrise_connections').update({ last_error: msg, updated_at: new Date().toISOString() }).eq('restaurant_id', restaurantId);
      return Response.json({ error: msg }, { status: 500 });
    }
  }

  const { data: conn } = await supabase
    .from('restaurant_hubrise_connections')
    .select('status, last_sync_at, last_error, account_id, location_id, catalog_id')
    .eq('restaurant_id', restaurantId)
    .single();

  return Response.json({
    connected: conn?.status === 'connected',
    status: conn?.status || 'disconnected',
    lastSyncAt: conn?.last_sync_at || null,
    lastError: conn?.last_error || null,
    accountId: conn?.account_id || null,
    locationId: conn?.location_id || null,
    catalogId: conn?.catalog_id || null,
  });
}
