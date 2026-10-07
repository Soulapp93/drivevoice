import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyUpdateOrder,
  createIdempotencyKey,
  jsonToolOutput,
  normalizeCatalog,
  parseUpdateOrderArguments,
  type CatalogProduct,
} from './tool-protocol';

const catalog: CatalogProduct[] = [
  {
    productId: 'menu',
    name: 'Menu',
    detail: 'Burger, frites et boisson',
    price: 12.9,
    available: true,
    optionGroups: [
      {
        id: 1,
        name: 'Boisson',
        min: 1,
        max: 1,
        required: true,
        options: [
          { id: 11, name: 'Cola zéro', priceDelta: 0, available: true },
          { id: 12, name: 'Jus', priceDelta: 0.5, available: true },
        ],
      },
    ],
  },
  {
    productId: 'fries',
    name: 'Frites',
    detail: 'Frites moyennes',
    price: 3.2,
    available: true,
  },
  {
    productId: 'sold-out',
    name: 'Produit indisponible',
    detail: '',
    price: 4,
    available: false,
  },
];

const sizeMenu: CatalogProduct = {
  productId: 'whopper-menu',
  name: 'Menu Whopper',
  detail: 'Whopper',
  price: 10,
  available: true,
  optionGroups: [
    {
      id: 1,
      name: 'Tailles',
      required: true,
      min: 1,
      max: 1,
      options: [
        { id: 11, name: 'Medium', priceDelta: 0, available: true },
        { id: 12, name: 'Large', priceDelta: 2, available: true },
      ],
    },
    {
      id: 2,
      name: 'Accompagnements',
      required: true,
      min: 1,
      max: 1,
      rulesBySize: {
        Medium: { required: true, min: 1, max: 1 },
        Large: { required: true, min: 1, max: 1 },
      },
      options: [
        { id: 21, name: 'Frites moyennes', priceDelta: 0, available: true, availableFor: ['Medium'] },
        { id: 22, name: 'Grande frite', priceDelta: 0, available: true, availableFor: ['Large'] },
      ],
    },
    {
      id: 3,
      name: 'Boissons',
      required: true,
      min: 1,
      max: 1,
      rulesBySize: {
        Medium: { required: true, min: 1, max: 1 },
        Large: { required: false, min: 0, max: 1 },
      },
      options: [
        { id: 31, name: 'Coca-Cola 40 cl', priceDelta: 0, available: true, availableFor: ['Medium'] },
        { id: 32, name: 'Coca-Cola 50 cl', priceDelta: 0, available: true, availableFor: ['Large'] },
      ],
    },
    {
      id: 4,
      name: 'Suppléments',
      required: false,
      min: 0,
      max: 1,
      options: [
        { id: 41, name: 'Cheddar', priceDelta: 0.5, priceDeltaBySize: { Medium: 0.5, Large: 1.5 }, available: true },
      ],
    },
  ],
};

const validMenu = JSON.stringify({
  items: [{ product_id: 'menu', quantity: 1, selections: [{ group: 'Boisson', options: ['Cola zéro'] }] }],
  status: 'editing',
});

test('parse un appel de panier valide', () => {
  const result = parseUpdateOrderArguments(validMenu);
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.items[0].product_id, 'menu');
});

test('rejette un JSON invalide', () => {
  const result = parseUpdateOrderArguments('{');
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.errorCode, 'INVALID_JSON');
});

test('rejette un statut inconnu', () => {
  const result = parseUpdateOrderArguments(JSON.stringify({ items: [], status: 'unknown' }));
  assert.equal(result.success, false);
});

test('rejette une quantité décimale', () => {
  const result = parseUpdateOrderArguments(JSON.stringify({ items: [{ product_id: 'fries', quantity: 1.5 }], status: 'editing' }));
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.errorCode, 'INVALID_QUANTITY');
});

test('rejette une quantité hors limites', () => {
  const result = parseUpdateOrderArguments(JSON.stringify({ items: [{ product_id: 'fries', quantity: 21 }], status: 'editing' }));
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.errorCode, 'INVALID_QUANTITY');
});

