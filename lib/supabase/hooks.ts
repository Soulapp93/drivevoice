import { useEffect, useState } from 'react';
import { supabase as supabaseBase } from './client';
import type { Database } from './database.types';

const supabase = supabaseBase as any;

export type MasterBrandRow = Database['public']['Tables']['master_brands']['Row'];
export type MasterProductRow = Database['public']['Tables']['master_products']['Row'];

export interface MasterBrandWithProducts extends MasterBrandRow {
  products: MasterProductRow[];
  productCount: number;
  categoryCount: number;
}

/**
 * Hook pour charger les catalogues maîtres depuis Supabase
 * Utilisé par le BackOfficePanel (super-admin) pour gérer les marques nationales
 */
export function useMasterBrands() {
  const [brands, setBrands] = useState<MasterBrandWithProducts[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadBrands();
  }, []);

  const loadBrands = async () => {
    try {
      setLoading(true);
      setError(null);

      // Charger les marques
      const { data: brandsData, error: brandsError } = await supabase
        .from('master_brands')
        .select('*')
        .order('name');

      if (brandsError) throw brandsError;
      if (!brandsData) throw new Error('No brands returned');

      // Charger les produits pour chaque marque
      const brandsWithProducts = await Promise.all(
        brandsData.map(async (brand: any) => {
          const { data: products, error: productsError } = await supabase
            .from('master_products')
            .select('*')
            .eq('master_brand_id', brand.id)
            .order('display_order');

          if (productsError) throw productsError;

          const categorySet = new Set((products ?? []).map((p: any) => p.category));

          return {
            ...brand,
            products: products ?? [],
            productCount: (products ?? []).length,
            categoryCount: categorySet.size,
          };
        })
      );

      setBrands(brandsWithProducts);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Erreur de chargement';
      setError(errorMsg);
      console.error('Error loading master brands:', err);
    } finally {
      setLoading(false);
    }
  };

  /**
   * Mettre à jour une marque
   */
  const updateBrand = async (
    brandId: string,
    updates: any
  ) => {
    try {
      const { error } = await supabase
        .from('master_brands')
        .update(updates)
        .eq('id', brandId);

      if (error) throw error;

      // Rafraîchir les données
      await loadBrands();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Erreur de mise à jour';
      setError(errorMsg);
      console.error('Error updating brand:', err);
    }
  };

  /**
   * Insérer ou mettre à jour un produit
   */
  const saveProduct = async (
    brandId: string,
    product: any
  ) => {
    try {
      const productWithBrand = {
        ...product,
        master_brand_id: brandId,
      };

      if ('id' in product && product.id) {
        // Update
        const { error } = await supabase
          .from('master_products')
          .update(productWithBrand)
          .eq('id', product.id);

        if (error) throw error;
      } else {
        // Insert
        const { error } = await supabase
          .from('master_products')
          .insert([productWithBrand]);

        if (error) throw error;
      }

      // Rafraîchir les données
      await loadBrands();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Erreur de sauvegarde';
      setError(errorMsg);
      console.error('Error saving product:', err);
      throw err;
    }
  };

  /**
   * Supprimer un produit
   */
  const deleteProduct = async (productId: string) => {
    try {
      const { error } = await supabase
        .from('master_products')
        .delete()
        .eq('id', productId);

      if (error) throw error;

      // Rafraîchir les données
      await loadBrands();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Erreur de suppression';
      setError(errorMsg);
      console.error('Error deleting product:', err);
    }
  };

  return {
    brands,
    loading,
    error,
    loadBrands,
    updateBrand,
    saveProduct,
    deleteProduct,
  };
}
