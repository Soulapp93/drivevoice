-- Seed Burger King catalogue into Supabase
-- This is a one-time seed to populate the master catalogs

-- 1. Create Burger King brand
INSERT INTO public.master_brands (name, short, color, soft, status, version)
VALUES (
  'Burger King France',
  'BK',
  '#c83a20',
  '#fff0e8',
  'Publié',
  1
)
ON CONFLICT DO NOTHING;

-- 2. Get the BK brand ID for inserting products
WITH bk_brand AS (
  SELECT id FROM public.master_brands WHERE short = 'BK' LIMIT 1
)

-- 3. Insert sample BK products
INSERT INTO public.master_products (
  master_brand_id,
  product_id,
  name,
  category,
  subcategory,
  price,
  detail,
  emoji,
  available,
  product_type,
  option_groups,
  ingredients,
  ingredient_settings,
  modifiers,
  variants,
  badges,
  display_order,
  image_url,
  pos_code,
  slug,
  meat_filter
)
SELECT
  bk_brand.id,
  'bk_' || LOWER(REPLACE(REPLACE(t.name, ' ', '_'), 'é', 'e')) || '_' || t.rownum,
  t.name,
  t.category,
  t.subcategory,
  t.price,
  t.detail,
  t.emoji,
  true,
  t.product_type,
  '[]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  '[]'::jsonb,
  t.rownum::int,
  NULL,
  '',
  NULL,
  NULL
FROM bk_brand,
LATERAL (VALUES
  (1, 'Master des Chefs', 'Nouveautés', '', 11.5, 'Burger de la gamme Masters des Chefs', '🍔', 'configurable'),
  (2, 'Master Sarran Mozzarella', 'Nouveautés', '', 11.5, 'Burger au poulet et mozzarella de la gamme Masters', '🍔', 'configurable'),
  (3, 'Master Pairet Poivre', 'Nouveautés', '', 11.5, 'Burger de la gamme Masters, note poivrée', '🍔', 'configurable'),
  (4, 'Red Bull Energy Drink (25cl)', 'Nouveautés', '', 3.9, 'Boisson énergisante Red Bull 25cl', '🥤', 'simple'),
  (5, 'Master Sarran Mozzarella', 'Menus', 'Poulet', 13.9, 'Master Sarran Mozzarella, accompagnement et boisson au choix', '🍔', 'menu'),
  (6, 'CBK', 'Menus', 'Poulet', 10.9, 'CBK, accompagnement et boisson au choix', '🍔', 'menu'),
  (7, 'Double CBK', 'Menus', 'Poulet', 12.9, 'Double CBK, accompagnement et boisson au choix', '🍔', 'menu'),
  (8, 'CBK', 'Burgers', 'Poulet', 8.4, 'Burger au poulet croustillant CBK', '🍔', 'configurable'),
  (9, 'Whopper®', 'Burgers', 'Bœuf', 6.5, 'Viande de bœuf grillée à la flamme et légumes frais', '🍔', 'configurable'),
  (10, 'Cheeseburger', 'Burgers', 'Bœuf', 2.95, 'Viande grillée à la flamme et fromage', '🍔', 'configurable'),
  (11, 'Hamburger', 'Burgers', 'Bœuf', 2.5, 'Viande grillée à la flamme, format classique', '🍔', 'configurable'),
  (12, 'Petites frites', 'Snacks & Sauces', 'Frites & Gaufrettes', 2.75, 'Petite portion de frites croustillantes', '🍟', 'simple'),
  (13, 'Moyennes frites', 'Snacks & Sauces', 'Frites & Gaufrettes', 2.95, 'Moyenne portion de frites croustillantes', '🍟', 'simple'),
  (14, 'Coca-Cola® (25cl)', 'Boissons', 'Sodas', 2.4, 'Coca-Cola classique 25cl', '🥤', 'simple'),
  (15, 'Vittel® (33cl)', 'Boissons', 'Eau', 2.6, 'Eau minérale Vittel 33cl', '💧', 'simple'),
  (16, 'Ketchup', 'Sauces', 'Sauces', 0.2, 'Sauce ketchup', '🍅', 'simple'),
  (17, 'Sauce Barbecue', 'Sauces', 'Sauces', 0.4, 'Sauce barbecue', '🌶️', 'simple'),
  (18, 'Sauce Andalouse', 'Sauces', 'Sauces', 0.4, 'Sauce Andalouse', '🍊', 'simple'),
  (19, 'Caesar', 'Sauces', 'Sauces', 0.6, 'Sauce Caesar', '🥬', 'simple'),
  (20, 'Master des Chefs', 'Burgers', 'Bœuf', 11.5, 'Burger de la gamme Masters des Chefs', '🍔', 'configurable')
) AS t(rownum, name, category, subcategory, price, detail, emoji, product_type)
ON CONFLICT DO NOTHING;