test('rejette des options mal formées', () => {
  const result = parseUpdateOrderArguments(JSON.stringify({
    items: [{ product_id: 'menu', quantity: 1, selections: [{ group: 'Boisson', options: 'Cola zéro' }] }],
    status: 'editing',
  }));
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.errorCode, 'INVALID_ARGUMENTS');
});

test('ajoute un produit simple au panier', () => {
  const parsed = parseUpdateOrderArguments(JSON.stringify({ items: [{ product_id: 'fries', quantity: 1 }], status: 'editing' }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, catalog);
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.total, 3.2);
});

test('gère plusieurs produits successifs', () => {
  const parsed = parseUpdateOrderArguments(JSON.stringify({
    items: [{ product_id: 'fries', quantity: 2 }, { product_id: 'menu', quantity: 1, selections: [{ group: 'Boisson', options: ['Jus'] }] }],
    status: 'editing',
  }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, catalog);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.items.length, 2);
    assert.equal(result.data.total, 19.8);
  }
});

test('valide les options obligatoires', () => {
  const parsed = parseUpdateOrderArguments(JSON.stringify({ items: [{ product_id: 'menu', quantity: 1 }], status: 'editing' }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, catalog);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.errorCode, 'REQUIRED_OPTIONS_MISSING');
});

test('refuse un produit inexistant', () => {
  const parsed = parseUpdateOrderArguments(JSON.stringify({ items: [{ product_id: 'ghost', quantity: 1 }], status: 'editing' }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, catalog);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.errorCode, 'PRODUCT_NOT_FOUND');
});

test('refuse un produit indisponible', () => {
  const parsed = parseUpdateOrderArguments(JSON.stringify({ items: [{ product_id: 'sold-out', quantity: 1 }], status: 'editing' }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, catalog);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.errorCode, 'PRODUCT_UNAVAILABLE');
});

test('refuse une option inexistante', () => {
  const parsed = parseUpdateOrderArguments(JSON.stringify({
    items: [{ product_id: 'menu', quantity: 1, selections: [{ group: 'Boisson', options: ['Cola imaginaire'] }] }],
    status: 'editing',
  }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, catalog);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.errorCode, 'OPTION_UNAVAILABLE');
});

test('refuse un groupe d’options inconnu', () => {
  const parsed = parseUpdateOrderArguments(JSON.stringify({
    items: [{ product_id: 'menu', quantity: 1, selections: [{ group: 'Sauce', options: ['Barbecue'] }] }],
    status: 'editing',
  }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, catalog);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.errorCode, 'REQUIRED_OPTIONS_MISSING');
});

test('refuse les options dupliquées', () => {
  const parsed = parseUpdateOrderArguments(JSON.stringify({
    items: [{ product_id: 'menu', quantity: 1, selections: [{ group: 'Boisson', options: ['Cola zéro', 'Cola zéro'] }] }],
    status: 'editing',
  }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, catalog);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.errorCode, 'INVALID_OPTIONS');
});

test('calcule le supplément d’option dans le total', () => {
  const parsed = parseUpdateOrderArguments(JSON.stringify({
    items: [{ product_id: 'menu', quantity: 1, selections: [{ group: 'Boisson', options: ['Jus'] }] }],
    status: 'ready_to_confirm',
  }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, catalog);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.total, 13.4);
    assert.equal(result.data.status, 'ready_to_confirm');
  }
});

test('applique composition et tarifs propres à la taille large', () => {
  const parsed = parseUpdateOrderArguments(JSON.stringify({
    items: [{
      product_id: 'whopper-menu',
      quantity: 1,
      selections: [
        { group: 'Tailles', options: ['Large'] },
        { group: 'Accompagnements', options: ['Grande frite'] },
        { group: 'Suppléments', options: ['Cheddar'] },
      ],
    }],
    status: 'editing',
  }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, [sizeMenu]);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.items[0].price, 13.5);
    assert.deepEqual(result.data.items[0].customizations, [
      'Tailles: Large',
      'Accompagnements: Grande frite',
      'Suppléments: Cheddar',
    ]);
  }
});

