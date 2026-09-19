import { createClient } from 'npm:@supabase/supabase-js@2.112.4';
import { createHmac, timingSafeEqual } from 'node:crypto';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// ------------------ Session token ------------------

type ToolSessionClaims = {
  conversationId: string;
  restaurantId: string;
  issuedAt: number;
  expiresAt: number;
};

function secret(env: Record<string, string>) {
  const value = env.DRIVEVOICE_SESSION_SECRET || env.OPENAI_API_KEY;
  if (!value) throw new Error('DRIVEVOICE_SESSION_SECRET is not configured');
  return value;
}

function decode(value: string) {
  return atob(value.replace(/-/g, '+').replace(/_/g, '/'));
}

function verifyToken(token: string, env: Record<string, string>): ToolSessionClaims | null {
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  try {
    const expected = createHmac('sha256', secret(env)).update(encoded).digest('base64url');
    const actual = new Uint8Array(Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
    const exp = new Uint8Array(Array.from(atob(expected.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)));
    if (actual.length !== exp.length || !timingSafeEqual(actual, exp)) return null;
    const claims = JSON.parse(decode(encoded)) as ToolSessionClaims;
    if (!claims.conversationId || !claims.restaurantId || !claims.expiresAt || claims.expiresAt < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

// ------------------ Tool protocol ------------------

type ToolResult<T = unknown> =
  | { success: true; data: T; message?: string }
  | { success: false; errorCode: string; message: string; retryable: boolean };

type CatalogProduct = {
  productId: string;
  name: string;
  detail: string;
  price: number;
  available: boolean;
};

type OrderSelection = { group: string; options: string[] };

type UpdateOrderArguments = {
  items: Array<{ product_id: string; quantity: number; selections?: OrderSelection[] }>;
  status: 'editing' | 'ready_to_confirm' | 'confirmed';
};

type BasketItem = {
  id: string;
  productId: string;
  name: string;
  detail: string;
  price: number;
  quantity: number;
  customizations: string[];
};

type BasketSnapshot = {
  restaurantId: string;
  items: BasketItem[];
  total: number;
  status: UpdateOrderArguments['status'];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const errorResult = (errorCode: string, message: string, retryable = false): ToolResult<never> => ({
  success: false,
  errorCode,
  message,
  retryable,
});

function parseUpdateOrderArguments(rawArguments: string): ToolResult<UpdateOrderArguments> {
  let value: unknown;
  try {
    value = JSON.parse(rawArguments);
  } catch {
    return errorResult('INVALID_JSON', 'Les arguments du panier ne sont pas un JSON valide. Demande au client de préciser sa commande.');
  }

  if (!isRecord(value) || !Array.isArray(value.items) || !['editing', 'ready_to_confirm', 'confirmed'].includes(String(value.status))) {
    return errorResult('INVALID_ARGUMENTS', 'Les arguments du panier sont incomplets. Demande au client de préciser les articles et leur état.');
  }

  const items: UpdateOrderArguments['items'] = [];
  for (const rawItem of value.items) {
    if (!isRecord(rawItem) || typeof rawItem.product_id !== 'string' || !rawItem.product_id.trim()) {
      return errorResult('INVALID_ARGUMENTS', 'Un article du panier ne possède pas d’identifiant produit valide.');
    }
    if (!Number.isInteger(rawItem.quantity) || Number(rawItem.quantity) < 1 || Number(rawItem.quantity) > 20) {
      return errorResult('INVALID_QUANTITY', 'La quantité doit être un nombre entier compris entre 1 et 20.');
    }
    items.push({
      product_id: rawItem.product_id.trim(),
      quantity: Number(rawItem.quantity),
    });
  }

  return {
    success: true,
    data: {
      items,
      status: value.status as UpdateOrderArguments['status'],
    },
  };
}

function normalizeCatalogProduct(value: unknown): CatalogProduct | null {
  if (!isRecord(value) || typeof value.productId !== 'string' || typeof value.name !== 'string') return null;
  const price = Number(value.price);
  if (!Number.isFinite(price) || price < 0) return null;
  return {
    productId: value.productId,
    name: value.name,
    detail: typeof value.detail === 'string' ? value.detail : '',
    price,
    available: value.available !== false,
  };
}

function normalizeCatalog(value: unknown): CatalogProduct[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const product = normalizeCatalogProduct(entry);
    return product ? [product] : [];
  });
}

function applyUpdateOrder(
  restaurantId: string,
  argumentsValue: UpdateOrderArguments,
  catalog: CatalogProduct[],
): ToolResult<BasketSnapshot> {
  const items: BasketItem[] = [];
  for (const requested of argumentsValue.items) {
    const product = catalog.find(entry => entry.productId === requested.product_id);
    if (!product) return errorResult('PRODUCT_NOT_FOUND', 'Le produit demandé n’existe pas dans le catalogue officiel.');
    if (!product.available) return errorResult('PRODUCT_UNAVAILABLE', 'Le produit demandé est actuellement indisponible. Propose une alternative au client.');
    items.push({
      id: `${requested.product_id}-${items.length + 1}`,
      productId: product.productId,
      name: product.name,
      detail: product.detail,
      price: product.price,
      quantity: requested.quantity,
      customizations: [],
    });
  }
  return {
    success: true,
    data: {
      restaurantId,
      items,
      total: items.reduce((total, item) => total + item.price * item.quantity, 0),
      status: argumentsValue.status,
    },
  };
}

function jsonToolOutput(result: ToolResult<unknown>): string {
  try {
    return JSON.stringify(result);
  } catch {
    return JSON.stringify(errorResult('SERIALIZATION_ERROR', 'Le résultat de l’opération n’a pas pu être sérialisé.', true));
  }
}

// ------------------ Handlers ------------------

async function handleUpdateOrder(
  supabase: ReturnType<typeof createClient>,
  claims: ToolSessionClaims,
  args: string,
): Promise<ToolResult<unknown>> {
  const parsed = parseUpdateOrderArguments(args);
  if (!parsed.success) return parsed;

  const { data: rows, error } = await supabase
    .from('restaurant_products')
    .select('data, product_id, name, price, available')
    .eq('restaurant_id', claims.restaurantId)
    .eq('available', true);

  if (error) {
    console.error('[voice-tool] catalog lookup failed', error.message);
    return errorResult('CATALOG_UNAVAILABLE', 'Le catalogue officiel est momentanément indisponible. Propose au client de réessayer.', true);
  }

  const catalog = normalizeCatalog((rows ?? []).map(row => ({
    ...(row.data as Record<string, unknown> | null),
    productId: row.product_id,
    name: row.name,
    price: row.price,
    available: row.available,
  })));

  const result = applyUpdateOrder(claims.restaurantId, parsed.data, catalog);
  if (!result.success) return result;

  const basket = result.data as BasketSnapshot;
  const { error: writeError } = await supabase.from('conversation_baskets').upsert({
    conversation_id: claims.conversationId,
    restaurant_id: claims.restaurantId,
    snapshot: basket,
    status: basket.status,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'conversation_id' });

  if (writeError) {
    console.error('[voice-tool] basket write failed', writeError.message);
    return errorResult('BASKET_STORAGE_ERROR', 'Le panier n’a pas pu être enregistré. Propose au client de réessayer.', true);
  }

  return result;
}

async function handleGetBasket(
  supabase: ReturnType<typeof createClient>,
  claims: ToolSessionClaims,
): Promise<ToolResult<unknown>> {
  const { data, error } = await supabase
    .from('conversation_baskets')
    .select('snapshot')
    .eq('conversation_id', claims.conversationId)
    .eq('restaurant_id', claims.restaurantId)
    .maybeSingle();

  if (error) {
    console.error('[voice-tool] basket lookup failed', error.message);
    return errorResult('BASKET_UNAVAILABLE', 'Le panier est momentanément indisponible. Propose au client de réessayer.', true);
  }

  const basket = (data?.snapshot as BasketSnapshot | null) ?? {
    restaurantId: claims.restaurantId,
    items: [],
    total: 0,
    status: 'editing' as const,
  };

  return { success: true, data: basket };
}

// ------------------ Serve ------------------

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const env = Deno.env.toObject();
    if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Supabase service role not configured');
    }

    const body = await req.json().catch(() => ({})) as { token?: string; callId?: string; tool?: string; arguments?: string };
    if (!body.token || !body.callId || !body.tool || typeof body.arguments !== 'string') {
      return jsonResponse({ result: errorResult('INVALID_REQUEST', 'Requête invalide.'), output: jsonToolOutput(errorResult('INVALID_REQUEST', 'Requête invalide.')) }, 400);
    }

    const claims = verifyToken(body.token, env);
    if (!claims) {
      return jsonResponse({ result: errorResult('UNAUTHORIZED', 'Session non authentifiée.'), output: jsonToolOutput(errorResult('UNAUTHORIZED', 'Session non authentifiée.')) }, 401);
    }

    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

    let result: ToolResult<unknown>;
    if (body.tool === 'update_order') {
      result = await handleUpdateOrder(supabase, claims, body.arguments);
    } else if (body.tool === 'get_basket') {
      result = await handleGetBasket(supabase, claims);
    } else {
      result = errorResult('UNKNOWN_TOOL', 'Cette opération n’est pas disponible.');
    }

    return jsonResponse({ result, output: jsonToolOutput(result) }, result.success ? 200 : 422);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[voice-tool] unhandled error', message);
    const result = errorResult('INTERNAL_ERROR', 'Une erreur technique est survenue. Propose au client de réessayer.', true);
    return jsonResponse({ result, output: jsonToolOutput(result) }, 500);
  }
});
