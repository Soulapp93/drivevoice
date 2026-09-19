import { supabase, isSupabaseConfigured } from './client';

/**
 * Représente une enseigne maître telle que manipulée dans l'app
 * (compatible avec le type `MasterBrand` de app/page.tsx).
 */
export interface MasterBrandInput {
  id: string;                 // clé logique : 'bk' | 'quick' | 'kfc'
  name: string;
  short: string;
  color: string;
  soft: string;
  version: number;
  status: string;
  restaurants: number;
  updated: string;
  products: SyncProduct[];
}

interface SyncProduct {
  productId?: string;
  id?: string | number;
  name: string;
  category: string;
  price: number;
  available?: boolean;
  displayOrder?: number;
  [key: string]: unknown;
}

interface BrandRow {
  id: string;
  brand_key: string;
  name: string;
  short: string | null;
  color: string | null;
  soft: string | null;
  version: number;
  status: string;
  restaurants: number;
  updated: string | null;
}

export interface SyncResult {
  ok: boolean;
  error?: string;
}

/**
 * Pousse l'intégralité des enseignes + produits en mémoire vers Supabase.
 * Opération idempotente : reflète exactement l'état local.
 */
export async function syncBrandsToDb(brands: MasterBrandInput[]): Promise<SyncResult> {
  if (!isSupabaseConfigured || !supabase) {
    return { ok: false, error: 'Supabase non configuré' };
  }
  try {
    for (const brand of brands) {
      // 1) Upsert de l'enseigne (conflit sur brand_key)
      const { data: brandRow, error: brandError } = await supabase
        .from('master_brands')
        .upsert(
          {
            brand_key: brand.id,
            name: brand.name,
            short: brand.short,
            color: brand.color,
            soft: brand.soft,
            version: brand.version,
            status: brand.status,
            restaurants: brand.restaurants,
            updated: brand.updated,
          },
          { onConflict: 'brand_key' }
        )
        .select('id')
        .single();

      if (brandError) throw brandError;
      const brandDbId = (brandRow as { id: string }).id;

      // 2) Supprime les anciens produits de cette enseigne
      const { error: delError } = await supabase
        .from('master_products')
        .delete()
        .eq('brand_id', brandDbId);
      if (delError) throw delError;

      // 3) Insère les produits (fiche complète dans `data`)
      const rows = brand.products.map((product, index) => ({
        brand_id: brandDbId,
        product_id: String(product.productId ?? product.id ?? `p_${index}`),
        name: product.name,
        category: product.category,
        price: product.price,
        available: product.available !== false,
        display_order: product.displayOrder ?? index,
        data: product,
      }));

      if (rows.length > 0) {
        const { error: insError } = await supabase.from('master_products').insert(rows);
        if (insError) throw insError;
      }
    }
    return { ok: true };
  } catch (err: unknown) {
    console.error('[syncBrandsToDb]', err);
    return { ok: false, error: err instanceof Error ? err.message : 'Erreur de synchronisation' };
  }
}

/**
 * Charge les enseignes + produits depuis Supabase.
 * Retourne `null` si Supabase n'est pas configuré, si les tables sont
 * vides, ou en cas d'erreur — l'app bascule alors en mode mémoire.
 */
export async function fetchBrandsFromDb(): Promise<MasterBrandInput[] | null> {
  if (!isSupabaseConfigured || !supabase) return null;
  try {
    const { data: brandRows, error: brandError } = await supabase
      .from('master_brands')
      .select('*')
      .order('name');

    if (brandError) throw brandError;
    if (!brandRows || brandRows.length === 0) return null;

    const result: MasterBrandInput[] = [];
    for (const row of brandRows as unknown as BrandRow[]) {
      const { data: productRows, error: productError } = await supabase
        .from('master_products')
        .select('data, display_order')
        .eq('brand_id', row.id)
        .order('display_order');

      if (productError) throw productError;

      const products = (productRows ?? [])
        .map((p: { data: unknown }) => p.data)
        .filter((product): product is SyncProduct => (
          typeof product === 'object'
          && product !== null
          && 'name' in product
          && 'category' in product
          && 'price' in product
        ));

      result.push({
        id: row.brand_key,
        name: row.name,
        short: row.short ?? '',
        color: row.color ?? '#000000',
        soft: row.soft ?? '#f5f5f5',
        version: row.version,
        status: row.status,
        restaurants: row.restaurants,
        updated: row.updated ?? '',
        products,
      });
    }
    return result;
  } catch (err) {
    console.error('[fetchBrandsFromDb]', err);
    return null;
  }
}

/**
 * Sauvegarde une seule enseigne (métadonnées + produits) après une édition.
 * Utilisée pour persister les modifications du back-office en continu.
 */
export async function saveBrandToDb(brand: MasterBrandInput): Promise<SyncResult> {
  return syncBrandsToDb([brand]);
}
