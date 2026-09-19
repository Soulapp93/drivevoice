import { RealtimeAudioSession, type RealtimeEventPayload } from './realtime-audio-session';
import { ConversationMachine, type ConversationState } from './conversation-machine';
import { BasketManager, type CatalogEntry, type OptimisticOperation } from './basket-manager';
import type { BasketSnapshot } from '@/lib/realtime/tool-protocol';

export type TranscriptMessage = {
  id: string;
  speaker: 'client' | 'agent';
  text: string;
  status: 'partial' | 'final';
  timestamp: number;
};

export type VoiceStatus = {
  connection: 'idle' | 'connecting' | 'connected' | 'error' | 'disconnected';
  conversation: ConversationState;
  error?: string;
};

export type VoiceOrchestratorOptions = {
  brand?: string;
  restaurantId?: string;
  conversationId?: string;
  catalog?: CatalogEntry[];
  onStatusChange?: (status: VoiceStatus) => void;
  onTranscriptUpdate?: (messages: TranscriptMessage[]) => void;
  onBasketUpdate?: (basket: { items: unknown[]; total: number; status: string }) => void;
  onOrderUpdate?: (order: { ref: string; status: 'submitted' | 'failed'; message?: string }) => void;
};

const TOOL_TIMEOUT_MS = 10_000;

export type ResponseStatus = 'completed' | 'cancelled' | 'failed' | 'incomplete';

export function extractResponseStatus(raw: unknown): ResponseStatus {
  const event = raw as { response?: { status?: unknown }; status?: unknown } | null | undefined;
  const value = event?.response?.status ?? event?.status;
  if (value === 'completed' || value === 'cancelled' || value === 'failed' || value === 'incomplete') {
    return value;
  }
  return 'completed';
}

export function extractStatusDetails(raw: unknown): { reason?: string } | undefined {
  const event = raw as { response?: { status_details?: { reason?: string } } } | null | undefined;
  return event?.response?.status_details;
}

export class VoiceOrchestrator {
  private session: RealtimeAudioSession;
  private machine: ConversationMachine;
  private basket: BasketManager;
  private transcriptMessages = new Map<string, TranscriptMessage>();
  private nextId = 1;
  private options: VoiceOrchestratorOptions;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryInFlight = false;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private responseStartedAt: number | null = null;
  private lastAudioActivityAt = 0;
  private audioElement: HTMLAudioElement | null = null;
  private currentStatus: VoiceStatus = { connection: 'idle', conversation: 'idle' };
  private pendingToolCalls = new Map<string, { name: string; args: string }>();
  private handledToolCalls = new Set<string>();
  private agentTranscriptBuffer = new Map<string, string>();
  private greetingSent = false;

