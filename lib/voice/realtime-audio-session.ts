export type RealtimeEventType =
  | 'open'
  | 'close'
  | 'error'
  | 'session.created'
  | 'session.updated'
  | 'input_audio_buffer.speech_started'
  | 'input_audio_buffer.speech_stopped'
  | 'conversation.item.created'
  | 'conversation.item.added'
  | 'response.created'
  | 'response.output_item.added'
  | 'response.output_item.done'
  | 'response.function_call_arguments.done'
  | 'response.output_audio.delta'
  | 'response.output_audio.done'
  | 'response.audio.delta'
  | 'response.audio.done'
  | 'response.done'
  | 'response.cancelled'
  | 'response.failed'
  | 'rate_limits.updated'
  | 'realtime_error'
  | 'remote_track'
  | 'audio_playback_error'
  | 'connection_state_change'
  | 'data_channel_state_change';

export type RealtimeEventPayload = {
  type: RealtimeEventType;
  raw?: unknown;
  responseId?: string;
  callId?: string;
  item?: unknown;
  error?: Error | { message?: string };
  state?: string;
  text?: string;
  track?: MediaStreamTrack;
  stream?: MediaStream;
};

export type RealtimeSessionConfig = {
  brand?: string;
  restaurantId?: string;
  conversationId?: string;
  onEvent?: (payload: RealtimeEventPayload) => void;
};

export class RealtimeAudioSession {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private started = false;
  private generation = 0;
  private signalingPromise: Promise<void> | null = null;
  private establishedConversationId: string | null = null;
  private restartConversationId: string | null = null;
  private config: RealtimeSessionConfig;

  sessionToken: string | null = null;
  conversationId: string | null = null;

  constructor(config: RealtimeSessionConfig = {}) {
    this.config = config;
  }

  updateConfig(config: Partial<Omit<RealtimeSessionConfig, 'onEvent'>>) {
    this.config = { ...this.config, ...config };
  }

  private emit(type: RealtimeEventType, extra: Omit<RealtimeEventPayload, 'type'> = {}) {
    this.config.onEvent?.({ type, ...extra });
  }

  async start(audioElement?: HTMLAudioElement): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.audioElement = audioElement ?? null;
    const generation = ++this.generation;

