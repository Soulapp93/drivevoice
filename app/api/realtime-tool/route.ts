import { createClient } from '@supabase/supabase-js';
import { applyUpdateOrder, jsonToolOutput, normalizeCatalog, parseUpdateOrderArguments, type BasketSnapshot, type ToolResult } from '@/lib/realtime/tool-protocol';
import { verifyToolSessionToken } from '@/lib/realtime/session-token';

export const runtime = 'nodejs';

type ToolRequest = {
  token?: string;
  callId?: string;
  tool?: string;
  arguments?: string;
};

const json = (result: ToolResult<unknown>, status = result.success ? 200 : 422) =>
  Response.json({ result, output: jsonToolOutput(result) }, { status });

function getServerSupabase() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

function failure(errorCode: string, message: string, retryable = false): ToolResult<never> {
  return { success: false, errorCode, message, retryable };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as ToolRequest;
  const claims = body.token ? verifyToolSessionToken(body.token) : null;
  if (!claims || !body.callId || !body.tool) {
    return json(failure('UNAUTHORIZED_TOOL_CALL', 'Cette opération n’est pas autorisée pour la session en cours.'), 401);
  }

  const supabase = getServerSupabase();
  if (!supabase) {
    return json(failure('BACKEND_NOT_CONFIGURED', 'La vérification du panier est momentanément indisponible. Propose au client de réessayer.', true), 503);
  }

  const existing = await supabase
    .from('conversation_tool_calls')
    .select('result')
    .eq('conversation_id', claims.conversationId)
    .eq('call_id', body.callId)
    .maybeSingle();
  if (existing.error) {
    console.error('[realtime-tool] idempotency lookup failed', existing.error.message);
    return json(failure('TOOL_STORAGE_ERROR', 'La vérification du panier est momentanément indisponible. Propose au client de réessayer.', true), 503);
  }
  if (existing.data?.result) {
    return json(existing.data.result as ToolResult<unknown>);
  }

  let result: ToolResult<unknown>;
  if (body.tool === 'update_order') {
    const parsed = parseUpdateOrderArguments(body.arguments ?? '');
    if (!parsed.success) return json(parsed);

    const catalogQuery = await supabase
      .from('restaurant_products')
      .select('data, product_id, name, price, available')
      .eq('restaurant_id', claims.restaurantId)
      .eq('available', true);
    if (catalogQuery.error) {
      console.error('[realtime-tool] catalog lookup failed', catalogQuery.error.message);
      return json(failure('CATALOG_UNAVAILABLE', 'Le catalogue officiel est momentanément indisponible. Propose au client de réessayer.', true), 503);
    }

    const catalog = normalizeCatalog((catalogQuery.data ?? []).map(row => ({
      ...(row.data as Record<string, unknown> | null),
      productId: row.product_id,
      name: row.name,
      price: row.price,
      available: row.available,
    })));
    result = applyUpdateOrder(claims.restaurantId, parsed.data, catalog);
    if (result.success) {
      const basket = result.data as BasketSnapshot;
      const basketWrite = await supabase.from('conversation_baskets').upsert({
        conversation_id: claims.conversationId,
        restaurant_id: claims.restaurantId,
        snapshot: basket,
        status: basket.status,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'conversation_id' });
      if (basketWrite.error) {
        console.error('[realtime-tool] basket write failed', basketWrite.error.message);
        result = failure('BASKET_STORAGE_ERROR', 'Le panier n’a pas pu être enregistré. Propose au client de réessayer.', true);
      }
    }
  } else if (body.tool === 'get_basket') {
    const basketQuery = await supabase
      .from('conversation_baskets')
      .select('snapshot')
      .eq('conversation_id', claims.conversationId)
      .eq('restaurant_id', claims.restaurantId)
      .maybeSingle();
    if (basketQuery.error) {
      console.error('[realtime-tool] basket lookup failed', basketQuery.error.message);
      result = failure('BASKET_UNAVAILABLE', 'Le panier est momentanément indisponible. Propose au client de réessayer.', true);
    } else {
      result = {
        success: true,
        data: (basketQuery.data?.snapshot as BasketSnapshot | null) ?? {
          restaurantId: claims.restaurantId,
          items: [],
          total: 0,
          status: 'editing',
        },
      };
    }
  } else {
    result = failure('UNKNOWN_TOOL', 'Cette opération n’est pas disponible dans cette session.');
  }

  const write = await supabase.from('conversation_tool_calls').insert({
    conversation_id: claims.conversationId,
    restaurant_id: claims.restaurantId,
    call_id: body.callId,
    tool_name: body.tool,
    result,
  });
  if (write.error) {
    console.error('[realtime-tool] idempotency write failed', write.error.message);
  }

  return json(result);
}