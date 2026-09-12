import { createClient } from '@supabase/supabase-js';

function generateOrderId() {
  return `DV-${Date.now().toString(36).toUpperCase()}`;
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as {
    restaurantId?: string;
    items?: Array<{ name: string; quantity: number; price: number; sku_ref?: string }>;
    customer?: { first_name?: string; phone?: string };
  };
  const restaurantId = body.restaurantId;
  const items = body.items || [];

  if (!restaurantId || items.length === 0) {
    return Response.json({ error: 'restaurantId and items required' }, { status: 400 });
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://pfnwodwpefugpcynykga.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || '',
  );

  const { data: conn, error: connError } = await supabase
    .from('restaurant_hubrise_connections')
    .select('*')
    .eq('restaurant_id', restaurantId)
    .single();

  if (connError || !conn) {
    return Response.json({ error: 'No HubRise connection found' }, { status: 404 });
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

  try {
    const res = await fetch('https://api.hubrise.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Access-Token': conn.access_token,
      },
      body: JSON.stringify(hubriseOrder),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`HubRise order error: ${err}`);
    }

    const data = await res.json() as { id?: string };

    await supabase.from('orders').insert({
      restaurant_id: restaurantId,
      hubrise_order_id: data.id || null,
      ref: orderId,
      source: 'voice',
      status: 'sent',
      total: total / 100,
      items: hubriseOrder.items,
      created_at: new Date().toISOString(),
    });

    return Response.json({ success: true, orderId: data.id || orderId, ref: orderId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: msg }, { status: 500 });
  }
}