    try {
      if (this.audioElement) {
        this.audioElement.autoplay = true;
        this.audioElement.setAttribute('autoplay', '');
        this.audioElement.setAttribute('playsinline', '');
        // Prépare la sortie audio pendant le geste utilisateur. La piste
        // distante arrive plus tard, parfois après que Safari a perdu le
        // contexte de lecture autorisé.
        this.audioElement.muted = true;
        void this.audioElement.play().catch(() => {
          // La lecture sera retentée quand la piste distante sera reçue.
        });
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('Le navigateur ne fournit pas accès au microphone.');
      }
      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      const peer = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });

      if (!this.started || this.generation !== generation) {
        peer.close();
        localStream.getTracks().forEach((track) => track.stop());
        return;
      }

      this.localStream = localStream;
      this.peer = peer;

      localStream.getAudioTracks().forEach((track) => {
        peer.addTrack(track, localStream);
      });

      peer.ontrack = (event) => {
        if (!this.isCurrent(peer, generation)) return;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        this.emit('remote_track', { stream, track: event.track });
        if (this.audioElement) {
          const audio = this.audioElement;
          audio.srcObject = stream;
          audio.volume = 1;
          // Le démarrage muet est autorisé par Safari/iOS même quand l'arrivée
          // de la piste distante intervient après le geste utilisateur. Le son
          // est réactivé immédiatement après play() pour éviter un agent muet.
          audio.muted = true;
          audio.play().then(() => {
            audio.muted = false;
          }).catch((error: unknown) => {
            audio.muted = false;
            this.emit('audio_playback_error', {
              error: error instanceof Error ? error : new Error('La lecture audio a été bloquée par le navigateur.'),
            });
          });
        }
      };

      peer.onconnectionstatechange = () => {
        if (!this.isCurrent(peer, generation)) return;
        this.emit('connection_state_change', { state: peer.connectionState });
      };

      peer.oniceconnectionstatechange = () => {
        if (!this.isCurrent(peer, generation)) return;
        if (peer.iceConnectionState === 'failed') {
          this.emit('error', { error: new Error('ICE connection failed') });
        }
      };

      // Le canal est créé avant l'offre. Safari peut sinon produire une
      // description locale sans m-line de données, puis refuser la réponse.
      const channel = peer.createDataChannel('oai-events', { ordered: true });
      this.channel = channel;
      this.setupDataChannel(channel, peer, generation);

      const offer = await peer.createOffer();
      if (!this.isCurrent(peer, generation)) return;
      await peer.setLocalDescription(offer);
      if (!this.isCurrent(peer, generation)) return;

      await this.waitForIceGathering(peer);
      if (!this.isCurrent(peer, generation)) return;
      await this.completeSignaling(peer, generation);
      await this.waitForDataChannelOpen(channel, peer, generation);
    } catch (error) {
      // Si la connexion a été remplacée ou fermée pendant le signaling
      // (changement de configuration, arrêt, nouvel essai), l'erreur
      // InvalidStateError du navigateur est attendue : on l'ignore.
      if (generation !== this.generation || !this.started) return;
      this.disposeCurrentConnection();
      throw error;
    }
  }

  private isCurrent(peer: RTCPeerConnection, generation: number) {
    return this.started && this.generation === generation && this.peer === peer && peer.signalingState !== 'closed';
  }

  private async waitForIceGathering(peer: RTCPeerConnection) {
    if (peer.iceGatheringState === 'complete') return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Le rassemblement ICE a expiré.'));
      }, 8_000);

      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        peer.removeEventListener('icegatheringstatechange', onStateChange);
        peer.removeEventListener('icecandidate', onCandidate);
        resolve();
      };
      const onStateChange = () => {
        if (peer.iceGatheringState === 'complete') finish();
      };
      const onCandidate = (event: RTCPeerConnectionIceEvent) => {
        if (!event.candidate) finish();
      };

      peer.addEventListener('icegatheringstatechange', onStateChange);
      peer.addEventListener('icecandidate', onCandidate);
      if (peer.iceGatheringState === 'complete') finish();
    });
  }

  private async waitForDataChannelOpen(channel: RTCDataChannel, peer: RTCPeerConnection, generation: number) {
    if (channel.readyState === 'open') return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        finish(new Error('Le canal vocal n’a pas pu être ouvert.'));
      }, 12_000);

      const cleanup = () => {
        window.clearTimeout(timeout);
        channel.removeEventListener('open', onOpen);
        channel.removeEventListener('close', onClose);
        channel.removeEventListener('error', onError);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      };
      const onOpen = () => {
        if (this.isCurrent(peer, generation)) finish();
        else finish(new Error('La session vocale a été remplacée.'));
      };
      const onClose = () => finish(new Error('Le canal vocal a été fermé.'));
      const onError = () => finish(new Error('Le canal vocal a rencontré une erreur.'));

      channel.addEventListener('open', onOpen);
      channel.addEventListener('close', onClose);
      channel.addEventListener('error', onError);
      if (channel.readyState === 'open') onOpen();
    });
  }

  private async completeSignaling(peer: RTCPeerConnection, generation: number) {
    if (!this.isCurrent(peer, generation) || !peer.localDescription) return;
    if (this.signalingPromise) return this.signalingPromise;

    this.signalingPromise = this.exchangeSignaling(peer, generation);
    try {
      await this.signalingPromise;
    } finally {
      this.signalingPromise = null;
    }
  }

  private async exchangeSignaling(peer: RTCPeerConnection, generation: number) {
    if (!peer.localDescription || !this.isCurrent(peer, generation)) return;

    // Validation SDP minimale avant envoi
    const sdp = peer.localDescription.sdp;
    if (!sdp || !sdp.startsWith('v=0')) {
      throw new Error('SDP locale invalide.');
    }

    const params = new URLSearchParams();
    if (this.config.brand) params.set('brand', this.config.brand);
    if (this.config.restaurantId) params.set('restaurantId', this.config.restaurantId);
    const conversationId = this.restartConversationId ?? this.config.conversationId;
    if (conversationId) params.set('conversationId', conversationId);

    const { supabase } = await import('@/lib/supabase/client');
    if (!supabase) throw new Error('Le client Supabase est indisponible.');
    const { data: { session } } = await supabase.auth.getSession();
    const headers: Record<string, string> = { 'Content-Type': 'application/sdp' };
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;

    const response = await fetch(`/api/voice/session?${params.toString()}`, {
      method: 'POST',
      headers,
      body: sdp,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || `Signaling failed: ${response.status}`);
    }

    const answerSdp = await response.text();
    if (!answerSdp || !answerSdp.startsWith('v=0')) {
      throw new Error('SDP distante invalide.');
    }
    if (!this.isCurrent(peer, generation) || peer.signalingState !== 'have-local-offer') return;
    const sessionToken = response.headers.get('x-drivevoice-session');
    const negotiatedConversationId = response.headers.get('x-drivevoice-conversation');
    if (sessionToken) this.sessionToken = sessionToken;
    if (negotiatedConversationId) {
      this.conversationId = negotiatedConversationId;
      this.establishedConversationId = negotiatedConversationId;
    }

    await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  }

  private setupDataChannel(channel: RTCDataChannel, peer: RTCPeerConnection, generation: number) {
    channel.onopen = () => {
      if (!this.isCurrent(peer, generation) || this.channel !== channel) return;
      this.emit('open');
      this.emit('data_channel_state_change', { state: channel.readyState });
    };

    channel.onclose = () => {
      if (this.channel !== channel) return;
      this.emit('data_channel_state_change', { state: channel.readyState });
      this.emit('close');
    };

    channel.onerror = (event) => {
      if (this.channel !== channel) return;
      this.emit('error', { error: event.error ?? new Error('Data channel error') });
    };

    channel.onmessage = (event) => {
      if (!this.isCurrent(peer, generation) || this.channel !== channel) return;
      try {
        const raw = JSON.parse(event.data as string) as { type: string };
        this.dispatchServerEvent(raw);
      } catch {
        this.emit('error', { error: new Error('Invalid server event JSON') });
      }
    };
  }

  private dispatchServerEvent(raw: { type: string } & Record<string, unknown>) {
    const type = raw.type as RealtimeEventType;
    const base = { raw };

    switch (type) {
      case 'session.created':
      case 'session.updated':
        this.emit(type, base);
        break;
      case 'input_audio_buffer.speech_started':
      case 'input_audio_buffer.speech_stopped':
        this.emit(type, base);
        break;
      case 'conversation.item.created':
      case 'conversation.item.added':
        this.emit(type, { ...base, item: raw.item });
        break;
      case 'response.created':
        this.emit(type, { ...base, responseId: String(raw.response_id ?? '') });
        break;
      case 'response.output_item.added':
      case 'response.output_item.done':
        this.emit(type, {
          ...base,
          responseId: String(raw.response_id ?? ''),
          callId: typeof (raw.item as { call_id?: unknown } | undefined)?.call_id === 'string'
            ? String((raw.item as { call_id: string }).call_id)
            : undefined,
          item: raw.item,
        });
        break;
      case 'response.function_call_arguments.done':
        this.emit(type, {
          ...base,
          responseId: String(raw.response_id ?? ''),
          callId: String(raw.call_id ?? ''),
          item: { name: raw.name, arguments: raw.arguments, call_id: raw.call_id },
        });
        break;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
      case 'response.output_audio.done':
      case 'response.audio.done':
        this.emit(type, {
          ...base,
          responseId: String(raw.response_id ?? ''),
          text: typeof raw.delta === 'string' ? raw.delta : undefined,
        });
        break;
      case 'response.done':
      case 'response.cancelled':
      case 'response.failed':
        this.emit(type, { ...base, responseId: String(raw.response_id ?? '') });
        break;
      case 'rate_limits.updated':
        this.emit(type, base);
        break;
      case 'error': {
        const details = raw.error as { message?: string; code?: string; type?: string; param?: string | null } | undefined;
        this.emit('realtime_error', {
          ...base,
          error: new Error(details?.message || 'Erreur Realtime reçue.'),
        });
        break;
      }
      default:
        // unknown event type ignored
        break;
    }
  }

  send(event: object): boolean {
    if (this.channel?.readyState !== 'open') return false;
    try {
      this.channel.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  stop() {
    this.generation += 1;
    this.started = false;
    this.sessionToken = null;
    this.conversationId = null;
    this.establishedConversationId = null;
    this.signalingPromise = null;
    const channel = this.channel;
    const peer = this.peer;
    const localStream = this.localStream;
    this.channel = null;
    this.peer = null;
    this.localStream = null;
    channel?.close();
    peer?.close();
    localStream?.getTracks().forEach((track) => track.stop());
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.srcObject = null;
    }
    this.audioElement = null;
  }

  async restart(): Promise<void> {
    const audioElement = this.audioElement;
    const conversationId = this.conversationId ?? this.establishedConversationId;
    this.stop();
    this.restartConversationId = conversationId;
    try {
      await this.start(audioElement ?? undefined);
    } finally {
      this.restartConversationId = null;
    }
  }

  private disposeCurrentConnection() {
    const channel = this.channel;
    const peer = this.peer;
    const localStream = this.localStream;
    this.channel = null;
    this.peer = null;
    this.localStream = null;
    channel?.close();
    peer?.close();
    localStream?.getTracks().forEach((track) => track.stop());
    this.started = false;
  }
}
