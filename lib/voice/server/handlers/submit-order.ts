import type { BasketSnapshot, ToolResult } from '@/lib/realtime/tool-protocol';
import { getServerSupabase } from '../catalog';
import type { AuthenticatedToolContext } from '../types';

const failure = (errorCode: string, message: string, retryable = false): ToolResult<never> => ({
  success: false,
  errorCode,
  message,
  retryable,
});

export async function handleSubmitOrder(ctx: AuthenticatedToolContext): Promise<ToolResult<unknown>> {
  const supabase = getServerSupabase();
  if (!supabase) return failure('BACKEND_NOT_CONFIGURED', 'La commande ne peut pas être transmise pour le moment. Propose au client de réessayer.', true);

  let args: { confirmation?: string } = {};
  try {
    args = JSON.parse(ctx.args || '{}') as { confirmation?: string };
  } catch {
    return failure('INVALID_ARGUMENTS', 'La confirmation n’a pas été comprise. Demande au client de confirmer clairement.', false);
  }

  if (args.confirmation !== 'explicit') {
    return failure('CONFIRMATION_REQUIRED', 'Le client doit confirmer explicitement sa commande avant l’envoi.', false);
  }

  const { data: basketRow, error: basketError } = await supabase
    .from('conversation_baskets')
    .select('snapshot, status')
    .eq('conversation_id', ctx.conversationId)
    .eq('restaurant_id', ctx.restaurantId)
    .maybeSingle();

  if (basketError) {
    console.error('[voice/submit_order] basket lookup failed', basketError.message);
    return failure('BASKET_UNAVAILABLE', 'Le panier est momentanément indisponible. Propose au client de réessayer.', true);
  }

  const basket = (basketRow?.snapshot as BasketSnapshot | null);
  if (!basket || basket.items.length === 0) {
    return failure('BASKET_EMPTY', 'Le panier est vide. Demande au client ce qu’il souhaite commander.', false);
  }

  const idempotencyKey = `${ctx.conversationId}:${ctx.callId}`;

  const { data: existingOrder } = await supabase
    .from('orders')
    .select('id')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  if (existingOrder) {
    return { success: true, data: { orderId: existingOrder.id, status: 'already_submitted' } };
  }

  // TODO: intégrer HubRise/Deliverect ici. Pour l’instant on persiste la commande localement.
  const { data: order, error: insertError } = await supabase.from('orders').insert({
    restaurant_id: ctx.restaurantId,
    conversation_id: ctx.conversationId,
    idempotency_key: idempotencyKey,
    ref: `VOICE-${Date.now()}`,
    source: 'voice',
    status: 'pending',
    total: basket.total,
    items: basket.items,
  }).select('id').single();

  if (insertError) {
    console.error('[voice/submit_order] insert failed', insertError.message);
    return failure('ORDER_STORAGE_ERROR', 'La commande n’a pas pu être enregistrée. Propose au client de réessayer.', true);
  }

  return {
    success: true,
    data: { orderId: order.id, status: 'submitted', total: basket.total },
    message: 'La commande a bien été transmise au restaurant.',
  };
}
