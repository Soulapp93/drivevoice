import { NextResponse } from 'next/server';
import { seedMasterCatalogs, type CatalogSeedData } from '@/lib/supabase/seed';

// Données Burger King - à extraire de app/page.tsx
// Pour ce seed, on utilise une version minimale et structurée
const burgerKingData: CatalogSeedData = [
  {
    name: 'Burger King France',
    short: 'BK',
    color: '#c83a20',
    soft: '#fff0e8',
    products: [
      // Nouveautés
      {
        productId: 'bk_master_chefs',
        name: 'Master des Chefs',
        category: 'Nouveautés',
        subcategory: 'Burgers',
        price: 11.5,
        detail: 'Burger de la gamme Masters des Chefs',
        emoji: '🍔',
        productType: 'configurable',
      },
      {
        productId: 'bk_master_sarran',
        name: 'Master Sarran Mozzarella',
        category: 'Nouveautés',
        subcategory: 'Burgers',
        price: 11.5,
        detail: 'Burger au poulet et mozzarella de la gamme Masters',
        emoji: '🍔',
        productType: 'configurable',
      },
      {
        productId: 'bk_red_bull',
        name: 'Red Bull Energy Drink (25cl)',
        category: 'Nouveautés',
        subcategory: 'Boissons',
        price: 3.9,
        detail: 'Boisson énergisante Red Bull 25cl',
        emoji: '🥤',
        productType: 'simple',
      },
      // Menus sample
      {
        productId: 'bk_menu_master_sarran',
        name: 'Master Sarran Mozzarella',
        category: 'Menus',
        subcategory: 'Poulet',
        price: 13.9,
        detail: 'Master Sarran Mozzarella, accompagnement et boisson au choix',
        emoji: '🍔',
        productType: 'menu',
      },
      {
        productId: 'bk_menu_cbk',
        name: 'CBK',
        category: 'Menus',
        subcategory: 'Poulet',
        price: 10.9,
        detail: 'CBK, accompagnement et boisson au choix',
        emoji: '🍔',
        productType: 'menu',
      },
      // Burgers
      {
        productId: 'bk_burger_cbk',
        name: 'CBK',
        category: 'Burgers',
        subcategory: 'Poulet',
        price: 8.4,
        detail: 'Burger au poulet croustillant CBK',
        emoji: '🍔',
        productType: 'configurable',
      },
      {
        productId: 'bk_burger_whopper',
        name: 'Whopper®',
        category: 'Burgers',
        subcategory: 'Bœuf',
        price: 6.5,
        detail: 'Viande de bœuf grillée à la flamme et légumes frais',
        emoji: '🍔',
        productType: 'configurable',
      },
      {
        productId: 'bk_burger_cheeseburger',
        name: 'Cheeseburger',
        category: 'Burgers',
        subcategory: 'Bœuf',
        price: 2.95,
        detail: 'Viande grillée à la flamme et fromage',
        emoji: '🍔',
        productType: 'configurable',
      },
      // Boissons
      {
        productId: 'bk_drink_coca_25cl',
        name: 'Coca-Cola® (25cl)',
        category: 'Boissons',
        subcategory: 'Sodas',
        price: 2.4,
        detail: 'Coca-Cola classique 25cl',
        emoji: '🥤',
        productType: 'simple',
      },
      {
        productId: 'bk_drink_vittel_33cl',
        name: 'Vittel® (33cl)',
        category: 'Boissons',
        subcategory: 'Eau',
        price: 2.6,
        detail: 'Eau minérale Vittel 33cl',
        emoji: '💧',
        productType: 'simple',
      },
      // Sauces
      {
        productId: 'bk_sauce_ketchup',
        name: 'Ketchup',
        category: 'Sauces',
        subcategory: 'Sauces',
        price: 0.2,
        detail: 'Sauce ketchup',
        emoji: '🍅',
        productType: 'simple',
      },
      {
        productId: 'bk_sauce_barbecue',
        name: 'Sauce Barbecue',
        category: 'Sauces',
        subcategory: 'Sauces',
        price: 0.4,
        detail: 'Sauce barbecue',
        emoji: '🌶️',
        productType: 'simple',
      },
    ],
  },
];

export async function POST() {
  try {
    // Protection basique : vérifier un header secret (optionnel)
    // const secret = process.env.SEED_SECRET;
    // if (!secret || req.headers.get('x-seed-secret') !== secret) {
    //   return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    // }

    console.log('Starting seed...');
    const result = await seedMasterCatalogs(burgerKingData);

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    console.error('Seed error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
