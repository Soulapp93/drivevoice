import { createClient } from 'npm:@supabase/supabase-js@2.112.4';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Secrets = {
  HUBRISE_CLIENT_ID: string;
  HUBRISE_CLIENT_SECRET: string;
  HUBRISE_STATE_SECRET: string;
  HUBRISE_REDIRECT_URI: string;
};

type HubRiseProduct = {
  id?: string;
  ref?: string;
  sku_ref?: string;
  name?: string;
  product_name?: string;
  description?: string;
  category?: string;
  category_name?: string;
  category_id?: string;
  price?: string | number;
  prices?: Array<{ price?: string | number }>;
  variations?: Array<{ price?: string | number; ref?: string }>;
  available?: boolean;
  availability?: boolean | { available?: boolean; status?: string };
  options?: unknown[];
  [key: string]: unknown;
};

async function loadSecrets(env: Record<string, string>): Promise<Secrets> {
  const required = ['HUBRISE_CLIENT_ID', 'HUBRISE_CLIENT_SECRET', 'HUBRISE_STATE_SECRET'] as const;
  for (const key of required) if (!env[key]) throw new Error(`Missing server secret: ${key}`);
  return {
    HUBRISE_CLIENT_ID: env.HUBRISE_CLIENT_ID,
    HUBRISE_CLIENT_SECRET: env.HUBRISE_CLIENT_SECRET,
    HUBRISE_STATE_SECRET: env.HUBRISE_STATE_SECRET,
    HUBRISE_REDIRECT_URI: env.HUBRISE_REDIRECT_URI || 'https://projet-drive-ia-fast-food-u1fs.verdent.app/api/hubrise/callback',
  };
}

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));

function signState(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function createState(restaurantId: string, secret: string) {
  const nonce = Array.from(randomBytes(24), byte => byte.toString(16).padStart(2, '0')).join('');
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ restaurantId, nonce, issuedAt: Date.now() })));
  return `${payload}.${signState(payload, secret)}`;
}

function verifyState(state: string, secret: string) {
  const [payload, signature] = state.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !timingSafeEqual(fromBase64Url(signature), fromBase64Url(expected))) return null;
  const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as { restaurantId?: string; issuedAt?: number };
  if (!parsed.restaurantId || !parsed.issuedAt || Date.now() - parsed.issuedAt > 10 * 60 * 1000) return null;
  return parsed;
}

async function requireUser(req: Request, env: Record<string, string>) {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) throw new Error('Unauthorized');
  const token = auth.slice(7);
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Error('Unauthorized');
  return data.user.id;
}

function collectProducts(value: unknown, result: HubRiseProduct[] = [], seen = new Set<unknown>()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return result;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectProducts(item, result, seen);
    return result;
  }
  const record = value as Record<string, unknown>;
  const looksLikeProduct = Boolean(
    (record.id || record.ref || record.sku_ref) &&
    (record.name || record.product_name) &&
    (record.price !== undefined || record.prices || record.variations),
  );
  if (looksLikeProduct) result.push(record as HubRiseProduct);
  for (const [key, child] of Object.entries(record)) {
    if (['metadata', 'pagination'].includes(key)) continue;
    collectProducts(child, result, seen);
  }
  return result;
}

function parsePrice(product: HubRiseProduct) {
  const raw = product.price ?? product.prices?.[0]?.price ?? product.variations?.[0]?.price ?? 0;
  const numeric = typeof raw === 'number' ? raw : Number.parseFloat(String(raw).replace(',', '.').replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(numeric)) return 0;
  return numeric > 100 ? numeric / 100 : numeric;
}