test('refuse une taille de menu non sélectionnée', () => {
  const parsed = parseUpdateOrderArguments(JSON.stringify({
    items: [{ product_id: 'whopper-menu', quantity: 1 }],
    status: 'editing',
  }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, [sizeMenu]);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.errorCode, 'REQUIRED_OPTIONS_MISSING');
});

test('reconnaît les alias de taille pour les choix et tarifs', () => {
  const aliasedMenu: CatalogProduct = {
    ...sizeMenu,
    optionGroups: sizeMenu.optionGroups?.map(group => {
      if (group.name === 'Accompagnements') {
        return {
          ...group,
          rulesBySize: { M: { required: true, min: 1, max: 1 } },
          options: group.options.map(option => option.name === 'Frites moyennes' ? { ...option, availableFor: ['M'] } : option),
        };
      }
      if (group.name === 'Suppléments') {
        return {
          ...group,
          options: group.options.map(option => ({ ...option, priceDeltaBySize: { M: 0.75 } })),
        };
      }
      return group;
    }),
  };
  const parsed = parseUpdateOrderArguments(JSON.stringify({
    items: [{
      product_id: 'whopper-menu',
      quantity: 1,
      selections: [
        { group: 'Tailles', options: ['Medium'] },
        { group: 'Accompagnements', options: ['Frites moyennes'] },
        { group: 'Boissons', options: ['Coca-Cola 40 cl'] },
        { group: 'Suppléments', options: ['Cheddar'] },
      ],
    }],
    status: 'editing',
  }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, [aliasedMenu]);
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.items[0].price, 10.75);
});

test('les règles de taille peuvent rendre un groupe facultatif', () => {
  const parsed = parseUpdateOrderArguments(JSON.stringify({
    items: [{
      product_id: 'whopper-menu',
      quantity: 1,
      selections: [
        { group: 'Tailles', options: ['Large'] },
        { group: 'Accompagnements', options: ['Grande frite'] },
      ],
    }],
    status: 'editing',
  }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, [sizeMenu]);
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.items[0].price, 12);
});

test('refuse une option réservée à une autre taille', () => {
  const parsed = parseUpdateOrderArguments(JSON.stringify({
    items: [{
      product_id: 'whopper-menu',
      quantity: 1,
      selections: [
        { group: 'Tailles', options: ['Medium'] },
        { group: 'Accompagnements', options: ['Grande frite'] },
        { group: 'Boissons', options: ['Coca-Cola 40 cl'] },
      ],
    }],
    status: 'editing',
  }));
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, [sizeMenu]);
  assert.equal(result.success, false);
  if (!result.success) assert.equal(result.errorCode, 'OPTION_UNAVAILABLE');
});

test('conserve le restaurant source dans le panier', () => {
  const parsed = parseUpdateOrderArguments(validMenu);
  assert.equal(parsed.success, true);
  if (!parsed.success) return;
  const result = applyUpdateOrder('restaurant-a', parsed.data, catalog);
  assert.equal(result.success, true);
  if (result.success) assert.equal(result.data.restaurantId, 'restaurant-a');
});

test('sérialise toujours un résultat JSON', () => {
  const output = jsonToolOutput({ success: false, errorCode: 'X', message: 'Réessayer', retryable: true });
  assert.deepEqual(JSON.parse(output), { success: false, errorCode: 'X', message: 'Réessayer', retryable: true });
});

test('crée une clé d’idempotence stable par conversation et call_id', () => {
  assert.equal(createIdempotencyKey('conversation-a', 'call-1'), 'conversation-a:call-1');
});

test('normalise un catalogue JSON provenant du backend', () => {
  const normalized = normalizeCatalog([{ productId: 'x', name: 'X', price: 2, available: true }]);
  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].productId, 'x');
});

test('ignore les produits backend incomplets', () => {
  const normalized = normalizeCatalog([{ productId: 'x', name: 'X' }, { name: 'Y', price: 2 }]);
  assert.equal(normalized.length, 0);
});