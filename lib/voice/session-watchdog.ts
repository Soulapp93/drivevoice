/**
 * Watchdog de session vocale.
 * Détecte les états bloqués (SUBMITTING, DISPLAYING_RESULT, ERROR persistant)
 * et déclenche des actions de recovery déterministes.
 */

export type WatchdogAction =
  | 'submit_timeout'
  | 'display_timeout'
  | 'error_recovery'
  | 'stale_session';

export interface WatchdogOptions {
  submittingTimeoutMs?: number;
  displayTimeoutMs?: number;
  errorTimeoutMs?: number;
  staleTimeoutMs?: number;
  onAction?: (action: WatchdogAction, elapsedMs: number) => void;
}

type StateTimestamp = {
  state: string;
  enteredAt: number;
};

export class SessionWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private options: Required<Pick<WatchdogOptions, 'submittingTimeoutMs' | 'displayTimeoutMs' | 'errorTimeoutMs' | 'staleTimeoutMs'>>;
  private onAction: (action: WatchdogAction, elapsedMs: number) => void;
  private currentState: StateTimestamp | null = null;
  private lastActivityAt: number = Date.now();
  private isRunning = false;

  constructor(options: WatchdogOptions = {}) {
    this.options = {
      submittingTimeoutMs: options.submittingTimeoutMs ?? 15_000,
      displayTimeoutMs: options.displayTimeoutMs ?? 15_000,
      errorTimeoutMs: options.errorTimeoutMs ?? 30_000,
      staleTimeoutMs: options.staleTimeoutMs ?? 120_000,
    };
    this.onAction = options.onAction ?? (() => {});
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastActivityAt = Date.now();
    this.timer = setInterval(() => this.check(), 1_000);
    // Check immédiat pour les tests et la réactivité
    this.check();
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  setState(state: string) {
    this.currentState = { state, enteredAt: Date.now() };
    this.bumpActivity();
  }

  clearState() {
    this.currentState = null;
    this.bumpActivity();
  }

  bumpActivity() {
    this.lastActivityAt = Date.now();
  }

  check() {
    const now = Date.now();

    // Détection session inactive (pas d'activité du tout)
    const idleMs = now - this.lastActivityAt;
    if (idleMs > this.options.staleTimeoutMs) {
      this.onAction('stale_session', idleMs);
      this.bumpActivity(); // éviter spam
      return;
    }

    if (!this.currentState) return;

    const elapsedMs = now - this.currentState.enteredAt;

    switch (this.currentState.state) {
      case 'SUBMITTING':
        if (elapsedMs > this.options.submittingTimeoutMs) {
          this.onAction('submit_timeout', elapsedMs);
          this.bumpActivity();
        }
        break;
      case 'DISPLAYING_RESULT':
        if (elapsedMs > this.options.displayTimeoutMs) {
          this.onAction('display_timeout', elapsedMs);
          this.bumpActivity();
        }
        break;
      case 'ERROR':
        if (elapsedMs > this.options.errorTimeoutMs) {
          this.onAction('error_recovery', elapsedMs);
          this.bumpActivity();
        }
        break;
    }
  }
}
