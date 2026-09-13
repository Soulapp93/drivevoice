import { createClient } from '@supabase/supabase-js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getHubRiseSecrets } from '@/lib/hubrise-secrets';

const fromBase64Url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));

function verifyState(state: string, secret: string) {
  const [payload, signature] = state.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (signature.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(fromBase64Url(signature), fromBase64Url(expected))) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { restaurantId?: string; issuedAt?: number };
    if (!parsed.restaurantId || !parsed.issuedAt || Date.now() - parsed.issuedAt > 10 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

function redirectWith(url: URL, path: string) {
  return Response.redirect(new URL(path, url.origin));
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  if (oauthError) {
    return redirectWith(url, `/?tab=technical&hubrise=error&reason=${encodeURIComponent(oauthError)}`);
  }
  if (!code || !state) {
    return redirectWith(url, '/?tab=technical&hubrise=error&reason=missing_params');
  }

  try {
    const edgeResponse = await fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-oauth?action=callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    });
    const edgeData = await edgeResponse.json().catch(() => ({})) as { success?: boolean; restaurantId?: string; error?: string };
    if (!edgeResponse.ok || !edgeData.success) {
      return redirectWith(url, '/?tab=technical&hubrise=error&reason=' + encodeURIComponent(edgeData.error || 'oauth_failed'));
    }
    return redirectWith(url, `/?tab=technical&hubrise=connected&restaurantId=${encodeURIComponent(edgeData.restaurantId || '')}`);
  } catch {
    return redirectWith(url, '/?tab=technical&hubrise=error&reason=oauth_network_error');
  }

  const secrets = await getHubRiseSecrets(url.origin);
  const clientId = secrets?.HUBRISE_CLIENT_ID;
  const clientSecret = secrets?.HUBRISE_CLIENT_SECRET;
  const stateSecret = secrets?.HUBRISE_STATE_SECRET;
  const redirectUri = secrets?.HUBRISE_REDIRECT_URI ?? `${url.origin}/api/hubrise/callback`;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://pfnwodwpefugpcynykga.supabase.co';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || '';

  if (!clientId || !clientSecret || !stateSecret || !serviceRoleKey) {
    return redirectWith(url, '/?tab=technical&hubrise=error&reason=' + encodeURIComponent('Configuration OAuth serveur incomplète'));
  }

  const parsed = verifyState(state, stateSecret);
  if (!parsed) {
    return redirectWith(url, '/?tab=technical&hubrise=error&reason=' + encodeURIComponent('State invalide ou expiré, relancez la connexion'));
  }

  try {
    const tokenRes = await fetch('https://manager.hubrise.com/oauth2/v1/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('[hubrise callback] token exchange failed:', errText);
      return redirectWith(url, '/?tab=technical&hubrise=error&reason=' + encodeURIComponent(`Échange de token échoué: ${errText.slice(0, 200)}`));
    }

    const tokens = await tokenRes.json() as { access_token?: string; refresh_token?: string; account_id?: string; location_id?: string; location_name?: string };

    if (!tokens.access_token) {
      return redirectWith(url, '/?tab=technical&hubrise=error&reason=' + encodeURIComponent('Réponse HubRise sans access_token'));
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const { error } = await supabase.from('restaurant_hubrise_connections').upsert({
      restaurant_id: parsed.restaurantId,
      account_id: tokens.account_id ?? null,
      location_id: tokens.location_id ?? null,
      location_name: tokens.location_name ?? null,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? null,
      status: 'connected',
      last_sync_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'restaurant_id' });

    if (error) {
      console.error('[hubrise callback] upsert error:', error.message);
      return redirectWith(url, '/?tab=technical&hubrise=error&reason=' + encodeURIComponent(error.message));
    }

    return redirectWith(url, `/?tab=technical&hubrise=connected&restaurantId=${encodeURIComponent(parsed.restaurantId ?? '')}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[hubrise callback] unexpected error:', msg);
    return redirectWith(url, '/?tab=technical&hubrise=error&reason=' + encodeURIComponent(msg.slice(0, 200)));
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
