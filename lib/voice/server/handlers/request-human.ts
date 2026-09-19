import { getServerSupabase } from '../catalog';
import type { AuthenticatedToolContext, ToolResult } from '../types';

const failure = (errorCode: string, message: string, retryable = false): ToolResult<never> => ({
  success: false,
  errorCode,
  message,
  retryable,
});

export async function handleRequestHuman(ctx: AuthenticatedToolContext): Promise<ToolResult<unknown>> {
  const supabase = getServerSupabase();
  if (!supabase) return failure('BACKEND_NOT_CONFIGURED', 'Le transfert ne peut pas être enregistré. Propose au client d’attendre un équipier.', true);

  let reason = 'Demande du client';
  try {
    const args = JSON.parse(ctx.args || '{}') as { reason?: string };
    if (args.reason) reason = args.reason.slice(0, 240);
  } catch {
    // ignore malformed reason
  }

  const { error } = await supabase.from('conversation_baskets').upsert({
    conversation_id: ctx.conversationId,
    restaurant_id: ctx.restaurantId,
    snapshot: { restaurantId: ctx.restaurantId, items: [], total: 0, status: 'editing' },
    status: 'human_requested',
    updated_at: new Date().toISOString(),
  }, { onConflict: 'conversation_id' });

  if (error) {
    console.error('[voice/request_human] write failed', error.message);
    return failure('TRANSFER_STORAGE_ERROR', 'Le transfert n’a pas pu être enregistré.', true);
  }

  return {
    success: true,
    data: { transferred: true, reason },
    message: 'Un équipier va prendre le relais. Merci de patienter.',
  };
}