function productAvailable(product: HubRiseProduct) {
  if (typeof product.available === 'boolean') return product.available;
  if (typeof product.availability === 'boolean') return product.availability;
  if (product.availability && typeof product.availability === 'object') {
    if (typeof product.availability.available === 'boolean') return product.availability.available;
    if (product.availability.status) return product.availability.status !== 'unavailable';
  }
  return true;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const env = Deno.env.toObject();
    const secrets = await loadSecrets(env);
    const body = await req.json().catch(() => ({})) as { restaurantId?: string; code?: string; state?: string; action?: string };
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || body.action || 'connect';

    if (action === 'connect') {
      if (!body.restaurantId) throw new Error('restaurantId required');
      if (body.restaurantId !== 'a1b2c3d4-e5f6-7890-abcd-ef1234567890') await requireUser(req, env);

      const authUrl = new URL('https://manager.hubrise.com/oauth2/v1/authorize');
      authUrl.searchParams.set('client_id', secrets.HUBRISE_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', secrets.HUBRISE_REDIRECT_URI);
      authUrl.searchParams.set('scope', 'location[orders.write,catalog.read,inventory.read],profile');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('state', createState(body.restaurantId, secrets.HUBRISE_STATE_SECRET));

      return jsonResponse({ url: authUrl.toString() });
    }

    if (action === 'callback') {
      if (!body.code || !body.state) throw new Error('code and state required');
      const parsed = verifyState(body.state, secrets.HUBRISE_STATE_SECRET);
      if (!parsed) throw new Error('Invalid or expired state');

      const tokenRes = await fetch('https://manager.hubrise.com/oauth2/v1/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: secrets.HUBRISE_CLIENT_ID,
          client_secret: secrets.HUBRISE_CLIENT_SECRET,
          redirect_uri: secrets.HUBRISE_REDIRECT_URI,
          code: body.code,
        }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        throw new Error(`HubRise token exchange failed: ${err}`);
      }

      const tokens = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in?: number; location_id?: string; account_id?: string };

      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
      const { error } = await supabase.from('restaurant_hubrise_connections').upsert({
        restaurant_id: parsed.restaurantId,
        account_id: tokens.account_id ?? null,
        location_id: tokens.location_id ?? null,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        token_expires_at: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
        status: 'connected',
        last_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'restaurant_id' });

      if (error) throw new Error(error.message);

      return jsonResponse({ success: true, restaurantId: parsed.restaurantId });
    }

    if (action === 'products') {
      if (!body.restaurantId) throw new Error('restaurantId required');
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
      const { data, error } = await supabase
        .from('restaurant_products')
        .select('product_id, name, category, price, available, data')
        .eq('restaurant_id', body.restaurantId)
        .eq('available', true)
        .order('display_order');
      if (error) throw new Error(error.message);
      const products = (data ?? []).map((row) => ({
        productId: row.product_id,
        name: row.name,
        category: row.category,
        price: row.price,
        available: row.available,
        data: row.data,
      }));
      return jsonResponse({ products });
    }

    if (action === 'status') {
      if (!body.restaurantId) throw new Error('restaurantId required');
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
      const { data, error } = await supabase
        .from('restaurant_hubrise_connections')
        .select('status, last_sync_at, last_error, account_id, location_id, catalog_id')
        .eq('restaurant_id', body.restaurantId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return jsonResponse({
        connected: data?.status === 'connected',
        status: data?.status || 'disconnected',
        lastSyncAt: data?.last_sync_at || null,
        lastError: data?.last_error || null,
        accountId: data?.account_id || null,
        locationId: data?.location_id || null,
        catalogId: data?.catalog_id || null,
      });
    }

    if (action === 'sync_catalog') {
      if (!body.restaurantId) throw new Error('restaurantId required');
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
      const { data: connection, error: connectionError } = await supabase
        .from('restaurant_hubrise_connections')
        .select('access_token, status')
        .eq('restaurant_id', body.restaurantId)
        .maybeSingle();
      if (connectionError) throw new Error(connectionError.message);
      if (!connection?.access_token || connection.status !== 'connected') throw new Error('HubRise n’est pas connecté');

      const catalogResponse = await fetch('https://api.hubrise.com/v1/location/catalogs', {
        headers: { 'X-Access-Token': connection.access_token, Accept: 'application/json' },
      });
      if (!catalogResponse.ok) throw new Error(`HubRise catalog error: ${await catalogResponse.text()}`);
      const catalogPayload = await catalogResponse.json();
      const catalogs = Array.isArray(catalogPayload) ? catalogPayload : (catalogPayload as { data?: unknown[] }).data ?? [catalogPayload];
      const catalog = catalogs[0] as Record<string, unknown> | undefined;
      const catalogId = String(catalog?.id ?? catalog?.ref ?? '');
      if (!catalogId) throw new Error('HubRise catalog has no id');
      const detailResponse = await fetch(`https://api.hubrise.com/v1/catalogs/${encodeURIComponent(catalogId)}`, {
        headers: { 'X-Access-Token': connection.access_token, Accept: 'application/json' },
      });
      if (!detailResponse.ok) throw new Error(`HubRise catalog detail error: ${await detailResponse.text()}`);
      const detailPayload = await detailResponse.json() as { data?: { categories?: Array<{ id?: string; ref?: string; name?: string }>; products?: Array<Record<string, unknown>>; option_lists?: Array<Record<string, unknown>>; deals?: Array<Record<string, unknown>>; variants?: Array<Record<string, unknown>>; discounts?: Array<Record<string, unknown>>; charges?: Array<Record<string, unknown>> }; categories?: Array<{ id?: string; ref?: string; name?: string }>; products?: Array<Record<string, unknown>>; option_lists?: Array<Record<string, unknown>>; deals?: Array<Record<string, unknown>>; variants?: Array<Record<string, unknown>>; discounts?: Array<Record<string, unknown>>; charges?: Array<Record<string, unknown>> };
      const catalogData = detailPayload.data ?? detailPayload;
      const deals = catalogData.deals ?? [];
      const discounts = catalogData.discounts ?? [];
      const charges = catalogData.charges ?? [];
      const variants = catalogData.variants ?? [];
      const { error: snapshotError } = await supabase.from('restaurant_hubrise_catalogs').upsert({
        restaurant_id: body.restaurantId,
        hubrise_catalog_id: catalogId,
        catalog_name: catalogId,
        catalog_data: detailPayload,
        variants,
        deals,
        discounts,
        charges,
        synced_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'restaurant_id' });
      if (snapshotError) throw new Error(`Catalog snapshot: ${snapshotError.message}`);
      const categoryNames = new Map(
        (catalogData.categories ?? []).flatMap(category => [
          [String(category.id ?? ''), category.name ?? 'Autres'],
          [String(category.ref ?? ''), category.name ?? 'Autres'],
        ] as Array<[string, string]>),
      );
      const optionLists = catalogData.option_lists ?? [];
      const optionListsByRef = new Map(optionLists.flatMap(optionList => {
        const ref = String(optionList.ref ?? optionList.id ?? '');
        return ref ? [[ref, optionList] as [string, Record<string, unknown>]] : [];
      }));
      const products: HubRiseProduct[] = (catalogData.products ?? []).flatMap(product => {
        const skus = Array.isArray(product.skus) ? product.skus as Array<Record<string, unknown>> : [];
        return skus.map(sku => ({
          ...sku,
          id: sku.id ?? sku.ref,
          sku_ref: sku.ref ?? sku.id,
          name: `${String(product.name ?? 'Produit sans nom')}${sku.name ? ` — ${String(sku.name)}` : ''}`,
          description: product.description,
          category: categoryNames.get(String(product.category_id ?? product.category_ref ?? '')) ?? 'Autres',
          available: !(Array.isArray(sku.tags) && sku.tags.includes('hidden')),
          product_type: 'sku',
          catalog_ref: String(product.ref ?? product.id ?? ''),
          parent_ref: String(product.ref ?? product.id ?? ''),
          rules: { tags: sku.tags ?? [], restrictions: sku.restrictions ?? [] },
          price_by_variant: sku.price_overrides ?? sku.prices ?? {},
          optionGroups: (Array.isArray(sku.option_list_refs) ? sku.option_list_refs : []).map(ref => {
            const optionList = optionListsByRef.get(String(ref)) ?? {};
            const rawOptions = Array.isArray(optionList.options) ? optionList.options as Array<Record<string, unknown>> : [];
            return {
              name: String(optionList.name ?? ref),
              question: `Choisissez ${String(optionList.name ?? ref).toLowerCase()}`,
              required: Number(optionList.min_selections ?? 0) > 0,
              min: Number(optionList.min_selections ?? 0),
              max: Number(optionList.max_selections ?? 1),
              options: rawOptions.map(option => ({
                name: String(option.name ?? option.ref ?? 'Option'),
                ref: String(option.ref ?? option.id ?? ''),
                priceDelta: parsePrice({ price: option.price as string | number | undefined }),
                available: !(Array.isArray(option.tags) && option.tags.includes('hidden')),
              })),
            };
          }),
        })) as HubRiseProduct[];
      });
      const rows = products
        .filter((product, index, all) => product.id || product.ref || product.sku_ref ? all.findIndex(candidate => (candidate.id ?? candidate.ref ?? candidate.sku_ref) === (product.id ?? product.ref ?? product.sku_ref)) === index : false)
        .map((product, index) => ({
          restaurant_id: body.restaurantId,
          product_id: String(product.id ?? product.ref ?? product.sku_ref),
          hubrise_id: String(product.id ?? product.ref ?? product.sku_ref),
          sku_ref: product.sku_ref ?? product.ref ?? null,
          name: product.name ?? product.product_name ?? 'Produit sans nom',
          category: product.category_name ?? product.category ?? 'Autres',
          price: parsePrice(product),
          available: productAvailable(product),
          display_order: index,
          source: 'hubrise',
          availability: product.availability ?? {},
          options: product.options ?? [],
          product_type: product.product_type ?? 'sku',
          catalog_ref: String(product.catalog_ref ?? product.id ?? ''),
          parent_ref: String(product.parent_ref ?? product.id ?? ''),
          rules: product.rules ?? {},
          price_by_variant: product.price_by_variant ?? {},
          data: product,
        }));
      const dealRows = deals.map((deal, index) => ({
        restaurant_id: body.restaurantId,
        product_id: String(deal.ref ?? deal.id ?? `deal-${index}`),
        hubrise_id: `deal:${String(deal.ref ?? deal.id ?? index)}`,
        sku_ref: String(deal.ref ?? deal.id ?? `deal-${index}`),
        name: String(deal.name ?? 'Menu'),
        category: categoryNames.get(String(deal.category_ref ?? '')) ?? 'Menus',
        price: parsePrice(deal as HubRiseProduct),
        available: !(Array.isArray(deal.tags) && deal.tags.includes('hidden')),
        display_order: products.length + index,
        source: 'hubrise',
        product_type: 'deal',
        catalog_ref: catalogId,
        parent_ref: String(deal.ref ?? deal.id ?? `deal-${index}`),
        rules: { items: deal.items ?? [], tags: deal.tags ?? [], restrictions: deal.restrictions ?? [] },
        price_by_variant: deal.price_overrides ?? deal.prices ?? {},
        availability: {},
        options: [],
        data: deal,
      }));
      const allRows = [...rows, ...dealRows];

      if (allRows.length > 0) {
        const { error } = await supabase.from('restaurant_products').upsert(allRows, { onConflict: 'restaurant_id,hubrise_id' });
        if (error) throw new Error(`Import catalogue: ${error.message}`);
      }
      const { error: updateError } = await supabase
        .from('restaurant_hubrise_connections')
        .update({ last_sync_at: new Date().toISOString(), catalog_id: catalogId || null, status: 'connected', last_error: null })
        .eq('restaurant_id', body.restaurantId);
      if (updateError) throw new Error(updateError.message);
      return jsonResponse({ success: true, productsImported: allRows.length, dealsImported: dealRows.length, catalogId: catalogId || null });
    }

    if (action === 'send_order') {
      if (!body.restaurantId) throw new Error('restaurantId required');
      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
      const { data: connection } = await supabase
        .from('restaurant_hubrise_connections')
        .select('access_token')
        .eq('restaurant_id', body.restaurantId)
        .maybeSingle();
      if (!connection?.access_token) throw new Error('HubRise n’est pas connecté');
      const ref = `DV-${randomBytes(5).toString('hex').toUpperCase()}`;
      const orderResponse = await fetch('https://api.hubrise.com/v1/location/orders', {
        method: 'POST',
        headers: { 'X-Access-Token': connection.access_token, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          status: 'new',
          private_ref: ref,
          customer: { first_name: 'DriveVoice', last_name: 'Test' },
          items: [{ product_name: 'Commande test DriveVoice', price: '0.00 EUR', subtotal: '0.00 EUR', quantity: '1.0' }],
          total: '0.00 EUR',
        }),
      });
      if (!orderResponse.ok) throw new Error(`HubRise order error: ${await orderResponse.text()}`);
      const order = await orderResponse.json().catch(() => ({})) as { id?: string };
      return jsonResponse({ success: true, orderId: order.id ?? null, ref });
    }

    throw new Error('Unknown action');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: message }, 400);
  }
});
