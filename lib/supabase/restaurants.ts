import { supabase, isSupabaseConfigured } from './client';
import type { SyncResult } from './sync';

/**
 * Restaurant tel qu'affiché dans le back-office, avec les métadonnées
 * de son enseigne de rattachement (jointure master_brands).
 */
export interface RestaurantInfo {
  id: string;
  brand_id: string | null;
  brand_key: string | null;
  brand_name: string | null;
  brand_short: string | null;
  brand_color: string | null;
  brand_soft: string | null;
  name: string;
  code: string | null;
  city: string | null;
  address: string | null;
  active: boolean;
}

/**
 * Produit local d'un restaurant (déclinaison du catalogue maître).
 */
export interface RestaurantProductInfo {
  id: string;
  product_id: string;
  name: string | null;
  category: string | null;
  price: number | null;
  available: boolean;
  display_order: number;
  data: Record<string, unknown> | null;
}

interface BrandJoin {
  brand_key: string | null;
  name: string | null;
  short: string | null;
  color: string | null;
  soft: string | null;
}

interface RestaurantRawRow {
  id: string;
  brand_id: string | null;
  name: string;
  code: string | null;
  city: string | null;
  address: string | null;
  active: boolean;
  master_brands: BrandJoin | BrandJoin[] | null;
}

interface MasterProductRawRow {
  product_id: string;
  name: string | null;
  category: string | null;
  price: number | null;
  available: boolean;
  display_order: number;
  data: Record<string, unknown> | null;
}

const errorMessage = (err: unknown, fallback: string): string =>
  err instanceof Error ? err.message : fallback;

export async function fetchRestaurants(): Promise<RestaurantInfo[] | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from('restaurants')
      .select('id, brand_id, name, code, city, address, active, master_brands(brand_key, name, short, color, soft)')
      .order('name');

    if (error) throw error;

    return (data ?? []).map((row: RestaurantRawRow) => {
      const brand = Array.isArray(row.master_brands) ? row.master_brands[0] ?? null : row.master_brands;
      return {
        id: row.id,
        brand_id: row.brand_id,
        brand_key: brand?.brand_key ?? null,
        brand_name: brand?.name ?? null,
        brand_short: brand?.short ?? null,
        brand_color: brand?.color ?? null,
        brand_soft: brand?.soft ?? null,
        name: row.name,
        code: row.code,
        city: row.city,
        address: row.address,
        active: row.active,
      } satisfies RestaurantInfo;
    });
  } catch (err: unknown) {
    console.error('[fetchRestaurants]', err);
    return null;
  }
}

export async function fetchRestaurantProducts(restaurantId: string): Promise<RestaurantProductInfo[] | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  try {
    const { data, error } = await supabase
      .from('restaurant_products')
      .select('id, product_id, name, category, price, available, display_order, data')
      .eq('restaurant_id', restaurantId)
      .order('display_order');

    if (error) throw error;
    return (data ?? []) as unknown as RestaurantProductInfo[];
  } catch (err: unknown) {
    console.error('[fetchRestaurantProducts]', err);
    return null;
  }
}

export interface NewRestaurantInput {
  brandKey: string;
  name: string;
  code?: string;
  city?: string;
  address?: string;
}

/**
 * Crée un restaurant rattaché à une enseigne puis copie l'intégralité
 * du catalogue maître dans restaurant_products (déclinaison locale).
 */
export async function createRestaurant(input: NewRestaurantInput): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!isSupabaseConfigured || !supabase) return { ok: false, error: 'Supabase non configuré' };
  try {
    // 1) Résolution de l'enseigne à partir de sa clé logique
    const { data: brandRow, error: brandError } = await supabase
      .from('master_brands')
      .select('id')
      .eq('brand_key', input.brandKey)
      .maybeSingle();
    if (brandError) throw brandError;
    if (!brandRow) {
      return { ok: false, error: 'Enseigne introuvable en base. Publiez d’abord les catalogues vers Supabase.' };
    }

    // 2) Création du restaurant
    const { data: restRow, error: restError } = await supabase
      .from('restaurants')
      .insert({
        brand_id: brandRow.id,
        name: input.name,
        code: input.code || null,
        city: input.city || null,
        address: input.address || null,
      })
      .select('id')
      .single();
    if (restError) throw restError;

    // 3) Copie du catalogue maître vers le catalogue local
    const { data: masterRows, error: masterError } = await supabase
      .from('master_products')
      .select('product_id, name, category, price, available, display_order, data')
      .eq('brand_id', brandRow.id)
      .order('display_order');
    if (masterError) throw masterError;

    const rows = (masterRows ?? []).map((product: MasterProductRawRow) => ({
      restaurant_id: restRow.id,
      product_id: product.product_id,
      name: product.name,
      category: product.category,
      price: product.price,
      available: product.available,
      display_order: product.display_order,
      data: product.data,
    }));

    if (rows.length > 0) {
      const { error: insError } = await supabase.from('restaurant_products').insert(rows);
      if (insError) throw insError;
    }

    return { ok: true, id: restRow.id };
  } catch (err: unknown) {
    console.error('[createRestaurant]', err);
    return { ok: false, error: errorMessage(err, 'Erreur lors de la création du restaurant') };
  }
}

/**
 * Met à jour un produit local (prix, disponibilité, nom) en gardant
 * la fiche JSONB cohérente avec les colonnes.
 */
export async function updateRestaurantProduct(
  restaurantId: string,
  productId: string,
  patch: { price?: number; available?: boolean; name?: string }
): Promise<SyncResult> {
  if (!isSupabaseConfigured || !supabase) return { ok: false, error: 'Supabase non configuré' };
  try {
    const { data: current, error: selError } = await supabase
      .from('restaurant_products')
      .select('data')
      .eq('restaurant_id', restaurantId)
      .eq('product_id', productId)
      .maybeSingle();
    if (selError) throw selError;

    const mergedData = { ...((current?.data as Record<string, unknown>) ?? {}), ...patch };

    const { error } = await supabase
      .from('restaurant_products')
      .update({ ...patch, data: mergedData })
      .eq('restaurant_id', restaurantId)
      .eq('product_id', productId);
    if (error) throw error;

    return { ok: true };
  } catch (err: unknown) {
    console.error('[updateRestaurantProduct]', err);
    return { ok: false, error: errorMessage(err, 'Erreur de sauvegarde') };
  }
}

export async function deleteRestaurant(restaurantId: string): Promise<SyncResult> {
  if (!isSupabaseConfigured || !supabase) return { ok: false, error: 'Supabase non configuré' };
  try {
    const { error } = await supabase.from('restaurants').delete().eq('id', restaurantId);
    if (error) throw error;
    return { ok: true };
  } catch (err: unknown) {
    console.error('[deleteRestaurant]', err);
    return { ok: false, error: errorMessage(err, 'Erreur lors de la suppression') };
  }
}
