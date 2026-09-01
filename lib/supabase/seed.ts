import { createServiceClient } from './server';
import type { Database } from './database.types';

/**
 * Structure pour extraire les données de bkSeed et similaires
 */
export type CatalogSeedData = Array<{
  name: string;
  short: string;
  color: string;
  soft: string;
  products: Array<{
    productId: string;
    name: string;
    category: string;
    subcategory?: string;
    price: number;
    detail: string;
    emoji: string;
    productType: 'simple' | 'configurable' | 'menu' | 'bundle';
    optionGroups?: any[];
    ingredients?: any[];
    ingredientSettings?: any[];
    modifiers?: any[];
  }>;
}>;

/**
 * Seed les catalogues maîtres BK, Quick, KFC dans Supabase
 * À appeler une seule fois lors du setup initial
 */
export async function seedMasterCatalogs(catalogData: CatalogSeedData) {
  const client = createServiceClient() as any;

  try {
    for (const brand of catalogData) {
      console.log(`Seeding brand: ${brand.name}...`);

      // 1. Créer ou mettre à jour la marque
      const { data: existingBrand, error: searchError } = await client
        .from('master_brands')
        .select('id')
        .eq('short', brand.short)
        .maybeSingle();

      let brandId: string;
      if (!existingBrand) {
        // Brand doesn't exist, create it
        const { data: newBrand, error: createError } = await client
          .from('master_brands')
          .insert({
            name: brand.name,
            short: brand.short,
            color: brand.color,
            soft: brand.soft,
            status: 'Publié',
            version: 1,
          })
          .select('id')
          .single();

        if (createError) throw createError;
        if (!newBrand?.id) throw new Error(`Failed to create brand ${brand.name}`);
        brandId = newBrand.id;
      } else if (searchError) {
        throw searchError;
      } else {
        brandId = existingBrand.id;
      }

      console.log(`Brand ID: ${brandId}`);

      // 2. Insérer les produits (remplacer les anciens)
      // D'abord, supprimer les anciens produits
      const { error: deleteError } = await client
        .from('master_products')
        .delete()
        .eq('master_brand_id', brandId);

      if (deleteError) throw deleteError;

      // Puis insérer les nouveaux
      const productsToInsert = brand.products.map((product, index) => ({
        master_brand_id: brandId,
        product_id: product.productId,
        name: product.name,
        category: product.category,
        subcategory: product.subcategory || null,
        price: product.price,
        detail: product.detail || '',
        emoji: product.emoji || '🍽️',
        available: true,
        product_type: product.productType,
        option_groups: product.optionGroups ?? [],
        ingredients: product.ingredients ?? [],
        ingredient_settings: product.ingredientSettings ?? [],
        modifiers: product.modifiers ?? [],
        variants: [],
        badges: [],
        display_order: index + 1,
        image_url: null,
        pos_code: '',
        slug: null,
        meat_filter: null,
      } as any));

      if (productsToInsert.length > 0) {
        const { error: insertError } = await client
          .from('master_products')
          .insert(productsToInsert as any);

        if (insertError) throw insertError;
        console.log(`  → Inserted ${productsToInsert.length} products`);
      }
    }

    console.log('✓ Seeding completed successfully');
    return { success: true };
  } catch (error) {
    console.error('✗ Seeding failed:', error);
    throw error;
  }
}
