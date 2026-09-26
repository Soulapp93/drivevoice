import { createClient } from '@supabase/supabase-js';

export type RestaurantOrderItem = {
  name: string;
  quantity: number;
  price: number;
  sku_ref?: string;
  customizations?: string[];
};

export type RestaurantSubmissionResult =
  | { success: true; ref: string; via: 'hubrise'; orderId?: string | null }
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

function formatMoney(value: number) {
  return `${Math.max(0, Number(value) || 0).toFixed(2)} EUR`;
}

export function buildHubRiseOrderPayload(ref: string, items: RestaurantOrderItem[]) {
  return {
    status: 'new',
    channel: 'DriveVoice',
    private_ref: ref,
    service_type: 'collection',
    asap: true,
    items: items.map((item, index) => ({
      product_name: item.name,
      sku_ref: item.sku_ref || `DV-ITEM-${index + 1}`,
      price: formatMoney(item.price),
      quantity: String(item.quantity || 1),
      ...(item.customizations && item.customizations.length > 0
        ? {
            options: item.customizations.map((customization) => {
              const separator = customization.indexOf(':');
              return {
                option_list_name: separator > 0 ? customization.slice(0, separator).trim() : 'Personnalisation',
                name: separator > 0 ? customization.slice(separator + 1).trim() : customization.trim(),
                quantity: 1,
              };
            }),
          }
        : {}),
    })),
    customer: { first_name: 'Client DriveVoice' },
    customer_notes: 'Commande drive transmise par DriveVoice',
  };
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
  const payload = buildHubRiseOrderPayload(ref, items);
  const payloadItems = payload.items;

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
    if (!reserve.hubrise_order_id) {
      return { success: false, errorCode: 'ORDER_NOT_CONFIRMED_BY_HUBRISE', message: 'Cette commande n’a pas de confirmation HubRise. Le restaurant doit vérifier son état avant une nouvelle tentative.', retryable: false };
    }
    return { success: true, ref: reserve.ref ?? ref, via: 'hubrise', orderId: reserve.hubrise_order_id };
  }
  if (reserve.status === 'in_progress') {
    return { success: false, errorCode: 'ORDER_IN_PROGRESS', message: 'La commande est déjà en cours de transmission. Propose au client de patienter.', retryable: true };
  }

  // Acquisition du verrou d'idempotence pour empêcher les doubles envois simultanés
  const { data: lockAcquired } = await supabase.rpc('voice_acquire_order_lock', {
    p_conversation_id: conversationId,
    p_idempotency_key: idempotencyKey,
    p_ttl_seconds: 30,
  });
  if (!lockAcquired) {
    console.warn('[submit-to-restaurant] order lock already held', { conversationId });
    return { success: false, errorCode: 'ORDER_IN_PROGRESS', message: 'Une commande est déjà en cours de traitement pour cette session.', retryable: true };
  }

  try {
    const { data: tokenData, error: tokenError } = await supabase.rpc('voice_get_hubrise_access_token', { p_restaurant_id: restaurantId });
    const accessToken = !tokenError && typeof tokenData === 'string' && tokenData.length > 0 ? tokenData : null;

    if (!accessToken) {
      console.error('[submit-to-restaurant] HubRise access token unavailable', tokenError?.message ?? 'No active token returned');
      const { error: finalizeError } = await supabase.rpc('voice_tool_finalize_order', {
        p_idempotency_key: idempotencyKey,
        p_status: 'failed',
        p_hubrise_order_id: null,
      });
      if (finalizeError) console.error('[submit-to-restaurant] failed to mark missing-token order', finalizeError.message);
      return { success: false, errorCode: 'HUBRISE_CONNECTION_UNAVAILABLE', message: 'La connexion HubRise du restaurant est indisponible. La commande n’a pas été envoyée.', retryable: true };
    }

    const res = await fetch('https://api.hubrise.com/v1/location/orders', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Access-Token': accessToken,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn('[submit-to-restaurant] HubRise rejected order', res.status);
      if (res.status < 500) {
        const { error: finalizeError } = await supabase.rpc('voice_tool_finalize_order', {
          p_idempotency_key: idempotencyKey,
          p_status: 'failed',
          p_hubrise_order_id: null,
        });
        if (finalizeError) console.error('[submit-to-restaurant] failed to mark rejected order', finalizeError.message);
        return { success: false, errorCode: 'HUBRISE_ORDER_REJECTED', message: 'HubRise a refusé la commande. Elle n’a pas été transmise au restaurant.', retryable: res.status === 429 };
      }
      return { success: false, errorCode: 'HUBRISE_RESPONSE_UNCERTAIN', message: 'HubRise n’a pas confirmé la commande. Vérifiez les commandes du restaurant avant toute nouvelle tentative.', retryable: false };
    }

    const data = (await res.json().catch(() => ({}))) as { id?: string };
    if (!data.id) {
      console.error('[submit-to-restaurant] HubRise response missing order id', { ref });
      return { success: false, errorCode: 'HUBRISE_RESPONSE_UNCERTAIN', message: 'HubRise n’a pas fourni de confirmation exploitable. Vérifiez les commandes du restaurant avant toute nouvelle tentative.', retryable: false };
    }

    const { error: finalizeError } = await supabase.rpc('voice_tool_finalize_order', {
      p_idempotency_key: idempotencyKey,
      p_status: 'sent',
      p_hubrise_order_id: data.id,
    });
    if (finalizeError) {
      console.error('[submit-to-restaurant] finalize rpc failed after upstream acceptance', finalizeError.message);
    }
    return { success: true, ref, via: 'hubrise', orderId: data.id };
  } catch (error) {
    console.error('[submit-to-restaurant] HubRise transmission outcome uncertain', error instanceof Error ? error.message : error);
    return { success: false, errorCode: 'HUBRISE_RESPONSE_UNCERTAIN', message: 'La transmission à HubRise n’a pas pu être confirmée. Vérifiez les commandes du restaurant avant toute nouvelle tentative.', retryable: false };
  } finally {
    try {
      await supabase.rpc('voice_release_order_lock', { p_conversation_id: conversationId });
    } catch (err) {
      console.error('[submit-to-restaurant] lock release failed', err instanceof Error ? err.message : err);
    }
  }
}
