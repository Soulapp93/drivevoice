import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RealtimeResponseController } from './session-controller';

function sender(events: object[]) {
  return (event: object) => {
    events.push(event);
    return true;
  };
}

test('crée une seule réponse active', () => {
  const events: object[] = [];
  const controller = new RealtimeResponseController();
  const send = sender(events);
  assert.equal(controller.requestResponse(send), true);
  assert.equal(controller.requestResponse(send), false);
  assert.equal(events.filter(event => (event as { type: string }).type === 'response.create').length, 1);
});

test('marque une réponse comme active après response.created', () => {
  const controller = new RealtimeResponseController();
  const events: object[] = [];
  controller.requestResponse(sender(events));
  controller.onResponseCreated('response-1');
  assert.equal(controller.isResponseActive, true);
  assert.equal(controller.activeResponseId, 'response-1');
  assert.equal(controller.state, 'assistant_speaking');
});

test('bloque deux response.create simultanés', () => {
  const controller = new RealtimeResponseController();
  const events: object[] = [];
  const send = sender(events);
  controller.requestResponse(send);
  controller.onResponseCreated('response-1');
  controller.requestResponse(send);
  assert.equal(events.filter(event => (event as { type: string }).type === 'response.create').length, 1);
});

test('met en file une continuation demandée pendant une réponse', () => {
  const controller = new RealtimeResponseController();
  const events: object[] = [];
  const send = sender(events);
  controller.requestResponse(send);
  controller.onResponseCreated('response-1');
  controller.requestResponse(send);
  controller.onResponseTerminal(send, 'completed');
  assert.equal(events.filter(event => (event as { type: string }).type === 'response.create').length, 2);
});

test('libère le verrou sur response.done', () => {
  const controller = new RealtimeResponseController();
  const events: object[] = [];
  const send = sender(events);
  controller.requestResponse(send);
  controller.onResponseCreated('response-1');
  controller.onResponseTerminal(send, 'completed');
  assert.equal(controller.isResponseActive, false);
  assert.equal(controller.state, 'listening');
});

test('libère le verrou sur response.cancelled', () => {
  const controller = new RealtimeResponseController();
  const events: object[] = [];
  const send = sender(events);
  controller.requestResponse(send);
  controller.onResponseCreated('response-1');
  controller.onResponseTerminal(send, 'cancelled');
  assert.equal(controller.isResponseActive, false);
  assert.equal(controller.state, 'interrupted');
});

test('libère le verrou sur response.failed', () => {
  const controller = new RealtimeResponseController();
  const events: object[] = [];
  const send = sender(events);
  controller.requestResponse(send);
  controller.onResponseCreated('response-1');
  controller.onResponseTerminal(send, 'failed');
  assert.equal(controller.isResponseActive, false);
});

test('annule la réponse quand le client commence à parler', () => {
  const controller = new RealtimeResponseController();
  const events: object[] = [];
  const send = sender(events);
  controller.requestResponse(send);
  controller.onResponseCreated('response-1');
  controller.onSpeechStarted(send);
  assert.equal((events.at(-1) as { type: string }).type, 'response.cancel');
  assert.equal(controller.state, 'user_speaking');
});

test('une interruption ne laisse pas le verrou actif', () => {
  const controller = new RealtimeResponseController();
  const events: object[] = [];
  const send = sender(events);
  controller.requestResponse(send);
  controller.cancel(send);
  assert.equal(controller.isResponseActive, false);
  assert.equal(controller.state, 'interrupted');
});

test('ne marque pas une réponse si le DataChannel refuse l’envoi', () => {
  const controller = new RealtimeResponseController();
  const sent = controller.requestResponse(() => false);
  assert.equal(sent, false);
  assert.equal(controller.isResponseActive, false);
});

test('rejette une continuation si une réponse est encore active puis la rejoue', () => {
  const controller = new RealtimeResponseController();
  const events: object[] = [];
  const send = sender(events);
  controller.requestResponse(send);
  controller.onResponseCreated('response-1');
  assert.equal(controller.requestResponse(send), false);
  controller.onResponseTerminal(send, 'incomplete');
  assert.equal(events.filter(event => (event as { type: string }).type === 'response.create').length, 2);
});

test('le cycle outil peut reprendre après la fin de la réponse', () => {
  const controller = new RealtimeResponseController();
  const events: object[] = [];
  const send = sender(events);
  controller.requestResponse(send);
  controller.onResponseCreated('response-1');
  controller.onToolStarted();
  controller.onResponseTerminal(send, 'completed');
  controller.onToolFinished();
  controller.requestResponse(send);
  assert.equal(events.filter(event => (event as { type: string }).type === 'response.create').length, 2);
});