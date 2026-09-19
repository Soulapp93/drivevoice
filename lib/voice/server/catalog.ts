import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { CatalogProduct } from '@/lib/realtime/tool-protocol';

export function getServerSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) return null;
  return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function fetchRestaurantCatalog(
  supabase: SupabaseClient,
  restaurantId: string,
): Promise<{ success: true; catalog: CatalogProduct[] } | { success: false; errorCode: string; message: string }> {
  const { data, error } = await supabase
    .from('restaurant_products')
    .select('data, product_id, name, price, available')
    .eq('restaurant_id', restaurantId);

  if (error) {
    console.error('[voice/catalog] lookup failed', error.message);
    return { success: false, errorCode: 'CATALOG_UNAVAILABLE', message: 'Le catalogue officiel est momentanément indisponible. Propose au client de réessayer.' };
  }

  const catalog: CatalogProduct[] = (data ?? []).map((row) => ({
    ...(row.data as Record<string, unknown> | null),
    productId: row.product_id,
    name: row.name,
    price: Number(row.price),
    available: row.available !== false,
  })) as CatalogProduct[];

  return { success: true, catalog };
}
