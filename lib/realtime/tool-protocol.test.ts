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