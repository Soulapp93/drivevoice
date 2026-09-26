import { RealtimeAudioSession, type RealtimeEventPayload } from './realtime-audio-session';
import { BasketManager, type CatalogEntry, type OptimisticOperation } from './basket-manager';
import type { BasketSnapshot } from '@/lib/realtime/tool-protocol';
import { logRealtimeEvent, logOrderAudit, type RealtimeLogContext } from '@/lib/realtime/logging';

export type VoiceStatus = {
  connection: 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';
  conversation: 'idle' | 'connecting' | 'listening' | 'user_speaking' | 'assistant_speaking' | 'tool_running' | 'error';
  error?: string;
};

export type VoiceOrchestratorOptions = {
  brand?: string;
  restaurantId?: string;
  conversationId?: string;
  catalog?: CatalogEntry[];
  onStatusChange?: (status: VoiceStatus) => void;
  onBasketUpdate?: (basket: { items: unknown[]; total: number; status: string }) => void;
  onOrderUpdate?: (order: { ref: string; status: 'submitted' | 'failed'; message?: string }) => void;
};

const TOOL_TIMEOUT_MS = 12_000;

function generateTraceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isOrderWrapUpPhrase(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[’']/g, "'")
    .replace(/[.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return [
    "c'est tout",
    'c est tout',
    'cest tout',
    "ca c'est tout",
    'ca c est tout',
    'ca c est tout pour moi',
    "non c'est tout",
    'non c est tout',
    'ca sera tout',
    'ce sera tout',
    "j'ai fini",
    'jai fini',
    'rien d autre',
    'termine',
    'commande complete',
    'c est complet',
  ].some((phrase) => normalized.includes(phrase));
}

export function isExplicitOrderConfirmation(text: string): boolean {
  const normalized = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[’']/g, "'")
    .replace(/[.,!?;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return [
    'oui',
    'oui je confirme',
    'je confirme',
    'd accord',
    "c'est bon",
    'c est bon',
    'valider',
    'validez',
    'envoyer',
    'allez y',
    'c est valide',
  ].some((phrase) => normalized === phrase || normalized.startsWith(`${phrase} `));
}

export class VoiceOrchestrator {
  private session: RealtimeAudioSession;
  private basket: BasketManager;
  private options: VoiceOrchestratorOptions;
  private audioElement: HTMLAudioElement | null = null;
  private currentStatus: VoiceStatus = { connection: 'idle', conversation: 'idle' };
  private pendingToolCalls = new Map<string, { name: string; args: string }>();
  private handledToolCalls = new Set<string>();
  private responseActive = false;
  private toolContinuationPending = false;
  private connectionEpoch = 0;
  private traceId: string;
  private greetingSent = false;

  constructor(options: VoiceOrchestratorOptions = {}) {
    this.options = options;
    this.traceId = generateTraceId();
    this.basket = new BasketManager(options.restaurantId ?? 'unknown', options.catalog ?? []);
    this.basket.onChange((snapshot) => {
      this.options.onBasketUpdate?.({ items: snapshot.items, total: snapshot.total, status: snapshot.status });
    });
    this.session = new RealtimeAudioSession({
      brand: options.brand,
      restaurantId: options.restaurantId,
      conversationId: options.conversationId,
      onEvent: (payload) => this.handleEvent(payload),
    });
  }

  updateConfig(options: Partial<VoiceOrchestratorOptions>) {
    this.options = { ...this.options, ...options };
    if (options.catalog) {
      this.basket.setCatalog(options.catalog);
    }
    this.session.updateConfig({
      brand: this.options.brand,
      restaurantId: this.options.restaurantId,
      conversationId: this.options.conversationId,
    });
  }

  private log(event: string, extra: Omit<RealtimeLogContext, 'traceId' | 'restaurantId' | 'sessionId'> = {}) {
    logRealtimeEvent(event, {
      traceId: this.traceId,
      restaurantId: this.options.restaurantId,
      sessionId: this.session.sessionToken,
      ...extra,
    });
  }

  private updateStatus(partial: Partial<VoiceStatus>) {
    this.currentStatus = { ...this.currentStatus, ...partial };
    this.options.onStatusChange?.(this.currentStatus);
  }

  private handleEvent(payload: RealtimeEventPayload) {
    switch (payload.type) {
      case 'open': {
        this.connectionEpoch += 1;
        this.updateStatus({ connection: 'connected', error: undefined });
        this.log('session.open');
        if (!this.greetingSent) {
          this.greetingSent = true;
          this.requestResponse();
        }
        break;
      }
      case 'close':
      case 'error': {
        this.log('session.error', { errorType: payload.type, errorCode: payload.error instanceof Error ? payload.error.message : 'unknown' });
        this.handleConnectionError(payload.error instanceof Error ? payload.error.message : 'Erreur de connexion audio');
        break;
      }
      case 'realtime_error': {
        const message = payload.error instanceof Error ? payload.error.message : 'Erreur Realtime reçue.';
        this.log('realtime.error', { errorType: message });
        this.updateStatus({ error: message });
        break;
      }
      case 'audio_playback_error':
        this.log('audio.playback_error', { errorType: payload.error instanceof Error ? payload.error.message : 'unknown' });
        this.updateStatus({ error: "Le navigateur a bloqué la lecture audio. Touchez l'écran puis relancez." });
        break;
      case 'connection_state_change': {
        if (payload.state === 'connected') {
          this.updateStatus({ connection: 'connected', error: undefined });
        } else if (payload.state === 'failed' || payload.state === 'closed') {
          this.log('connection.lost', { status: payload.state });
          this.handleConnectionError('Connexion audio interrompue.');
        }
        break;
      }
      case 'input_audio_buffer.speech_started': {
        this.responseActive = false;
        this.updateStatus({ conversation: 'user_speaking' });
        this.log('speech.started');
        break;
      }
      case 'input_audio_buffer.speech_stopped': {
        this.updateStatus({ conversation: 'listening' });
        this.log('speech.stopped');
        // create_response: true côté serveur : OpenAI déclenche la réponse
        // automatiquement après chaque tour de parole. Le client n'intervient pas.
        break;
      }
      case 'response.created': {
        this.responseActive = true;
        this.updateStatus({ conversation: 'assistant_speaking', error: undefined });
        this.log('response.created', { responseId: payload.responseId });
        break;
      }
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        this.updateStatus({ conversation: 'assistant_speaking' });
        break;
      }
      case 'response.output_item.added': {
        const item = payload.item as { type?: string; name?: string; arguments?: string; call_id?: string } | undefined;
        if (item?.type === 'function_call') {
          this.pendingToolCalls.set(payload.callId ?? item.call_id ?? '', { name: item.name ?? '', args: item.arguments ?? '' });
        }
        break;
      }
      case 'response.output_item.done':
      case 'response.function_call_arguments.done': {
        const callId = payload.callId ?? '';
        if (!callId || this.handledToolCalls.has(callId)) break;
        const pending = this.pendingToolCalls.get(callId);
        const completedItem = payload.item as { name?: string; arguments?: string } | undefined;
        const name = completedItem?.name || pending?.name || '';
        const args = completedItem?.arguments || pending?.args || '';
        if (!name) break;
        this.pendingToolCalls.delete(callId);
        this.handledToolCalls.add(callId);
        this.updateStatus({ conversation: 'tool_running' });
        this.log('tool.started', { tool: name, callId });
        const optimisticOperation = this.buildOptimisticOperation(name, args);
        if (optimisticOperation) {
          this.basket.applyOptimisticOperation(callId, optimisticOperation);
        }
        void this.executeTool(callId, name, args);
        break;
      }
      case 'response.done':
      case 'response.cancelled':
      case 'response.failed': {
        this.responseActive = false;
        const status = payload.type === 'response.cancelled'
          ? 'cancelled'
          : payload.type === 'response.failed'
            ? 'failed'
            : 'completed';
        const rawResponse = payload.raw as {
          response?: {
            status?: string;
            status_details?: { error?: { message?: string }; reason?: string };
          };
          status?: string;
          status_details?: { error?: { message?: string }; reason?: string };
        } | undefined;
        const responseStatus = rawResponse?.response?.status ?? rawResponse?.status;
        const responseError = rawResponse?.response?.status_details?.error?.message
          ?? rawResponse?.status_details?.error?.message
          ?? (responseStatus === 'incomplete' ? 'La réponse vocale a été interrompue.' : undefined);
        this.log('response.done', { responseId: payload.responseId, status: responseStatus ?? status, errorType: responseError });
        this.updateStatus({
          conversation: 'listening',
          error: responseStatus === 'failed' || responseStatus === 'incomplete' ? responseError ?? "La réponse vocale n'a pas abouti." : undefined,
        });
        if (this.toolContinuationPending) {
          this.toolContinuationPending = false;
          this.requestResponse();
        }
        break;
      }
      default:
        break;
    }
  }

  private requestResponse(response?: object) {
    if (this.responseActive || this.currentStatus.conversation === 'user_speaking') return;
    this.session.send({ type: 'response.create', response: response ?? { output_modalities: ['audio'] } });
  }

  private async executeTool(callId: string, name: string, args: string) {
    const token = this.session.sessionToken;
    const epoch = this.connectionEpoch;
    const startedAt = Date.now();
    if (!token) {
      this.basket.rollbackOperation(callId);
      this.sendToolOutput(callId, { success: false, errorCode: 'UNAUTHORIZED', message: 'Session non authentifiée.', retryable: false });
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);

    try {
      const response = await fetch('/api/voice/tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, callId, tool: name, arguments: args }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const body = await response.json().catch(() => ({
        output: JSON.stringify({ success: false, errorCode: 'INVALID_RESPONSE', message: 'Réponse du serveur invalide.', retryable: true }),
      })) as { output?: string; result?: { success?: boolean; message?: string; data?: { items?: unknown[]; total?: number; status?: string; ref?: string; orderId?: string | null } } };

      if (epoch !== this.connectionEpoch) {
        this.basket.rollbackOperation(callId);
        return;
      }

      if (name === 'submit_order') {
        if (body.result?.success && body.result.data?.ref) {
          this.options.onOrderUpdate?.({ ref: body.result.data.ref, status: 'submitted', message: body.result.message });
          this.log('order.submitted', { tool: name, callId, durationMs: Date.now() - startedAt });
          if (this.options.conversationId && this.options.restaurantId) {
            logOrderAudit(this.options.conversationId, this.options.restaurantId, 'order.submitted', { ref: body.result.data.ref, callId });
          }
        } else {
          this.options.onOrderUpdate?.({ ref: '', status: 'failed', message: body.result?.message ?? "La commande n'a pas pu être transmise." });
          this.log('order.failed', { tool: name, callId, errorCode: 'SUBMIT_FAILED', durationMs: Date.now() - startedAt });
        }
      }

      if (body.result?.success && body.result?.data && body.result.data.items) {
        this.basket.applyServerSnapshot(body.result.data as BasketSnapshot);
      } else if (name !== 'submit_order') {
        this.basket.rollbackOperation(callId);
      }

      this.log('tool.completed', { tool: name, callId, status: body.result?.success ? 'success' : 'failure', durationMs: Date.now() - startedAt });
      const toolResult = body.result
        ? { ...body.result, success: body.result.success ?? false }
        : { success: false, errorCode: 'INVALID_RESPONSE', message: 'Réponse du serveur invalide.', retryable: true };
      this.sendToolOutput(callId, toolResult);

      // Une seule continuation vocale, après la fin de la réponse qui a
      // produit l'appel outil.
      if (this.responseActive) {
        this.toolContinuationPending = true;
      } else {
        this.requestResponse();
      }
    } catch {
      clearTimeout(timeout);
      this.log('tool.timeout', { tool: name, callId, errorCode: 'TOOL_TIMEOUT', durationMs: Date.now() - startedAt });
      this.basket.rollbackOperation(callId);
      this.sendToolOutput(callId, { success: false, errorCode: 'TOOL_TIMEOUT', message: 'La vérification du panier a pris trop de temps. Propose au client de réessayer.', retryable: true });
      if (this.responseActive) {
        this.toolContinuationPending = true;
      } else {
        this.requestResponse();
      }
    }
  }

  private sendToolOutput(callId: string, result: { success: boolean; errorCode?: string; message?: string; retryable?: boolean; data?: unknown }) {
    this.session.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) },
    });
  }

  private buildOptimisticOperation(name: string, args: string): OptimisticOperation | null {
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      const productId = typeof parsed.product_id === 'string' ? parsed.product_id.trim() : '';

      if (name === 'add_item' && productId) {
        const quantity = Number(parsed.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) return null;
        return { kind: 'add', productId, quantity, customizations: this.extractCustomizations(parsed.selections) };
      }
      if (name === 'remove_item' && productId) {
        return { kind: 'remove', productId, ...(parsed.quantity !== undefined ? { quantity: Number(parsed.quantity) } : {}) };
      }
      if (name === 'update_item_quantity' && productId) {
        const quantity = Number(parsed.quantity);
        if (!Number.isInteger(quantity) || quantity < 0) return null;
        return { kind: 'set_quantity', productId, quantity };
      }
    } catch {
      // ignore
    }
    return null;
  }

  private extractCustomizations(selections: unknown): string[] | undefined {
    if (!Array.isArray(selections)) return undefined;
    const labels: string[] = [];
    for (const selection of selections) {
      if (typeof selection !== 'object' || selection === null || Array.isArray(selection)) continue;
      const group = typeof (selection as Record<string, unknown>).group === 'string' ? (selection as Record<string, unknown>).group : '';
      const options = Array.isArray((selection as Record<string, unknown>).options)
        ? (selection as Record<string, unknown>).options as unknown[]
        : [];
      for (const option of options) {
        if (typeof option === 'string' && option.trim()) {
          labels.push(`${group}: ${option.trim()}`);
        }
      }
    }
    return labels.length > 0 ? labels : undefined;
  }

  private handleConnectionError(message: string) {
    this.updateStatus({ connection: 'error', conversation: 'error', error: message });
  }

  async start(audioElement?: HTMLAudioElement): Promise<boolean> {
    if (this.currentStatus.connection === 'connected' || this.currentStatus.connection === 'connecting') {
      return this.currentStatus.connection === 'connected';
    }
    if (audioElement) this.audioElement = audioElement;
    this.updateStatus({ connection: 'connecting', conversation: 'connecting', error: undefined });
    try {
      await this.session.start(this.audioElement ?? undefined);
      return true;
    } catch (error) {
      this.updateStatus({
        connection: 'error',
        conversation: 'error',
        error: error instanceof Error ? error.message : "Impossible d'accéder au microphone.",
      });
      return false;
    }
  }

  stop() {
    this.connectionEpoch += 1;
    this.session.stop();
    this.responseActive = false;
    this.toolContinuationPending = false;
    this.pendingToolCalls.clear();
    this.handledToolCalls.clear();
    this.greetingSent = false;
    this.audioElement = null;
    this.updateStatus({ connection: 'idle', conversation: 'idle', error: undefined });
  }

  sendText(text: string) {
    this.session.send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    this.requestResponse();
  }

  interrupt() {
    this.session.send({ type: 'response.cancel' });
    this.updateStatus({ conversation: 'user_speaking' });
  }

  confirmOrder() {
    this.submitOrder();
  }

  submitOrder() {
    const token = this.session.sessionToken;
    const snapshot = this.basket.getSnapshot();
    if (!token) {
      this.options.onOrderUpdate?.({ ref: '', status: 'failed', message: "La session vocale n'est pas authentifiée." });
      return;
    }
    if (snapshot.items.length === 0) {
      this.options.onOrderUpdate?.({ ref: '', status: 'failed', message: 'Le panier est vide.' });
      return;
    }

    const epoch = this.connectionEpoch;
    const callId = `confirm-${generateTraceId()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);

    void fetch('/api/voice/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, callId, tool: 'submit_order', arguments: JSON.stringify({ confirmation: 'explicit' }) }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({})) as {
          result?: { success?: boolean; message?: string; data?: { ref?: string } };
        };
        if (epoch !== this.connectionEpoch) return;
        if (body.result?.success && body.result.data?.ref) {
          this.options.onOrderUpdate?.({ ref: body.result.data.ref, status: 'submitted', message: body.result.message });
          this.log('order.submitted', { tool: 'submit_order', callId });
          if (this.options.conversationId && this.options.restaurantId) {
            logOrderAudit(this.options.conversationId, this.options.restaurantId, 'order.submitted', { ref: body.result.data.ref, callId });
          }
        } else {
          this.options.onOrderUpdate?.({ ref: '', status: 'failed', message: body.result?.message ?? "La commande n'a pas pu être transmise." });
          this.log('order.failed', { tool: 'submit_order', callId, errorCode: 'SUBMIT_FAILED' });
        }
      })
      .catch(() => {
        if (epoch !== this.connectionEpoch) return;
        this.options.onOrderUpdate?.({ ref: '', status: 'failed', message: 'La transmission au restaurant a pris trop de temps. Réessayez.' });
        this.log('order.failed', { tool: 'submit_order', callId, errorCode: 'SUBMIT_TIMEOUT' });
      })
      .finally(() => {
        clearTimeout(timeout);
      });
  }

  resetForNextCustomer() {
    this.stop();
    this.basket.reset();
  }

  get status() {
    return this.currentStatus;
  }

}
