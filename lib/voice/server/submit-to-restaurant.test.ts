import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildHubRiseOrderPayload } from './submit-to-restaurant';

describe('buildHubRiseOrderPayload', () => {
  it('produit le format HubRise pour une commande drive', () => {
    const payload = buildHubRiseOrderPayload('DV-ABC123', [
      {
        name: 'Whopper',
        quantity: 2,
        price: 9.5,
        sku_ref: 'whopper',
        customizations: ['Sauce: Barbecue'],
      },
    ]);

    assert.strictEqual(payload.status, 'new');
    assert.strictEqual(payload.channel, 'DriveVoice');
    assert.strictEqual(payload.private_ref, 'DV-ABC123');
    assert.strictEqual(payload.service_type, 'collection');
    assert.strictEqual(payload.asap, true);
    assert.deepStrictEqual(payload.items, [
      {
        product_name: 'Whopper',
        sku_ref: 'whopper',
        price: '9.50 EUR',
        quantity: '2',
        options: [
          {
            option_list_name: 'Sauce',
            name: 'Barbecue',
            quantity: 1,
          },
        ],
      },
    ]);
  });
});

describe('submit-to-restaurant regression guard', () => {
  it('ne chaîne jamais .catch()/.then()/.finally() directement sur .rpc() (cause de "u.rpc(...).catch is not a function")', () => {
    // Le PostgrestFilterBuilder de supabase-js n'implémente qu'un simple
    // protocole "thenable" et n'expose pas forcément .catch()/.finally() une
    // fois bundlé/minifié. Chaîner ces méthodes directement provoque un
    // TypeError qui écrase silencieusement le résultat de submitOrderToRestaurant
    // et fait échouer TOUTES les commandes avec un INTERNAL_ERROR aléatoire.
    // Toujours envelopper l'appel dans un `await ... ` + try/catch classique.
    const filePath = fileURLToPath(new URL('./submit-to-restaurant.ts', import.meta.url));
    const source = readFileSync(filePath, 'utf8');
    const forbiddenPattern = /\.rpc\([^)]*\)\s*\.(catch|then|finally)\(/;
    assert.strictEqual(
      forbiddenPattern.test(source),
      false,
      'Chaîner .catch()/.then()/.finally() directement sur supabase.rpc(...) est interdit : utilisez await + try/catch.',
    );
  });
});