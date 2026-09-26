import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SessionFSM } from './session-fsm';

describe('SessionFSM', () => {
  it('démarre en IDLE', () => {
    const fsm = new SessionFSM();
    assert.strictEqual(fsm.state, 'IDLE');
  });

  it('transitionne correctement sur le chemin heureux', () => {
    const fsm = new SessionFSM();
    fsm.transition('START_REQUESTED');
    assert.strictEqual(fsm.state, 'CONNECTING');
    fsm.transition('CONNECTION_OPENED');
    assert.strictEqual(fsm.state, 'LISTENING');
    fsm.transition('CONFIRM_INTENT_CALLED');
    assert.strictEqual(fsm.state, 'CONFIRMING');
    fsm.transition('CLIENT_CONFIRMED');
    assert.strictEqual(fsm.state, 'SUBMITTING');
    fsm.transition('SUBMIT_SUCCEEDED');
    assert.strictEqual(fsm.state, 'DISPLAYING_RESULT');
    fsm.transition('DISPLAY_TIMER_ELAPSED');
    assert.strictEqual(fsm.state, 'RESETTING');
    fsm.transition('RESET_COMPLETED');
    assert.strictEqual(fsm.state, 'IDLE');
  });

  it('rejette les transitions invalides', () => {
    const fsm = new SessionFSM();
    assert.throws(() => fsm.transition('CONNECTION_OPENED'), /Invalid FSM transition/);
  });

  it('permet le retour LISTENING depuis CONFIRMING si client annule', () => {
    const fsm = new SessionFSM();
    fsm.transition('START_REQUESTED');
    fsm.transition('CONNECTION_OPENED');
    fsm.transition('CONFIRM_INTENT_CALLED');
    assert.strictEqual(fsm.state, 'CONFIRMING');
    fsm.transition('CLIENT_CANCELLED');
    assert.strictEqual(fsm.state, 'LISTENING');
  });

  it('passe en ERROR sur CONNECTION_FAILED depuis tout état connecté', () => {
    const fsm = new SessionFSM();
    fsm.transition('START_REQUESTED');
    fsm.transition('CONNECTION_OPENED');
    fsm.transition('CONFIRM_INTENT_CALLED');
    fsm.transition('CONNECTION_FAILED');
    assert.strictEqual(fsm.state, 'ERROR');
  });

  it('permet recovery depuis ERROR vers LISTENING', () => {
    const fsm = new SessionFSM();
    fsm.transition('START_REQUESTED');
    fsm.transition('CONNECTION_FAILED');
    assert.strictEqual(fsm.state, 'ERROR');
    fsm.transition('RECOVERY_TRIGGERED');
    assert.strictEqual(fsm.state, 'LISTENING');
  });

  it('log chaque transition via onTransition', () => {
    const logs: Array<{ from: string; to: string; event: string }> = [];
    const fsm = new SessionFSM({
      conversationId: 'test-conv',
      onTransition: (log) => logs.push({ from: log.from, to: log.to, event: log.event }),
    });
    fsm.transition('START_REQUESTED');
    fsm.transition('CONNECTION_OPENED');
    assert.strictEqual(logs.length, 2);
    assert.strictEqual(logs[0].from, 'IDLE');
    assert.strictEqual(logs[0].to, 'CONNECTING');
    assert.strictEqual(logs[1].event, 'CONNECTION_OPENED');
  });

  it('canTransition retourne false pour transitions invalides', () => {
    const fsm = new SessionFSM();
    assert.strictEqual(fsm.canTransition('START_REQUESTED'), true);
    assert.strictEqual(fsm.canTransition('CONNECTION_OPENED'), false);
  });

  it('forceState permet override pour recovery', () => {
    const fsm = new SessionFSM();
    fsm.transition('START_REQUESTED');
    fsm.forceState('IDLE', 'manual-reset');
    assert.strictEqual(fsm.state, 'IDLE');
  });

  it('reset ramène à IDLE', () => {
    const fsm = new SessionFSM({ conversationId: 'old' });
    fsm.transition('START_REQUESTED');
    fsm.reset('new');
    assert.strictEqual(fsm.state, 'IDLE');
  });
});
