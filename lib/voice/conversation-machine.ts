export type ConversationState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'user_speaking'
  | 'processing'
  | 'assistant_speaking'
  | 'tool_running'
  | 'interrupted'
  | 'recovering'
  | 'disconnected'
  | 'error';

type SendEvent = (event: object) => boolean;

type QueuedAction =
  | { kind: 'response.create'; response?: object }
  | { kind: 'tool.output'; callId: string; output: string };

export class ConversationMachine {
  private state: ConversationState = 'idle';
  private activeResponse = false;
  private responseCreatePending = false;
  private toolCallsRunning = 0;
  private queue: QueuedAction[] = [];
  private responseId: string | null = null;
  private lastUserMessageQueuedAt = 0;

  get currentState() {
    return this.state;
  }

  get isResponseActive() {
    return this.activeResponse || this.responseCreatePending;
  }

  get activeResponseId() {
    return this.responseId;
  }

  get hasRunningTool() {
    return this.toolCallsRunning > 0;
  }

  setState(state: ConversationState) {
    this.state = state;
  }

  connect() {
    this.state = 'connecting';
  }

  connected() {
    this.state = 'listening';
  }

  sendUserMessage(send: SendEvent, message: string) {
    this.lastUserMessageQueuedAt = Date.now();
    if (this.isResponseActive || this.hasRunningTool) {
      if (this.activeResponse || this.responseCreatePending) {
        send({ type: 'response.cancel' });
      }
      this.activeResponse = false;
      this.responseCreatePending = false;
      this.responseId = null;
      this.queue = this.queue.filter((action) => action.kind !== 'response.create');
      this.state = 'interrupted';
    }

    send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] },
    });
    this.requestResponse(send);
  }

  requestResponse(send: SendEvent, response?: object): boolean {
    if (this.isResponseActive || this.hasRunningTool) {
      this.queue.push({ kind: 'response.create', response });
      return false;
    }
    const sent = send({ type: 'response.create', ...(response ? { response } : {}) });
    if (sent) {
      this.responseCreatePending = true;
      this.state = 'processing';
    }
    return sent;
  }

  onResponseCreated(responseId: string) {
    this.responseCreatePending = false;
    this.activeResponse = true;
    this.responseId = responseId;
    this.state = 'assistant_speaking';
  }

  onAudioDelta() {
    if (this.state === 'processing' || this.state === 'assistant_speaking') {
      this.state = 'assistant_speaking';
    }
  }

  onToolCallStarted() {
    this.toolCallsRunning += 1;
    this.state = 'tool_running';
  }

  onToolCallFinished(send: SendEvent, callId: string, output: string) {
    this.toolCallsRunning = Math.max(0, this.toolCallsRunning - 1);
    // On envoie le résultat immédiatement, puis on redemande une réponse si aucun autre outil n'est en cours.
    send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    if (this.toolCallsRunning === 0) {
      this.activeResponse = false;
      this.responseId = null;
      this.requestResponse(send);
    }
  }

  onResponseDone(send: SendEvent, status: 'completed' | 'cancelled' | 'failed' | 'incomplete' | string) {
    this.activeResponse = false;
    this.responseCreatePending = false;
    this.responseId = null;

    if (status === 'cancelled') {
      this.state = 'interrupted';
    } else if (status === 'failed') {
      this.state = 'error';
    } else {
      this.state = 'listening';
    }

    this.flushQueue(send);
  }

  onSpeechStarted(send: SendEvent) {
    if (this.isResponseActive) {
      send({ type: 'response.cancel' });
    }
    this.activeResponse = false;
    this.responseCreatePending = false;
    this.responseId = null;
    this.queue = this.queue.filter((action) => action.kind !== 'response.create');
    this.state = 'user_speaking';
  }

  onSpeechStopped() {
    if (this.state === 'user_speaking') {
      this.state = 'listening';
    }
  }

  private flushQueue(send: SendEvent) {
    const next = this.queue.shift();
    if (!next) return;
    if (next.kind === 'response.create') {
      this.requestResponse(send, next.response);
    }
  }

  reset() {
    this.state = 'idle';
    this.activeResponse = false;
    this.responseCreatePending = false;
    this.toolCallsRunning = 0;
    this.queue = [];
    this.responseId = null;
    this.lastUserMessageQueuedAt = 0;
  }

  startRecovery() {
    this.state = 'recovering';
  }

  markError() {
    this.state = 'error';
  }

  markDisconnected() {
    this.state = 'disconnected';
  }
}
