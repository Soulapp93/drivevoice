import { applyUpdateOrder, parseUpdateOrderArguments, type BasketSnapshot, type ToolResult } from '@/lib/realtime/tool-protocol';
import { fetchRestaurantCatalog, getServerSupabase } from '../catalog';
import type { AuthenticatedToolContext } from '../types';

const failure = (errorCode: string, message: string, retryable = false): ToolResult<never> => ({
  success: false,
  errorCode,
  message,
  retryable,
});

export async function handleUpdateOrder(ctx: AuthenticatedToolContext): Promise<ToolResult<unknown>> {
  const supabase = getServerSupabase();
  if (!supabase) return failure('BACKEND_NOT_CONFIGURED', 'La vérification du panier est momentanément indisponible. Propose au client de réessayer.', true);

  const parsed = parseUpdateOrderArguments(ctx.args);
  if (!parsed.success) return parsed;

  const catalogResult = await fetchRestaurantCatalog(supabase, ctx.restaurantId);
  if (!catalogResult.success) return failure(catalogResult.errorCode, catalogResult.message, true);

  const result = applyUpdateOrder(ctx.restaurantId, parsed.data, catalogResult.catalog);
  if (!result.success) return result;

  const basket = result.data as BasketSnapshot;
  const { error } = await supabase.from('conversation_baskets').upsert({
    conversation_id: ctx.conversationId,
    restaurant_id: ctx.restaurantId,
    snapshot: basket,
    status: basket.status,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'conversation_id' });

  if (error) {
    console.error('[voice/update_order] basket write failed', error.message);
    return failure('BASKET_STORAGE_ERROR', 'Le panier n’a pas pu être enregistré. Propose au client de réessayer.', true);
  }

  return result;
}
