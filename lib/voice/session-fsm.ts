/**
 * Machine d'états finie (FSM) pour la session vocale DriveVoice.
 * Garantit des transitions déterministes et traçables entre les états de session.
 */

export type SessionState =
  | 'IDLE'
  | 'CONNECTING'
  | 'LISTENING'
  | 'CONFIRMING'
  | 'SUBMITTING'
  | 'DISPLAYING_RESULT'
  | 'RESETTING'
  | 'ERROR';

export type SessionEvent =
  | 'START_REQUESTED'
  | 'CONNECTION_OPENED'
  | 'CONNECTION_FAILED'
  | 'CONFIRM_INTENT_CALLED'
  | 'CLIENT_CONFIRMED'
  | 'CLIENT_CANCELLED'
  | 'SUBMIT_STARTED'
  | 'SUBMIT_SUCCEEDED'
  | 'SUBMIT_FAILED'
  | 'DISPLAY_TIMER_ELAPSED'
  | 'RESET_COMPLETED'
  | 'RECOVERY_TRIGGERED';

export interface TransitionLog {
  from: SessionState;
  to: SessionState;
  event: SessionEvent;
  timestamp: number;
  conversationId?: string;
}

type TransitionMap = Record<SessionState, Partial<Record<SessionEvent, SessionState>>>;

const TRANSITIONS: TransitionMap = {
  IDLE: {
    START_REQUESTED: 'CONNECTING',
  },
  CONNECTING: {
    CONNECTION_OPENED: 'LISTENING',
    CONNECTION_FAILED: 'ERROR',
  },
  LISTENING: {
    CONFIRM_INTENT_CALLED: 'CONFIRMING',
    CONNECTION_FAILED: 'ERROR',
  },
  CONFIRMING: {
    CLIENT_CONFIRMED: 'SUBMITTING',
    CLIENT_CANCELLED: 'LISTENING',
    CONNECTION_FAILED: 'ERROR',
  },
  SUBMITTING: {
    SUBMIT_SUCCEEDED: 'DISPLAYING_RESULT',
    SUBMIT_FAILED: 'ERROR',
    CONNECTION_FAILED: 'ERROR',
  },
  DISPLAYING_RESULT: {
    DISPLAY_TIMER_ELAPSED: 'RESETTING',
    RESET_COMPLETED: 'IDLE',
    CONNECTION_FAILED: 'ERROR',
  },
  RESETTING: {
    RESET_COMPLETED: 'IDLE',
  },
  ERROR: {
    RECOVERY_TRIGGERED: 'LISTENING',
    RESET_COMPLETED: 'IDLE',
  },
};

export class SessionFSM {
  private currentState: SessionState = 'IDLE';
  private conversationId?: string;
  private onTransition?: (log: TransitionLog) => void;

  constructor(options?: { conversationId?: string; onTransition?: (log: TransitionLog) => void }) {
    this.conversationId = options?.conversationId;
    this.onTransition = options?.onTransition;
  }

  get state(): SessionState {
    return this.currentState;
  }

  canTransition(event: SessionEvent): boolean {
    const nextState = TRANSITIONS[this.currentState]?.[event];
    return nextState !== undefined;
  }

  transition(event: SessionEvent): SessionState {
    const nextState = TRANSITIONS[this.currentState]?.[event];
    if (nextState === undefined) {
      throw new Error(
        `Invalid FSM transition: ${this.currentState} --[${event}]--> ? (allowed: ${Object.keys(TRANSITIONS[this.currentState] || {}).join(', ') || 'none'})`
      );
    }

    const log: TransitionLog = {
      from: this.currentState,
      to: nextState,
      event,
      timestamp: Date.now(),
      conversationId: this.conversationId,
    };

    this.currentState = nextState;
    this.onTransition?.(log);

    return nextState;
  }

  forceState(state: SessionState, reason?: string): void {
    const log: TransitionLog = {
      from: this.currentState,
      to: state,
      event: 'RECOVERY_TRIGGERED',
      timestamp: Date.now(),
      conversationId: this.conversationId,
    };
    this.currentState = state;
    this.onTransition?.({ ...log, event: `FORCE:${reason || 'manual'}` as SessionEvent });
  }

  reset(conversationId?: string): void {
    this.currentState = 'IDLE';
    if (conversationId) {
      this.conversationId = conversationId;
    }
  }

  toJSON(): { state: SessionState; conversationId?: string } {
    return { state: this.currentState, conversationId: this.conversationId };
  }
}
