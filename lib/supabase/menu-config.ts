import { supabase } from './client';

export type MenuConfigItem = {
  name: string;
  priceDelta: number;
  posCode: string;
};

export type MenuSizeConfiguration = {
  sizeName: string;
  sides: MenuConfigItem[];
  sauces: MenuConfigItem[];
  drinks: MenuConfigItem[];
};

export type MenuConfiguration = {
  id: string;
  brandId: string;
  sizeName: string;
  sides: MenuConfigItem[];
  sauces: MenuConfigItem[];
  drinks: MenuConfigItem[];
  createdAt: string;
  updatedAt: string;
};

export async function fetchMenuConfigurations(brandId: string): Promise<MenuConfiguration[]> {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('menu_configurations')
    .select('id, brand_id, size_name, sides, sauces, drinks, created_at, updated_at')
    .eq('brand_id', brandId)
    .order('size_name');

  if (error || !data) return [];

  return data.map((row) => ({
    id: row.id,
    brandId: row.brand_id,
    sizeName: row.size_name,
    sides: Array.isArray(row.sides) ? row.sides : [],
    sauces: Array.isArray(row.sauces) ? row.sauces : [],
    drinks: Array.isArray(row.drinks) ? row.drinks : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function upsertMenuConfiguration(
  brandId: string,
  sizeName: string,
  sides: MenuConfigItem[],
  sauces: MenuConfigItem[],
  drinks: MenuConfigItem[]
): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: true };
  const { error } = await supabase
    .from('menu_configurations')
    .upsert(
      {
        brand_id: brandId,
        size_name: sizeName,
        sides,
        sauces,
        drinks,
      },
      { onConflict: 'brand_id,size_name' }
    );
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function deleteMenuConfiguration(
  brandId: string,
  sizeName: string
): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: true };
  const { error } = await supabase
    .from('menu_configurations')
    .delete()
    .eq('brand_id', brandId)
    .eq('size_name', sizeName);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function renameMenuConfiguration(
  brandId: string,
  oldSizeName: string,
  newSizeName: string
): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: true };
  const { data: existing } = await supabase
    .from('menu_configurations')
    .select('sides, sauces, drinks')
    .eq('brand_id', brandId)
    .eq('size_name', oldSizeName)
    .single();

  if (!existing) return { ok: false, error: 'Configuration introuvable' };

  const { error: deleteError } = await supabase
    .from('menu_configurations')
    .delete()
    .eq('brand_id', brandId)
    .eq('size_name', oldSizeName);
  if (deleteError) return { ok: false, error: deleteError.message };

  return upsertMenuConfiguration(brandId, newSizeName, existing.sides, existing.sauces || [], existing.drinks);
}
