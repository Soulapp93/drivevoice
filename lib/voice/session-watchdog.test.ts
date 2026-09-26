import { describe, it } from 'node:test';
import assert from 'node:assert';
import { SessionWatchdog } from './session-watchdog';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SessionWatchdog', () => {
  it('déclenche submit_timeout après le délai configuré', async () => {
    const actions: Array<{ action: string; elapsedMs: number }> = [];
    const watchdog = new SessionWatchdog({
      submittingTimeoutMs: 50,
      onAction: (action, elapsedMs) => actions.push({ action, elapsedMs }),
    });
    watchdog.start();
    watchdog.setState('SUBMITTING');
    await sleep(300);
    watchdog.check();
    watchdog.stop();

    assert.strictEqual(actions.length >= 1, true);
    assert.strictEqual(actions[0].action, 'submit_timeout');
    assert.strictEqual(actions[0].elapsedMs >= 50, true);
  });

  it('déclenche display_timeout après le délai configuré', async () => {
    const actions: Array<{ action: string; elapsedMs: number }> = [];
    const watchdog = new SessionWatchdog({
      displayTimeoutMs: 50,
      onAction: (action, elapsedMs) => actions.push({ action, elapsedMs }),
    });
    watchdog.start();
    watchdog.setState('DISPLAYING_RESULT');
    await sleep(300);
    watchdog.check();
    watchdog.stop();

    assert.strictEqual(actions.length >= 1, true);
    assert.strictEqual(actions[0].action, 'display_timeout');
  });

  it('ne déclenche pas avant le délai', async () => {
    const actions: Array<{ action: string; elapsedMs: number }> = [];
    const watchdog = new SessionWatchdog({
      submittingTimeoutMs: 500,
      onAction: (action, elapsedMs) => actions.push({ action, elapsedMs }),
    });
    watchdog.start();
    watchdog.setState('SUBMITTING');
    await sleep(50);
    watchdog.check();
    watchdog.stop();

    assert.strictEqual(actions.length, 0);
  });

  it('détecte une session inactive (stale_session)', async () => {
    const actions: Array<{ action: string; elapsedMs: number }> = [];
    const watchdog = new SessionWatchdog({
      staleTimeoutMs: 1,
      onAction: (action, elapsedMs) => actions.push({ action, elapsedMs }),
    });
    watchdog.start();
    await sleep(10);
    watchdog.check();
    watchdog.stop();

    assert.strictEqual(actions.length >= 1, true);
    assert.strictEqual(actions[0].action, 'stale_session');
  });

  it('reset bumpActivity repousse stale_session', async () => {
    const actions: Array<{ action: string; elapsedMs: number }> = [];
    const watchdog = new SessionWatchdog({
      staleTimeoutMs: 80,
      onAction: (action, elapsedMs) => actions.push({ action, elapsedMs }),
    });
    watchdog.start();
    await sleep(50);
    watchdog.bumpActivity();
    await sleep(50);
    watchdog.check();
    watchdog.stop();

    assert.strictEqual(actions.length, 0);
  });
});