  constructor(options: VoiceOrchestratorOptions = {}) {
    this.options = options;
    this.machine = new ConversationMachine();
    this.basket = new BasketManager(
      options.restaurantId ?? 'unknown',
      options.catalog ?? [],
    );
    this.basket.onChange((snapshot) => {
      this.options.onBasketUpdate?.({
        items: snapshot.items,
        total: snapshot.total,
        status: snapshot.status,
      });
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

  private updateStatus(partial: Partial<VoiceStatus>) {
    this.currentStatus = { ...this.currentStatus, ...partial };
    this.options.onStatusChange?.(this.currentStatus);
  }

  private upsertTranscript(id: string, speaker: 'client' | 'agent', text: string, status: 'partial' | 'final') {
    const normalized = text.trim();
    if (!normalized) return;
    const now = Date.now();

    for (const [existingId, existing] of this.transcriptMessages.entries()) {
      const isRecent = now - existing.timestamp < 15_000;
      const isSameSpeaker = existing.speaker === speaker;
      const isDuplicate =
        existing.text === normalized ||
        (status === 'final' && existing.status === 'partial' && (normalized.startsWith(existing.text) || existing.text.startsWith(normalized)));
      if (existingId !== id && isRecent && isSameSpeaker && isDuplicate) {
        this.transcriptMessages.delete(existingId);
      }
    }

    this.transcriptMessages.set(id, { id, speaker, text: normalized, status, timestamp: now });
    this.options.onTranscriptUpdate?.(Array.from(this.transcriptMessages.values()).sort((a, b) => a.timestamp - b.timestamp));
  }

  private handleEvent(payload: RealtimeEventPayload) {
    switch (payload.type) {
      case 'open':
        this.updateStatus({ connection: 'connected', error: undefined });
        this.machine.connected();
        this.startWatchdog();
        if (!this.greetingSent) {
          this.greetingSent = true;
          this.machine.requestResponse((event) => this.session.send(event));
          this.updateStatus({ conversation: this.machine.currentState });
        }
        break;
      case 'close':
      case 'error':
        this.handleConnectionError(payload.error instanceof Error ? payload.error.message : 'Erreur de connexion audio');
        break;
      case 'realtime_error': {
        const message = payload.error instanceof Error ? payload.error.message : 'Erreur Realtime reçue.';
        console.warn('[voice] realtime protocol error', message);
        const lower = message.toLowerCase();
        const benign = lower.includes('response not in progress') || lower.includes('no response in progress') || lower.includes('already in progress') || lower.includes('conversation already has a response');
        if (!benign) {
          this.updateStatus({ error: "Une vérification a échoué. L'agent continue la conversation." });
        }
        break;
      }
      case 'audio_playback_error':
        this.updateStatus({
          error: "Le navigateur a bloqué la lecture audio. Touchez l'écran puis relancez la conversation.",
        });
        break;
      case 'connection_state_change':
        if (payload.state === 'failed' || payload.state === 'disconnected' || payload.state === 'closed') {
          this.handleConnectionError('Connexion audio interrompue.');
        }
        break;
      case 'input_audio_buffer.speech_started':
        this.machine.onSpeechStarted((event) => this.session.send(event));
        this.updateStatus({ conversation: this.machine.currentState });
        break;
      case 'input_audio_buffer.speech_stopped':
        this.machine.onSpeechStopped();
        this.updateStatus({ conversation: this.machine.currentState });
        break;
      case 'conversation.item.created': {
        const item = payload.item as { role?: string; content?: Array<{ type?: string; transcript?: string; text?: string }> } | undefined;
        if (item?.role === 'user') {
          const text = item.content?.map((c) => c.transcript || c.text).filter(Boolean).join(' ');
          if (text) this.upsertTranscript(`user-${this.nextId++}`, 'client', text, 'final');
        }
        break;
      }
      case 'response.created':
        this.machine.onResponseCreated(payload.responseId ?? `resp-${Date.now()}`);
        this.responseStartedAt = Date.now();
        this.lastAudioActivityAt = Date.now();
        this.updateStatus({ conversation: this.machine.currentState, error: undefined });
        break;
      case 'response.output_audio.delta':
        this.machine.onAudioDelta();
        this.lastAudioActivityAt = Date.now();
        this.updateStatus({ conversation: this.machine.currentState });
        break;
      case 'response.output_item.added': {
        const item = payload.item as { type?: string; name?: string; arguments?: string; call_id?: string } | undefined;
        if (item?.type === 'function_call') {
          this.pendingToolCalls.set(payload.callId ?? item.call_id ?? '', {
            name: item.name ?? '',
            args: item.arguments ?? '',
          });
        }
        break;
      }
      case 'response.function_call_arguments.done': {
        const callId = payload.callId ?? '';
        if (!callId || this.handledToolCalls.has(callId)) break;
        const pending = this.pendingToolCalls.get(callId);
        const completedItem = payload.item as { name?: string; arguments?: string } | undefined;
        const name = completedItem?.name || pending?.name || '';
        const args = completedItem?.arguments || pending?.args || '';
        if (!name) break;
        if (pending) {
          this.pendingToolCalls.delete(callId);
        }
        this.handledToolCalls.add(callId);
        this.machine.onToolCallStarted();
        this.updateStatus({ conversation: this.machine.currentState });
        const optimisticOperation = this.buildOptimisticOperation(name, args);
        if (optimisticOperation) {
          this.basket.applyOptimisticOperation(callId, optimisticOperation);
        }
        void this.executeTool(callId, name, args);
        break;
      }
      case 'response.output_audio.done':
        this.lastAudioActivityAt = Date.now();
        break;
      case 'response.audio_transcript.delta': {
        const responseKey = payload.responseId || 'agent';
        const delta = payload.text ?? '';
        if (!delta) break;
        const accumulated = (this.agentTranscriptBuffer.get(responseKey) ?? '') + delta;
        this.agentTranscriptBuffer.set(responseKey, accumulated);
        this.upsertTranscript(`agent-${responseKey}`, 'agent', accumulated, 'partial');
        break;
      }
      case 'response.audio_transcript.done': {
        const responseKey = payload.responseId || 'agent';
        const finalText = payload.text ?? this.agentTranscriptBuffer.get(responseKey) ?? '';
        this.agentTranscriptBuffer.delete(responseKey);
        if (finalText) this.upsertTranscript(`agent-${responseKey}`, 'agent', finalText, 'final');
        break;
      }
      case 'response.done':
      case 'response.cancelled':
      case 'response.failed': {
        const status = extractResponseStatus(payload.raw);
        const details = extractStatusDetails(payload.raw);
        console.log('[voice/orchestrator] response done', { type: payload.type, status, details, rawKeys: Object.keys(payload.raw || {}) });
        this.responseStartedAt = null;
        this.machine.onResponseDone((event) => this.session.send(event), status);
        if (status === 'failed' || status === 'incomplete') {
          this.updateStatus({
            conversation: this.machine.currentState,
            error: details?.reason === 'max_output_tokens'
              ? "La réponse vocale a été coupée (limite de longueur)."
              : "La réponse vocale n'a pas abouti.",
          });
        } else {
          this.updateStatus({ conversation: this.machine.currentState, error: undefined });
        }
        break;
      }
      default:
        break;
    }
  }

  private buildOptimisticOperation(name: string, args: string): OptimisticOperation | null {
    try {
      const parsed = JSON.parse(args) as Record<string, unknown>;
      const productId = typeof parsed.product_id === 'string' ? parsed.product_id.trim() : '';

      if (name === 'add_item' && productId) {
        const quantity = Number(parsed.quantity);
        if (!Number.isInteger(quantity) || quantity < 1) return null;
        return {
          kind: 'add',
          productId,
          quantity,
          customizations: this.extractCustomizations(parsed.selections),
        };
      }

      if (name === 'remove_item' && productId) {
        return {
          kind: 'remove',
          productId,
          ...(parsed.quantity !== undefined ? { quantity: Number(parsed.quantity) } : {}),
        };
      }

      if (name === 'update_item_quantity' && productId) {
        const quantity = Number(parsed.quantity);
        if (!Number.isInteger(quantity) || quantity < 0) return null;
        return { kind: 'set_quantity', productId, quantity };
      }
    } catch {
      // ignore parse errors; server will validate
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

  private async executeTool(callId: string, name: string, args: string) {
    const token = this.session.sessionToken;
    if (!token) {
      this.basket.rollbackOperation(callId);
      this.machine.onToolCallFinished(
        (event) => this.session.send(event),
        callId,
        JSON.stringify({ success: false, errorCode: 'UNAUTHORIZED', message: 'Session non authentifiée.', retryable: false }),
      );
      this.updateStatus({ conversation: this.machine.currentState });
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
      const body = await response.json().catch(() => ({ output: JSON.stringify({ success: false, errorCode: 'INVALID_RESPONSE', message: 'Réponse du serveur invalide.', retryable: true }) })) as { output?: string; result?: { success?: boolean; message?: string; data?: { items?: unknown[]; total?: number; status?: string; ref?: string; orderId?: string | null } } };

      if (name === 'submit_order') {
        const data = body.result?.data;
        if (body.result?.success && data?.ref) {
          this.options.onOrderUpdate?.({ ref: data.ref, status: 'submitted', message: body.result.message });
        } else {
          this.options.onOrderUpdate?.({ ref: '', status: 'failed', message: body.result?.message ?? "La commande n'a pas pu être transmise." });
        }
      }

      if (body.result?.success && body.result?.data && body.result.data.items) {
        this.basket.applyServerSnapshot(body.result.data as BasketSnapshot);
      } else if (name !== 'submit_order') {
        this.basket.rollbackOperation(callId);
      }

      this.machine.onToolCallFinished((event) => this.session.send(event), callId, body.output ?? JSON.stringify({ success: false, errorCode: 'INVALID_RESPONSE', message: 'Réponse du serveur invalide.', retryable: true }));
    } catch {
      clearTimeout(timeout);
      this.basket.rollbackOperation(callId);
      this.machine.onToolCallFinished(
        (event) => this.session.send(event),
        callId,
        JSON.stringify({
          success: false,
          errorCode: 'TOOL_TIMEOUT',
          message: 'La vérification du panier a pris trop de temps. Propose au client de réessayer.',
          retryable: true,
        }),
      );
    }
    this.updateStatus({ conversation: this.machine.currentState });
  }

  private handleConnectionError(message: string) {
    this.stopWatchdog();
    this.machine.markDisconnected();
    this.updateStatus({ connection: 'error', conversation: 'recovering', error: message });
    if (this.recoveryInFlight || this.reconnectTimer) return;
    if (this.reconnectAttempts >= 3) {
      this.machine.markError();
      this.updateStatus({ connection: 'error', conversation: 'error', error: 'La connexion audio est instable. Touchez Recommencer pour ouvrir une nouvelle conversation.' });
      return;
    }
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.restartConnection();
    }, 700);
  }

  private async restartConnection() {
    this.recoveryInFlight = true;
    this.updateStatus({ connection: 'connecting', conversation: 'recovering' });
    try {
      await this.session.restart();
    } catch (error) {
      this.recoveryInFlight = false;
      this.handleConnectionError(error instanceof Error ? error.message : 'Impossible de rétablir la connexion audio.');
      return;
    }
    this.recoveryInFlight = false;
  }

  private startWatchdog() {
    this.stopWatchdog();
    this.watchdogTimer = setInterval(() => {
      const now = Date.now();
      if (this.responseStartedAt) {
        const inactive = now - this.lastAudioActivityAt;
        const total = now - this.responseStartedAt;
        if (inactive > 15_000 || total > 45_000) {
          this.responseStartedAt = null;
          if (this.machine.isResponseActive) {
            this.session.send({ type: 'response.cancel' });
          }
          this.machine.startRecovery();
          this.updateStatus({ conversation: 'recovering', error: "L'agent n'a pas terminé sa réponse audio." });
        }
      }
    }, 500);
  }

  private stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  async start(audioElement?: HTMLAudioElement): Promise<void> {
    if (audioElement) this.audioElement = audioElement;
    this.updateStatus({ connection: 'connecting', conversation: 'connecting' });
    this.machine.connect();
    try {
      await this.session.start(this.audioElement ?? undefined);
    } catch (error) {
      this.handleConnectionError(error instanceof Error ? error.message : "Impossible d'accéder au microphone.");
    }
  }

  stop() {
    this.stopWatchdog();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.session.stop();
    this.recoveryInFlight = false;
    this.machine.reset();
    this.reconnectAttempts = 0;
    this.responseStartedAt = null;
    this.lastAudioActivityAt = 0;
    this.pendingToolCalls.clear();
    this.handledToolCalls.clear();
    this.audioElement = null;
    this.updateStatus({ connection: 'idle', conversation: 'idle', error: undefined });
  }

  sendText(text: string) {
    this.machine.sendUserMessage((event) => this.session.send(event), text);
    this.updateStatus({ conversation: this.machine.currentState });
  }

  confirmOrder() {
    this.sendText('Je confirme ma commande.');
  }

  resetForNextCustomer() {
    this.stop();
    this.transcriptMessages.clear();
    this.options.onTranscriptUpdate?.([]);
    this.basket.reset();
    this.greetingSent = false;
  }

  get status() {
    return this.currentStatus;
  }

  get transcript() {
    return Array.from(this.transcriptMessages.values()).sort((a, b) => a.timestamp - b.timestamp);
  }
}
