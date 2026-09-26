import { describe, it } from 'node:test';
import assert from 'node:assert';
import { isExplicitOrderConfirmation, isOrderWrapUpPhrase } from './voice-orchestrator';

describe('Détection des phrases de fin de commande', () => {
  it('reconnaît les formulations de fin réellement transcrites par le client', () => {
    assert.strictEqual(isOrderWrapUpPhrase("Non, ça c'est tout."), true);
    assert.strictEqual(isOrderWrapUpPhrase('Ça c’est tout pour moi'), true);
    assert.strictEqual(isOrderWrapUpPhrase('Vous voulez autre chose ?'), false);
  });
});

describe('Détection des confirmations explicites', () => {
  it('reconnaît oui et je confirme', () => {
    assert.strictEqual(isExplicitOrderConfirmation('Oui'), true);
    assert.strictEqual(isExplicitOrderConfirmation('Je confirme'), true);
    assert.strictEqual(isExplicitOrderConfirmation('Non, ajoutez un menu'), false);
  });
});
