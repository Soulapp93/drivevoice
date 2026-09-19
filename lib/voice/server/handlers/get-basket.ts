import type { BasketSnapshot, ToolResult } from '@/lib/realtime/tool-protocol';
import { getServerSupabase } from '../catalog';
import type { AuthenticatedToolContext } from '../types';

const failure = (errorCode: string, message: string, retryable = false): ToolResult<never> => ({
  success: false,
  errorCode,
  message,
  retryable,
});

export async function handleGetBasket(ctx: AuthenticatedToolContext): Promise<ToolResult<unknown>> {
  const supabase = getServerSupabase();
  if (!supabase) return failure('BACKEND_NOT_CONFIGURED', 'La vérification du panier est momentanément indisponible. Propose au client de réessayer.', true);

  const { data, error } = await supabase
    .from('conversation_baskets')
    .select('snapshot')
    .eq('conversation_id', ctx.conversationId)
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle();

  if (error) {
    console.error('[voice/get_basket] lookup failed', error.message);
    return failure('BASKET_UNAVAILABLE', 'Le panier est momentanément indisponible. Propose au client de réessayer.', true);
  }

  const basket = (data?.snapshot as BasketSnapshot | null) ?? {
    restaurantId: ctx.restaurantId,
    items: [],
    total: 0,
    status: 'editing' as const,
  };

  return { success: true, data: basket };
}
