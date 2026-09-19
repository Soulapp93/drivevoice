import { createClient } from '@supabase/supabase-js';

export type RestaurantOrderItem = {
  name: string;
  quantity: number;
  price: number;
  sku_ref?: string;
};

export type RestaurantSubmissionResult =
  | { success: true; ref: string; via: 'hubrise' | 'kitchen_queue'; orderId?: string | null }
  | { success: false; errorCode: string; message: string; retryable: boolean };

type ReserveResult = {
  success: boolean;
  status?: 'reserved' | 'already_sent' | 'in_progress';
  ref?: string;
  hubrise_order_id?: string;
  errorCode?: string;
  message?: string;
};

const supabaseUrl =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://pfnwodwpefugpcynykga.supabase.co';
const supabaseAnonKey =
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmbndvZHdwZWZ1Z3BjeW55a2dhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNjk1NjYsImV4cCI6MjEwMzg0NTU2Nn0.9pjtztv06yFoawUi4ZszCq9XPQ9RqHEOMDlgzmiSCR4';

function generateRef() {
  return `DV-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
}

export async function submitOrderToRestaurant(params: {
  restaurantId: string;
  conversationId: string;
  idempotencyKey: string;
  items: RestaurantOrderItem[];
  total: number;
}): Promise<RestaurantSubmissionResult> {
  const { restaurantId, conversationId, idempotencyKey, items, total } = params;
  if (items.length === 0) {
    return { success: false, errorCode: 'BASKET_EMPTY', message: 'Le panier est vide.', retryable: false };
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const ref = generateRef();
  const payloadItems = items.map((item, index) => ({
    product_name: item.name,
    sku_ref: item.sku_ref || `DV-ITEM-${index + 1}`,
    price: String(item.price),
    quantity: String(item.quantity || 1),
  }));

  const { data: reserveData, error: reserveError } = await supabase.rpc('voice_tool_reserve_order', {
    p_conversation_id: conversationId,
    p_restaurant_id: restaurantId,
    p_idempotency_key: idempotencyKey,
    p_ref: ref,
    p_items: payloadItems,
    p_total: total,
  });

  if (reserveError) {
    console.error('[submit-to-restaurant] reserve rpc failed', reserveError.message);
    return { success: false, errorCode: 'ORDER_STORAGE_ERROR', message: 'La commande ne peut pas être enregistrée pour le moment.', retryable: true };
  }

  const reserve = reserveData as ReserveResult | null;
  if (!reserve || reserve.success !== true) {
    return {
      success: false,
      errorCode: reserve?.errorCode ?? 'ORDER_STORAGE_ERROR',
      message: reserve?.message ?? 'La commande ne peut pas être enregistrée pour le moment.',
      retryable: false,
    };
  }

  if (reserve.status === 'already_sent') {
    return { success: true, ref: reserve.ref ?? ref, via: reserve.hubrise_order_id ? 'hubrise' : 'kitchen_queue', orderId: reserve.hubrise_order_id || null };
  }
  if (reserve.status === 'in_progress') {
    return { success: false, errorCode: 'ORDER_IN_PROGRESS', message: 'La commande est déjà en cours de transmission. Propose au client de patienter.', retryable: true };
  }

  const { data: tokenData } = await supabase.rpc('voice_get_hubrise_access_token', { p_restaurant_id: restaurantId });
  const accessToken = typeof tokenData === 'string' && tokenData.length > 0 ? tokenData : null;

  if (accessToken) {
    try {
      const res = await fetch('https://api.hubrise.com/v1/location/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Access-Token': accessToken },
        body: JSON.stringify({
          private_ref: ref,
          service_type: 'delivery',
          payment: 'offline',
          items: payloadItems,
          total: String(total),
          customer: { first_name: 'Client DriveVoice' },
          expected_time: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          comments: 'Commande drive transmise par DriveVoice',
        }),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { id?: string };
        await supabase.rpc('voice_tool_finalize_order', {
          p_idempotency_key: idempotencyKey,
          p_status: 'sent',
          p_hubrise_order_id: data.id || null,
        });
        return { success: true, ref, via: 'hubrise', orderId: data.id || null };
      }
      console.error('[submit-to-restaurant] hubrise upstream failed', res.status);
      await supabase.rpc('voice_tool_finalize_order', { p_idempotency_key: idempotencyKey, p_status: 'failed' });
      return { success: false, errorCode: 'HUBRISE_SUBMISSION_FAILED', message: 'La transmission au restaurant a échoué. Propose au client de réessayer.', retryable: true };
    } catch (error) {
      console.error('[submit-to-restaurant] hubrise unexpected failure', error instanceof Error ? error.message : error);
      await supabase.rpc('voice_tool_finalize_order', { p_idempotency_key: idempotencyKey, p_status: 'failed' });
      return { success: false, errorCode: 'ORDER_SUBMISSION_FAILED', message: 'La transmission au restaurant a échoué. Propose au client de réessayer.', retryable: true };
    }
  }

  const { error: finalizeError } = await supabase.rpc('voice_tool_finalize_order', {
    p_idempotency_key: idempotencyKey,
    p_status: 'sent',
  });
  if (finalizeError) {
    console.error('[submit-to-restaurant] finalize rpc failed', finalizeError.message);
    return { success: false, errorCode: 'ORDER_STORAGE_ERROR', message: 'La commande n’a pas pu être finalisée.', retryable: true };
  }
  return { success: true, ref, via: 'kitchen_queue' };
}
