import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ConversationMachine } from './conversation-machine';
import { extractResponseStatus } from './voice-orchestrator';

const send = () => true;

describe('ConversationMachine', () => {
  it('démarre à idle', () => {
    const machine = new ConversationMachine();
    assert.strictEqual(machine.currentState, 'idle');
  });

  it('envoie response.create et passe en processing', () => {
    const machine = new ConversationMachine();
    const events: object[] = [];
    machine.requestResponse((event) => { events.push(event); return true; });
    assert.deepStrictEqual(events, [{ type: 'response.create' }]);
    assert.strictEqual(machine.currentState, 'processing');
  });

  it('ne déclenche pas deux response.create simultanés', () => {
    const machine = new ConversationMachine();
    let count = 0;
    const sendCount = () => { count += 1; return true; };
    machine.requestResponse(sendCount);
    machine.requestResponse(sendCount);
    assert.strictEqual(count, 1);
  });

  it('passe en assistant_speaking quand la réponse est créée', () => {
    const machine = new ConversationMachine();
    machine.requestResponse(send);
    machine.onResponseCreated('resp-1');
    assert.strictEqual(machine.currentState, 'assistant_speaking');
  });

  it('exécute un outil puis redemande une réponse', () => {
    const machine = new ConversationMachine();
    const events: object[] = [];
    const captureSend = (event: object) => { events.push(event); return true; };
    machine.requestResponse(captureSend);
    machine.onResponseCreated('resp-1');
    machine.onToolCallStarted();
    assert.strictEqual(machine.currentState, 'tool_running');
    machine.onToolCallFinished(captureSend, 'call-1', '{"success":true,"data":{}}');
    assert.deepStrictEqual(events[events.length - 2], {
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call-1', output: '{"success":true,"data":{}}' },
    });
    assert.deepStrictEqual(events[events.length - 1], { type: 'response.create' });
  });

  it('interrompt la réponse en cours quand le client parle', () => {
    const machine = new ConversationMachine();
    const events: object[] = [];
    const captureSend = (event: object) => { events.push(event); return true; };
    machine.requestResponse(captureSend);
    machine.onResponseCreated('resp-1');
    machine.onSpeechStarted(captureSend);
    assert.deepStrictEqual(events[events.length - 1], { type: 'response.cancel' });
    assert.strictEqual(machine.currentState, 'user_speaking');
  });

  it('file les réponses en attente après response.done', () => {
    const machine = new ConversationMachine();
    const events: object[] = [];
    const captureSend = (event: object) => { events.push(event); return true; };
    machine.requestResponse(captureSend);
    machine.onResponseCreated('resp-1');
    machine.requestResponse(captureSend);
    machine.onResponseDone(captureSend, 'completed');
    assert.deepStrictEqual(events[events.length - 1], { type: 'response.create' });
  });

  it('passe en erreur si response.done est failed', () => {
    const machine = new ConversationMachine();
    machine.requestResponse(send);
    machine.onResponseCreated('resp-1');
    machine.onResponseDone(send, 'failed');
    assert.strictEqual(machine.currentState, 'error');
  });

  it('reste à l’écoute si response.done est incomplete', () => {
    const machine = new ConversationMachine();
    machine.requestResponse(send);
    machine.onResponseCreated('resp-1');
    machine.onResponseDone(send, 'incomplete');
    assert.strictEqual(machine.currentState, 'listening');
  });

  it('lit le statut réel dans response.done au format OpenAI', () => {
    const machine = new ConversationMachine();
    machine.requestResponse(send);
    machine.onResponseCreated('resp-1');
    const raw = { type: 'response.done', response: { id: 'resp-1', status: 'completed', output: [] } };
    machine.onResponseDone(send, extractResponseStatus(raw));
    assert.strictEqual(machine.currentState, 'listening');
  });

  it('interprète une interruption comme interrupted et non comme une erreur', () => {
    const machine = new ConversationMachine();
    machine.requestResponse(send);
    machine.onResponseCreated('resp-1');
    const raw = { type: 'response.done', response: { id: 'resp-1', status: 'cancelled' } };
    machine.onResponseDone(send, extractResponseStatus(raw));
    assert.strictEqual(machine.currentState, 'interrupted');
  });

  it('attend que tous les outils soient terminés avant de redemander une réponse', () => {
    const machine = new ConversationMachine();
    const events: object[] = [];
    const captureSend = (event: object) => { events.push(event); return true; };
    machine.requestResponse(captureSend);
    machine.onResponseCreated('resp-1');
    machine.onToolCallStarted();
    machine.onToolCallStarted();
    assert.strictEqual(machine.hasRunningTool, true);
    machine.onToolCallFinished(captureSend, 'call-1', '{}');
    assert.strictEqual(machine.hasRunningTool, true);
    machine.onToolCallFinished(captureSend, 'call-2', '{}');
    assert.strictEqual(machine.hasRunningTool, false);
    assert.deepStrictEqual(events[events.length - 1], { type: 'response.create' });
  });
});

describe('extractResponseStatus', () => {
  it('lit status depuis response.status', () => {
    assert.strictEqual(extractResponseStatus({ response: { status: 'completed' } }), 'completed');
    assert.strictEqual(extractResponseStatus({ response: { status: 'failed', status_details: { reason: 'max_output_tokens' } } }), 'failed');
    assert.strictEqual(extractResponseStatus({ response: { status: 'incomplete' } }), 'incomplete');
  });

  it('retombe sur le status racine si response est absent', () => {
    assert.strictEqual(extractResponseStatus({ status: 'cancelled' }), 'cancelled');
  });

  it('considère un événement sans statut comme terminé', () => {
    assert.strictEqual(extractResponseStatus({}), 'completed');
    assert.strictEqual(extractResponseStatus(undefined), 'completed');
  });
});
