# Implémentation Supabase — État d'avancement

## ✓ Phase 3 complétée : Seed des données

**Fichiers créés :**
- `lib/supabase/seed.ts` — Fonction `seedMasterCatalogs()` pour importer les données en vrac
- `app/api/seed/route.ts` — API route `/api/seed` (POST) pour exécuter le seed
- `lib/supabase/hooks.ts` — Hook `useMasterBrands()` pour charger les catalogues depuis Supabase

**État :** ✓ Build OK · API route active

**Prochaine action :**  
Appel POST à `http://localhost:5173/api/seed` pour remplir Supabase avec les catalogues BK, Quick, KFC.

---

## Phase 4 en cours : Intégrer Supabase dans BackOfficePanel

**Approche :**  
Refactoriser graduellement `BackOfficePanel()` (ligne 1560 de app/page.tsx) pour utiliser le hook `useMasterBrands()` au lieu de `useState` en mémoire.

**Étapes :**

1. **Remplacer les états React par le hook Supabase**
   ```typescript
   // Avant (ligne 1561)
   const [brands, setBrands] = useState<MasterBrand[]>(initialMasterBrands);
   
   // Après
   const { brands, loading, error, updateBrand, saveProduct, deleteProduct } = useMasterBrands();
   ```

2. **Adapter les appels de sauvegarde**
   - `publish()` → appelle `updateBrand()` avec `{ status: 'Publié', version: version + 1 }`
   - `saveProduct()` → appelle `saveProduct()` du hook

3. **Tester les trois tabs du back-office**
   - Catalog : charger/afficher les produits
   - Versions : voir les versions publiées
   - Restaurants : afficher les rattachements (données simulées)

**Fichiers à modifier :**
- `app/page.tsx` ligne 1560 : fonction `BackOfficePanel()`

---

## Phase 5 : Refactoriser RestaurantMenuBuilderPanel

**Objectif :**  
Charger `restaurant_products` au lieu de gérer une liste en mémoire.

**Approche :**
1. Créer un hook `useRestaurantCatalog(restaurantId)`
2. Adapter `RestaurantMenuBuilderPanel` pour charger depuis ce hook
3. Permettre aux restaurateurs de modifier les prix localement (indépendants du catalogue maître)

**Fichiers à créer :**
- `lib/supabase/hooks.ts` → ajouter `useRestaurantCatalog()`

**Fichiers à modifier :**
- `app/page.tsx` ligne ~1380 : fonction `RestaurantMenuBuilderPanel()`

---

## Phase 6 : Authentification et gestion des restaurants

**Objectif :**  
Implémenter le système multi-tenant : création d'organisations, restaurants, utilisateurs.

**Nouvelles pages :**
1. `/admin/restaurants` — Voir/créer ses restaurants
2. `/admin/super` — Super-admin : gérer les marques maîtres et tous les restaurants

**Fonctionnalités :**
- Formulaire d'inscription → crée une `organization`
- Bouton "Créer restaurant" → rattache à une `master_brand`, génère un code unique
- Invite par email → crée `organization_members` ou `restaurant_members`
- Authentification via `auth.openSignInModal()` (Verdent Auth)

**Fichiers à créer :**
- `app/admin/restaurants/page.tsx` — Gestion des restaurants
- `app/admin/super/page.tsx` — Super-admin panel
- Lib `lib/supabase/auth-helpers.ts` — Détection du rôle, vérification RLS

**Fichiers à modifier :**
- `app/page.tsx` — ajouter lien vers `/admin/restaurants`

---

## Phase 7 : Synchroniser l'agent vocal

**Objectif :**  
L'API `/api/realtime-call` charge les produits d'un restaurant depuis Supabase au lieu d'utiliser des données hardcodées.

**Changements dans `/api/realtime-call/route.ts` :**
1. Lire `restaurant_id` depuis query/headers
2. Charger `restaurant_products` via `createServiceClient()`
3. Générer dynamiquement la `CARTE` et l'enum `product_id` de l'outil `update_order`
4. Supporter les ingrédients personnalisés par l'agent (retraits, suppléments)

**Fichiers à créer :**
- `lib/realtime-helpers.ts` — Fonction pour construire le contexte d'agent à partir de Supabase

**Fichiers à modifier :**
- `app/api/realtime-call/route.ts`

---

## Phase 8 : Tests end-to-end

**Vérifications :**
1. ✓ TypeScript compile sans erreur
2. ✓ Build production réussit
3. ✓ API `/api/seed` remplit Supabase
4. ✓ Back-office maître charge/sauvegarde depuis Supabase
5. ✓ Créer un restaurant → copie le catalogue maître
6. ✓ Modifier un prix local → agent vocal le reflète
7. ✓ Appel vocal → agent cite les produits du restaurant
8. ✓ RLS Supabase vérifie les permissions

**Commandes :**
```bash
# Vérifier les types
npx tsc --noEmit

# Build production
npm run build

# Démarrer le serveur de développement
npm run dev

# Tester l'API seed (à partir du navigateur ou curl)
curl -X POST http://localhost:5173/api/seed
```

---

## Architecture multi-tenant finalisée

```
┌─────────────────────────────────────────────┐
│ Organisations (tenants)                      │
│  - BK France (super-admin)                   │
│  - Quick France (super-admin)                │
│  - KFC France (super-admin)                  │
└────────────────┬────────────────────────────┘
                 │
        ┌────────┴───────────┐
        │                    │
   ┌────v────┐        ┌──────v────┐
   │ Marques │        │Restaurants│
   │ maîtres │        │ (locaux)   │
   │(BK/Q/K) │        └────┬───────┘
   └────┬────┘             │
        │                  │
   Produits          Produits
   nationaux         locaux
   (prix             (prix
    fixes)          modifiés)
        │                  │
        └────────┬─────────┘
                 │
           ┌─────v──────┐
           │Agent vocal │
           │pour chaque │
           │restaurant  │
           └────────────┘
```

---

## Checkpoints clés

- [ ] Seed réussit → Supabase contient les 3 catalogues maîtres
- [ ] Hook `useMasterBrands()` charge les marques en preview
- [ ] BackOfficePanel utilise Supabase (non plus `initialMasterBrands`)
- [ ] Créer un restaurant copie ses produits de la marque maître
- [ ] Modifier un prix restaurant ne change pas la marque maître
- [ ] Agent vocal charge les produits du restaurant actif
- [ ] RLS Supabase protège les données (utilisateurs ne voient que leurs restaurants)
- [ ] Déploiement ready pour Verdent Publish

