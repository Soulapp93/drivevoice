import { createClient } from '@supabase/supabase-js';
import { verifyToolSessionToken } from '@/lib/realtime/session-token';

export const runtime = 'nodejs';

function generateOrderId() {
  return `DV-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as {
    sessionToken?: string;
    conversationId?: string;
    idempotencyKey?: string;
    restaurantId?: string;
    items?: Array<{ name: string; quantity: number; price: number; sku_ref?: string }>;
    customer?: { first_name?: string; phone?: string };
  };
  const claims = body.sessionToken ? verifyToolSessionToken(body.sessionToken) : null;
  const restaurantId = claims?.restaurantId;
  const items = body.items || [];

  if (!claims || !restaurantId || !body.conversationId || !body.idempotencyKey || items.length === 0) {
    return Response.json({ errorCode: 'INVALID_ORDER_REQUEST', message: 'La demande de commande est invalide.' }, { status: 400 });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json({ errorCode: 'ORDER_BACKEND_NOT_CONFIGURED', message: 'La transmission au restaurant est momentanément indisponible.', retryable: true }, { status: 503 });
  }
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const existing = await supabase
    .from('orders')
    .select('hubrise_order_id, ref, status')
    .eq('idempotency_key', body.idempotencyKey)
    .maybeSingle();
  if (existing.error) {
    console.error('[hubrise orders] idempotency lookup failed', existing.error.message);
    return Response.json({ errorCode: 'ORDER_STORAGE_ERROR', message: 'La commande ne peut pas être vérifiée pour le moment.', retryable: true }, { status: 503 });
  }
  if (existing.data) {
    if (existing.data.status !== 'sent') {
      return Response.json({
        success: false,
        errorCode: 'ORDER_IN_PROGRESS',
        message: 'La commande est déjà en cours de transmission. Propose au client de patienter.',
        retryable: true,
      }, { status: 409 });
    }
    return Response.json({
      success: true,
      orderId: existing.data.hubrise_order_id || existing.data.ref,
      ref: existing.data.ref,
      alreadySubmitted: true,
    });
  }

  const { data: conn, error: connError } = await supabase
    .from('restaurant_hubrise_connections')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .single();

  if (connError || !conn) {
    return Response.json({ errorCode: 'HUBRISE_NOT_CONNECTED', message: 'La transmission au restaurant n’est pas configurée.', retryable: false }, { status: 503 });
  }

  const orderId = generateOrderId();
  const total = items.reduce((sum, item) => sum + item.price * (item.quantity || 1), 0);

  const hubriseOrder = {
    private_ref: orderId,
    service_type: 'delivery',
    payment: 'offline',
    items: items.map((item, index) => ({
      product_name: item.name,
      sku_ref: item.sku_ref || `DV-ITEM-${index + 1}`,
      price: String(item.price),
      quantity: String(item.quantity || 1),
    })),
    total: String(total),
    customer: body.customer || { first_name: 'Client DriveVoice' },
    expected_time: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    comments: 'Commande test envoyée depuis DriveVoice',
  };

  const reservation = await supabase.from('orders').insert({
    restaurant_id: restaurantId,
    conversation_id: body.conversationId,
    idempotency_key: body.idempotencyKey,
    hubrise_order_id: null,
    ref: orderId,
    source: 'voice',
    status: 'pending',
    total,
    items: hubriseOrder.items,
    created_at: new Date().toISOString(),
  });
  if (reservation.error && reservation.error.code !== '23505') {
    console.error('[hubrise orders] idempotency reservation failed', reservation.error.message);
    return Response.json({ errorCode: 'ORDER_STORAGE_ERROR', message: 'La commande ne peut pas être sécurisée pour le moment.', retryable: true }, { status: 503 });
  }
  if (reservation.error?.code === '23505') {
    return Response.json({
      success: false,
      errorCode: 'ORDER_IN_PROGRESS',
      message: 'La commande est déjà en cours de transmission. Propose au client de patienter.',
      retryable: true,
    }, { status: 409 });
  }

  try {
    const res = await fetch('https://api.hubrise.com/v1/location/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Token': conn.access_token,
      },
      body: JSON.stringify(hubriseOrder),
    });

    if (!res.ok) {
      console.error('[hubrise orders] upstream failed', res.status);
      await supabase.from('orders').update({ status: 'failed' }).eq('idempotency_key', body.idempotencyKey);
      return Response.json({ errorCode: 'HUBRISE_SUBMISSION_FAILED', message: 'La transmission au restaurant a échoué. Propose au client de réessayer.', retryable: res.status >= 500 }, { status: 502 });
    }

    const data = await res.json() as { id?: string };

    await supabase.from('orders').update({
      hubrise_order_id: data.id || null,
      status: 'sent',
    }).eq('idempotency_key', body.idempotencyKey);

    return Response.json({ success: true, orderId: data.id || orderId, ref: orderId });
  } catch {
    console.error('[hubrise orders] unexpected failure');
    await supabase.from('orders').update({ status: 'failed' }).eq('idempotency_key', body.idempotencyKey);
    return Response.json({ errorCode: 'ORDER_SUBMISSION_FAILED', message: 'La transmission au restaurant a échoué. Propose au client de réessayer.', retryable: true }, { status: 502 });
  }
}
