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
const DEFAULT_RESPONSE = { output_modalities: ['audio'] };

type QueuedAction =
  | { kind: 'response.create'; response?: object; priority: number }
  | { kind: 'tool.output'; callId: string; output: string; priority: number };

export type ResponseLifecycle = 'idle' | 'creating' | 'active' | 'completing';

export class ConversationMachine {
  private state: ConversationState = 'idle';
  private responseLifecycle: ResponseLifecycle = 'idle';
  private toolCallsRunning = 0;
  private queue: QueuedAction[] = [];
  private responseId: string | null = null;
  private lastUserMessageQueuedAt = 0;

  get currentState() {
    return this.state;
  }

  get isResponseActive() {
    return this.responseLifecycle !== 'idle';
  }

  get activeResponseId() {
    return this.responseId;
  }

  get hasRunningTool() {
    return this.toolCallsRunning > 0;
  }

  get lifecycle() {
    return this.responseLifecycle;
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
      if (this.responseLifecycle === 'active') {
        this.cancelActiveResponse(send);
      }
      this.queue = this.queue.filter((action) => action.kind !== 'response.create');
      this.state = 'interrupted';
    }

    send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: message }] },
    });
    this.requestResponse(send, undefined, 0);
  }

  requestResponse(send: SendEvent, response?: object, priority = 10): boolean {
    if (this.responseLifecycle !== 'idle' || this.hasRunningTool) {
      const queuedResponseIndex = this.queue.findIndex((action) => action.kind === 'response.create');
      if (queuedResponseIndex === -1) {
        this.enqueue({ kind: 'response.create', response, priority });
      } else {
        const queuedResponse = this.queue[queuedResponseIndex];
        if (queuedResponse.kind === 'response.create' && priority < queuedResponse.priority) {
          this.queue.splice(queuedResponseIndex, 1);
          this.enqueue({ kind: 'response.create', response, priority });
        }
      }
      return false;
    }
    const sent = send({
      type: 'response.create',
      response: response ?? DEFAULT_RESPONSE,
    });
    if (sent) {
      this.responseLifecycle = 'creating';
      this.state = 'processing';
    }
    return sent;
  }

  onResponseCreated(responseId: string) {
    if (this.responseLifecycle !== 'creating') {
      // Guard: réponse créée sans requestResponse préalable → on ignore.
      return;
    }
    this.responseLifecycle = 'active';
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
    // Le résultat doit partir même si le backend a renvoyé une erreur métier.
    send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output },
    });
    if (this.toolCallsRunning === 0) {
      // La plupart des événements Realtime terminent la réponse après
      // `response.function_call_arguments.done`. On met donc toujours la
      // continuation en file si la réponse productrice est encore active.
      // Elle sera envoyée uniquement après `response.done`.
      this.requestResponse(send, undefined, 5);
    }
  }

  onResponseDone(
    send: SendEvent,
    status: 'completed' | 'cancelled' | 'failed' | 'incomplete' | string,
    responseId?: string,
  ): boolean {
    if (responseId && (this.responseLifecycle === 'idle' || (this.responseId && this.responseId !== responseId))) {
      return false;
    }

    this.responseLifecycle = 'completing';
    this.responseId = null;

    if (status === 'cancelled') {
      this.state = 'interrupted';
    } else if (status === 'failed') {
      this.state = 'error';
    } else {
      this.state = 'listening';
    }

    this.responseLifecycle = 'idle';
    this.flushQueue(send);
    return true;
  }

  onResponseRequestRejected() {
    if (this.responseLifecycle === 'creating') {
      this.responseLifecycle = 'idle';
    }
    if (!this.isResponseActive && !this.hasRunningTool) {
      this.state = 'recovering';
    }
  }

  onCancellationRejected() {
    if (!this.isResponseActive && !this.hasRunningTool) {
      this.state = 'listening';
    }
  }

  onSpeechStarted() {
    // Avec server_vad + interrupt_response, OpenAI annule déjà la réponse
    // lorsqu'il détecte la parole. Un response.cancel ici provoquerait une
    // double annulation et l'erreur "no active response found".
    this.queue = this.queue.filter((action) => action.kind !== 'response.create');
    this.state = 'user_speaking';
  }

  private cancelActiveResponse(send: SendEvent): boolean {
    if (this.responseLifecycle !== 'active') return false;
    const sent = send({ type: 'response.cancel' });
    if (sent) {
      this.state = 'interrupted';
    }
    return sent;
  }

  cancelResponse(send: SendEvent): boolean {
    return this.cancelActiveResponse(send);
  }

  onSpeechStopped() {
    if (this.state === 'user_speaking') {
      this.state = 'listening';
    }
  }

  private enqueue(action: QueuedAction) {
    this.queue.push(action);
    this.queue.sort((a, b) => a.priority - b.priority);
  }

  private flushQueue(send: SendEvent) {
    const next = this.queue.shift();
    if (!next) return;
    if (next.kind === 'response.create') {
      const sent = this.requestResponse(send, next.response, next.priority);
      if (!sent) {
        this.queue.unshift(next);
      }
    }
  }

  reset() {
    this.state = 'idle';
    this.responseLifecycle = 'idle';
    this.toolCallsRunning = 0;
    this.queue = [];
    this.responseId = null;
    this.lastUserMessageQueuedAt = 0;
  }

  resetForReconnect() {
    this.responseLifecycle = 'idle';
    this.toolCallsRunning = 0;
    this.queue = [];
    this.responseId = null;
    this.state = 'listening';
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
