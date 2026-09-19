import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BasketManager } from './basket-manager';

const catalog = [
  { productId: 'fries', name: 'Frites', price: 3.2 },
  { productId: 'burger', name: 'Burger', price: 8.5 },
  { productId: 'drink', name: 'Boisson', price: 2.8 },
];

describe('BasketManager', () => {
  it('crée un panier vide par défaut', () => {
    const basket = new BasketManager('rest-1', catalog);
    const snapshot = basket.getSnapshot();
    assert.strictEqual(snapshot.restaurantId, 'rest-1');
    assert.deepStrictEqual(snapshot.items, []);
    assert.strictEqual(snapshot.total, 0);
    assert.strictEqual(snapshot.status, 'editing');
  });

  it('restaure un snapshot initial', () => {
    const basket = new BasketManager('rest-1', catalog, {
      restaurantId: 'rest-1',
      items: [{ id: 'fries-1', productId: 'fries', name: 'Frites', detail: '', price: 3.2, quantity: 2, customizations: [] }],
      total: 6.4,
      status: 'editing',
    });
    assert.strictEqual(basket.getSnapshot().items.length, 1);
    assert.strictEqual(basket.getSnapshot().total, 6.4);
  });

  it('ajoute un produit au panier', () => {
    const basket = new BasketManager('rest-1', catalog);
    basket.applyOptimisticOperation('op-1', { kind: 'add', productId: 'fries', quantity: 1 });
    const snapshot = basket.getSnapshot();
    assert.strictEqual(snapshot.items.length, 1);
    assert.strictEqual(snapshot.items[0].name, 'Frites');
    assert.strictEqual(snapshot.items[0].quantity, 1);
    assert.strictEqual(snapshot.total, 3.2);
  });

  it('incrémente la quantité quand le même produit est ajouté', () => {
    const basket = new BasketManager('rest-1', catalog);
    basket.applyOptimisticOperation('op-1', { kind: 'add', productId: 'fries', quantity: 1 });
    basket.applyOptimisticOperation('op-2', { kind: 'add', productId: 'fries', quantity: 2 });
    const snapshot = basket.getSnapshot();
    assert.strictEqual(snapshot.items.length, 1);
    assert.strictEqual(snapshot.items[0].quantity, 3);
    assert.strictEqual(Number(snapshot.total.toFixed(2)), 9.6);
  });

  it('crée deux lignes pour les mêmes produits avec customizations différentes', () => {
    const basket = new BasketManager('rest-1', catalog);
    basket.applyOptimisticOperation('op-1', { kind: 'add', productId: 'burger', quantity: 1, customizations: ['Sauce: ketchup'] });
    basket.applyOptimisticOperation('op-2', { kind: 'add', productId: 'burger', quantity: 1, customizations: ['Sauce: mayo'] });
    const snapshot = basket.getSnapshot();
    assert.strictEqual(snapshot.items.length, 2);
    assert.strictEqual(snapshot.total, 17);
  });

  it('retire tout un produit du panier', () => {
    const basket = new BasketManager('rest-1', catalog);
    basket.applyOptimisticOperation('op-1', { kind: 'add', productId: 'fries', quantity: 2 });
    basket.applyOptimisticOperation('op-2', { kind: 'remove', productId: 'fries' });
    const snapshot = basket.getSnapshot();
    assert.strictEqual(snapshot.items.length, 0);
    assert.strictEqual(snapshot.total, 0);
  });

  it('retire partiellement un produit', () => {
    const basket = new BasketManager('rest-1', catalog);
    basket.applyOptimisticOperation('op-1', { kind: 'add', productId: 'fries', quantity: 3 });
    basket.applyOptimisticOperation('op-2', { kind: 'remove', productId: 'fries', quantity: 1 });
    const snapshot = basket.getSnapshot();
    assert.strictEqual(snapshot.items[0].quantity, 2);
    assert.strictEqual(snapshot.total, 6.4);
  });

  it('modifie la quantité exacte', () => {
    const basket = new BasketManager('rest-1', catalog);
    basket.applyOptimisticOperation('op-1', { kind: 'add', productId: 'fries', quantity: 1 });
    basket.applyOptimisticOperation('op-2', { kind: 'set_quantity', productId: 'fries', quantity: 5 });
    const snapshot = basket.getSnapshot();
    assert.strictEqual(snapshot.items[0].quantity, 5);
    assert.strictEqual(snapshot.total, 16);
  });

  it('supprime un produit quand la quantité est mise à 0', () => {
    const basket = new BasketManager('rest-1', catalog);
    basket.applyOptimisticOperation('op-1', { kind: 'add', productId: 'fries', quantity: 2 });
    basket.applyOptimisticOperation('op-2', { kind: 'set_quantity', productId: 'fries', quantity: 0 });
    assert.strictEqual(basket.getSnapshot().items.length, 0);
  });

  it('ignore une opération déjà appliquée (idempotence)', () => {
    const basket = new BasketManager('rest-1', catalog);
    basket.applyOptimisticOperation('op-1', { kind: 'add', productId: 'fries', quantity: 1 });
    basket.applyOptimisticOperation('op-1', { kind: 'add', productId: 'fries', quantity: 1 });
    assert.strictEqual(basket.getSnapshot().items[0].quantity, 1);
  });

  it('notifie les listeners à chaque changement', () => {
    const basket = new BasketManager('rest-1', catalog);
    let calls = 0;
    basket.onChange(() => {
      calls += 1;
    });
    basket.applyOptimisticOperation('op-1', { kind: 'add', productId: 'fries', quantity: 1 });
    basket.applyOptimisticOperation('op-2', { kind: 'remove', productId: 'fries' });
    assert.strictEqual(calls, 2);
  });

  it('restaure le snapshot serveur et efface les opérations en attente', () => {
    const basket = new BasketManager('rest-1', catalog);
    basket.applyOptimisticOperation('op-1', { kind: 'add', productId: 'fries', quantity: 1 });
    basket.applyServerSnapshot({
      restaurantId: 'rest-1',
      items: [{ id: 'drink-1', productId: 'drink', name: 'Boisson', detail: '', price: 2.8, quantity: 1, customizations: [] }],
      total: 2.8,
      status: 'editing',
    });
    const snapshot = basket.getSnapshot();
    assert.strictEqual(snapshot.items.length, 1);
    assert.strictEqual(snapshot.items[0].productId, 'drink');
    assert.strictEqual(snapshot.total, 2.8);
  });

  it('rollback annule une opération optimiste', () => {
    const basket = new BasketManager('rest-1', catalog);
    basket.applyOptimisticOperation('op-1', { kind: 'add', productId: 'fries', quantity: 1 });
    assert.strictEqual(basket.getSnapshot().items.length, 1);
    basket.rollbackOperation('op-1');
    assert.strictEqual(basket.getSnapshot().items.length, 0);
    assert.strictEqual(basket.getSnapshot().total, 0);
  });
});
