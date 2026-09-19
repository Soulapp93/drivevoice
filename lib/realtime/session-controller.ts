export type ConversationState =
  | 'idle'
  | 'listening'
  | 'user_speaking'
  | 'processing'
  | 'tool_running'
  | 'assistant_speaking'
  | 'interrupted'
  | 'recovering'
  | 'disconnected'
  | 'error';

type SendEvent = (event: object) => boolean;

export class RealtimeResponseController {
  private activeResponse = false;
  private responseCreatePending = false;
  private continuationQueued = false;
  private responseId: string | null = null;
  private currentState: ConversationState = 'idle';

  get state() {
    return this.currentState;
  }

  get isResponseActive() {
    return this.activeResponse || this.responseCreatePending;
  }

  get activeResponseId() {
    return this.responseId;
  }

  setState(state: ConversationState) {
    this.currentState = state;
  }

  requestResponse(send: SendEvent, response?: object) {
    if (this.activeResponse || this.responseCreatePending) {
      this.continuationQueued = true;
      return false;
    }
    const sent = send({ type: 'response.create', ...(response ? { response } : {}) });
    if (sent) {
      this.responseCreatePending = true;
      this.currentState = 'processing';
    }
    return sent;
  }

  onResponseCreated(responseId: string | null | undefined) {
    this.responseCreatePending = false;
    this.activeResponse = true;
    this.responseId = responseId ?? null;
    this.currentState = 'assistant_speaking';
  }

  onAudioDelta() {
    this.currentState = 'assistant_speaking';
  }

  onToolStarted() {
    this.currentState = 'tool_running';
  }

  onToolFinished() {
    if (this.activeResponse) this.currentState = 'processing';
  }

  onResponseTerminal(send: SendEvent, status: string | undefined) {
    this.activeResponse = false;
    this.responseCreatePending = false;
    this.responseId = null;
    const shouldContinue = this.continuationQueued;
    this.continuationQueued = false;
    this.currentState = status === 'cancelled' ? 'interrupted' : 'listening';
    if (shouldContinue) return this.requestResponse(send);
    return false;
  }

  onSpeechStarted(send: SendEvent) {
    if (this.activeResponse || this.responseCreatePending) {
      send({ type: 'response.cancel' });
    }
    this.activeResponse = false;
    this.responseCreatePending = false;
    this.responseId = null;
    this.continuationQueued = false;
    this.currentState = 'user_speaking';
  }

  cancel(send: SendEvent) {
    if (this.activeResponse || this.responseCreatePending) send({ type: 'response.cancel' });
    this.activeResponse = false;
    this.responseCreatePending = false;
    this.responseId = null;
    this.continuationQueued = false;
    this.currentState = 'interrupted';
  }

  reset() {
    this.activeResponse = false;
    this.responseCreatePending = false;
    this.continuationQueued = false;
    this.responseId = null;
    this.currentState = 'idle';
  }
}