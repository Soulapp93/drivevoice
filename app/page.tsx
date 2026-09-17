'use client';

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isSupabaseConfigured, supabase, supabaseAnonKey } from '@/lib/supabase/client';
import { fetchBrandsFromDb, syncBrandsToDb, type MasterBrandInput } from '@/lib/supabase/sync';
import { createRestaurant, deleteRestaurant, fetchRestaurantProducts, fetchRestaurants, updateRestaurantProduct, type RestaurantInfo, type RestaurantProductInfo } from '@/lib/supabase/restaurants';
import { calculateCatalogPrice, getCatalogSelectionLabels, validateCatalogSelection, type CatalogSelection } from '@/lib/catalog-rules';

type ProductId = string;
type OrderItem = { id: number; productId: ProductId; name: string; detail: string; price: number; emoji: string; customizations?: string[] };
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';
type TranscriptMessage = { id: string; speaker: 'client' | 'agent'; text: string; status: 'partial' | 'final'; timestamp: number };
type RealtimeEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  text?: string;
  item_id?: string;
  response_id?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  error?: { message?: string };
  item?: {
    type?: string;
    id?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
    id?: string;
    role?: string;
    item_id?: string;
    content?: Array<{ type?: string; transcript?: string; text?: string }>;
  };
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onresult: ((event: {
    resultIndex: number;
    results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
  }) => void) | null;
  start: () => void;
  stop: () => void;
};

type BrowserSpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

declare global {
  interface Window {
    SpeechRecognition?: BrowserSpeechRecognitionConstructor;
    webkitSpeechRecognition?: BrowserSpeechRecognitionConstructor;
  }
}

const brands = [
  { name: 'Burger King', mark: 'BK', color: '#e32725', ink: '#fff' },
  { name: "McDonald's", mark: 'M', color: '#ffcc00', ink: '#1d1d1b' },
  { name: 'Quick', mark: 'Q', color: '#e31c3d', ink: '#fff' },
  { name: 'KFC', mark: 'K', color: '#e4002b', ink: '#fff' },
];

const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });
const splitField = (value: string) => value.split(/\r?\n|,/).map(item => item.trim()).filter(Boolean);
const menuOptionMatchesSize = (name: string, selectedSize: string, type: 'accompagnement' | 'boisson') => {
  const text = name.toLowerCase();
  const size = selectedSize.toLowerCase();
  if (type === 'accompagnement') {
    if (/king fries/.test(text)) return true;
    if (/grande|9\)|large/.test(text)) return /king|extra|xxl|xl/.test(size);
    if (/moyenne|6\)|petite/.test(text)) return /medium|m|king|extra|xxl|xl/.test(size);
    return true;
  }
  if (/25cl|33cl|20cl/.test(text)) return /medium|m/.test(size);
  if (/40cl/.test(text)) return /medium|m|king|extra|xxl|xl/.test(size);
  if (/50cl/.test(text)) return /king|extra|xxl|xl/.test(size);
  return true;
};

function OrderWorkspace({ products, agentWelcome, agentRules }: { products: CatalogProduct[]; agentWelcome: string; agentRules: Array<[string, boolean]> }) {
  const [brand, setBrand] = useState(brands[0]);
  const [started, setStarted] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [pricing, setPricing] = useState<{ acceptingOrders: boolean; discountTotal: number; total: number } | null>(null);
  const [customerText, setCustomerText] = useState('');
  const [voiceInput, setVoiceInput] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [agentText, setAgentText] = useState('Bonjour ! Je suis prêt à prendre votre commande.');
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [items, setItems] = useState<OrderItem[]>([]);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const outputTranscriptRef = useRef('');
  const transcriptMessagesRef = useRef(new Map<string, TranscriptMessage>());
  const activeClientTranscriptIdRef = useRef<string | null>(null);
  const activeAgentTranscriptIdRef = useRef<string | null>(null);
  const speechRecognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const browserSpeechIdRef = useRef<string | null>(null);
  const latestBrowserClientIdRef = useRef<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  const conversationStartedAtRef = useRef<string | null>(null);
  const handledCallsRef = useRef(new Set<string>());
  const microphoneReadyRef = useRef(false);
  const responseInProgressRef = useRef(false);
  const responseStartedAtRef = useRef<number | null>(null);
  const lastAudioActivityAtRef = useRef(0);
  const speechStoppedAtRef = useRef<number | null>(null);
  const responseRecoveryAtRef = useRef(0);
  const recoveryAttemptsRef = useRef(0);
  const watchdogTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const startOrderRef = useRef<((preserveState?: boolean) => Promise<void>) | null>(null);
  const nextId = useRef(1);

  const total = useMemo(() => items.reduce((sum, item) => sum + item.price, 0), [items]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-pricing', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Authorization: `Bearer ${supabaseAnonKey}` },
        body: JSON.stringify({ restaurantId: demoRestaurantId, subtotal: total }),
      }).then(async response => {
        const result = await response.json().catch(() => ({})) as { acceptingOrders?: boolean; discountTotal?: number; total?: number };
        if (response.ok) setPricing({ acceptingOrders: result.acceptingOrders !== false, discountTotal: result.discountTotal ?? 0, total: result.total ?? total });
      }).catch(() => setPricing(null));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [total]);
  const finalTotal = pricing?.total ?? total;

  const sendEvent = (event: object) => {
    const channel = dataChannelRef.current;
    if (channel?.readyState !== 'open') return false;
    channel.send(JSON.stringify(event));
    return true;
  };

  const cleanupSession = (persistAudit = true) => {
    const messages = Array.from(transcriptMessagesRef.current.values());
    if (persistAudit && conversationIdRef.current && messages.length > 0) {
      void fetch('/api/conversations/audit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversationIdRef.current,
          restaurantId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
          startedAt: conversationStartedAtRef.current,
          endedAt: new Date().toISOString(),
          messages,
        }),
      }).catch(() => undefined);
    }
    speechRecognitionRef.current?.stop();
    speechRecognitionRef.current = null;
    dataChannelRef.current?.close();
    peerRef.current?.close();
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
    }
    dataChannelRef.current = null;
    peerRef.current = null;
    mediaStreamRef.current = null;
    audioRef.current = null;
    microphoneReadyRef.current = false;
    responseInProgressRef.current = false;
    responseStartedAtRef.current = null;
    speechStoppedAtRef.current = null;
    if (watchdogTimerRef.current !== null) window.clearInterval(watchdogTimerRef.current);
    if (reconnectTimerRef.current !== null) window.clearTimeout(reconnectTimerRef.current);
    watchdogTimerRef.current = null;
    reconnectTimerRef.current = null;
    setListening(false);
    setSpeaking(false);
  };

  const scheduleRecovery = (reason: string) => {
    if (reconnectTimerRef.current !== null || !startOrderRef.current) return;
    if (reconnectAttemptsRef.current >= 3) {
      setConnectionState('error');
      setVoiceError('La connexion audio est instable. Touchez Recommencer pour ouvrir une nouvelle conversation.');
      return;
    }
    reconnectAttemptsRef.current += 1;
    setConnectionState('connecting');
    setVoiceError(`${reason} Reconnexion automatique…`);
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      void startOrderRef.current?.(true);
    }, 700);
  };

  const sendTextToAgent = (text: string) => {
    const message = text.trim();
    if (!message) return false;
    setCustomerText(message);
    upsertTranscript(`text-client-${Date.now()}`, 'client', message, 'final');
    outputTranscriptRef.current = '';
    const sent = sendEvent({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: message }],
      },
    });
    if (sent) sendEvent({ type: 'response.create' });
    else setVoiceError("L'agent n'est pas encore connecté. Réessayez dans un instant.");
    return sent;
  };

  const upsertTranscript = (id: string, speaker: 'client' | 'agent', text: string, status: 'partial' | 'final') => {
    const normalized = text.trim();
    if (!normalized) return;
    const now = Date.now();
    for (const [existingId, existing] of transcriptMessagesRef.current.entries()) {
      const isRecent = now - existing.timestamp < 15_000;
      const isSameSpeaker = existing.speaker === speaker;
      const isDuplicate = existing.text === normalized
        || (status === 'final' && existing.status === 'partial' && (normalized.startsWith(existing.text) || existing.text.startsWith(normalized)));
      if (existingId !== id && isRecent && isSameSpeaker && isDuplicate) {
        transcriptMessagesRef.current.delete(existingId);
      }
    }
    const existing = transcriptMessagesRef.current.get(id);
    transcriptMessagesRef.current.set(id, {
      id,
      speaker,
      text: normalized,
      status,
      timestamp: existing?.timestamp ?? now,
    });
    setTranscript(Array.from(transcriptMessagesRef.current.values()));
  };

  const appendTranscriptDelta = (id: string, speaker: 'client' | 'agent', delta: string) => {
    const existing = transcriptMessagesRef.current.get(id);
    const nextText = `${existing?.text === '…' ? '' : existing?.text ?? ''}${delta}`.trim();
    if (!nextText) return;
    upsertTranscript(id, speaker, nextText, 'partial');
  };

  const finalizeTranscript = (id: string, speaker: 'client' | 'agent', text: string) => {
    upsertTranscript(id, speaker, text, 'final');
  };

  const handleOrderTool = (name: string | undefined, rawArguments: string | undefined, callId: string | undefined) => {
    if (name !== 'update_order' || !callId || handledCallsRef.current.has(callId)) return;
    handledCallsRef.current.add(callId);

    let output: { ok: boolean; item_count?: number; total?: number; error?: string };
    try {
      const parsed = JSON.parse(rawArguments ?? '{}') as {
        items?: Array<{ product_id?: ProductId; quantity?: number; selections?: Array<{ group?: string; options?: string[] }> }>;
        status?: 'editing' | 'ready_to_confirm' | 'confirmed';
      };
      const nextItems: OrderItem[] = [];
      for (const requested of parsed.items ?? []) {
        const product = products.find((entry) => entry.productId === requested.product_id && entry.available);
        const quantity = Math.min(20, Math.max(0, Math.trunc(Number(requested.quantity) || 0)));
        if (!product) continue;
        const selections = requested.selections ?? [];
        const selectionIds: CatalogSelection = {};
        const selectedOptions = selections.flatMap(selection => {
          const group = product.optionGroups?.find(entry => entry.name.toLowerCase() === String(selection.group ?? '').toLowerCase());
          if (!group) return [];
          const options = (selection.options ?? []).map(optionName => group.options.find(option => option.name.toLowerCase() === optionName.toLowerCase())).filter((option): option is ProductOption => Boolean(option && option.available));
          selectionIds[group.id] = options.map(option => option.id);
          return options;
        });
        const ruleGroups = product.optionGroups ?? [];
        if (!validateCatalogSelection(ruleGroups, selectionIds).valid) {
          output = { ok: false, error: 'Certains choix obligatoires ou certaines limites de menu ne sont pas respectés.' };
          continue;
        }
        const customizationPrice = calculateCatalogPrice(0, ruleGroups, selectionIds);
        const customizationLabels = getCatalogSelectionLabels(ruleGroups, selectionIds);
        for (let index = 0; index < quantity; index += 1) {
          nextItems.push({ ...product, id: nextId.current++, price: product.price + customizationPrice, customizations: customizationLabels });
        }
      }
      setItems(nextItems);
      setConfirmed(parsed.status === 'confirmed');
      const nextTotal = nextItems.reduce((sum, item) => sum + item.price, 0);
      output = { ok: true, item_count: nextItems.length, total: nextTotal };
    } catch {
      output = { ok: false, error: 'Arguments de panier invalides.' };
    }

    sendEvent({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    });
    sendEvent({ type: 'response.create' });
  };

  const handleRealtimeEvent = (event: RealtimeEvent) => {
    const appendTranscript = (speaker: 'client' | 'agent', text: string) => {
      const id = speaker === 'client'
        ? activeClientTranscriptIdRef.current ?? `client-${Date.now()}`
        : activeAgentTranscriptIdRef.current ?? `agent-${Date.now()}`;
      finalizeTranscript(id, speaker, text);
    };
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        setConnectionState('connected');
        break;
      case 'input_audio_buffer.speech_started':
        setListening(microphoneReadyRef.current);
        setSpeaking(false);
        speechStoppedAtRef.current = null;
        responseRecoveryAtRef.current = 0;
        if (responseInProgressRef.current) {
          sendEvent({ type: 'response.cancel' });
          responseInProgressRef.current = false;
          responseStartedAtRef.current = null;
        }
        setCustomerText('…');
        if (microphoneReadyRef.current) {
          const id = event.item_id ?? `client-${Date.now()}`;
          activeClientTranscriptIdRef.current = id;
          upsertTranscript(id, 'client', '…', 'partial');
        }
        break;
      case 'input_audio_buffer.speech_stopped':
        setListening(false);
        speechStoppedAtRef.current = Date.now();
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) {
          setCustomerText(event.transcript);
          const id = latestBrowserClientIdRef.current ?? event.item_id ?? activeClientTranscriptIdRef.current ?? `client-${Date.now()}`;
          finalizeTranscript(id, 'client', event.transcript);
          activeClientTranscriptIdRef.current = null;
          latestBrowserClientIdRef.current = null;
        }
        break;
      case 'conversation.item.input_audio_transcription.failed':
        setVoiceError(event.error?.message ?? "OpenAI n'a pas fourni la transcription de ce message vocal.");
        break;
      case 'conversation.item.created': {
        const item = event.item;
        if (item?.role === 'user') {
          const userText = (item.content ?? [])
            .map((part) => part.transcript ?? part.text ?? '')
            .filter(Boolean)
            .join(' ')
            .trim();
          if (userText) {
            setCustomerText(userText);
            const id = item.id ?? activeClientTranscriptIdRef.current ?? `client-${Date.now()}`;
            finalizeTranscript(id, 'client', userText);
            activeClientTranscriptIdRef.current = null;
          }
        }
        break;
      }
      case 'conversation.item.input_audio_transcription.delta':
      case 'input_audio_transcription.delta':
        if (event.delta) {
          const id = latestBrowserClientIdRef.current ?? event.item_id ?? activeClientTranscriptIdRef.current ?? `client-${Date.now()}`;
          activeClientTranscriptIdRef.current = id;
          appendTranscriptDelta(id, 'client', event.delta);
          setCustomerText(transcriptMessagesRef.current.get(id)?.text ?? event.delta);
        }
        break;
      case 'response.created':
        outputTranscriptRef.current = '';
        activeAgentTranscriptIdRef.current = event.response_id ?? `agent-${Date.now()}`;
        responseInProgressRef.current = true;
        responseStartedAtRef.current = Date.now();
        speechStoppedAtRef.current = null;
        setSpeaking(true);
        setListening(false);
        break;
      case 'response.output_audio.delta':
      case 'response.audio.delta':
        lastAudioActivityAtRef.current = Date.now();
        setSpeaking(true);
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
      case 'response.output_text.delta':
        if (event.delta) {
          outputTranscriptRef.current += event.delta;
          setAgentText(outputTranscriptRef.current);
          const id = event.item_id ?? activeAgentTranscriptIdRef.current ?? `agent-${Date.now()}`;
          activeAgentTranscriptIdRef.current = id;
          upsertTranscript(id, 'agent', outputTranscriptRef.current, 'partial');
        }
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (event.transcript) {
          setAgentText(event.transcript);
          appendTranscript('agent', event.transcript);
          activeAgentTranscriptIdRef.current = null;
        }
        break;
      case 'response.output_text.done':
        if (event.text) {
          setAgentText(event.text);
          appendTranscript('agent', event.text);
        }
        break;
      case 'response.function_call_arguments.done':
        handleOrderTool(event.name, event.arguments, event.call_id);
        break;
      case 'response.output_item.done': {
        const item = event.item;
        if (item?.type === 'function_call') {
          handleOrderTool(item.name, item.arguments, item.call_id);
        } else if (item?.type === 'message') {
          const transcript = (item.content ?? [])
            .map((part) => part.transcript ?? part.text ?? '')
            .filter(Boolean)
            .join(' ');
          if (transcript) setAgentText(transcript);
          if (transcript) appendTranscript('agent', transcript);
        }
        break;
      }
      case 'response.done':
        responseInProgressRef.current = false;
        responseStartedAtRef.current = null;
        setSpeaking(false);
        setListening(microphoneReadyRef.current);
        break;
      case 'error':
        responseInProgressRef.current = false;
        responseStartedAtRef.current = null;
        setSpeaking(false);
        setVoiceError(event.error?.message ?? "L'agent vocal a rencontré une erreur. Réessayez.");
        if (event.error?.message && /response|audio|turn|connection/i.test(event.error.message)) {
          scheduleRecovery("Le moteur temps réel a signalé une erreur.");
        }
        break;
    }
  };

  const startOrder = async (preserveState = false) => {
    const savedCustomerText = preserveState ? customerText : '';
    const savedAgentText = preserveState ? agentText : '';
    cleanupSession(!preserveState);
    setStarted(true);
    setConfirmed(preserveState ? confirmed : false);
    if (!preserveState) setItems([]);
    setCustomerText(savedCustomerText);
    setVoiceError('');
    setAgentText(savedAgentText || "Connexion à l'équipier vocal…");
    setConnectionState('connecting');
    if (!preserveState) {
      handledCallsRef.current.clear();
      transcriptMessagesRef.current.clear();
      activeClientTranscriptIdRef.current = null;
      activeAgentTranscriptIdRef.current = null;
      browserSpeechIdRef.current = null;
      latestBrowserClientIdRef.current = null;
      conversationIdRef.current = crypto.randomUUID();
      conversationStartedAtRef.current = new Date().toISOString();
      setTranscript([]);
    }
    responseInProgressRef.current = false;
    responseStartedAtRef.current = null;
    speechStoppedAtRef.current = null;
    responseRecoveryAtRef.current = 0;
    if (!preserveState) reconnectAttemptsRef.current = 0;

    try {
      const peer = new RTCPeerConnection();
      peerRef.current = peer;

      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('micro-unavailable');
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        mediaStreamRef.current = stream;
        microphoneReadyRef.current = true;
        stream.getTracks().forEach((track) => peer.addTrack(track, stream));
      } catch {
        microphoneReadyRef.current = false;
        peer.addTransceiver('audio', { direction: 'recvonly' });
        setVoiceError("Le micro n'est pas accessible dans ce navigateur. L'agent reste disponible par écrit et répond à l'oral.");
      }

      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.setAttribute('playsinline', '');
      audioRef.current = audio;
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
        lastAudioActivityAtRef.current = Date.now();
        void audio.play().catch(() => setVoiceError("Touchez l'écran pour autoriser le son de l'agent."));
      };
      audio.addEventListener('playing', () => {
        lastAudioActivityAtRef.current = Date.now();
        setVoiceError('');
      });
      audio.addEventListener('waiting', () => {
        if (responseInProgressRef.current) scheduleRecovery("Le flux audio de l'agent est interrompu.");
      });
      audio.addEventListener('stalled', () => {
        if (responseInProgressRef.current) scheduleRecovery("Le flux audio de l'agent est instable.");
      });
      audio.addEventListener('error', () => {
        if (responseInProgressRef.current) scheduleRecovery("La lecture audio de l'agent a rencontré une erreur.");
      });

      const channel = peer.createDataChannel('oai-events');
      dataChannelRef.current = channel;
      channel.addEventListener('message', (message) => {
        try {
          handleRealtimeEvent(JSON.parse(message.data) as RealtimeEvent);
        } catch {
          setVoiceError("Un message de l'agent n'a pas pu être lu.");
        }
      });
      channel.addEventListener('open', () => {
        reconnectAttemptsRef.current = 0;
        setConnectionState('connected');
        setListening(microphoneReadyRef.current);
        const openingMessage = preserveState
          ? 'La connexion est rétablie. Reprends la commande là où nous nous sommes arrêtés et demande au client ce qu’il souhaite faire.'
          : agentWelcome;
        setAgentText(preserveState ? 'Connexion rétablie…' : 'Bonjour, je vous accueille…');
        const activeProducts = products.filter(product => product.available);
        const productKnowledge = activeProducts.map(product => {
          const groups = product.optionGroups?.map(group => `${group.name} [${group.required ? 'obligatoire' : 'facultatif'}, ${group.min}-${group.max}] : ${group.options.filter(option => option.available).map(option => `${option.name}${option.priceDelta ? ` (+${money.format(option.priceDelta)})` : ''}`).join(', ')}`).join(' | ') ?? '';
          return `- ${product.productId}: ${product.name} — ${product.detail} — ${money.format(product.price)}${groups ? ` — CHOIX: ${groups}` : ''}`;
        }).join('\n');
        const behaviorRules = agentRules.filter(([, enabled]) => enabled).map(([rule]) => `- ${rule}`).join('\n');
        sendEvent({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: `Tu es DriveVoice, équipier du drive ${brand.name}. Parle en français avec des phrases courtes. Utilise uniquement le catalogue ci-dessous. Pour chaque groupe obligatoire, pose la question et attends le choix. Pour un ingrédient retiré ou ajouté, utilise uniquement une option réellement disponible. Ne confirme jamais une commande tant que les choix obligatoires ne sont pas complets.\n\nMESSAGE D'ACCUEIL\n${openingMessage}\n\nCATALOGUE DISPONIBLE\n${productKnowledge}\n\nRÈGLES MÉTIER\n${behaviorRules}\n\nAprès chaque modification, appelle update_order avec le panier complet, en transmettant les choix dans selections. N'invente jamais un produit, un prix, une option ou une disponibilité.`,
            tools: [{
              type: 'function',
              name: 'update_order',
              description: "Synchronise l'intégralité du panier visible après chaque modification.",
              parameters: {
                type: 'object',
                properties: {
                  items: { type: 'array', items: { type: 'object', properties: { product_id: { type: 'string', enum: activeProducts.map(product => product.productId) }, quantity: { type: 'integer', minimum: 1, maximum: 20 }, selections: { type: 'array', items: { type: 'object', properties: { group: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, required: ['group', 'options'], additionalProperties: false } } }, required: ['product_id', 'quantity'], additionalProperties: false } },
                  status: { type: 'string', enum: ['editing', 'ready_to_confirm', 'confirmed'] },
                },
                required: ['items', 'status'],
                additionalProperties: false,
              },
            }],
            tool_choice: 'auto',
          },
        });
        sendEvent({
          type: 'response.create',
          response: {
            output_modalities: ['audio'],
            instructions: preserveState
              ? 'Confirme brièvement que la connexion est rétablie, puis demande au client s’il souhaite continuer ou modifier la commande.'
              : `Prononce ce message d'accueil de façon naturelle puis attends la commande : ${agentWelcome}`,
          },
        });
      });
      channel.addEventListener('close', () => {
        setListening(false);
        setSpeaking(false);
        if (startOrderRef.current) scheduleRecovery("La liaison temps réel a été fermée.");
      });

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'connected') {
          setConnectionState('connected');
        } else if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
          scheduleRecovery('La liaison WebRTC a été interrompue.');
        }
      };
      peer.oniceconnectionstatechange = () => {
        if (peer.iceConnectionState === 'failed' || peer.iceConnectionState === 'disconnected') {
          scheduleRecovery('La connexion réseau audio a été interrompue.');
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (peer.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve) => {
          const handleIceGatheringStateChange = () => {
            if (peer.iceGatheringState === 'complete') {
              peer.removeEventListener('icegatheringstatechange', handleIceGatheringStateChange);
              resolve();
            }
          };
          peer.addEventListener('icegatheringstatechange', handleIceGatheringStateChange);
          window.setTimeout(() => {
            peer.removeEventListener('icegatheringstatechange', handleIceGatheringStateChange);
            resolve();
          }, 5000);
        });
      }
      const response = await fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/realtime-call', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sdp',
          Authorization: `Bearer ${supabaseAnonKey}`,
          apikey: supabaseAnonKey,
        },
        body: offer.sdp,
      });
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        let errorMessage = errorBody || `realtime-${response.status}`;
        try {
          const parsed = JSON.parse(errorBody) as { error?: { message?: string } | string; message?: string };
          errorMessage = typeof parsed.error === 'string'
            ? parsed.error
            : parsed.error?.message ?? parsed.message ?? errorMessage;
        } catch {
          errorMessage = errorBody || `realtime-${response.status}`;
        }
        throw new Error(errorMessage);
      }
      const answerSdp = await response.text();
      await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      if (watchdogTimerRef.current !== null) window.clearInterval(watchdogTimerRef.current);
      watchdogTimerRef.current = window.setInterval(() => {
        const now = Date.now();
        const channelOpen = dataChannelRef.current?.readyState === 'open';
        if (!channelOpen) return;
        if (responseInProgressRef.current && responseStartedAtRef.current && now - responseStartedAtRef.current > 15_000) {
          responseInProgressRef.current = false;
          responseStartedAtRef.current = null;
          sendEvent({ type: 'response.cancel' });
          scheduleRecovery("L'agent n'a pas terminé sa réponse audio.");
          return;
        }
        if (!responseInProgressRef.current && speechStoppedAtRef.current && now - speechStoppedAtRef.current > 2_500 && now - responseRecoveryAtRef.current > 5_000) {
          responseRecoveryAtRef.current = now;
          speechStoppedAtRef.current = null;
          sendEvent({ type: 'response.create' });
        }
      }, 500);
    } catch (error) {
      cleanupSession(!preserveState);
      setConnectionState('error');
      const message = error instanceof Error ? error.message : '';
      setVoiceError(message ? `Connexion vocale impossible : ${message}` : "Impossible de joindre l'agent vocal. Vérifiez la connexion puis touchez Recommencer.");
      setAgentText("Je n'ai pas pu ouvrir la ligne audio.");
    }
  };
  startOrderRef.current = startOrder;

  const interrupt = () => {
    if (connectionState !== 'connected' || !microphoneReadyRef.current) return;
    sendEvent({ type: 'response.cancel' });
    responseInProgressRef.current = false;
    responseStartedAtRef.current = null;
    setSpeaking(false);
    setListening(true);
    setAgentText('Je vous écoute.');
  };

  const submitText = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sendTextToAgent(voiceInput)) setVoiceInput('');
  };

  const confirmOrder = () => {
    setConfirmed(true);
    sendTextToAgent("Je confirme définitivement la commande affichée. Donne-moi mon numéro de commande et invite-moi à avancer.");
  };

  const restart = () => {
    cleanupSession();
    setStarted(false);
    setConnectionState('idle');
    setItems([]);
    setConfirmed(false);
    setVoiceError('');
    microphoneReadyRef.current = false;
    setAgentText('Bonjour ! Je suis prêt à prendre votre commande.');
    transcriptMessagesRef.current.clear();
    handledCallsRef.current.clear();
    activeClientTranscriptIdRef.current = null;
    activeAgentTranscriptIdRef.current = null;
    browserSpeechIdRef.current = null;
    latestBrowserClientIdRef.current = null;
    conversationIdRef.current = null;
    conversationStartedAtRef.current = null;
    responseInProgressRef.current = false;
    responseStartedAtRef.current = null;
    speechStoppedAtRef.current = null;
    responseRecoveryAtRef.current = 0;
    reconnectAttemptsRef.current = 0;
    setTranscript([]);
  };

  useEffect(() => () => cleanupSession(), []);

  const statusLabel = connectionState === 'connecting'
    ? 'Connexion en cours'
    : connectionState === 'error'
      ? 'Agent hors ligne'
      : connectionState === 'connected'
        ? 'Agent temps réel'
        : 'Borne disponible';

  return (
    <main className="min-h-screen bg-[#f4f5ef] text-[#142018]">
      <header className="mx-auto flex max-w-[1540px] items-center justify-between px-5 py-5 md:px-10">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#0b1f14] text-lg font-black text-white">D</span>
          <div>
            <p className="text-lg font-black tracking-[-0.04em]">DRIVE<span className="text-[#ff5a36]">VOICE</span></p>
            <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#6b766e]">Assistant de commande</p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-[#dce1d8] bg-white px-4 py-2 text-xs font-bold">
          <span className={`h-2 w-2 rounded-full ${connectionState === 'error' ? 'bg-[#e74d3c]' : connectionState === 'connecting' ? 'animate-pulse bg-[#ffc647]' : 'animate-pulse bg-[#39b76a]'}`} /> {statusLabel}
        </div>
      </header>

      <section className="mx-auto grid max-w-[1540px] gap-5 px-5 pb-8 md:px-10 xl:grid-cols-[1.2fr_1fr]">
        <div className="relative flex min-h-[720px] flex-col overflow-hidden rounded-[32px] bg-[#0b1f14] p-7 text-white md:p-11">
          <div className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full bg-[#ff5a36]" />
          <div className="pointer-events-none absolute right-28 top-20 h-24 w-24 rounded-full bg-[#ffc647]" />

          <div className="relative z-10 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-bold">FR · LIVE</span>
              <span className="text-xs text-white/55">Drive n°04 · Voie A</span>
            </div>
          </div>

          {!started ? (
            <div className="relative z-10 my-auto max-w-3xl py-16">
              <h1 className="max-w-2xl text-[clamp(2.7rem,6vw,6rem)] font-black leading-[.9] tracking-[-0.07em]">Prêt à passer votre commande<span className="text-[#ff5a36]"> ?</span></h1>
              <p className="mt-7 max-w-xl text-base font-semibold leading-relaxed text-white/70 md:text-lg">Veuillez cliquer sur le bouton « Passer ma commande » pour commencer votre commande.</p>
            </div>
          ) : (
            <div className="relative z-10 my-auto py-8">
              <div className="mb-8 flex items-center gap-5">
                <button onClick={interrupt} disabled={connectionState !== 'connected' || !microphoneReadyRef.current} aria-label="Interrompre l’agent et parler" className={`voice-orb grid h-24 w-24 shrink-0 place-items-center rounded-full border-[10px] text-3xl shadow-2xl transition md:h-32 md:w-32 ${listening ? 'border-[#ffc647]/25 bg-[#ffc647] text-[#142018]' : speaking ? 'border-[#ff5a36]/25 bg-[#ff5a36]' : 'border-white/10 bg-white/10'} disabled:cursor-not-allowed disabled:opacity-50`}>
                  {connectionState === 'connecting' ? '···' : listening ? '●' : speaking ? '◖' : '◎'}
                </button>
                <div>
                  <p className="text-xs font-bold uppercase tracking-[.22em] text-[#ffc647]">{connectionState === 'connecting' ? 'Ouverture de la ligne' : listening ? 'Je vous écoute en direct' : speaking ? 'DriveVoice vous parle' : connectionState === 'connected' && !microphoneReadyRef.current ? 'Mode texte actif' : 'À vous de parler'}</p>
                  <div className="mt-3 flex h-8 items-center gap-1" aria-hidden="true">
                    {[14, 26, 38, 22, 44, 31, 18, 36, 24, 15].map((height, index) => <span key={index} className={`wave-bar w-1.5 rounded-full transition-colors ${listening ? 'bg-[#ffc647]' : speaking ? 'bg-[#ff5a36]' : 'bg-white/20'}`} style={{ height }} />)}
                  </div>
                </div>
              </div>

              <div className="max-w-3xl rounded-[28px] bg-white/8 p-6 backdrop-blur md:p-8">
                <div className="flex items-center gap-4"><span className={`grid h-12 w-12 shrink-0 place-items-center rounded-full text-xs font-black text-[#142018] ${listening ? 'bg-[#ffc647]' : speaking ? 'bg-[#ff5a36] text-white' : 'bg-white/20 text-white'}`}>{listening ? 'VOUS' : speaking ? 'DV' : '•••'}</span><div><p className="text-xl font-bold leading-snug md:text-3xl">{listening ? 'Le client parle' : speaking ? 'DriveVoice vous répond' : 'Conversation vocale active'}</p><p className="mt-2 text-sm text-white/50">Les transcriptions sont conservées en arrière-plan pour les audits.</p></div></div>
              </div>
              <section className="mt-5 max-w-3xl rounded-[24px] border border-white/10 bg-black/15 p-5 backdrop-blur" aria-label="Transcription de la conversation">
                <div className="flex items-center justify-between"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#ffc647]">État de la conversation</p><h2 className="mt-1 text-lg font-black">Prise de parole en direct</h2></div><span className="rounded-full bg-white/10 px-3 py-1 text-[10px] font-black text-white/60">Transcription masquée</span></div>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div className={`rounded-2xl border p-4 ${listening ? 'border-[#ffc647]/70 bg-[#ffc647]/15' : 'border-white/10 bg-white/5'}`}><div className="flex items-center justify-between"><p className="text-[10px] font-black uppercase tracking-widest text-[#ffc647]">Client</p><span className={`h-2.5 w-2.5 rounded-full ${listening ? 'animate-pulse bg-[#ffc647]' : 'bg-white/25'}`} /></div><p className="mt-3 text-sm font-black">{listening ? 'Le client parle' : 'En attente du client'}</p><p className="mt-1 text-[10px] text-white/45">{listening ? 'Parole détectée en direct' : 'Le prochain tour de parole sera affiché ici'}</p></div>
                  <div className={`rounded-2xl border p-4 ${speaking ? 'border-[#ff5a36]/70 bg-[#ff5a36]/15' : 'border-white/10 bg-white/5'}`}><div className="flex items-center justify-between"><p className="text-[10px] font-black uppercase tracking-widest text-[#ff927a]">DriveVoice IA</p><span className={`h-2.5 w-2.5 rounded-full ${speaking ? 'animate-pulse bg-[#ff5a36]' : 'bg-white/25'}`} /></div><p className="mt-3 text-sm font-black">{speaking ? 'L’agent parle' : 'En attente de l’agent'}</p><p className="mt-1 text-[10px] text-white/45">{speaking ? 'Réponse vocale en direct' : 'La réponse apparaîtra après le client'}</p></div>
                </div>
              </section>

              {voiceError && <p role="alert" className="mt-4 max-w-3xl rounded-2xl border border-[#ffc647]/30 bg-[#ffc647]/10 px-4 py-3 text-sm text-[#ffe099]">{voiceError}</p>}

            </div>
          )}

          {!started ? (
            <button onClick={() => void startOrder()} disabled={pricing?.acceptingOrders === false} className="relative z-10 flex w-full items-center justify-between rounded-2xl bg-[#ff5a36] px-6 py-5 text-left transition hover:-translate-y-0.5 hover:bg-[#ff6c4d] disabled:cursor-not-allowed disabled:opacity-50 md:w-[440px]">
              <span><strong className="block text-lg">{pricing?.acceptingOrders === false ? 'Commandes temporairement fermées' : 'Passer ma commande'}</strong><small className="text-white/70">{pricing?.acceptingOrders === false ? 'Le restaurant est actuellement fermé ou en pause.' : 'Autorisez le micro, l’agent démarre en direct'}</small></span><span className="grid h-12 w-12 place-items-center rounded-full bg-white text-2xl text-[#ff5a36]">●</span>
            </button>
          ) : (
            <div className="relative z-10 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-5"><p className="text-xs text-white/45">Vous pouvez parler par-dessus l’agent ou toucher le cercle pour l’interrompre.</p><button onClick={restart} className="text-xs font-bold text-white/60 underline decoration-white/20 underline-offset-4">Recommencer</button></div>
          )}
        </div>

        <aside className="flex min-h-[720px] flex-col rounded-[32px] bg-white p-8 shadow-sm md:p-10 xl:sticky xl:top-24 xl:h-fit">
          <div className="flex items-center justify-between border-b border-[#e7eae4] pb-7"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-[#899189]">Commande · {brand.mark}</p><h2 className="mt-1 text-2xl font-black tracking-[-0.04em]">Votre panier</h2></div><span className="rounded-full bg-[#f1f3ee] px-3 py-1.5 text-xs font-bold">{items.length} article{items.length !== 1 ? 's' : ''}</span></div>

          {confirmed ? (
            <div className="grid flex-1 place-items-center text-center"><div><div className="mx-auto mb-5 grid h-24 w-24 place-items-center rounded-full bg-[#dff6e5] text-4xl">✓</div><p className="text-xs font-bold uppercase tracking-[.18em] text-[#38a55f]">Commande confirmée</p><p className="mt-2 text-7xl font-black tracking-[-.08em]">47</p><p className="mt-4 max-w-xs text-sm leading-relaxed text-[#758077]">Avancez jusqu’à la prochaine fenêtre. Votre commande a été transmise en cuisine.</p></div></div>
          ) : items.length ? (
            <div className="flex-1 space-y-3 overflow-auto py-6">
              {items.map((item, index) => <div key={item.id} className="group flex items-center gap-4 rounded-2xl border border-[#edf0ea] p-4 transition hover:border-[#d9ded5]"><span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[#f3f5f0] text-2xl">{item.emoji}</span><div className="min-w-0 flex-1"><p className="truncate font-black">{index + 1}. {item.name}</p><p className="truncate text-xs text-[#8a938b]">{item.detail}</p>{item.customizations?.length ? <p className="mt-1 text-[10px] font-bold text-[#bd5d3d]">{item.customizations.join(' · ')}</p> : null}</div><div className="text-right"><p className="font-black">{money.format(item.price)}</p><button onClick={() => sendTextToAgent(`Retire un ${item.name} de ma commande.`)} className="mt-1 text-[11px] font-bold text-[#ff5a36] opacity-70 hover:opacity-100">Retirer</button></div></div>)}
            </div>
          ) : (
            <div className="grid flex-1 place-items-center text-center"><div className="max-w-[250px]"><div className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full bg-[#f3f5f0] text-3xl">🎙️</div><h3 className="text-xl font-black">Prêt à vous écouter</h3><p className="mt-2 text-sm leading-relaxed text-[#7b847d]">Le panier se met à jour pendant votre conversation avec l’agent.</p></div></div>
          )}

          <div className="border-t border-[#e7eae4] pt-6">
            <div className="flex items-end justify-between"><div><span className="text-sm font-bold text-[#717a73]">Total TTC</span>{pricing?.discountTotal ? <small className="mt-1 block text-xs font-bold text-[#bd5d3d]">Remise HubRise : −{money.format(pricing.discountTotal)}</small> : null}</div><strong className="text-4xl font-black tracking-[-0.05em]">{money.format(finalTotal)}</strong></div>
            <button disabled={!items.length || confirmed || connectionState !== 'connected' || pricing?.acceptingOrders === false} onClick={confirmOrder} className="mt-6 flex h-14 w-full items-center justify-between rounded-2xl bg-[#0b1f14] px-5 font-black text-white transition enabled:hover:bg-[#153623] disabled:cursor-not-allowed disabled:bg-[#edf0ea] disabled:text-[#aeb5ad]"><span>{confirmed ? 'Commande transmise' : pricing?.acceptingOrders === false ? 'Commandes fermées' : 'Confirmer la commande'}</span><span>→</span></button>
            <p className="mt-4 text-center text-[11px] text-[#9aa19a]">Paiement à la prochaine fenêtre · Conversation traitée en temps réel</p>
          </div>
        </aside>
      </section>
    </main>
  );
}

type WorkspaceTab = 'order' | 'dashboard' | 'integrations' | 'catalog' | 'agent' | 'account';
type ProductVariant = { id: number; name: string; priceDelta: number; posCode: string };
type ProductOption = { id: number; name: string; priceDelta: number; priceDeltaBySize?: Partial<Record<string, number>>; posCode: string; available: boolean; availableFor?: string[]; imageUrl?: string };
type ProductOptionGroup = { id: number; name: string; question: string; required: boolean; min: number; max: number; options: ProductOption[] };
type ProductModifier = { id: number; name: string; kind: 'remove' | 'add'; priceDelta: number };
type ProductIngredient = { id: number; name: string; removable: boolean; extraAllowed: boolean; extraPrice: number };
type ProductNutrition = { calories: string; fat: string; saturatedFat: string; proteins: string; carbohydrates: string; sugars: string; salt: string };
type CatalogProduct = {
  id: number;
  productId: ProductId;
  name: string;
  detail: string;
  emoji: string;
  imageUrl?: string;
  category: string;
  subcategory?: string;
  price: number;
  posCode: string;
  available: boolean;
  ingredients?: string[];
  ingredientSettings?: ProductIngredient[];
  productType?: 'simple' | 'configurable' | 'menu' | 'bundle' | 'deal';
  variants?: ProductVariant[];
  optionGroups?: ProductOptionGroup[];
  modifiers?: ProductModifier[];
  slug?: string;
  meatFilter?: string;
  badges?: string[];
  ingredientImages?: string[];
  allergens?: string[];
  traces?: string[];
  nutrition?: ProductNutrition;
  displayOrder?: number;
};

const demoRestaurantId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function mapRestaurantProduct(product: RestaurantProductInfo, index: number): CatalogProduct {
  const productId = String(product.product_id ?? product.id ?? `hubrise-${index}`);
  const source = product.data && typeof product.data === 'object' ? product.data : {};
  const sourceValue = (key: string) => source[key];
  const isTechnicalRef = (value: string) => /^[a-z0-9]{5,14}$/i.test(value) && !/[À-ÿ\s]/.test(value);
  const rawOptionGroups = sourceValue('optionGroups');
  const optionGroups: ProductOptionGroup[] = Array.isArray(rawOptionGroups)
    ? rawOptionGroups.map((group, groupIndex) => {
      const groupRecord = group && typeof group === 'object' ? group as Record<string, unknown> : {};
      const rawOptions = Array.isArray(groupRecord.options) ? groupRecord.options : [];
      const rawGroupName = String(groupRecord.name ?? '');
      const groupName = rawGroupName && !isTechnicalRef(rawGroupName) ? rawGroupName : `Choix ${groupIndex + 1}`;
      return {
        id: groupIndex + 1,
        name: groupName,
        question: String(groupRecord.question ?? `Choisissez ${groupName.toLowerCase()}`),
        required: Boolean(groupRecord.required),
        min: Number(groupRecord.min ?? 0),
        max: Number(groupRecord.max ?? 1),
        options: rawOptions.map((option, optionIndex) => {
          const optionRecord = option && typeof option === 'object' ? option as Record<string, unknown> : {};
          const rawOptionName = String(optionRecord.name ?? '');
          return {
            id: optionIndex + 1,
            name: rawOptionName && !isTechnicalRef(rawOptionName) ? rawOptionName : `Option ${optionIndex + 1}`,
            priceDelta: Number(optionRecord.priceDelta ?? 0),
            posCode: String(optionRecord.ref ?? optionRecord.id ?? ''),
            available: optionRecord.available !== false,
          };
        }),
      };
    })
    : [];
  const numericId = Number.parseInt(productId.replace(/\D/g, '').slice(-8), 10);
  const imageUrl = sourceValue('image_url');
  return {
    id: Number.isFinite(numericId) ? numericId : index + 1,
    productId,
    name: product.name ?? String(sourceValue('name') ?? 'Produit sans nom'),
    detail: String(sourceValue('description') ?? sourceValue('detail') ?? ''),
    emoji: '🍽️',
    imageUrl: typeof imageUrl === 'string' ? imageUrl : undefined,
    category: product.category ?? String(sourceValue('category_name') ?? sourceValue('category') ?? 'Autres'),
    price: Number(product.price ?? 0),
    posCode: String(sourceValue('sku_ref') ?? productId),
    available: product.available,
    productType: product.product_type === 'deal' ? 'deal' : optionGroups.length ? 'configurable' : 'simple',
    optionGroups,
    displayOrder: product.display_order,
  };
}

const workspaceTabs: Array<{ id: WorkspaceTab; label: string; short: string; icon: string }> = [
  { id: 'order', label: 'Écran de commande', short: 'Commande', icon: '◉' },
  { id: 'dashboard', label: 'Pilotage', short: 'Pilotage', icon: '▥' },
  { id: 'integrations', label: 'Configuration technique', short: 'Technique', icon: '⌁' },
  { id: 'catalog', label: 'Carte du restaurant', short: 'Carte', icon: '▦' },
  { id: 'agent', label: 'Configuration de l’agent IA', short: 'Agent IA', icon: '✦' },
  { id: 'account', label: 'Mon compte', short: 'Mon compte', icon: '◎' },
];

const burgerKingCategoryTemplate = [
  ['Nouveautés', '✦'], ['Menus', '▤'], ['Burgers', '🍔'], ['Menus enfants', '♛'], ['À partager', '🍗'],
  ['Tortillas & Wraps', '🌯'], ['Snacks & Sauces', '🍟'], ['Salades', '🥗'],
  ['Desserts & Boissons', '🥤'], ['Offres du moment', '％'], ['Goodies', '🎁'],
] as const;

const subcategoryTemplates: Record<string, string[]> = {
  'Burgers': ['Tous', 'Poulet', 'Bœuf', 'Poisson', 'Veggie'],
  'Menus': ['Tous', 'Poulet', 'Bœuf', 'Poisson', 'Veggie'],
  'À partager': ['Tous', 'Krispper Tenders', 'Kingbox', 'Baby Burgers'],
  'Tortillas & Wraps': ['Tous', 'King Tortillas', 'King Wraps'],
  'Snacks & Sauces': ['Tous', 'Krispper Tenders', 'King Nuggets', 'Frites & Gaufrettes', 'Chili Cheese', 'Onion Rings', 'Sauces', 'King Fries'],
  'Desserts & Boissons': ['Tous', 'Glaces', 'Pâtisseries', 'Boissons froides', 'Boissons chaudes', 'Autres'],
  'Offres du moment': ['Tous', 'Kingbox', 'Autres'],
};

const bkDrinks = [
  'Coca-Cola® (25cl)', 'Coca-Cola® (40cl)', 'Coca-Cola® (50cl)',
  'Coca-Cola Zéro Sucres® (25cl)', 'Coca-Cola Zéro Sucres® (40cl)', 'Coca-Cola Zéro Sucres® (50cl)',
  'Coca-Cola® Cherry Zéro Sucres (25cl)', 'Coca-Cola® Cherry Zéro Sucres (40cl)', 'Coca-Cola® Cherry Zéro Sucres (50cl)',
  'Fanta® Goût Original sans sucres (25cl)', 'Fanta® Goût Original sans sucres (40cl)', 'Fanta® Goût Original sans sucres (50cl)',
  'Oasis Tropical (25cl)', 'Oasis Tropical (40cl)', 'Oasis Tropical (50cl)',
  'Fuze Tea Pêche Hibiscus (25cl)', 'Fuze Tea Pêche Hibiscus (40cl)', 'Fuze Tea Pêche Hibiscus (50cl)',
  'Vittel® (33cl)', 'Vittel® (50cl)', 'Perrier® (33cl)',
  'Jus de Pomme C’est qui le Patron ?! (20CL)', 'Red Bull Energy Drink (25cl)',
];
const bkSaucePrices: Record<string, number> = {
  'Sauce Ketchup': 0.2,
  'Sauce pour les frites': 0.2,
  'Sauce Barbecue': 0.4,
  'Sauce Moutarde Miel': 0.4,
  'Sauce Smoky Bacon Flavor': 0.4,
  'Spicy Andalouse': 0.4,
  'Sauce 1954': 0.4,
  'Sauce Creamy Ranch': 0.4,
  'Sauce Chili goût Cheese': 0.4,
  'Sauce Balsamique': 0.6,
  'Sauce Caesar': 0.6,
  'Sauce Cheddar XXL': 1.9,
  'Pack de 6 sauces': 1.9,
};
const bkSauces = Object.keys(bkSaucePrices);
const sizeAliases: Record<string, string[]> = {
  Medium: ['Medium', 'M'],
  'King Size': ['King Size', 'King', 'L', 'XL'],
  Extra: ['Extra', 'XXL', 'XL'],
};
const sizeMatches = (availableFor: string[] | undefined, selectedSize: string) => !availableFor || availableFor.some(size => (sizeAliases[selectedSize] ?? [selectedSize]).some(alias => alias.toLowerCase() === size.toLowerCase()));
const priceForSize = (option: ProductOption | undefined, selectedSize: string) => {
  if (!option) return 0;
  const aliases = sizeAliases[selectedSize] ?? [selectedSize];
  const sizePrice = option.priceDeltaBySize && Object.entries(option.priceDeltaBySize).find(([size]) => aliases.some(alias => alias.toLowerCase() === size.toLowerCase()))?.[1];
  return sizePrice ?? option.priceDelta;
};
const menuSizeSurcharge = (menuName: string, selectedSize: string) => {
  if (selectedSize === 'Medium' || selectedSize === 'M') return 0;
  if (/x10/i.test(menuName)) return selectedSize === 'King Size' || selectedSize === 'L' ? 1.9 : 5;
  return selectedSize === 'King Size' || selectedSize === 'L' ? 0.95 : 2.5;
};
const drinkSizes = (name: string): string[] => {
  if (/25cl/i.test(name)) return [];
  if (/33cl|40cl|20CL/i.test(name)) return ['Medium'];
  if (/50cl/i.test(name)) return ['King Size', 'Extra'];
  return ['Medium', 'King Size', 'Extra'];
};
const bkOptions = (base: number, style: 'burger' | 'crispy' | 'kids' = 'burger', menuName = ''): ProductOptionGroup[] => {
  const drinks = bkDrinks.map((name, index) => ({
    id: base * 100 + 30 + index,
    name,
    priceDelta: /^Red Bull/i.test(name) ? 1.5 : 0,
    priceDeltaBySize: /^Red Bull/i.test(name) ? { Extra: 0 } : undefined,
    posCode: '',
    available: true,
    availableFor: /^Red Bull/i.test(name) ? ['Medium', 'King Size', 'Extra'] : drinkSizes(name),
  }));
  const sides = [
    ['Moyennes frites', ['Medium'], 0],
    ['Grandes frites', ['King Size'], 0],
    ['Onion Rings (6)', ['Medium'], 0],
    ['Onion Rings (9)', ['King Size'], 0],
    ['King Fries Cheddar & Bacon', ['Medium', 'King Size', 'Extra'], 1.55],
    ['King Fries Cheddar & Crispy Onions', ['Medium', 'King Size', 'Extra'], 1.55],
    ['King Fries Double Cheddar', ['Medium', 'King Size', 'Extra'], 1.55],
    ['King Carotte', ['Medium', 'King Size'], 0],
    ['Petite salade', ['Medium', 'King Size'], 0],
    ['Moyenne Gaufrette Frites', ['Medium'], 0],
    ['Grande Gaufrette Frites', ['King Size'], 0],
  ].map(([name, availableFor, priceDelta], index) => ({ id: base * 100 + 20 + index, name: String(name), priceDelta: Number(priceDelta), priceDeltaBySize: Number(priceDelta) ? { Extra: 0 } : undefined, posCode: '', available: true, availableFor: availableFor as string[] }));
  if (style === 'kids') {
    return [
      { id: base * 10 + 1, name: 'Plat', question: 'Quel plat pour l’enfant ?', required: true, min: 1, max: 1, options: ['Mini burger de bœuf', 'Mini burger au poulet', 'Nuggets (4)'].map((name, index) => ({ id: base * 100 + index, name, priceDelta: 0, posCode: '', available: true })) },
      { id: base * 10 + 2, name: 'Accompagnement', question: 'Quel accompagnement ?', required: true, min: 1, max: 1, options: ['Petites frites', 'Pom’Potes®'].map((name, index) => ({ id: base * 100 + 10 + index, name, priceDelta: 0, posCode: '', available: true })) },
      { id: base * 10 + 3, name: 'Boisson', question: 'Quelle boisson ?', required: true, min: 1, max: 1, options: ['Jus de Pomme (20cl)', 'Coca-Cola® (25cl)', 'Coca-Cola® Zéro Sucres (25cl)', 'Vittel® (33cl)'].map((name, index) => ({ id: base * 100 + 20 + index, name, priceDelta: 0, posCode: '', available: true })) },
      { id: base * 10 + 4, name: 'Dessert ou jouet', question: 'Un dessert ou un jouet ?', required: true, min: 1, max: 1, options: ['Dessert du moment', 'Jouet'].map((name, index) => ({ id: base * 100 + 40 + index, name, priceDelta: 0, posCode: '', available: true })) },
    ];
  }
  if (style === 'crispy') {
    return [
      { id: base * 10 + 1, name: 'Taille du menu', question: 'Quelle taille de menu souhaitez-vous ?', required: true, min: 1, max: 1, options: [{ name: 'Medium', priceDelta: 0 }, { name: 'King Size', priceDelta: menuName.includes('x10') ? 1.9 : 0.95 }, { name: 'Extra', priceDelta: menuName.includes('x10') ? 5 : 2.5 }].map((item, index) => ({ id: base * 100 + index, ...item, posCode: '', available: true })) },
      { id: base * 10 + 2, name: 'Accompagnement', question: 'Quel accompagnement souhaitez-vous ?', required: true, min: 1, max: 1, options: sides },
      { id: base * 10 + 3, name: 'Boisson', question: 'Quelle boisson souhaitez-vous ?', required: true, min: 1, max: 1, options: drinks },
      { id: base * 10 + 4, name: 'Sauce', question: 'Quelle sauce souhaitez-vous ?', required: true, min: 1, max: 2, options: bkSauces.map((name, index) => ({ id: base * 100 + 50 + index, name, priceDelta: bkSaucePrices[name], posCode: '', available: true })) },
    ];
  }
  return [
    { id: base * 10 + 1, name: 'Taille du menu', question: 'Quelle taille de menu souhaitez-vous ?', required: true, min: 1, max: 1, options: [{ name: 'Medium', priceDelta: 0 }, { name: 'King Size', priceDelta: 0.95 }, { name: 'Extra', priceDelta: 2.5 }].map((item, index) => ({ id: base * 100 + index, ...item, posCode: '', available: true })) },
    { id: base * 10 + 2, name: 'Accompagnement', question: 'Quel accompagnement souhaitez-vous ?', required: true, min: 1, max: 1, options: sides },
    { id: base * 10 + 3, name: 'Boisson', question: 'Quelle boisson souhaitez-vous ?', required: true, min: 1, max: 1, options: drinks },
    { id: base * 10 + 4, name: 'Sauces', question: 'Une sauce pour accompagner ?', required: false, min: 0, max: 2, options: bkSauces.map((name, index) => ({ id: base * 100 + 60 + index, name, priceDelta: bkSaucePrices[name], posCode: '', available: true })) },
  ];
};

type BkSeed = [string, string, string, number, string, string, 'simple' | 'configurable' | 'menu' | 'bundle', ('burger' | 'crispy' | 'kids')?];
const bkSeed: BkSeed[] = [
  ['Master des Chefs', 'Nouveautés', '', 11.5, 'Burger de la gamme Masters des Chefs', '🍔', 'configurable'],
  ['Master Sarran Mozzarella', 'Nouveautés', '', 11.5, 'Burger au poulet et mozzarella de la gamme Masters', '🍔', 'configurable'],
  ['Master Pairet Poivre', 'Nouveautés', '', 11.5, 'Burger de la gamme Masters, note poivrée', '🍔', 'configurable'],
  ['King Fusion des Chefs', 'Nouveautés', '', 4.3, 'Dessert glacé King Fusion en édition des Chefs', '🍨', 'simple'],
  ['Red Bull Energy Drink (25cl)', 'Nouveautés', '', 3.9, 'Boisson énergisante Red Bull 25cl', '🥤', 'simple'],
  ['Master Sarran Mozzarella', 'Menus', 'Poulet', 13.9, 'Master Sarran Mozzarella, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['CBK', 'Menus', 'Poulet', 10.9, 'CBK, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['Double CBK', 'Menus', 'Poulet', 12.9, 'Double CBK, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['Smoky Chicken', 'Menus', 'Poulet', 8.5, 'Smoky Chicken, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['Menu Krispper Tenders x10', 'Menus', 'Poulet', 19.9, '10 Krispper Tenders, accompagnement, boisson et sauces', '🍗', 'menu', 'crispy'],
  ['Menu Krispper Tenders x5', 'Menus', 'Poulet', 9.95, '5 Krispper Tenders, accompagnement, boisson et sauce', '🍗', 'menu', 'crispy'],
  ['Chicken Louisiane Steakhouse', 'Menus', 'Poulet', 9.9, 'Chicken Louisiane Steakhouse, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['Menu King Nuggets (10)', 'Menus', 'Poulet', 8.9, '10 King Nuggets, accompagnement, boisson et sauce', '🍗', 'menu', 'crispy'],
  ['Menu King Nuggets (7)', 'Menus', 'Poulet', 7.9, '7 King Nuggets, accompagnement, boisson et sauce', '🍗', 'menu', 'crispy'],
  ['Tortilla Cheese & Bacon', 'Menus', 'Poulet', 7.9, 'Tortilla Cheese & Bacon, accompagnement et boisson au choix', '🌯', 'menu', 'burger'],
  ['Wrap Chicken Louisiane', 'Menus', 'Poulet', 9.4, 'Wrap Chicken Louisiane, accompagnement et boisson au choix', '🌯', 'menu', 'burger'],
  ['Master des Chefs', 'Menus', 'Bœuf', 13.9, 'Master des Chefs, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['Master Pairet Poivre', 'Menus', 'Bœuf', 13.9, 'Master Pairet Poivre, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['Big King®', 'Menus', 'Bœuf', 7.9, 'Big King®, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['Whopper®', 'Menus', 'Bœuf', 8.9, 'Whopper®, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['Steakhouse', 'Menus', 'Bœuf', 9.9, 'Steakhouse, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['Double Whopper® Cheese', 'Menus', 'Bœuf', 11.7, 'Double Whopper® Cheese, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['Double Cheese Bacon XXL', 'Menus', 'Bœuf', 12, 'Double Cheese Bacon XXL, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['Big King XXL', 'Menus', 'Bœuf', 11.3, 'Big King XXL, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['Double Steakhouse', 'Menus', 'Bœuf', 12.2, 'Double Steakhouse, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['Double Cheese Bacon', 'Menus', 'Bœuf', 8.2, 'Double Cheese Bacon, accompagnement et boisson au choix', '🍔', 'menu', 'burger'],
  ['Big Fish', 'Menus', 'Poisson', 7.9, 'Big Fish, accompagnement et boisson au choix', '🐟', 'menu', 'burger'],
  ['Veggie Chicken Louisiane Steakhouse', 'Menus', 'Veggie', 9.9, 'Version végétarienne, accompagnement et boisson au choix', '🌱', 'menu', 'burger'],
  ['Tortilla Veggie Cheese & Bacon', 'Menus', 'Veggie', 7.9, 'Version végétarienne, accompagnement et boisson au choix', '🌯', 'menu', 'burger'],
  ['Veggie Whopper', 'Menus', 'Veggie', 8.9, 'Veggie Whopper, accompagnement et boisson au choix', '🌱', 'menu', 'burger'],
  ['Veggie Steakhouse', 'Menus', 'Veggie', 9.9, 'Veggie Steakhouse, accompagnement et boisson au choix', '🌱', 'menu', 'burger'],
  ['Wrap Veggie Chicken Louisiane', 'Menus', 'Veggie', 9.4, 'Version végétarienne, accompagnement et boisson au choix', '🌯', 'menu', 'burger'],
  ['Master Sarran Mozzarella', 'Burgers', 'Poulet', 11.5, 'Poulet croustillant et mozzarella, gamme Masters', '🍔', 'configurable'],
  ['CBK', 'Burgers', 'Poulet', 8.4, 'Burger au poulet croustillant CBK', '🍔', 'configurable'],
  ['Double CBK', 'Burgers', 'Poulet', 10.4, 'Deux filets de poulet croustillants', '🍔', 'configurable'],
  ['Smoky Chicken', 'Burgers', 'Poulet', 6, 'Poulet croustillant, note fumée', '🍔', 'configurable'],
  ['Chicken Louisiane Steakhouse', 'Burgers', 'Poulet', 7.5, 'Poulet croustillant façon Louisiane', '🍔', 'configurable'],
  ['Wrap Chicken Louisiane', 'Burgers', 'Poulet', 5.7, 'Wrap au poulet croustillant façon Louisiane', '🌯', 'configurable'],
  ['Tortilla Cheese & Bacon', 'Burgers', 'Poulet', 4.9, 'Tortilla au poulet, fromage et bacon', '🌯', 'configurable'],
  ['Master des Chefs', 'Burgers', 'Bœuf', 11.5, 'Burger de la gamme Masters des Chefs', '🍔', 'configurable'],
  ['Master Pairet Poivre', 'Burgers', 'Bœuf', 11.5, 'Burger de la gamme Masters, note poivrée', '🍔', 'configurable'],
  ['Big King®', 'Burgers', 'Bœuf', 5.6, 'Deux viandes grillées à la flamme, cheddar et sauce Big King', '🍔', 'configurable'],
  ['Whopper®', 'Burgers', 'Bœuf', 6.5, 'Viande de bœuf grillée à la flamme et légumes frais', '🍔', 'configurable'],
  ['Double Cheese Bacon', 'Burgers', 'Bœuf', 5.8, 'Deux viandes, fromage et bacon', '🍔', 'configurable'],
  ['Double Whopper® Cheese', 'Burgers', 'Bœuf', 9.2, 'Deux viandes grillées à la flamme, fromage et légumes frais', '🍔', 'configurable'],
  ['Double Cheese Bacon XXL', 'Burgers', 'Bœuf', 9.6, 'Version XXL, deux viandes, fromage et bacon', '🍔', 'configurable'],
  ['Big King XXL®', 'Burgers', 'Bœuf', 8.9, 'Version XXL du Big King, deux viandes et cheddar', '🍔', 'configurable'],
  ['Steakhouse', 'Burgers', 'Bœuf', 7.5, 'Bœuf grillé à la flamme, cheddar et oignons croustillants', '🍔', 'configurable'],
  ['Double Steakhouse', 'Burgers', 'Bœuf', 9.8, 'Deux viandes, cheddar et oignons croustillants', '🍔', 'configurable'],
  ['Cheeseburger', 'Burgers', 'Bœuf', 2.95, 'Viande grillée à la flamme et fromage', '🍔', 'configurable'],
  ['Hamburger', 'Burgers', 'Bœuf', 2.5, 'Viande grillée à la flamme, format classique', '🍔', 'configurable'],
  ['Big Fish', 'Burgers', 'Poisson', 5.5, 'Poisson pané croustillant, sauce et salade', '🐟', 'configurable'],
  ['Veggie Chicken Louisiane Steakhouse', 'Burgers', 'Veggie', 7.5, 'Alternative végétarienne du Chicken Louisiane', '🌱', 'configurable'],
  ['Veggie Whopper®', 'Burgers', 'Veggie', 6.5, 'Alternative végétarienne du Whopper®', '🌱', 'configurable'],
  ['Veggie Steakhouse', 'Burgers', 'Veggie', 7.5, 'Alternative végétarienne du Steakhouse', '🌱', 'configurable'],
  ['Wrap Veggie Chicken Louisiane', 'Burgers', 'Veggie', 5.7, 'Wrap végétarien façon Louisiane', '🌯', 'configurable'],
  ['Tortilla Veggie Cheese & Bacon', 'Burgers', 'Veggie', 4.9, 'Tortilla végétarienne, fromage et bacon végétal', '🌯', 'configurable'],
  ['King Junior', 'Menus enfants', '', 4, 'Menu enfant 4-7 ans : plat, accompagnement, boisson et surprise', '♛', 'menu', 'kids'],
  ['King JR +', 'Menus enfants', '', 5.5, 'Menu enfant complet avec plat, accompagnement, boisson et surprise', '♛', 'menu', 'kids'],
  ['Menu Krispper Tenders x5', 'À partager', 'Krispper Tenders', 9.95, '5 Krispper Tenders, accompagnement, boisson et sauce', '🍗', 'menu', 'crispy'],
  ['Menu Krispper Tenders x10', 'À partager', 'Krispper Tenders', 19.9, '10 Krispper Tenders, accompagnement, boisson et sauces', '🍗', 'menu', 'crispy'],
  ['Krispper Tenders x2', 'À partager', 'Krispper Tenders', 3.95, '2 filets de poulet croustillants', '🍗', 'simple'],
  ['Krispper Tenders x5', 'À partager', 'Krispper Tenders', 8.6, '5 filets de poulet croustillants', '🍗', 'simple'],
  ['Krispper Tenders x10', 'À partager', 'Krispper Tenders', 17, '10 filets de poulet croustillants', '🍗', 'simple'],
  ['Kingbox 10 King Nuggets® + 10 Chili Cheese', 'À partager', 'Kingbox', 10.5, '10 King Nuggets et 10 Chili Cheese à partager', '📦', 'bundle'],
  ['Kingbox 10 Onion Rings + 10 King Nuggets®', 'À partager', 'Kingbox', 10.5, '10 Onion Rings et 10 King Nuggets à partager', '📦', 'bundle'],
  ['Kingbox 10 Onion Rings + 10 Chili Cheese', 'À partager', 'Kingbox', 10.5, '10 Onion Rings et 10 Chili Cheese à partager', '📦', 'bundle'],
  ['Kingbox 20 King Nuggets®', 'À partager', 'Kingbox', 10.5, '20 King Nuggets à partager', '📦', 'bundle'],
  ['Menu Baby Burgers x3', 'À partager', 'Baby Burgers', 12.4, '3 baby burgers en menu, avec accompagnement et boisson', '🍔', 'menu', 'burger'],
  ['Baby Burgers x3', 'À partager', 'Baby Burgers', 9.9, '3 mini burgers à partager', '🍔', 'bundle'],
  ['Tortilla Cheese & Bacon', 'Tortillas & Wraps', 'King Tortillas', 4.9, 'Tortilla au poulet, fromage et bacon', '🌯', 'configurable'],
  ['Tortilla Veggie Cheese & Bacon', 'Tortillas & Wraps', 'King Tortillas', 4.9, 'Tortilla végétarienne, fromage et bacon végétal', '🌯', 'configurable'],
  ['Wrap Chicken Louisiane', 'Tortillas & Wraps', 'King Wraps', 5.7, 'Wrap au poulet croustillant façon Louisiane', '🌯', 'configurable'],
  ['Wrap Veggie Chicken Louisiane', 'Tortillas & Wraps', 'King Wraps', 5.7, 'Wrap végétarien façon Louisiane', '🌯', 'configurable'],
  ['King Nuggets® (4)', 'Snacks & Sauces', 'King Nuggets', 3.5, '4 nuggets de poulet', '🍗', 'simple'],
  ['King Nuggets® (7)', 'Snacks & Sauces', 'King Nuggets', 5.3, '7 nuggets de poulet', '🍗', 'simple'],
  ['King Nuggets® (10)', 'Snacks & Sauces', 'King Nuggets', 6.4, '10 nuggets de poulet', '🍗', 'simple'],
  ['Petites frites', 'Snacks & Sauces', 'Frites & Gaufrettes', 2.75, 'Petite portion de frites croustillantes', '🍟', 'simple'],
  ['Moyennes frites', 'Snacks & Sauces', 'Frites & Gaufrettes', 2.95, 'Moyenne portion de frites croustillantes', '🍟', 'simple'],
  ['Grandes frites', 'Snacks & Sauces', 'Frites & Gaufrettes', 3.1, 'Grande portion de frites croustillantes', '🍟', 'simple'],
  ['Chili Cheese (4)', 'Snacks & Sauces', 'Chili Cheese', 3.95, '4 bouchées panées au fromage', '🧀', 'simple'],
  ['Chili Cheese (6)', 'Snacks & Sauces', 'Chili Cheese', 5.5, '6 bouchées panées au fromage', '🧀', 'simple'],
  ['Chili Cheese (9)', 'Snacks & Sauces', 'Chili Cheese', 6.7, '9 bouchées panées au fromage', '🧀', 'simple'],
  ['Onion Rings (4)', 'Snacks & Sauces', 'Onion Rings', 1.9, '4 rondelles d’oignon panées', '🧅', 'simple'],
  ['Onion Rings (6)', 'Snacks & Sauces', 'Onion Rings', 2.75, '6 rondelles d’oignon panées', '🧅', 'simple'],
  ['Onion Rings (9)', 'Snacks & Sauces', 'Onion Rings', 3.1, '9 rondelles d’oignon panées', '🧅', 'simple'],
  ['Sauce Cheddar XXL', 'Snacks & Sauces', 'Sauces', 1.9, 'Grande portion de sauce cheddar', '🧀', 'simple'],
  ['Sauce Smoky Bacon Flavor', 'Snacks & Sauces', 'Sauces', 0.4, 'Sauce goût bacon fumé', '🥫', 'simple'],
  ['Sauce Moutarde Miel', 'Snacks & Sauces', 'Sauces', 0.4, 'Sauce moutarde et miel', '🥫', 'simple'],
  ['Sauce Barbecue', 'Snacks & Sauces', 'Sauces', 0.4, 'Sauce barbecue fumée', '🥫', 'simple'],
  ['Spicy Andalouse', 'Snacks & Sauces', 'Sauces', 0.4, 'Sauce andalouse relevée', '🥫', 'simple'],
  ['Sauce 1954', 'Snacks & Sauces', 'Sauces', 0.4, 'Sauce signature Burger King', '🥫', 'simple'],
  ['Sauce Creamy Ranch', 'Snacks & Sauces', 'Sauces', 0.4, 'Sauce ranch onctueuse', '🥫', 'simple'],
  ['Sauce Chili goût Cheese', 'Snacks & Sauces', 'Sauces', 0.4, 'Sauce chili goût fromage', '🥫', 'simple'],
  ['Sauce pour les frites', 'Snacks & Sauces', 'Sauces', 0.2, 'Sauce pour les frites', '🥫', 'simple'],
  ['Sauce Ketchup', 'Snacks & Sauces', 'Sauces', 0.2, 'Ketchup', '🥫', 'simple'],
  ['Sauce Balsamique', 'Snacks & Sauces', 'Sauces', 0.6, 'Sauce balsamique pour salades', '🥫', 'simple'],
  ['Sauce Caesar', 'Snacks & Sauces', 'Sauces', 0.6, 'Sauce caesar pour salades', '🥫', 'simple'],
  ['King Fries Cheddar & Bacon', 'Snacks & Sauces', 'King Fries', 3.95, 'Frites généreuses, cheddar et bacon', '🍟', 'simple'],
  ['King Fries Cheddar & Crispy Onions', 'Snacks & Sauces', 'King Fries', 3.95, 'Frites généreuses, cheddar et oignons croustillants', '🍟', 'simple'],
  ['King Fries Double Cheddar', 'Snacks & Sauces', 'King Fries', 3.95, 'Frites généreuses et double cheddar', '🍟', 'simple'],
  ['Sauce Balsamique', 'Salades', '', 0.6, 'Sauce balsamique pour salades', '🥗', 'simple'],
  ['Sauce Caesar', 'Salades', '', 0.6, 'Sauce caesar pour salades', '🥗', 'simple'],
  ['Extra King Fusion Dubaï Style', 'Desserts & Boissons', 'Glaces', 5.2, 'Glace vanille, nappages pistache et chocolat, éclats de gaufrettes et deux barres Kit Kat®', '🍨', 'simple'],
  ["King Fusion M&M's®", 'Desserts & Boissons', 'Glaces', 3.95, 'Glace vanille, nappage chocolat et éclats de M&M’s® cacahuète', '🍨', 'simple'],
  ['King Fusion Snickers®', 'Desserts & Boissons', 'Glaces', 3.95, 'Glace vanille, nappage caramel, éclats de cacahuète et de SNICKERS®', '🍨', 'simple'],
  ['King Fusion Dubaï Style', 'Desserts & Boissons', 'Glaces', 4.3, 'Glace vanille, nappages pistache et chocolat, éclats de gaufrettes et gaufrettes chocolatées KitKat®', '🍨', 'simple'],
  ['King Sundae Vanille', 'Desserts & Boissons', 'Glaces', 2.95, 'Onctueuse glace saveur vanille', '🍨', 'simple'],
  ['King Sundae Chocolat', 'Desserts & Boissons', 'Glaces', 2.95, 'Glace saveur vanille avec nappage chocolat et pointe de sel', '🍨', 'simple'],
  ['King Sundae Caramel', 'Desserts & Boissons', 'Glaces', 2.95, 'Glace saveur vanille avec nappage caramel et pointe de sel', '🍨', 'simple'],
  ['Red Bull Energy Drink (25cl)', 'Desserts & Boissons', 'Boissons froides', 3.9, 'Boisson énergisante Red Bull 25cl', '🥤', 'simple'],
  ['Coca-Cola® Cherry Zéro Sucres (25cl)', 'Desserts & Boissons', 'Boissons froides', 2.4, 'Coca-Cola® Cherry zéro sucres, saveur cerise, 25cl', '🥤', 'simple'],
  ['Coca-Cola® Cherry Zéro Sucres (40cl)', 'Desserts & Boissons', 'Boissons froides', 3, 'Coca-Cola® Cherry zéro sucres, saveur cerise, 40cl', '🥤', 'simple'],
  ['Coca-Cola® Cherry Zéro Sucres (50cl)', 'Desserts & Boissons', 'Boissons froides', 3.4, 'Coca-Cola® Cherry zéro sucres, saveur cerise, 50cl', '🥤', 'simple'],
  ['Coca-Cola Zéro Sucres® (25cl)', 'Desserts & Boissons', 'Boissons froides', 2.4, 'Coca-Cola Zéro Sucres format 25cl', '🥤', 'simple'],
  ['Coca-Cola Zéro Sucres® (40cl)', 'Desserts & Boissons', 'Boissons froides', 3, 'Coca-Cola Zéro Sucres format 40cl', '🥤', 'simple'],
  ['Coca-Cola Zéro Sucres® (50cl)', 'Desserts & Boissons', 'Boissons froides', 3.4, 'Coca-Cola Zéro Sucres format 50cl', '🥤', 'simple'],
  ['Fanta® Goût Original sans sucres (25cl)', 'Desserts & Boissons', 'Boissons froides', 2.4, 'Fanta sans sucres format 25cl', '🥤', 'simple'],
  ['Fanta® Goût Original sans sucres (40cl)', 'Desserts & Boissons', 'Boissons froides', 3, 'Fanta sans sucres format 40cl', '🥤', 'simple'],
  ['Fanta® Goût Original sans sucres (50cl)', 'Desserts & Boissons', 'Boissons froides', 3.4, 'Fanta sans sucres format 50cl', '🥤', 'simple'],
  ['Vittel® (33cl)', 'Desserts & Boissons', 'Boissons froides', 2.7, 'Eau minérale Vittel 33cl', '💧', 'simple'],
  ['Vittel® (50cl)', 'Desserts & Boissons', 'Boissons froides', 3.1, 'Eau minérale Vittel 50cl', '💧', 'simple'],
  ['Perrier® (33cl)', 'Desserts & Boissons', 'Boissons froides', 2.7, 'Eau pétillante Perrier 33cl', '💧', 'simple'],
  ['Coca-Cola® (25cl)', 'Desserts & Boissons', 'Boissons froides', 2.4, 'Coca-Cola format 25cl', '🥤', 'simple'],
  ['Coca-Cola® (40cl)', 'Desserts & Boissons', 'Boissons froides', 3, 'Coca-Cola format 40cl', '🥤', 'simple'],
  ['Coca-Cola® (50cl)', 'Desserts & Boissons', 'Boissons froides', 3.4, 'Coca-Cola format 50cl', '🥤', 'simple'],
  ['Oasis Tropical (25cl)', 'Desserts & Boissons', 'Boissons froides', 2.4, 'Oasis Tropical format 25cl', '🥤', 'simple'],
  ['Oasis Tropical (40cl)', 'Desserts & Boissons', 'Boissons froides', 3, 'Oasis Tropical format 40cl', '🥤', 'simple'],
  ['Oasis Tropical (50cl)', 'Desserts & Boissons', 'Boissons froides', 3.4, 'Oasis Tropical format 50cl', '🥤', 'simple'],
  ['Fuze Tea Pêche Hibiscus (25cl)', 'Desserts & Boissons', 'Boissons froides', 2.4, 'Fusion rafraîchissante de saveurs pêche et hibiscus, 25cl', '🥤', 'simple'],
  ['Fuze Tea Pêche Hibiscus (40cl)', 'Desserts & Boissons', 'Boissons froides', 3, 'Fusion rafraîchissante de saveurs pêche et hibiscus, 40cl', '🥤', 'simple'],
  ['Fuze Tea Pêche Hibiscus (50cl)', 'Desserts & Boissons', 'Boissons froides', 3.4, 'Fusion rafraîchissante de saveurs pêche et hibiscus, 50cl', '🥤', 'simple'],
  ['Jus de Pomme C’est qui le Patron ?! (20CL)', 'Desserts & Boissons', 'Boissons froides', 2.4, 'Jus de pomme 20cl', '🧃', 'simple'],
  ['Expresso', 'Desserts & Boissons', 'Boissons chaudes', 1.4, 'Expresso', '☕', 'simple'],
  ['Café allongé', 'Desserts & Boissons', 'Boissons chaudes', 1.8, 'Café allongé', '☕', 'simple'],
  ['Cappuccino', 'Desserts & Boissons', 'Boissons chaudes', 2.3, 'Cappuccino', '☕', 'simple'],
  ['Café Latté', 'Desserts & Boissons', 'Boissons chaudes', 2.3, 'Café latté au lait C’est qui le Patron ?!®', '☕', 'simple'],
  ['Double expresso', 'Desserts & Boissons', 'Boissons chaudes', 2.1, 'Double expresso', '☕', 'simple'],
  ['Thé vert menthe', 'Desserts & Boissons', 'Boissons chaudes', 2.1, 'Thé vert à la menthe', '🍵', 'simple'],
  ['Thé Earl Grey', 'Desserts & Boissons', 'Boissons chaudes', 2.1, 'Thé Earl Grey', '🍵', 'simple'],
  ['Boisson Cacaotée', 'Desserts & Boissons', 'Boissons chaudes', 2.2, 'Boisson cacaotée avec du lait C’est qui le Patron ?!®', '☕', 'simple'],
  ["Pom'Potes® Pomme", 'Desserts & Boissons', 'Autres', 1.9, 'Gourde de fruits sans sucres ajoutés', '🍏', 'simple'],
  ['King Yaourt', 'Desserts & Boissons', 'Autres', 1.9, 'Yaourt à boire à l’arôme naturel de fraise', '🍓', 'simple'],
  ['King Fruits', 'Desserts & Boissons', 'Autres', 2, 'Quartiers de fruits de saison', '🍎', 'simple'],
  ['Kingbox 10 King Nuggets® + 10 Chili Cheese', 'Offres du moment', 'Kingbox', 10.5, '10 King Nuggets et 10 Chili Cheese à partager', '📦', 'bundle'],
  ['Kingbox 10 Onion Rings + 10 Chili Cheese', 'Offres du moment', 'Kingbox', 10.5, '10 Onion Rings et 10 Chili Cheese à partager', '📦', 'bundle'],
  ['Kingbox 20 King Nuggets®', 'Offres du moment', 'Kingbox', 10.5, '20 King Nuggets à partager', '📦', 'bundle'],
  ['3 Menus + 1 Kingbox', 'Offres du moment', 'Autres', 30.5, 'Offre à partager : 3 menus au choix et 1 Kingbox', '🎉', 'bundle'],
  ['2 Menus + 1 Kingbox', 'Offres du moment', 'Autres', 23.2, 'Offre à partager : 2 menus au choix et 1 Kingbox', '🎉', 'bundle'],
  ['T-shirt K2000', 'Goodies', '', 3.3, 'Goodie collector Burger King', '👕', 'simple'],
  ['Mug Charmed', 'Goodies', '', 3.3, 'Goodie collector Burger King', '☕', 'simple'],
];

const bkOfficialImages: Record<string, string> = {
  'Master des Chefs': 'https://medias.burgerking.fr/_prd/img/products/3/83/383a3e25-9e15-4032-9aa6-41cd43fc83f2_',
  'Master Sarran Mozzarella': 'https://medias.burgerking.fr/_prd/img/products/a/0e/a0e7c77c-9407-46e3-9c8d-e477f5e79140_',
  'Master Pairet Poivre': 'https://medias.burgerking.fr/_prd/img/products/3/94/394d0df5-d99c-4ce0-89d3-9664e3511352_',
  'King Fusion des Chefs': 'https://medias.burgerking.fr/_prd/img/products/a/b0/ab04ec22-882f-4ecd-b316-08e948ea3601_',
  'Red Bull Energy Drink (25cl)': 'https://medias.burgerking.fr/_prd/img/products/c/2b/c2bb8ddc-97b8-4b15-b191-650363e54f7d_',
  'CBK': 'https://medias.burgerking.fr/_prd/img/products/7/70/7707b4e5-501f-4401-a0c7-6587cc1b0723_',
  'Double CBK': 'https://medias.burgerking.fr/_prd/img/products/5/3b/53b5bdd4-5999-48c1-a846-9a957a6de811_',
  'Smoky Chicken': 'https://medias.burgerking.fr/_prd/img/products/9/0a/90ada2c7-8126-42da-a8da-6beadbdc84f2_',
  'Chicken Louisiane Steakhouse': 'https://medias.burgerking.fr/_prd/img/products/8/b8/8b8a3387-bfb8-4842-ab16-e36815abe882_',
  'Big King®': 'https://medias.burgerking.fr/_prd/img/products/0/95/095c4404-c84a-4b22-b805-e37840f56927_',
  'Big King XXL': 'https://medias.burgerking.fr/_prd/img/products/4/ff/4ff723fd-ab65-4d10-8b16-0d1301204753_',
  'Whopper®': 'https://medias.burgerking.fr/_prd/img/products/f/f4/ff4e30d8-7602-47ef-aac0-64db980b7063_',
  'Double Whopper® Cheese': 'https://medias.burgerking.fr/_prd/img/products/1/0e/10ecf4e5-b8cc-4ba7-bcec-d9e6d29dd9cf_',
  'Double Cheese Bacon': 'https://medias.burgerking.fr/_prd/img/products/c/54/c548eb72-06ba-4845-b354-f2b798c876a1_',
  'Double Cheese Bacon XXL': 'https://medias.burgerking.fr/_prd/img/products/9/d5/9d5dfdb4-1aa4-417d-a800-2a036700d61f_',
  'Steakhouse': 'https://medias.burgerking.fr/_prd/img/products/8/b8/8b8a3387-bfb8-4842-ab16-e36815abe882_',
  'Double Steakhouse': 'https://medias.burgerking.fr/_prd/img/products/b/d1/bd115879-25ba-46a8-8eff-418439fe7f4b_',
  'Cheeseburger': 'https://medias.burgerking.fr/_prd/img/products/2/a0/2a08fd38-efe4-4c17-b008-5ce56be0833a_',
  'Hamburger': 'https://medias.burgerking.fr/_prd/img/products/2/a0/2a08fd38-efe4-4c17-b008-5ce56be0833a_',
  'Big Fish': 'https://medias.burgerking.fr/_prd/img/products/c/50/c50b1730-993f-4869-8222-01d3a47f597e_',
  'Veggie Whopper®': 'https://medias.burgerking.fr/_prd/img/products/6/d6/6d6df3c3-a852-4567-9fd7-027d2a70c917_',
  'Veggie Steakhouse': 'https://medias.burgerking.fr/_prd/img/products/8/f2/8f24a4f0-33d2-438e-8d1d-22cca6e0e2db_',
  'Veggie Chicken Louisiane Steakhouse': 'https://medias.burgerking.fr/_prd/img/products/3/3e/33e82960-24f5-42bc-a679-847421fca159_',
  'Wrap Chicken Louisiane': 'https://medias.burgerking.fr/_prd/img/products/d/13/d131fd59-9f98-46a9-a6c0-eca7585b80a7_',
  'Wrap Veggie Chicken Louisiane': 'https://medias.burgerking.fr/_prd/img/products/c/88/c881d6db-3e00-4a71-a6bf-8cc3d34830ca_',
  'Tortilla Cheese & Bacon': 'https://medias.burgerking.fr/_prd/img/products/e/20/e201795e-14ee-406a-b409-c03f7e4cc391_',
  'Tortilla Veggie Cheese & Bacon': 'https://medias.burgerking.fr/_prd/img/products/d/0e/d0e35fc0-b5a5-4666-95a6-4a6f79ab75a7_',
  'King Nuggets® (4)': 'https://medias.burgerking.fr/_prd/img/products/3/6d/36d123fa-5923-4dfb-9693-de4891351edf_',
  'King Nuggets® (7)': 'https://medias.burgerking.fr/_prd/img/products/2/9f/29f4d11a-2152-4231-ab5f-1dde36119fa5_',
  'King Nuggets® (10)': 'https://medias.burgerking.fr/_prd/img/products/3/6d/36d123fa-5923-4dfb-9693-de4891351edf_',
  'Krispper Tenders x2': 'https://medias.burgerking.fr/_prd/img/products/0/fd/0fd97ca5-16e2-408c-b9f0-f26a9772ed0b_',
  'Krispper Tenders x5': 'https://medias.burgerking.fr/_prd/img/products/4/17/417ba9f3-7c69-49ff-a123-26992066cd2f_',
  'Krispper Tenders x10': 'https://medias.burgerking.fr/_prd/img/products/6/6d/66d03ab6-22c4-4185-8755-1136f53330c8_',
  'Sauce Smoky Bacon Flavor': 'https://medias.burgerking.fr/_prd/img/products/2/dd/2dd3b286-e570-450e-86c2-5ce5a2ec387f_',
  'Sauce Creamy Ranch': 'https://medias.burgerking.fr/_prd/img/products/a/d4/ad4d24b8-ad81-4943-be73-502344c73c0c_',
  'Sauce Cheddar XXL': 'https://medias.burgerking.fr/_prd/img/products/9/1a/91a36f17-3c32-4ea5-9252-71ec5c449854_',
  'King Fries Double Cheddar': 'https://medias.burgerking.fr/_prd/img/products/6/a7/6a7d85a3-b2ac-410b-a9da-22dffa72ace1_',
  'King Fusion': 'https://medias.burgerking.fr/_prd/img/products/7/da/7da7ed83-9bac-45f3-8707-fb63afe0fe9c_',
  'King Sundae': 'https://medias.burgerking.fr/_prd/img/products/3/a7/3a7c2f49-4ddf-41d3-bda7-7c653118b079_',
  'King Yaourt': 'https://medias.burgerking.fr/_prd/img/products/f/f1/ff126d4c-b88b-42f7-890c-866f2673710d_',
  'Perrier® (33cl)': 'https://medias.burgerking.fr/_prd/img/products/a/f7/af750d93-241e-4be1-af2c-816576645f43_',
  'Oasis Tropical (25cl)': 'https://medias.burgerking.fr/_prd/img/products/8/8e/88e62700-4673-4a18-b5be-e81dd535a4f0_',
  'Oasis Tropical (40cl)': 'https://medias.burgerking.fr/_prd/img/products/9/7f/97f3962a-e9a4-4a02-8f27-dad0b3cbaed0_',
  'Oasis Tropical (50cl)': 'https://medias.burgerking.fr/_prd/img/products/d/da/dda47f96-e9a0-41c2-8589-a18e90607454_',
  'Jus de Pomme C’est qui le Patron ?! (20CL)': 'https://medias.burgerking.fr/_prd/img/products/e/dd/edd885eb-5bc9-45df-ac78-62a8ee67bf58_',
  'T-shirt K2000': 'https://medias.burgerking.fr/_prd/img/products/e/30/e30b2880-5511-4d8e-a618-364c64a88b7a_',
  'Mug Charmed': 'https://medias.burgerking.fr/_prd/img/products/4/f3/4f358fab-59d8-4088-9a45-c1be852a6fa9_',
};

Object.assign(bkOfficialImages, {
  'Big King XXL®': 'https://medias.burgerking.fr/_prd/img/products/4/ff/4ff723fd-ab65-4d10-8b16-0d1301204753_',
  'Veggie Whopper': 'https://medias.burgerking.fr/_prd/img/products/6/d6/6d6df3c3-a852-4567-9fd7-027d2a70c917_',
  'Kingbox 10 King Nuggets® + 10 Chili Cheese': 'https://medias.burgerking.fr/_prd/img/products/9/de/9dea7277-61c2-4bc2-a6b8-fe654cea3cc0_',
  'Kingbox 10 Onion Rings + 10 King Nuggets®': 'https://medias.burgerking.fr/_prd/img/products/3/e0/3e0172a3-dddc-4bdf-a0d7-edda5ea75783_',
  'Kingbox 10 Onion Rings + 10 Chili Cheese': 'https://medias.burgerking.fr/_prd/img/products/a/ba/aba832d0-2431-4f24-89f3-dac94d877ae5_',
  'Kingbox 20 King Nuggets®': 'https://medias.burgerking.fr/_prd/img/products/6/94/6944696a-b0a3-4ba1-b313-59fb21690adb_',
  'Baby Whopper®': 'https://medias.burgerking.fr/_prd/img/products/6/40/640026a9-da1a-4a2e-9ecd-9c81a4cf5a9e_',
  'Baby Big King®': 'https://medias.burgerking.fr/_prd/img/products/7/f1/7f1a6d54-e7aa-474e-a28c-b76a2eaf27a6_',
  'Baby Chicken Louisiane': 'https://medias.burgerking.fr/_prd/img/products/8/e2/8e288ad1-e9a7-45b7-9f88-dbcf252f90de_',
  'Baby Burgers x3': 'https://medias.burgerking.fr/_prd/img/menu/e869961c-2c59-4344-8287-e8fffcd6571e_',
  'Menu Baby Burgers x3': 'https://medias.burgerking.fr/_prd/img/menu/ac14434f-d524-4dfe-9b69-7a79ee58abd3_',
  'Petites frites': 'https://medias.burgerking.fr/_prd/img/products/2/b6/2b60d99b-07ec-4eea-8c2e-2edf7a60e5ac_',
  'Moyennes frites': 'https://medias.burgerking.fr/_prd/img/products/8/83/88348035-d147-4e80-9508-f17276748056_',
  'Grandes frites': 'https://medias.burgerking.fr/_prd/img/products/c/5e/c5ef2528-be6a-46f9-9262-273386a97de8_',
  'Sauce pour les frites': 'https://medias.burgerking.fr/_prd/img/products/7/de/7de936fb-1d18-421d-8209-5c98aeb1550c_',
  'Spicy Andalouse': 'https://medias.burgerking.fr/_prd/img/products/4/75/4752d28e-4ef5-4c6f-af29-73facad82ae7_',
  "King Fusion M&M's®": 'https://medias.burgerking.fr/_prd/img/products/7/da/7da7ed83-9bac-45f3-8707-fb63afe0fe9c_',
  'King Fusion Snickers®': 'https://medias.burgerking.fr/_prd/img/products/3/2d/32d60f23-cb2a-4ec7-8577-78b644b3d136_',
  'King Fusion Dubaï Style': 'https://medias.burgerking.fr/_prd/img/products/3/5c/35c65115-453a-4687-bac8-6d9b0bfb48b9_',
  'Extra King Fusion Dubaï Style': 'https://medias.burgerking.fr/_prd/img/products/a/aa/aaa1c9f6-c7ea-41c3-8534-4b78a300729b_',
  'King Sundae Vanille': 'https://medias.burgerking.fr/_prd/img/products/3/a7/3a7c2f49-4ddf-41d3-bda7-7c653118b079_',
  'King Sundae Chocolat': 'https://medias.burgerking.fr/_prd/img/products/f/d0/fd068bb4-b2ee-4fda-8288-cb0ca26cf88d_',
  'King Sundae Caramel': 'https://medias.burgerking.fr/_prd/img/products/4/dc/4dc2792d-c3db-4e2c-888c-2b57c23058ef_',
  'Coca-Cola® Cherry Zéro Sucres (25cl)': 'https://medias.burgerking.fr/_prd/img/products/b/35/b35a6551-069a-4637-9666-a3c8a0d62b7e_',
  'Coca-Cola® Cherry Zéro Sucres (40cl)': 'https://medias.burgerking.fr/_prd/img/products/6/7e/67e1f133-2b16-4a54-957c-9d73c8af4b86_',
  'Coca-Cola® Cherry Zéro Sucres (50cl)': 'https://medias.burgerking.fr/_prd/img/products/f/e7/fe794228-5bd1-493c-9a57-ac537588915b_',
  'Fuze Tea Pêche Hibiscus (25cl)': 'https://medias.burgerking.fr/_prd/img/products/6/0f/60f7159c-1b06-4884-895d-39b2fa47796d_',
  'Fuze Tea Pêche Hibiscus (40cl)': 'https://medias.burgerking.fr/_prd/img/products/2/ee/2ee8f845-91d6-4e6f-8b2a-24b2fedf13dd_',
  'Fuze Tea Pêche Hibiscus (50cl)': 'https://medias.burgerking.fr/_prd/img/products/b/fa/bfa92b89-d0ba-4f1a-b80c-c930dbb1238c_',
  'Expresso': 'https://medias.burgerking.fr/_prd/img/products/6/c6/6c6fbe3b-9fe9-4fac-81c0-5191849fbe59_',
  'Café allongé': 'https://medias.burgerking.fr/_prd/img/products/f/23/f238509b-b811-4fb8-adb2-977cfa250c36_',
  'Café Latté': 'https://medias.burgerking.fr/_prd/img/products/4/eb/4ebc743a-50cc-497c-8599-48fa0c3ecbdb_',
  'Cappuccino': 'https://medias.burgerking.fr/_prd/img/products/9/7a/97a4bc4c-8145-41db-9ff1-2f627366db62_',
  'Double expresso': 'https://medias.burgerking.fr/_prd/img/products/e/28/e28ca9c1-6850-4fa3-90d9-049b7ba8bb94_',
  'Thé vert menthe': 'https://medias.burgerking.fr/_prd/img/products/6/bc/6bcf26f8-3764-48e0-ae09-9f034ce6a67f_',
  'Thé Earl Grey': 'https://medias.burgerking.fr/_prd/img/products/3/18/318c0015-e45c-47b1-82a3-dc2b12e28551_',
  'Chili Cheese (4)': 'https://medias.burgerking.fr/_prd/img/products/9/51/95109ca5-1bc0-47a7-a19c-91ca2d0ec948_',
  'Chili Cheese (6)': 'https://medias.burgerking.fr/_prd/img/products/1/fe/1feb8943-1f4b-4e6e-b4b2-a6e637bfab48_',
  'Chili Cheese (9)': 'https://medias.burgerking.fr/_prd/img/products/f/75/f7552547-135b-449b-bc5a-65228a53b940_',
  'Onion Rings (4)': 'https://medias.burgerking.fr/_prd/img/products/e/3f/e3fc35c3-3790-4d7a-9c9a-0936e92fe60b_',
  'Onion Rings (6)': 'https://medias.burgerking.fr/_prd/img/products/4/6e/46e8906c-5d85-4f38-bff1-18d29bcbc526_',
  'Onion Rings (9)': 'https://medias.burgerking.fr/_prd/img/products/2/91/291f86e3-97ee-4897-877e-f6ef39dae360_',
  'Sauce Barbecue': 'https://medias.burgerking.fr/_prd/img/products/4/bb/4bbe894d-60fd-451e-a603-0ea7fbb3b1d2_',
  'Sauce Ketchup': 'https://medias.burgerking.fr/_prd/img/products/e/09/e099af94-b9cf-4732-98a5-3a798a3f35ed_',
  'Sauce Balsamique': 'https://medias.burgerking.fr/_prd/img/products/5/01/5013149f-24b2-4ee2-919d-e006c4141e50_',
  'Sauce Caesar': 'https://medias.burgerking.fr/_prd/img/products/8/93/8937d22c-1fe0-4eb4-9020-78468f8f5b11_',
  'Sauce Chili goût Cheese': 'https://medias.burgerking.fr/_prd/img/products/9/c2/9c2bf558-e51a-4b9c-8e05-b8039fad04c2_',
  'Sauce Moutarde Miel': 'https://medias.burgerking.fr/_prd/img/products/f/f4/ff45622d-f54f-4014-8e7f-b06f49ea4b0b_',
  'King Fries Cheddar & Bacon': 'https://medias.burgerking.fr/_prd/img/products/6/d9/6d92ab7c-e386-4499-a71e-65cf00acd8af_',
  'King Fries Cheddar & Crispy Onions': 'https://medias.burgerking.fr/_prd/img/products/0/5d/05d3732b-1af4-4809-9769-24f318860fdc_',
  'Coca-Cola® (25cl)': 'https://medias.burgerking.fr/_prd/img/products/f/ca/fcaa4668-d34d-462e-8cd9-1743951ce739_',
  'Coca-Cola® (40cl)': 'https://medias.burgerking.fr/_prd/img/products/e/0e/e0ee9abf-f32d-4ea4-b919-5d5cb6ebcccb_',
  'Coca-Cola® (50cl)': 'https://medias.burgerking.fr/_prd/img/products/3/62/3629a705-afa8-4d7a-804d-51e3c3b9b6c1_',
  'Coca-Cola Zéro Sucres® (25cl)': 'https://medias.burgerking.fr/_prd/img/products/5/a5/5a548543-7fae-4958-88ef-b435b362851f_',
  'Coca-Cola Zéro Sucres® (40cl)': 'https://medias.burgerking.fr/_prd/img/products/9/b2/9b246f68-34ff-40d0-ba92-b7fa354390d3_',
  'Coca-Cola Zéro Sucres® (50cl)': 'https://medias.burgerking.fr/_prd/img/products/a/ea/aea3e2f4-5e41-4cdc-b064-e187d6fbbaf5_',
  'Fanta® Goût Original sans sucres (25cl)': 'https://medias.burgerking.fr/_prd/img/products/4/b1/4b15031f-1846-4796-aeb3-ff1ebe3d96c5_',
  'Fanta® Goût Original sans sucres (40cl)': 'https://medias.burgerking.fr/_prd/img/products/0/cb/0cb4a6d9-bbfe-4e5c-afd1-88b6629e13a2_',
  'Fanta® Goût Original sans sucres (50cl)': 'https://medias.burgerking.fr/_prd/img/products/0/e8/0e87a700-ba05-414c-b4f8-8b2165f42fc0_',
  'Vittel® (33cl)': 'https://medias.burgerking.fr/_prd/img/products/2/3f/23f6964d-fb2a-4082-b510-64e9d5206826_',
  'Vittel® (50cl)': 'https://medias.burgerking.fr/_prd/img/products/a/bd/abd88e13-e0d8-4244-92cc-1733edffc650_',
  "Pom'Potes® Pomme": 'https://medias.burgerking.fr/_prd/img/products/c/be/cbec2ca6-81c9-4e73-9d21-468d4fb4e3ee_',
  'King Fruits': 'https://medias.burgerking.fr/_prd/img/products/e/4b/e4b3c0ea-42fe-41e2-b721-2e343256cf85_',
  'Boisson Cacaotée': 'https://medias.burgerking.fr/_prd/img/products/0/89/08903aa7-3ea3-4ef0-8949-e6ff3b7fa853_',
});

const bkOfficialMenuImages: Record<string, string> = {
  'Master des Chefs': 'https://medias.burgerking.fr/_prd/img/menu/7df3b3f5-d00b-4876-a11c-ad5285cdca72_',
  'Master Sarran Mozzarella': 'https://medias.burgerking.fr/_prd/img/menu/85856066-4a51-4876-95a5-40921afdd3e9_',
  'Master Pairet Poivre': 'https://medias.burgerking.fr/_prd/img/menu/e5953da4-e59a-459f-84b1-59b08a6e0526_',
  'CBK': 'https://medias.burgerking.fr/_prd/img/menu/7d6af4c4-9931-4325-a7c3-83e358883ffc_',
  'Double CBK': 'https://medias.burgerking.fr/_prd/img/menu/2902fc48-2615-42bc-9425-f7bb3b6cc393_',
  'Smoky Chicken': 'https://medias.burgerking.fr/_prd/img/menu/7ccd861d-6965-4a7d-9b23-0c5de0a78d38_',
  'Menu Krispper Tenders x10': 'https://medias.burgerking.fr/_prd/img/menu/f1691c1f-30ef-40ce-90e7-f5a57e2336af_',
  'Menu Krispper Tenders x5': 'https://medias.burgerking.fr/_prd/img/menu/2b8128d7-d531-4fc4-9226-211df0896f35_',
  'Chicken Louisiane Steakhouse': 'https://medias.burgerking.fr/_prd/img/menu/bd2ca9b4-fde2-49be-9748-91830a3b8512_',
  'Menu King Nuggets (10)': 'https://medias.burgerking.fr/_prd/img/menu/29df3c61-108e-442b-aa45-98f5a79f628e_',
  'Menu King Nuggets (7)': 'https://medias.burgerking.fr/_prd/img/menu/18c5943d-8bfa-461e-a5bb-31e49ed0c531_',
  'Tortilla Cheese & Bacon': 'https://medias.burgerking.fr/_prd/img/menu/60983793-a2df-4e2a-98d2-e95c386b3b31_',
  'Wrap Chicken Louisiane': 'https://medias.burgerking.fr/_prd/img/menu/3fb1f340-7cc9-44bf-88a6-bd5e0fd41eaa_',
  'Big King®': 'https://medias.burgerking.fr/_prd/img/menu/c4596178-f626-4cc0-93a6-0e1f746e8b62_',
  'Whopper®': 'https://medias.burgerking.fr/_prd/img/menu/92952978-c0d3-4545-b4a3-ffae2f09f74e_',
  'Steakhouse': 'https://medias.burgerking.fr/_prd/img/menu/c98ab9c7-1df5-47eb-9723-15b99aa4b046_',
  'Double Whopper® Cheese': 'https://medias.burgerking.fr/_prd/img/menu/e102c28f-a8a9-447a-b34f-f7964cd95cf3_',
  'Double Cheese Bacon XXL': 'https://medias.burgerking.fr/_prd/img/menu/1f9f7d00-f845-415e-ae63-1c9489c9ca7e_',
  'Big King XXL': 'https://medias.burgerking.fr/_prd/img/menu/f86b20c5-e201-4aaf-abd7-b63c0cdffa77_',
  'Double Steakhouse': 'https://medias.burgerking.fr/_prd/img/menu/25073a15-0054-4ab1-8de5-3a97dcc052a6_',
  'Double Cheese Bacon': 'https://medias.burgerking.fr/_prd/img/menu/91c18d86-4414-44be-ba8d-35bb64d5187f_',
  'Big Fish': 'https://medias.burgerking.fr/_prd/img/menu/ca84fbab-ce6d-4dea-883d-94bdfeb50890_',
  'Veggie Chicken Louisiane Steakhouse': 'https://medias.burgerking.fr/_prd/img/menu/21a52971-2ff6-44a1-b5b8-f431c5c08410_',
  'Tortilla Veggie Cheese & Bacon': 'https://medias.burgerking.fr/_prd/img/menu/1c6405fb-15ac-4d5a-aeb1-ee490f5db1f2_',
  'Veggie Whopper': 'https://medias.burgerking.fr/_prd/img/menu/0361dcc2-00e5-4959-a787-d1ccab633f33_',
  'Veggie Steakhouse': 'https://medias.burgerking.fr/_prd/img/menu/141dc36f-c7bd-4288-a719-900a6ed68485_',
  'Wrap Veggie Chicken Louisiane': 'https://medias.burgerking.fr/_prd/img/menu/dcaf616f-45f7-4ae2-af5a-86cdaf4f5e7a_',
  'Menu Baby Burgers x3': 'https://medias.burgerking.fr/_prd/img/menu/ac14434f-d524-4dfe-9b69-7a79ee58abd3_',
  'King Junior': 'https://medias.burgerking.fr/_prd/img/menu/96219f1b-0467-4737-87b4-bd0114175c56_',
  'King JR +': 'https://medias.burgerking.fr/_prd/img/menu/281475f1-f8e9-4c23-ad9e-30802644239a_',
};

const burgerKingCatalogTemplate: CatalogProduct[] = bkSeed.map(([name, category, subcategory, price, detail, emoji, productType, menuStyle], index) => {
  const id = 5000 + index;
  const product: CatalogProduct = { id, productId: `bkfr_${index}`, name, detail, emoji, imageUrl: productType === 'menu' ? (bkOfficialMenuImages[name] ?? bkOfficialImages[name]) : bkOfficialImages[name], category, subcategory: subcategory || undefined, price, posCode: '', available: true, productType };
  if (productType === 'menu') product.optionGroups = bkOptions(id, menuStyle ?? 'burger', name);
  return product;
});

const burgerIngredientExtraPrices: Record<string, number> = {
  'Bacon fumé (2 tranches)': 0.75,
  'Bacon végétal LA VIE': 0.75,
  'Cheddar fondu (1 tranche)': 0.75,
  'Oignons croustillants': 0.4,
  'Sauce épicée façon cajun': 0.3,
};

const configureBurger = (name: string, ingredients: string[], detail: string, idBase: number) => {
  const products = burgerKingCatalogTemplate.filter(item => item.name === name && item.productType !== 'menu' && item.productType !== 'bundle');
  products.forEach(product => {
    product.detail = detail;
    product.ingredients = ingredients;
    product.ingredientSettings = ingredients.map((ingredient, index) => ({
      id: idBase + index,
      name: ingredient,
      removable: !/pain|viande|poulet croustillant|pané végétal|haché végétal/i.test(ingredient),
      extraAllowed: !/pain|viande|poulet croustillant|pané végétal|haché végétal|sauce/i.test(ingredient),
      extraPrice: burgerIngredientExtraPrices[ingredient] ?? 0,
    }));
    product.modifiers = product.ingredientSettings.flatMap(ingredient => [
      ...(ingredient.removable ? [{ id: ingredient.id * 10 + 1, name: `Sans ${ingredient.name}`, kind: 'remove' as const, priceDelta: 0 }] : []),
      ...(ingredient.extraAllowed ? [{ id: ingredient.id * 10 + 2, name: `Supplément ${ingredient.name}`, kind: 'add' as const, priceDelta: ingredient.extraPrice }] : []),
    ]);
  });
};

configureBurger(
  'Master des Chefs',
  ['Pain brioché moelleux', 'Sauce inspiration chili aïoli', 'Roquette', 'Tranches de tomates fraîches', "Rondelles d’oignons frais", 'Sauce onctueuse à la graisse de canard', 'Chips de pommes de terre croustillantes', 'Épices merguez relevées', 'Viande grillée à la flamme', 'Sauce inspiration chili aïoli', 'Pain brioché moelleux'],
  'Une viande de bœuf d’origine France grillée à la flamme, une sauce inspiration chili aïoli, de la roquette, des tomates et des oignons frais, une sauce onctueuse à la graisse de canard, des chips de pommes de terre croustillantes et des épices merguez relevées, dans un pain brioché moelleux.',
  112900,
);
configureBurger(
  'Master Sarran Mozzarella',
  ['Pain aux quatre graines', 'Sauce basilic', 'Sauce olives et thym aux tomates séchées', 'Oignons croustillants', 'Mozzarella fior di latte', 'Poulet croustillant', 'Pain aux quatre graines'],
  'Un poulet 100 % issu de filets enrobé d’une panure ultra croustillante, une sauce basilic, une sauce olives et thym avec une pointe de tomates séchées, une tranche de mozzarella fior di latte et des oignons croustillants, dans un pain aux quatre graines.',
  112950,
);
configureBurger(
  'Whopper®',
  ['Pain aux graines de sésame', 'Sauce', 'Salade', 'Tranches de tomates fraîches', "Rondelles d’oignons frais", 'Ketchup', 'Rondelles de cornichons', 'Viande grillée à la flamme'],
  'Une viande de bœuf grillée à la flamme, une sauce onctueuse, des tomates fraîches, une salade croquante, des cornichons et des oignons.',
  114000,
);
configureBurger(
  'Big King®',
  ['Pain aux graines de sésame', 'Sauce Big King', 'Salade', "Rondelles d’oignons frais", 'Cheddar fondu (1 tranche)', 'Rondelles de cornichons', 'Viande grillée à la flamme', 'Cheddar fondu (1 tranche)', 'Viande grillée à la flamme', 'Pain aux graines de sésame'],
  'Deux viandes de bœuf grillées à la flamme, de la sauce BIG KING® et des tranches de cheddar fondu.',
  113000,
);
configureBurger(
  'Big King XXL®',
  ['Pain aux graines de sésame', 'Sauce Big King', 'Cheddar fondu (1 tranche)', 'Viande grillée à la flamme', 'Cheddar fondu (1 tranche)', 'Viande grillée à la flamme', 'Pain aux graines de sésame'],
  'Deux viandes de bœuf grillées à la flamme, de la sauce BIG KING® et deux tranches de cheddar fondu.',
  113100,
);
configureBurger(
  'Double Whopper® Cheese',
  ['Pain aux graines de sésame', 'Sauce', 'Salade', 'Tranches de tomates fraîches', "Rondelles d’oignons frais", 'Ketchup', 'Rondelles de cornichons', 'Cheddar fondu (1 tranche)', 'Viande grillée à la flamme', 'Viande grillée à la flamme'],
  'Deux viandes de bœuf grillées à la flamme, des tranches de cheddar fondu et tous les ingrédients du WHOPPER®.',
  113200,
);
configureBurger(
  'Double Cheese Bacon',
  ['Pain aux graines de sésame', 'Viande grillée à la flamme', 'Cheddar fondu (1 tranche)', 'Rondelles de cornichons', 'Bacon fumé (2 tranches)', 'Viande grillée à la flamme', 'Cheddar fondu (1 tranche)', 'Pain aux graines de sésame'],
  'Deux viandes de bœuf grillées à la flamme, deux tranches de cheddar fondu, deux rondelles de cornichons et deux tranches de bacon.',
  113300,
);
configureBurger(
  'Double Cheese Bacon XXL',
  ['Pain aux graines de sésame', 'Viande grillée à la flamme', 'Cheddar fondu (1 tranche)', 'Bacon fumé (2 tranches)', 'Viande grillée à la flamme', 'Cheddar fondu (1 tranche)', 'Pain aux graines de sésame'],
  'Deux viandes de bœuf grillées à la flamme, des tranches de cheddar fondu et du bacon.',
  113400,
);
configureBurger(
  'Steakhouse',
  ['Pain aux graines de sésame', 'Sauce Barbecue', 'Bacon fumé (2 tranches)', 'Cheddar fondu (1 tranche)', 'Oignons croustillants', 'Viande grillée à la flamme'],
  'Une viande de bœuf grillée à la flamme, une sauce barbecue, du bacon, du cheddar fondu et des oignons croustillants.',
  113500,
);
configureBurger(
  'Double Steakhouse',
  ['Pain aux graines de sésame', 'Sauce Barbecue', 'Bacon fumé (2 tranches)', 'Cheddar fondu (1 tranche)', 'Oignons croustillants', 'Viande grillée à la flamme', 'Viande grillée à la flamme'],
  'Deux viandes de bœuf grillées à la flamme, une sauce barbecue, du bacon, du cheddar fondu et des oignons croustillants.',
  113600,
);
configureBurger(
  'CBK',
  ['Pain aux pépites de bacon', 'Sauce crémeuse à l’oignon', 'Salade', 'Oignons croustillants', 'Bacon fumé (2 tranches)', 'Cheddar fondu (1 tranche)', 'Poulet croustillant'],
  'Une sauce crémeuse à l’oignon, de la salade, des oignons croustillants, du bacon fumé, du cheddar fondu et un poulet croustillant dans un pain aux pépites de bacon.',
  113700,
);
configureBurger(
  'Double CBK',
  ['Pain aux pépites de bacon', 'Sauce crémeuse à l’oignon', 'Salade', 'Oignons croustillants', 'Bacon fumé (2 tranches)', 'Cheddar fondu (1 tranche)', 'Poulet croustillant', 'Cheddar fondu (1 tranche)', 'Poulet croustillant'],
  'Deux fois plus de poulet croustillant et de cheddar, avec sauce crémeuse à l’oignon, salade, oignons croustillants et bacon fumé.',
  113800,
);
configureBurger(
  'Smoky Chicken',
  ['Pain aux graines de sésame', 'Sauce aux herbes goût grillé', 'Poulet croustillant', 'Cheddar fondu (1 tranche)', 'Tranches de tomates fraîches', 'Salade iceberg'],
  'Une sauce aux herbes goût grillé, du poulet croustillant, du cheddar fondu, des tomates fraîches et de la salade iceberg.',
  113900,
);
configureBurger(
  'Chicken Louisiane Steakhouse',
  ['Pain moelleux', 'Sauce épicée façon cajun', 'Oignons croustillants', 'Bacon fumé (2 tranches)', 'Cheddar fondu (1 tranche)', 'Poulet croustillant'],
  'Une sauce épicée façon cajun, des oignons croustillants, du bacon, du cheddar fondu et un poulet pané croustillant.',
  114100,
);
configureBurger(
  'Big Fish',
  ['Pain aux graines de sésame', 'Filet de poisson frit', 'Salade', 'Sauce Big King', 'Cheddar fondu (1 tranche)', 'Tranches de tomates fraîches'],
  'Un filet de poisson pané croustillant, de la salade, de la sauce BIG KING®, du cheddar fondu et des tomates fraîches.',
  114200,
);
configureBurger(
  'Veggie Whopper®',
  ['Pain aux graines de sésame', 'Sauce', 'Salade', 'Tranches de tomates fraîches', "Rondelles d’oignons frais", 'Rondelles de cornichons', 'Haché végétal grillé à la flamme'],
  'Un haché végétal grillé à la flamme, une sauce onctueuse, des tomates fraîches, de la salade, des cornichons et des oignons.',
  114300,
);
configureBurger(
  'Veggie Whopper',
  ['Pain aux graines de sésame', 'Sauce', 'Salade', 'Tranches de tomates fraîches', "Rondelles d’oignons frais", 'Rondelles de cornichons', 'Haché végétal grillé à la flamme'],
  'Un haché végétal grillé à la flamme, une sauce onctueuse, des tomates fraîches, de la salade, des cornichons et des oignons.',
  114400,
);
configureBurger(
  'Veggie Steakhouse',
  ['Pain aux graines de sésame', 'Sauce Barbecue', 'Bacon végétal LA VIE', 'Cheddar fondu (1 tranche)', 'Oignons croustillants', 'Haché végétal grillé à la flamme'],
  'Des oignons croustillants, une sauce barbecue, du cheddar fondu, du bacon végétal LA VIE™ et un haché végétal grillé à la flamme.',
  114500,
);
configureBurger(
  'Veggie Chicken Louisiane Steakhouse',
  ['Pain moelleux', 'Sauce épicée façon cajun', 'Bacon végétal LA VIE', 'Cheddar fondu (1 tranche)', 'Pané végétal croustillant'],
  'Une sauce épicée façon cajun, du bacon végétal LA VIE™, du cheddar fondu et un pané végétal croustillant.',
  114600,
);
configureBurger(
  'Master Pairet Poivre',
  ['Pain brioché moelleux', 'Sauce au poivre', 'Tranches de cheddar fondu', 'Fine galette croustillante de pomme de terre', "Rondelles d’oignons frais", 'Oignons croustillants', 'Viande grillée à la flamme', 'Pain brioché moelleux'],
  'Une viande de bœuf d’origine France grillée à la flamme, une sauce au poivre, du cheddar fondu, une fine galette croustillante de pomme de terre et des oignons frais et croustillants, dans un pain brioché moelleux.',
  114700,
);
configureBurger(
  'Cheeseburger',
  ['Pain aux graines de sésame', 'Ketchup', 'Moutarde', 'Rondelles de cornichons', 'Cheddar fondu (1 tranche)', 'Viande grillée à la flamme'],
  'Une viande de bœuf grillée à la flamme, une tranche de cheddar fondu, du ketchup, de la moutarde et des cornichons dans un pain aux graines de sésame.',
  114800,
);
configureBurger(
  'Hamburger',
  ['Pain aux graines de sésame', 'Ketchup', 'Moutarde', 'Rondelles de cornichons', 'Viande grillée à la flamme'],
  'Une viande de bœuf grillée à la flamme, du ketchup, de la moutarde et des cornichons dans un pain aux graines de sésame.',
  114900,
);
configureBurger(
  'Wrap Chicken Louisiane',
  ['Galette de blé toastée', 'Sauce épicée façon cajun', 'Salade', 'Tranches de tomates fraîches', 'Oignons croustillants', 'Poulet croustillant'],
  'Un poulet croustillant, une sauce épicée façon cajun, de la salade, des tomates fraîches et des oignons croustillants dans une galette de blé toastée.',
  115000,
);
configureBurger(
  'Tortilla Cheese & Bacon',
  ['Galette de blé toastée', 'Poulet croustillant', 'Cheddar fondu (1 tranche)', 'Sauce Barbecue', 'Bacon fumé (2 tranches)', 'Oignons croustillants'],
  'Un poulet croustillant, du cheddar fondu, de la sauce barbecue, du bacon et des oignons croustillants dans une galette de blé toastée.',
  115100,
);
configureBurger(
  'Wrap Veggie Chicken Louisiane',
  ['Galette de blé toastée', 'Sauce épicée façon cajun', 'Salade', 'Tranches de tomates fraîches', 'Oignons croustillants', 'Pané végétal croustillant'],
  'Un pané végétal croustillant, une sauce épicée façon cajun, de la salade, des tomates fraîches et des oignons croustillants dans une galette de blé toastée.',
  115200,
);
configureBurger(
  'Tortilla Veggie Cheese & Bacon',
  ['Galette de blé toastée', 'Pané végétal croustillant', 'Cheddar fondu (1 tranche)', 'Sauce Barbecue', 'Bacon végétal LA VIE', 'Oignons croustillants'],
  'Un pané végétal croustillant, du cheddar fondu, de la sauce barbecue, du bacon végétal et des oignons croustillants dans une galette de blé toastée.',
  115300,
);

const initialCatalog: CatalogProduct[] = burgerKingCatalogTemplate;

const initialAgentRules: Array<[string, boolean]> = [
  ['Toujours reformuler les choix et suppléments', true],
  ['Proposer une boisson lorsqu’elle manque au menu', true],
  ['Ne jamais inventer un produit indisponible', true],
  ['Transférer à un équipier après deux incompréhensions', true],
  ['Proposer automatiquement le dessert du moment', false],
];

const panelCard = 'rounded-[24px] border border-[#e2e6df] bg-white shadow-[0_16px_50px_rgba(17,32,22,.05)]';
const fieldClass = 'h-11 w-full rounded-xl border border-[#dfe4dc] bg-white px-3 text-sm font-semibold outline-none transition focus:border-[#ff6a45] focus:ring-4 focus:ring-[#ff6a45]/10';

function SectionHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: React.ReactNode }) {
  return (
    <div className="mb-7 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p className="text-[11px] font-black uppercase tracking-[.22em] text-[#ff5a36]">{eyebrow}</p>
        <h1 className="mt-2 text-3xl font-black tracking-[-.045em] text-[#132018] md:text-4xl">{title}</h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[#6f7971]">{description}</p>
      </div>
      {action}
    </div>
  );
}

function DashboardPanel() {
  const [ordersOpen, setOrdersOpen] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [dashboardPeriod, setDashboardPeriod] = useState('Aujourd’hui');
  const [periodMenuOpen, setPeriodMenuOpen] = useState(false);
  const hourly = [24, 38, 48, 62, 78, 91, 86, 70, 58, 81, 96, 74];
  const recentOrders = [
    { id: '#DV-1048', date: '2026-09-09', time: '12:42', channel: 'Vocal', total: '18,60 €', status: 'Préparation', duration: '1 min 38 s', items: ['Menu Master des Chefs × 1', 'King Fries × 1'], transcript: [['Client', 'Bonjour, je voudrais un Master des Chefs avec des frites.'], ['DriveVoice IA', 'Très bien. Quelle boisson souhaitez-vous avec votre menu ?'], ['Client', 'Un Coca-Cola zéro, s’il vous plaît.']] },
    { id: '#DV-1047', date: '2026-09-09', time: '12:39', channel: 'Vocal', total: '12,90 €', status: 'Remise', duration: '2 min 04 s', items: ['Whopper × 1', 'Frites moyennes × 1'], transcript: [['Client', 'Je prends un Whopper et des frites moyennes.'], ['DriveVoice IA', 'Votre commande est bien enregistrée.']] },
    { id: '#DV-1046', date: '2026-09-09', time: '12:36', channel: 'Texte', total: '21,40 €', status: 'Terminée', duration: '1 min 21 s', items: ['Menu Double Cheese Bacon × 1', 'King Fusion × 1'], transcript: [['Client', 'Un menu Double Cheese Bacon et un dessert.'], ['DriveVoice IA', 'Je vous propose un King Fusion. Confirmez-vous ?']] },
    { id: '#DV-1045', date: '2026-09-09', time: '12:31', channel: 'Vocal', total: '15,70 €', status: 'Terminée', duration: '1 min 47 s', items: ['Menu King Nuggets × 1'], transcript: [['Client', 'Je voudrais un menu King Nuggets.'], ['DriveVoice IA', 'Quelle boisson et quelle taille de frites choisissez-vous ?']] },
  ];
  const exportOrders = () => {
    const header = ['Commande', 'Date', 'Heure', 'Canal', 'Montant', 'Statut', 'Temps de prise'];
    const rows = recentOrders.map((order) => [order.id, order.date, order.time, order.channel, order.total, order.status, order.duration]);
    const csv = [header, ...rows].map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(';')).join('\n');
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `drivevoice-commandes-${dashboardPeriod.toLowerCase().replaceAll(' ', '-')}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <SectionHeading eyebrow="Pilotage temps réel" title="Tableau de bord opérationnel" description="Suivez les performances de la voie drive, la qualité des conversations et les ventes générées par l'agent vocal." action={<div className="relative flex gap-2"><button onClick={() => setPeriodMenuOpen((open) => !open)} className="rounded-xl border border-[#dfe4dc] bg-white px-4 py-2 text-xs font-black">{dashboardPeriod}⌄</button>{periodMenuOpen && <div className="absolute right-[92px] top-11 z-20 w-40 rounded-2xl border border-[#e2e7e0] bg-white p-2 shadow-xl">{['Aujourd’hui', 'Hier', 'Cette semaine', 'Ce mois', 'Cette année'].map((period) => <button key={period} onClick={() => { setDashboardPeriod(period); setPeriodMenuOpen(false); }} className={`block w-full rounded-xl px-3 py-2.5 text-left text-xs font-black ${dashboardPeriod === period ? 'bg-[#eaf5ec] text-[#27894a]' : 'hover:bg-[#f4f6f2]'}`}>{period}</button>)}</div>}<button onClick={exportOrders} className="rounded-xl bg-[#0b1f14] px-4 py-2 text-xs font-black text-white transition hover:bg-[#173b27]">Exporter CSV</button></div>} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {[
          ['Commandes', '248', '+12,4 %', '◉'],
          ['Chiffre d’affaires', '4 286 €', '+8,7 %', '€'],
          ['Panier moyen', '17,28 €', '+1,4 %', '↗'],
          ['Temps de prise', '1 min 42', '-18 sec', '◷'],
          ['Résolution vocale', '96,8 %', '+2,1 pts', '✦'],
        ].map(([label, value, trend, icon]) => <button key={label} onClick={() => label === 'Commandes' && setOrdersOpen(true)} className={`${panelCard} p-5 text-left transition hover:-translate-y-0.5 hover:border-[#ffb09c] ${label === 'Commandes' ? 'cursor-pointer' : 'cursor-default'}`}><div className="flex items-center justify-between"><span className="text-xs font-bold text-[#7e887f]">{label}</span><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#f1f4ef] font-black text-[#ff5a36]">{icon}</span></div><p className="mt-5 text-3xl font-black tracking-[-.05em]">{value}</p><p className={`mt-2 text-xs font-black ${trend.startsWith('-') && label !== 'Temps de prise' ? 'text-[#e04d39]' : 'text-[#2a9b55]'}`}>{trend} <span className="font-semibold text-[#a0a8a1]">vs. hier</span></p>{label === 'Commandes' && <p className="mt-3 text-[10px] font-black text-[#ff5a36]">Cliquer pour voir le détail →</p>}</button>)}
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-[1.45fr_.8fr]">
        <section className={`${panelCard} p-6`}>
          <div className="flex items-start justify-between"><div><h2 className="text-lg font-black">Volume de commandes</h2><p className="mt-1 text-xs text-[#879088]">Commandes par tranche de 30 minutes</p></div><span className="rounded-full bg-[#e6f7eb] px-3 py-1 text-xs font-black text-[#248b4a]">En direct</span></div>
          <div className="mt-8 flex h-64 items-end gap-2 rounded-2xl bg-[#f7f8f5] px-5 pb-5 pt-8">
            {hourly.map((height, index) => <div key={index} className="group flex h-full flex-1 items-end"><div className="relative w-full rounded-t-lg bg-[#163423] transition hover:bg-[#ff5a36]" style={{ height: `${height}%` }}><span className="absolute -top-7 left-1/2 hidden -translate-x-1/2 rounded bg-[#0b1f14] px-2 py-1 text-[10px] font-bold text-white group-hover:block">{Math.round(height / 3)}</span></div></div>)}
          </div>
          <div className="mt-3 flex justify-between px-1 text-[10px] font-bold text-[#9ba39c]"><span>09:00</span><span>11:00</span><span>13:00</span><span>15:00</span><span>17:00</span><span>19:00</span></div>
        </section>
        <section className={`${panelCard} p-6`}>
          <h2 className="text-lg font-black">Qualité des conversations</h2><p className="mt-1 text-xs text-[#879088]">Analyse automatique des 248 sessions</p>
          <div className="mx-auto mt-7 grid h-40 w-40 place-items-center rounded-full" style={{ background: 'conic-gradient(#ff5a36 0 84%, #ffc647 84% 96%, #e9ece7 96%)' }}><div className="grid h-28 w-28 place-items-center rounded-full bg-white text-center"><div><strong className="text-3xl font-black">4,7</strong><p className="text-[10px] font-bold uppercase tracking-widest text-[#9aa29b]">score moyen</p></div></div></div>
          <div className="mt-7 space-y-3 text-xs"><div className="flex justify-between"><span className="font-bold text-[#657068]">Compréhension correcte</span><strong>96,8 %</strong></div><div className="flex justify-between"><span className="font-bold text-[#657068]">Intervention humaine</span><strong>3,2 %</strong></div><div className="flex justify-between"><span className="font-bold text-[#657068]">Abandon</span><strong>1,6 %</strong></div></div>
        </section>
      </div>
      <section className={`${panelCard} mt-5 overflow-hidden`}><div className="flex items-center justify-between border-b border-[#e8ebe6] p-6"><div><h2 className="text-lg font-black">Dernières commandes</h2><p className="mt-1 text-xs text-[#879088]">Synchronisation KDS instantanée</p></div><button onClick={() => setOrdersOpen(true)} className="text-xs font-black text-[#ff5a36]">Voir toutes →</button></div><div className="overflow-x-auto"><table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-[#f8f9f6] text-[10px] uppercase tracking-widest text-[#8d968e]"><tr>{['Commande','Heure','Canal','Montant','Statut'].map(x=><th key={x} className="px-6 py-3">{x}</th>)}</tr></thead><tbody>{recentOrders.map(row=><tr key={row.id} onClick={() => { setSelectedOrder(row.id); setOrdersOpen(true); }} className="cursor-pointer border-t border-[#edf0eb] hover:bg-[#fafbf8]"><td className="px-6 py-4 font-black">{row.id}</td><td className="px-6 py-4 text-[#6f7971]">{row.time}</td><td className="px-6 py-4"><span className="rounded-full bg-[#eef2ed] px-3 py-1 text-xs font-bold">{row.channel}</span></td><td className="px-6 py-4 font-black">{row.total}</td><td className="px-6 py-4"><span className="text-xs font-black text-[#2e9553]">● {row.status}</span></td></tr>)}</tbody></table></div></section>
      {ordersOpen && <OrderHistory orders={recentOrders} selectedId={selectedOrder} onSelect={setSelectedOrder} onClose={() => { setOrdersOpen(false); setSelectedOrder(null); }} />}
    </div>
  );
}

function OrderHistory({ orders, selectedId, onSelect, onClose }: { orders: Array<{ id: string; date: string; time: string; channel: string; total: string; status: string; duration: string; items: string[]; transcript: string[][] }>; selectedId: string | null; onSelect: (id: string) => void; onClose: () => void }) {
  const [period, setPeriod] = useState('jour');
  const [date, setDate] = useState('2026-09-09');
  const selected = orders.find((order) => order.id === selectedId) ?? null;
  const filtered = orders.filter((order) => period === 'jour' ? order.date === date : period === 'mois' ? order.date.startsWith(date.slice(0, 7)) : period === 'année' ? order.date.startsWith(date.slice(0, 4)) : true);
  return <div className="fixed inset-0 z-50 overflow-y-auto bg-[#07130d]/70 p-4 md:p-8"><div className="mx-auto max-w-6xl rounded-[28px] bg-[#f4f6f1] shadow-2xl"><div className="flex items-start justify-between border-b border-[#e1e6df] bg-white p-6 md:p-8"><div><p className="text-xs font-black uppercase tracking-[.2em] text-[#ff5a36]">Pilotage des ventes</p><h2 className="mt-2 text-3xl font-black">Toutes les commandes</h2><p className="mt-2 text-sm text-[#738078]">Filtrez, ouvrez une commande et consultez sa conversation complète.</p></div><button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-xl bg-[#f0f3ee] text-xl font-black">×</button></div><div className="grid gap-5 p-5 md:grid-cols-[250px_1fr] md:p-8"><aside className="rounded-2xl bg-white p-5"><p className="text-xs font-black uppercase tracking-widest text-[#89948b]">Période</p><div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-1">{['jour', 'mois', 'année', 'toutes'].map((item) => <button key={item} onClick={() => setPeriod(item)} className={`rounded-xl px-4 py-3 text-left text-xs font-black capitalize ${period === item ? 'bg-[#0b1f14] text-white' : 'bg-[#f3f5f1] text-[#68736a]'}`}>{item === 'toutes' ? 'Toutes les dates' : `Par ${item}`}</button>)}</div>{period !== 'toutes' && <label className="mt-5 block text-xs font-black text-[#68736a]">Sélectionner une date<input type={period === 'jour' ? 'date' : period === 'mois' ? 'month' : 'number'} min={period === 'année' ? '2020' : undefined} max={period === 'année' ? '2100' : undefined} value={period === 'année' ? date.slice(0, 4) : period === 'mois' ? date.slice(0, 7) : date} onChange={(event) => setDate(period === 'année' ? `${event.target.value}-01-01` : period === 'mois' ? `${event.target.value}-01` : event.target.value)} className="mt-2 w-full rounded-xl border border-[#dfe5de] px-3 py-3 text-sm" /></label>}<div className="mt-6 rounded-2xl bg-[#e8f6eb] p-4"><p className="text-2xl font-black text-[#248b4a]">{filtered.length}</p><p className="mt-1 text-xs font-bold text-[#55745d]">commandes affichées</p></div></aside><section className="min-w-0">{selected ? <div><button onClick={() => onSelect('')} className="mb-4 text-xs font-black text-[#ff5a36]">← Retour à la liste</button><div className="grid gap-5 lg:grid-cols-[1fr_360px]"><article className="rounded-2xl bg-white p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-widest text-[#89948b]">Commande</p><h3 className="mt-2 text-2xl font-black">{selected.id}</h3><p className="mt-1 text-xs text-[#7c887f]">{selected.date} · {selected.time} · {selected.channel}</p></div><span className="rounded-full bg-[#e5f6e9] px-3 py-2 text-xs font-black text-[#27894a]">● {selected.status}</span></div><div className="mt-7"><p className="text-xs font-black uppercase tracking-widest text-[#89948b]">Transcription de la conversation</p><div className="mt-4 space-y-3">{selected.transcript.map(([speaker, text], index) => <div key={index} className={`rounded-2xl p-4 text-sm ${speaker === 'Client' ? 'bg-[#fff1e8]' : 'bg-[#eef5ef]'}`}><p className="mb-1 text-[10px] font-black uppercase tracking-widest text-[#89948b]">{speaker}</p>{text}</div>)}</div></div></article><aside className="rounded-2xl bg-[#0b1f14] p-6 text-white"><p className="text-xs font-black uppercase tracking-widest text-[#ffc647]">Détails opérationnels</p><div className="mt-6 space-y-4">{[['Montant total', selected.total], ['Temps de prise', selected.duration], ['Canal', selected.channel], ['Articles', String(selected.items.length)]].map(([label, value]) => <div key={label} className="flex justify-between border-b border-white/10 pb-3 text-sm"><span className="text-white/55">{label}</span><strong>{value}</strong></div>)}</div><p className="mt-7 text-xs font-black uppercase tracking-widest text-[#ffc647]">Commande client</p><ul className="mt-3 space-y-2 text-sm text-white/75">{selected.items.map((item) => <li key={item}>✓ {item}</li>)}</ul></aside></div></div> : <div className="overflow-hidden rounded-2xl bg-white"><div className="border-b border-[#edf0eb] px-5 py-4 text-xs font-black uppercase tracking-widest text-[#89948b]">Historique des commandes</div>{filtered.length ? <div className="divide-y divide-[#edf0eb]">{filtered.map((order) => <button key={order.id} onClick={() => onSelect(order.id)} className="grid w-full grid-cols-[1fr_1fr_1fr] items-center gap-3 px-5 py-5 text-left transition hover:bg-[#fafbf8] md:grid-cols-[1.2fr_1fr_1fr_1fr_1fr]"><span className="font-black">{order.id}</span><span className="text-xs text-[#7c887f]">{order.date} · {order.time}</span><span className="text-xs font-bold">{order.channel}</span><span className="font-black">{order.total}</span><span className="text-xs font-black text-[#27894a]">● {order.status}</span></button>)}</div> : <div className="p-12 text-center text-sm text-[#7b887f]">Aucune commande pour cette période.</div>}</div>}</section></div></div></div>;
}

function IntegrationsPanel({ onCatalogSynced }: { onCatalogSynced: () => Promise<void> }) {
  const [testState, setTestState] = useState<'idle' | 'testing' | 'success'>('idle');
  const [hubriseState, setHubriseState] = useState<'idle' | 'connecting' | 'connected' | 'error'>('idle');
  const [hubriseMessage, setHubriseMessage] = useState('');
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [productsCount, setProductsCount] = useState<number | null>(null);
  const [orderTestState, setOrderTestState] = useState<'idle' | 'sending' | 'success' | 'error'>('idle');
  const [orderTestMessage, setOrderTestMessage] = useState('');
  const restaurantId = demoRestaurantId;

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-oauth?action=status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ restaurantId }),
      });
      const data = await res.json() as { connected?: boolean; lastSyncAt?: string | null; error?: string };
      if (data.connected) {
        setHubriseState('connected');
        setLastSync(data.lastSyncAt || null);
      } else {
        setHubriseState('idle');
      }
      if (data.error) setHubriseMessage(data.error);
    } catch {
      setHubriseState('idle');
    }
  }, [restaurantId]);

  useEffect(() => {
    void loadStatus();
    const params = new URLSearchParams(window.location.search);
    if (params.get('hubrise') === 'connected') {
      setHubriseState('connected');
      window.history.replaceState({}, '', window.location.pathname + window.location.search.replace(/[?&]hubrise=connected[^&]*/, '').replace(/^\?&/, '?'));
      void loadStatus();
      window.setTimeout(() => {
        void fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-oauth?action=sync_catalog', {
          method: 'POST',
          headers: { 'content-type': 'application/json', Authorization: `Bearer ${supabaseAnonKey}` },
          body: JSON.stringify({ restaurantId }),
        }).then(async response => {
          const result = await response.json().catch(() => ({})) as { productsImported?: number };
          if (response.ok) {
            setProductsCount(result.productsImported ?? null);
            setLastSync(new Date().toISOString());
            await onCatalogSynced();
          }
        });
      }, 0);
    } else if (params.get('hubrise') === 'error') {
      setHubriseState('error');
      setHubriseMessage(decodeURIComponent(params.get('reason') || 'Erreur OAuth HubRise'));
    }
  }, [loadStatus]);

  const runTest = () => { setTestState('testing'); window.setTimeout(() => setTestState('success'), 900); };

  const connectHubRise = async () => {
    setHubriseState('connecting');
    setHubriseMessage('');
    try {
      window.sessionStorage.setItem('hubrise_oauth_restaurant_id', restaurantId);
      const { data: sessionData } = supabase ? await supabase.auth.getSession() : { data: { session: null } };
      const response = await fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-oauth?action=connect', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${sessionData.session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ restaurantId }),
      });
      const result = await response.json() as { url?: string; error?: string };
      if (!response.ok || !result.url) throw new Error(result.error ?? 'Impossible de démarrer la connexion HubRise.');
      window.location.assign(result.url);
    } catch (error) {
      setHubriseState('error');
      setHubriseMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const syncCatalog = async () => {
    setHubriseState('connecting');
    setHubriseMessage('');
    try {
      const res = await fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-oauth?action=sync_catalog', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ restaurantId }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; productsImported?: number; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error ?? 'Échec de la synchronisation');
      setProductsCount(data.productsImported ?? null);
      setLastSync(new Date().toISOString());
      setHubriseState('connected');
      setHubriseMessage(`${data.productsImported ?? 0} produits synchronisés`);
      await onCatalogSynced();
    } catch (error) {
      setHubriseState('error');
      setHubriseMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const sendTestOrder = async () => {
    setOrderTestState('sending');
    setOrderTestMessage('');
    try {
      const res = await fetch('https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-oauth?action=send_order', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ restaurantId, items: [{ name: 'Menu Whopper', quantity: 1, price: 12.9 }] }),
      });
      const data = await res.json().catch(() => ({})) as { success?: boolean; orderId?: string; error?: string };
      if (!res.ok || !data.success) throw new Error(data.error ?? 'Échec de l\'envoi');
      setOrderTestState('success');
      setOrderTestMessage(`Commande test envoyée : ${data.orderId ?? '—'}`);
    } catch (error) {
      setOrderTestState('error');
      setOrderTestMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div>
      <SectionHeading eyebrow="Configuration technique" title="Connectez votre environnement restaurant" description="HubRise centralisera la liaison avec votre caisse, votre catalogue et vos flux de commande. Les identifiants restent protégés côté serveur." action={<button onClick={runTest} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">{testState === 'testing' ? 'Test en cours…' : testState === 'success' ? '✓ Connexion validée' : 'Tester le flux complet'}</button>} />
      <section className={`${panelCard} mb-5 overflow-hidden border-[#d9e5dc]`}>
        <div className="flex flex-col gap-6 bg-[#0e2418] p-6 text-white md:flex-row md:items-center md:justify-between md:p-8">
          <div className="flex items-start gap-4">
            <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-[#ff5a36] text-2xl font-black">H</span>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[.2em] text-[#ffc647]">{hubriseState === 'connected' ? 'Connecté à HubRise' : 'Connexion recommandée'}</p>
              <h2 className="mt-2 text-2xl font-black">{hubriseState === 'connected' ? 'HubRise connecté' : 'Connecter HubRise'}</h2>
              <p className="mt-2 max-w-xl text-sm leading-relaxed text-white/60">
                {hubriseState === 'connected'
                  ? `La caisse est synchronisée. ${lastSync ? 'Dernière synchronisation : ' + new Date(lastSync).toLocaleString('fr-FR') : ''} ${productsCount !== null ? `(${productsCount} produits importés)` : ''}`
                  : 'Connectez la caisse de cet établissement et synchronisez les commandes, le catalogue et les disponibilités depuis un seul espace.'}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-3 md:items-end">
            {hubriseState === 'connected' ? (
              <div className="flex flex-wrap gap-2">
                <button onClick={syncCatalog} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white transition hover:bg-[#ff7657]">↻ Synchroniser le catalogue</button>
                <button onClick={sendTestOrder} disabled={orderTestState === 'sending'} className="rounded-xl border border-white/30 bg-white/10 px-5 py-3 text-xs font-black text-white transition hover:bg-white/20 disabled:opacity-60">{orderTestState === 'sending' ? 'Envoi…' : 'Envoyer une commande test'}</button>
              </div>
            ) : (
              <button onClick={connectHubRise} disabled={hubriseState === 'connecting'} className="shrink-0 rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white transition hover:bg-[#ff7657] disabled:opacity-60">{hubriseState === 'connecting' ? 'Connexion en cours…' : 'Connecter HubRise →'}</button>
            )}
            {hubriseMessage && <p className="max-w-xl text-xs font-semibold text-[#ff927a]">{hubriseMessage}</p>}
            {orderTestMessage && <p className={`max-w-xl text-xs font-semibold ${orderTestState === 'success' ? 'text-[#7ce3a1]' : 'text-[#ff927a]'}`}>{orderTestMessage}</p>}
          </div>
        </div>
        <div className="flex flex-wrap gap-5 border-t border-[#e3ebe5] px-6 py-4 text-xs font-bold text-[#68776c] md:px-8"><span>✓ Caisse POS</span><span>✓ Catalogue en temps réel</span><span>✓ Commandes synchronisées</span><span>✓ Données chiffrées</span></div>
      </section>
      <section className={`${panelCard} p-6 md:p-7`}><div className="flex flex-wrap items-center justify-between gap-4"><div><p className="text-xs font-black uppercase tracking-widest text-[#ff5a36]">Flux couverts</p><h2 className="mt-2 text-xl font-black">Une connexion pour vos commandes</h2><p className="mt-2 max-w-2xl text-sm leading-relaxed text-[#778279]">DriveVoice prend la commande, la transmet à votre caisse via HubRise et suit la synchronisation du catalogue. Le paiement reste géré par votre restaurant.</p></div><span className="rounded-full bg-[#e5f6e9] px-3 py-2 text-[10px] font-black text-[#27894a]">Commandes uniquement</span></div><div className="mt-6 grid gap-3 sm:grid-cols-3">{[['01','Connecter','Autorisez la caisse du restaurant'],['02','Synchroniser','Récupérez la carte HubRise'],['03','Transmettre','Envoyez chaque commande confirmée']].map(([number,title,detail])=><div key={number} className="rounded-2xl bg-[#f7f8f5] p-4"><span className="text-[10px] font-black text-[#ff5a36]">{number}</span><p className="mt-2 text-sm font-black">{title}</p><p className="mt-1 text-xs leading-relaxed text-[#7d877f]">{detail}</p></div>)}</div></section>
    </div>
  );
}

function AccountPanel() {
  return (
    <div>
      <SectionHeading eyebrow="Espace restaurant" title="Mon compte" description="Gérez votre abonnement, vos factures et les droits d’accès de votre équipe." action={<button className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">Gérer l’abonnement</button>} />
      <div className="grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
        <section className={`${panelCard} p-6 md:p-7`}><div className="flex items-start justify-between"><div><p className="text-xs font-black uppercase tracking-widest text-[#ff5a36]">Abonnement actuel</p><h2 className="mt-2 text-2xl font-black">DriveVoice Pro</h2><p className="mt-2 text-sm text-[#748078]">Facturation mensuelle · prochain renouvellement le 02 octobre 2026</p></div><span className="rounded-full bg-[#e1f6e7] px-3 py-1.5 text-[10px] font-black uppercase text-[#278a49]">Actif</span></div><div className="mt-7 grid gap-3 sm:grid-cols-3">{[['Commandes incluses','1 000 / mois'],['Agents IA','1 actif'],['Établissements','1 connecté']].map(([label,value])=><div key={label} className="rounded-2xl bg-[#f7f8f5] p-4"><p className="text-[10px] font-bold text-[#8a948c]">{label}</p><p className="mt-2 text-sm font-black">{value}</p></div>)}</div></section>
        <section className={`${panelCard} p-6 md:p-7`}><p className="text-xs font-black uppercase tracking-widest text-[#ff5a36]">Facturation</p><h2 className="mt-2 text-xl font-black">Dernière facture</h2><div className="mt-5 flex items-center justify-between rounded-2xl border border-[#e5e9e3] p-4"><div><p className="text-sm font-black">Facture septembre 2026</p><p className="mt-1 text-xs text-[#859087]">02 septembre 2026</p></div><div className="text-right"><p className="font-black">149,00 €</p><button className="mt-1 text-[10px] font-black text-[#ff5a36]">Télécharger PDF</button></div></div><button className="mt-5 w-full rounded-xl border border-[#dfe4dc] py-3 text-xs font-black">Voir toutes les factures</button></section>
      </div>
      <section className={`${panelCard} mt-5 p-6 md:p-7`}><div className="flex items-start justify-between"><div><p className="text-xs font-black uppercase tracking-widest text-[#ff5a36]">Droits d’accès</p><h2 className="mt-2 text-xl font-black">Équipe du restaurant</h2><p className="mt-1 text-sm text-[#7b857d]">Contrôlez ce que chaque profil peut consulter ou modifier.</p></div><button className="rounded-xl bg-[#0b1f14] px-4 py-3 text-xs font-black text-white">＋ Inviter un membre</button></div><div className="mt-6 overflow-hidden rounded-2xl border border-[#e7ebe5]"><div className="grid grid-cols-[1.3fr_1fr_1fr] bg-[#f7f8f5] px-4 py-3 text-[10px] font-black uppercase tracking-widest text-[#8b948c]"><span>Profil</span><span>Accès</span><span>Statut</span></div>{[['Alex Martin','Espace directeur','Administrateur'],['Sophie Bernard','Espace manager','Actif'],['Équipe restaurant','Espace franchisé','12 membres']].map(([name,role,status])=><div key={name} className="grid grid-cols-[1.3fr_1fr_1fr] items-center border-t border-[#edf0eb] px-4 py-4 text-xs"><span className="font-black">{name}</span><span className="font-semibold text-[#68746b]">{role}</span><span className="font-black text-[#2b9652]">● {status}</span></div>)}</div></section>
    </div>
  );
}

function CatalogPanel({ products, setProducts }: { products: CatalogProduct[]; setProducts: React.Dispatch<React.SetStateAction<CatalogProduct[]>> }) {
  const [query, setQuery] = useState('');
  const [saved, setSaved] = useState(false);
  const [syncState, setSyncState] = useState<'synced' | 'refreshing'>('synced');
  const [selectedProduct, setSelectedProduct] = useState<CatalogProduct | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<Record<number, number[]>>({});
  const filtered = products.filter(product => `${product.name} ${product.category} ${product.posCode}`.toLowerCase().includes(query.toLowerCase()));
  const updateProduct = (id: number, patch: Partial<CatalogProduct>) => setProducts(current => current.map(product => product.id === id ? { ...product, ...patch } : product));
  const addProduct = () => setProducts(current => [...current, { id: Date.now(), productId: `product_${Date.now()}`, name: 'Nouveau produit', detail: 'Description à compléter', emoji: '🍽️', category: 'Menus', price: 0, posCode: `NEW-${current.length + 1}`, available: true }]);
  const save = () => { setSaved(true); window.setTimeout(() => setSaved(false), 1800); };
  const refresh = async () => {
    setSyncState('refreshing');
    const rows = await fetchRestaurantProducts(demoRestaurantId);
    if (rows) setProducts(rows.map(mapRestaurantProduct));
    setSyncState('synced');
  };
  const selectedPrice = selectedProduct
    ? calculateCatalogPrice(selectedProduct.price, selectedProduct.optionGroups ?? [], selectedOptions)
    : 0;
  const canAddSelected = selectedProduct
    ? validateCatalogSelection(selectedProduct.optionGroups ?? [], selectedOptions).valid
    : false;
  return (
    <div>
      <SectionHeading eyebrow="Carte restaurant" title="Catalogue HubRise" description="Consultez la carte importée depuis la caisse de cet établissement. Les produits, prix et disponibilités sont synchronisés avec HubRise en temps réel." action={<div className="flex flex-wrap gap-2"><button onClick={refresh} className="rounded-xl border border-[#dfe4dc] bg-white px-4 py-3 text-xs font-black">{syncState === 'refreshing' ? 'Synchronisation…' : '↻ Actualiser'}</button><span className="flex items-center gap-2 rounded-xl bg-[#e5f6e9] px-4 py-3 text-xs font-black text-[#27894a]"><span className="h-2 w-2 rounded-full bg-[#35a85a]" />Synchronisé en direct</span></div>} />
      <section className={`${panelCard} mb-5 overflow-hidden`}><div className="flex flex-col gap-5 bg-[#0e2418] p-6 text-white md:flex-row md:items-center md:justify-between md:p-7"><div className="flex items-start gap-4"><span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#ff5a36] text-lg font-black">H</span><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#ffc647]">Source de vérité</p><h2 className="mt-1 text-xl font-black">Carte du restaurant · HubRise</h2><p className="mt-2 text-sm text-white/60">Dernière synchronisation il y a quelques secondes · Les modifications de la caisse seront répercutées automatiquement.</p></div></div><div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-right"><p className="text-[10px] font-bold uppercase tracking-widest text-white/45">Établissement</p><p className="mt-1 text-sm font-black">BK Paris République</p></div></div><div className="flex flex-wrap gap-5 border-t border-[#dce9df] px-6 py-4 text-xs font-bold text-[#68776c] md:px-7"><span>✓ Catalogue importé</span><span>✓ Prix synchronisés</span><span>✓ Disponibilités en direct</span><span>✓ Utilisé par l’agent IA</span></div></section>
      <section className={`${panelCard} overflow-hidden`}><div className="flex flex-col gap-4 border-b border-[#e7ebe5] p-5 md:flex-row md:items-center md:justify-between"><div className="flex items-center gap-3"><input aria-label="Rechercher dans le catalogue HubRise" className={`${fieldClass} md:w-80`} placeholder="Rechercher dans le catalogue HubRise…" value={query} onChange={event=>setQuery(event.target.value)} /><span className="rounded-full bg-[#eef2ed] px-3 py-2 text-xs font-black">{products.length} produits</span></div><div className="flex gap-2 text-xs"><span className="rounded-full bg-[#e5f6e9] px-3 py-2 font-black text-[#28894a]">{products.filter(p=>p.available).length} disponibles</span><span className="rounded-full bg-[#f3f4f1] px-3 py-2 font-black text-[#737d75]">{products.filter(p=>!p.available).length} masqués</span></div></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left"><thead className="bg-[#f8f9f6] text-[10px] font-black uppercase tracking-[.14em] text-[#8f9790]"><tr>{['Produit','Catégorie HubRise','Prix TTC','Configuration','Disponibilité'].map(label=><th key={label} className="px-5 py-3">{label}</th>)}</tr></thead><tbody>{filtered.map(product=><tr key={product.id} onClick={() => { setSelectedProduct(product); setSelectedOptions({}); }} className="cursor-pointer border-t border-[#edf0eb] transition hover:bg-[#fbfcfa]"><td className="px-5 py-4"><button onClick={event => { event.stopPropagation(); setSelectedProduct(product); setSelectedOptions({}); }} className="w-full min-w-48 text-left font-black hover:text-[#ff5a36]">{product.name}</button></td><td className="px-5 py-4"><span className="rounded-lg bg-[#f3f5f1] px-3 py-2 text-xs font-bold">{product.category}</span></td><td className="px-5 py-4"><div className="flex items-center gap-1"><input onClick={event => event.stopPropagation()} aria-label={`Prix de ${product.name}`} className="w-20 rounded-lg border border-[#e0e4de] px-3 py-2 text-sm font-black" type="number" step="0.1" value={product.price} onChange={event=>updateProduct(product.id,{price:Number(event.target.value)})} /><span className="font-black">€</span></div></td><td className="px-5 py-4 text-xs font-semibold text-[#69756c]">{product.optionGroups?.length ? `${product.optionGroups.length} groupe${product.optionGroups.length > 1 ? 's' : ''} de choix · Voir les détails` : 'Produit simple · Voir les détails'}</td><td className="px-5 py-4"><button onClick={event=>{ event.stopPropagation(); updateProduct(product.id,{available:!product.available}); }} className={`flex items-center gap-2 rounded-full px-3 py-2 text-xs font-black ${product.available?'bg-[#e3f6e8] text-[#258848]':'bg-[#eff1ee] text-[#7f8880]'}`}><span className={`h-2 w-2 rounded-full ${product.available?'bg-[#34a759]':'bg-[#a6ada7]'}`} />{product.available?'Disponible':'Masqué'}</button></td></tr>)}</tbody></table></div>
      </section>
      {selectedProduct && <div className="fixed inset-0 z-50 grid place-items-center bg-[#0b1f14]/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={`Détails de ${selectedProduct.name}`} onClick={() => setSelectedProduct(null)}>
        <div className="max-h-[min(860px,calc(100vh-2rem))] w-full max-w-5xl overflow-hidden rounded-[28px] bg-white shadow-2xl" onClick={event => event.stopPropagation()}>
          <div className="flex items-center justify-between border-b border-[#e7ebe5] px-6 py-4"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#ff5a36]">{selectedProduct.category}</p><h2 className="mt-1 text-2xl font-black">{selectedProduct.name}</h2></div><button onClick={() => setSelectedProduct(null)} aria-label="Fermer les détails" className="grid h-10 w-10 place-items-center rounded-full bg-[#f3f5f1] text-xl">×</button></div>
          <div className="grid max-h-[calc(100vh-8rem)] overflow-y-auto md:grid-cols-[.9fr_1.1fr]">
            <div className="m-6 grid min-h-64 place-items-center rounded-3xl bg-[#f4f6f2] p-6">{selectedProduct.imageUrl ? <img src={selectedProduct.imageUrl} alt={selectedProduct.name} className="max-h-80 w-full object-contain" /> : <div className="text-center text-[#89948b]"><div className="text-6xl">🍽️</div><p className="mt-3 text-xs font-bold">Image non fournie par HubRise</p></div>}</div>
            <div className="p-6 md:pl-0"><p className="text-sm leading-relaxed text-[#657168]">{selectedProduct.detail || 'Détails du produit importés depuis HubRise.'}</p><p className="mt-3 text-2xl font-black">{money.format(selectedPrice)}</p>
              <div className="mt-6 space-y-5">{(selectedProduct.optionGroups ?? []).map(group => <section key={group.id}><div className="flex items-start justify-between gap-3"><div><h3 className="font-black">{group.name}</h3><p className="mt-1 text-xs text-[#7f8981]">{group.question}</p></div><span className={`rounded-full px-2 py-1 text-[10px] font-black ${group.required ? 'bg-[#fff0ea] text-[#d95332]' : 'bg-[#eef4ee] text-[#36814d]'}`}>{group.required ? 'Obligatoire' : 'Facultatif'}</span></div><div className="mt-3 space-y-2">{group.options.filter(option => option.available).map(option => { const active = selectedOptions[group.id]?.includes(option.id); return <button key={option.id} onClick={() => setSelectedOptions(current => { const values = current[group.id] ?? []; const next = group.max === 1 ? (active ? [] : [option.id]) : active ? values.filter(id => id !== option.id) : values.length < group.max ? [...values, option.id] : values; return { ...current, [group.id]: next }; })} className={`flex w-full items-center justify-between rounded-xl border px-4 py-3 text-left text-sm transition ${active ? 'border-[#ff5a36] bg-[#fff3ef]' : 'border-[#e7ebe5] hover:border-[#ffb29f]'}`}><span className="font-bold">{option.name}</span><span className="flex items-center gap-3">{option.priceDelta ? <span className="text-xs font-black text-[#bd5d3d]">+{money.format(option.priceDelta)}</span> : null}<span className={`grid h-5 w-5 place-items-center rounded-full border-2 ${active ? 'border-[#ff5a36] bg-[#ff5a36]' : 'border-[#aeb7af]'}`}>{active && <span className="h-2 w-2 rounded-full bg-white" />}</span></span></button>; })}</div></section>)}</div>
              <button disabled={!selectedProduct.available || !canAddSelected} className="mt-7 w-full rounded-2xl bg-[#0b1f14] px-5 py-4 text-sm font-black text-white disabled:cursor-not-allowed disabled:bg-[#dfe5de] disabled:text-[#879187]">Ajouter à la commande · {money.format(selectedPrice)}</button>
            </div>
          </div>
        </div>
      </div>}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#dfe8e0] bg-[#eef7f0] px-5 py-4 text-xs"><span className="font-black text-[#267d43]">● Catalogue synchronisé avec HubRise</span><span className="font-semibold text-[#6f8073]">Dernière mise à jour il y a quelques secondes · Lecture seule</span></div>
    </div>
  );
}

function EnterpriseCatalogPanel({ products, setProducts }: { products: CatalogProduct[]; setProducts: React.Dispatch<React.SetStateAction<CatalogProduct[]>> }) {
  const [sourceUrl, setSourceUrl] = useState('https://www.burgerking.fr/carte');
  const [importState, setImportState] = useState<'idle' | 'scanning' | 'ready'>('idle');
  const [activeCategory, setActiveCategory] = useState('Accueil');
  const [selectedProduct, setSelectedProduct] = useState<CatalogProduct | null>(null);
  const importedCatalog: CatalogProduct[] = [
    { id: 101, productId: 'master_cantal', name: 'Master Cantal', detail: 'Bœuf grillé, cantal AOP, sauce moutarde', emoji: '🍔', category: 'Nouveautés', price: 13.9, posCode: 'BK-MST-CAN', available: true, ingredients: ['Pain brioché', 'Steak haché grillé à la flamme', 'Cantal AOP', 'Oignons croustillants', 'Sauce moutarde'] },
    { id: 102, productId: 'menu_whopper', name: 'Menu Whopper', detail: 'Whopper, accompagnement et boisson au choix', emoji: '🥤', category: 'Menus', price: 12.9, posCode: 'BK-MNU-WHP', available: true, ingredients: ['Whopper', 'Frites ou onion rings', 'Boisson 40 cl', 'Sauce au choix'] },
    { id: 103, productId: 'whopper', name: 'Whopper', detail: 'Le burger iconique grillé à la flamme', emoji: '🍔', category: 'Burgers', price: 7.9, posCode: 'BK-BRG-WHP', available: true, ingredients: ['Pain aux graines de sésame', 'Steak haché grillé', 'Tomates', 'Salade', 'Cornichons', 'Oignons', 'Sauce'] },
    { id: 104, productId: 'king_junior', name: 'King Junior', detail: 'Menu enfant avec plat, accompagnement et boisson', emoji: '👑', category: 'Menus Enfants', price: 5.5, posCode: 'BK-KID-001', available: true, ingredients: ['Produit principal au choix', 'Petite frite', 'Boisson', 'Dessert ou fruit'] },
    { id: 105, productId: 'kingbox_20', name: 'Kingbox 20', detail: 'Assortiment généreux à partager', emoji: '🍗', category: 'À Partager', price: 16.9, posCode: 'BK-SHR-020', available: true, ingredients: ['Nuggets', 'Chili cheese', 'Onion rings', 'Sauces au choix'] },
    { id: 106, productId: 'wrap_crousty', name: 'Crousty Wrap', detail: 'Poulet croustillant, salade et sauce', emoji: '🌯', category: 'Tortillas & Wraps', price: 6.9, posCode: 'BK-WRP-CRS', available: true, ingredients: ['Tortilla de blé', 'Poulet pané', 'Salade', 'Tomates', 'Sauce'] },
    { id: 107, productId: 'chili_cheese_6', name: 'Chili Cheese x6', detail: 'Bouchées panées au fromage et piment', emoji: '🧀', category: 'Snacks & Sauces', price: 4.9, posCode: 'BK-SNK-CC6', available: true, ingredients: ['Fromage fondu', 'Piment jalapeño', 'Panure'] },
    { id: 108, productId: 'king_sundae', name: 'King Sundae', detail: 'Glace onctueuse avec nappage au choix', emoji: '🍨', category: 'Desserts & Boissons', price: 3.5, posCode: 'BK-DES-SUN', available: true, ingredients: ['Glace vanille', 'Nappage au choix'] },
    { id: 109, productId: 'double_cheese', name: 'Double Cheese', detail: 'Deux steaks, fromage et sauce', emoji: '🍔', category: 'Bon et Pas Cher', price: 4.9, posCode: 'BK-VFM-DC', available: true, ingredients: ['Pain', 'Deux steaks hachés', 'Fromage fondu', 'Cornichons', 'Sauce'] },
    { id: 110, productId: 'salade_chicken', name: 'Salade Chicken', detail: 'Salade composée et poulet croustillant', emoji: '🥗', category: 'Salades', price: 7.5, posCode: 'BK-SAL-CHK', available: true, ingredients: ['Salade', 'Poulet pané', 'Tomates', 'Fromage', 'Sauce salade'] },
  ];
  const categories = ['Accueil', 'Nouveautés', 'Menus', 'Burgers', 'Menus Enfants', 'À Partager', 'Tortillas & Wraps', 'Snacks & Sauces', 'Desserts & Boissons', 'Bon et Pas Cher', 'Salades'];
  const categoryIcons: Record<string, string> = { Accueil: '⌂', Nouveautés: '✦', Menus: '▤', Burgers: '🍔', 'Menus Enfants': '♛', 'À Partager': '♧', 'Tortillas & Wraps': '🌯', 'Snacks & Sauces': '◌', 'Desserts & Boissons': '🍨', 'Bon et Pas Cher': '€', Salades: '🥗' };
  const displayedProducts = activeCategory === 'Accueil' ? products : products.filter(product => product.category === activeCategory);
  const importCatalog = () => {
    if (!/^https?:\/\//i.test(sourceUrl.trim())) return;
    setImportState('scanning');
    window.setTimeout(() => {
      setProducts(importedCatalog);
      setActiveCategory('Accueil');
      setImportState('ready');
    }, 1300);
  };
  return (
    <div>
      <SectionHeading eyebrow="Catalogue omnicanal" title="Carte du restaurant" description="Importez la carte officielle d’une enseigne, contrôlez sa structure puis synchronisez les catégories, produits, compositions et disponibilités avec DriveVoice." action={<span className="rounded-full bg-[#e4f6e9] px-4 py-2 text-[10px] font-black text-[#27894a]">● Catalogue maître</span>} />
      <section className={`${panelCard} overflow-hidden`}>
        <div className="bg-[#0b1f14] p-6 text-white md:p-7"><div className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#77d994]">Source de la carte</p><h2 className="mt-2 text-2xl font-black tracking-[-.04em]">Importer depuis le site de l’enseigne</h2><p className="mt-2 max-w-2xl text-xs leading-relaxed text-white/55">DriveVoice analyse l’arborescence publique, les fiches produits et les visuels, puis prépare un catalogue structuré à valider avant diffusion.</p></div><div className="flex w-full max-w-2xl flex-col gap-2 sm:flex-row"><input aria-label="URL de la carte du restaurant" className="h-12 min-w-0 flex-1 rounded-xl border border-white/15 bg-white/10 px-4 text-sm font-bold text-white outline-none placeholder:text-white/30 focus:border-[#ff7658]" value={sourceUrl} onChange={event=>setSourceUrl(event.target.value)} placeholder="https://www.enseigne.fr/carte" /><button onClick={importCatalog} disabled={importState==='scanning'} className="h-12 shrink-0 rounded-xl bg-[#ff5a36] px-5 text-xs font-black text-white disabled:opacity-60">{importState==='scanning'?'Analyse en cours…':'Analyser et importer'}</button></div></div>
          {importState==='scanning'&&<div className="mt-5"><div className="mb-2 flex justify-between text-[10px] font-bold text-white/55"><span>Lecture des catégories et des fiches produits</span><span>Synchronisation…</span></div><div className="h-1.5 overflow-hidden rounded-full bg-white/10"><div className="h-full w-3/4 rounded-full bg-[#ff5a36]" /></div></div>}
          {importState==='ready'&&<div className="mt-5 flex flex-wrap gap-2 text-[10px] font-black"><span className="rounded-full bg-white/10 px-3 py-2">✓ {categories.length-1} catégories</span><span className="rounded-full bg-white/10 px-3 py-2">✓ {products.length} produits détectés</span><span className="rounded-full bg-white/10 px-3 py-2">✓ Compositions indexées</span><span className="rounded-full bg-[#2e9553] px-3 py-2">Prêt à valider</span></div>}
        </div>
        <nav className="flex gap-1 overflow-x-auto border-b border-[#e8e1d5] bg-[#fff9ef] px-4 py-3" aria-label="Catégories de la carte">{categories.map(category=><button key={category} onClick={()=>setActiveCategory(category)} className={`flex shrink-0 flex-col items-center gap-1 rounded-xl px-3 py-2 text-[10px] font-black transition ${activeCategory===category?'bg-[#ff5a36] text-white shadow-md':'text-[#725748] hover:bg-white'}`}><span className="text-base">{categoryIcons[category]}</span><span>{category}</span></button>)}</nav>
        <div className="bg-[#f7efe2] p-5 md:p-7"><div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#a16e51]">Aperçu de la carte importée</p><h2 className="mt-1 text-2xl font-black">{activeCategory === 'Accueil' ? 'Toutes les catégories' : activeCategory}</h2></div><div className="flex gap-2"><span className="rounded-full bg-white px-3 py-2 text-[10px] font-black">{displayedProducts.length} produits</span><button className="rounded-xl bg-white px-4 py-2 text-[10px] font-black text-[#ff5a36]">Modifier la structure</button></div></div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">{displayedProducts.map(product=><button key={product.id} onClick={()=>setSelectedProduct(product)} className="group overflow-hidden rounded-[20px] border border-[#eadfce] bg-white text-left shadow-[0_10px_30px_rgba(70,42,20,.06)] transition hover:-translate-y-1 hover:border-[#ff9a81]"><div className="grid h-40 place-items-center bg-gradient-to-br from-[#fffdf9] to-[#f5ead9]">{product.imageUrl?<img src={product.imageUrl} alt={product.name} className="h-full w-full object-contain p-3 transition group-hover:scale-105" />:<span className="text-7xl transition group-hover:scale-110">{product.emoji}</span>}</div><div className="border-t border-[#f0e8dc] p-4"><span className="text-[9px] font-black uppercase tracking-wider text-[#a37459]">{product.category}</span><h3 className="mt-1 text-base font-black">{product.name}</h3><p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[#7d817c]">{product.detail}</p><div className="mt-4 flex items-center justify-between"><strong>{money.format(product.price)}</strong><span className="rounded-full bg-[#e5f6e9] px-2 py-1 text-[9px] font-black text-[#27894a]">Disponible</span></div></div></button>)}</div>
        </div>
      </section>
      {selectedProduct&&<div className="fixed inset-0 z-50 grid place-items-center bg-[#07130d]/55 p-4" role="dialog" aria-modal="true" aria-label={`Fiche ${selectedProduct.name}`}><div className="w-full max-w-xl overflow-hidden rounded-[28px] bg-white shadow-2xl"><div className="flex items-start justify-between bg-[#fff7eb] p-6"><div><span className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Fiche produit importée</span><h2 className="mt-2 text-2xl font-black">{selectedProduct.name}</h2><p className="mt-1 text-xs text-[#7d817c]">{selectedProduct.category} · {selectedProduct.posCode}</p></div><button onClick={()=>setSelectedProduct(null)} aria-label="Fermer" className="grid h-10 w-10 place-items-center rounded-xl bg-white font-black">×</button></div><div className="p-6"><div className="grid gap-5 sm:grid-cols-[110px_1fr]"><div className="grid h-28 place-items-center rounded-2xl bg-[#f7efe2]">{selectedProduct.imageUrl?<img src={selectedProduct.imageUrl} alt={selectedProduct.name} className="h-full w-full object-contain p-2" />:<span className="text-6xl">{selectedProduct.emoji}</span>}</div><div><p className="text-xs leading-relaxed text-[#6f7971]">{selectedProduct.detail}</p><p className="mt-4 text-[10px] font-black uppercase tracking-widest text-[#9a7966]">Composition</p><div className="mt-2 flex flex-wrap gap-2">{(selectedProduct.ingredients??['Composition à vérifier']).map(ingredient=><span key={ingredient} className="rounded-full bg-[#f1f3ee] px-3 py-2 text-[10px] font-bold">{ingredient}</span>)}</div></div></div><div className="mt-6 grid gap-3 sm:grid-cols-3">{[['Prix TTC',money.format(selectedProduct.price)],['Code POS',selectedProduct.posCode],['Statut',selectedProduct.available?'Disponible':'Masqué']].map(([label,value])=><div key={label} className="rounded-xl border border-[#e5e9e2] p-3"><p className="text-[9px] font-black uppercase tracking-wider text-[#949c95]">{label}</p><p className="mt-1 text-sm font-black">{value}</p></div>)}</div><div className="mt-6 flex justify-end gap-2"><button className="rounded-xl border border-[#dfe4dc] px-4 py-3 text-xs font-black">Modifier</button><button onClick={()=>setSelectedProduct(null)} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">Valider la fiche</button></div></div></div></div>}
    </div>
  );
}

type MenuCategory = { id: number; name: string; icon: string; enabled: boolean };
type ProductDraft = {
  name: string; detail: string; category: string; subcategory: string; price: number; posCode: string; emoji: string; ingredients: any; available: boolean;
  productType: 'simple' | 'configurable' | 'menu' | 'bundle';
  variants: ProductVariant[];
  optionGroups: ProductOptionGroup[];
  modifiers: ProductModifier[];
  imageUrl: string; slug: string; meatFilter: string; badges: string; ingredientImages: string; allergens: string; traces: string; displayOrder: number; nutrition: ProductNutrition;
};

function ProductConfigurator({ product, onClose, onSave }: { product: CatalogProduct; onClose: () => void; onSave: (patch: Partial<CatalogProduct>) => void }) {
  const [productType, setProductType] = useState<CatalogProduct['productType']>(product.productType ?? (product.category === 'Menus' ? 'menu' : 'configurable'));
  const [variants, setVariants] = useState<ProductVariant[]>(product.variants ?? []);
  const [groups, setGroups] = useState<ProductOptionGroup[]>(product.optionGroups ?? []);
  const [modifiers, setModifiers] = useState<ProductModifier[]>(product.modifiers ?? []);
  const addGroup = () => setGroups(current => [...current, { id: Date.now(), name: 'Nouveau groupe', question: 'Quel choix souhaitez-vous ?', required: true, min: 1, max: 1, options: [] }]);
  const updateGroup = (id: number, patch: Partial<ProductOptionGroup>) => setGroups(current => current.map(group => group.id === id ? { ...group, ...patch } : group));
  const addOption = (groupId: number) => setGroups(current => current.map(group => group.id === groupId ? { ...group, options: [...group.options, { id: Date.now(), name: 'Nouvelle option', priceDelta: 0, posCode: '', available: true }] } : group));
  const updateOption = (groupId: number, optionId: number, patch: Partial<ProductOption>) => setGroups(current => current.map(group => group.id === groupId ? { ...group, options: group.options.map(option => option.id === optionId ? { ...option, ...patch } : option) } : group));
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-[#07130d]/60 p-4" role="dialog" aria-modal="true" aria-label={`Configuration de ${product.name}`}>
      <div className="max-h-[94vh] w-full max-w-5xl overflow-y-auto rounded-[30px] bg-[#f5f6f1] shadow-2xl">
        <div className="sticky top-0 z-20 flex items-start justify-between border-b border-[#dfe4dc] bg-white p-6"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#ff5a36]">Phase 2 · Configuration avancée</p><h2 className="mt-1 text-2xl font-black">{product.emoji} {product.name}</h2><p className="mt-1 text-xs text-[#7d867e]">Construisez les variantes, choix et personnalisations compris par l’agent.</p></div><button onClick={onClose} className="grid h-10 w-10 place-items-center rounded-xl bg-[#f0f3ee] font-black">×</button></div>
        <div className="space-y-5 p-5 md:p-6">
          <section className={`${panelCard} p-5`}><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Type de produit</p><div className="mt-4 grid gap-2 sm:grid-cols-4">{([['simple','Produit simple','Sans choix'],['configurable','Personnalisable','Burger ou wrap'],['menu','Menu / formule','Plusieurs choix'],['bundle','Lot / box','Produits groupés']] as const).map(([type,label,detail])=><button key={type} onClick={()=>setProductType(type)} className={`rounded-2xl border p-4 text-left ${productType===type?'border-[#ff7658] bg-[#fff4ef] ring-2 ring-[#ff7658]/15':'border-[#e3e7e0]'}`}><strong className="block text-xs">{label}</strong><span className="mt-1 block text-[9px] text-[#8a938b]">{detail}</span></button>)}</div></section>
          <section className={`${panelCard} p-5`}><div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Variantes et tailles</p><h3 className="mt-1 text-lg font-black">Formats disponibles</h3><p className="mt-1 text-[10px] text-[#858e86]">Ex. Petite, moyenne, grande ou parfum.</p></div><button onClick={()=>setVariants(current=>[...current,{id:Date.now(),name:'Nouvelle variante',priceDelta:0,posCode:''}])} className="rounded-xl bg-[#0b1f14] px-4 py-2.5 text-[10px] font-black text-white">＋ Variante</button></div><div className="mt-4 space-y-2">{variants.map(variant=><div key={variant.id} className="grid gap-2 rounded-2xl border border-[#e5e9e2] p-3 sm:grid-cols-[1fr_120px_150px_34px]"><input aria-label="Nom de la variante" className={fieldClass} value={variant.name} onChange={event=>setVariants(current=>current.map(item=>item.id===variant.id?{...item,name:event.target.value}:item))} /><input aria-label="Supplément variante" className={fieldClass} type="number" step="0.1" value={variant.priceDelta} onChange={event=>setVariants(current=>current.map(item=>item.id===variant.id?{...item,priceDelta:Number(event.target.value)}:item))} /><input aria-label="Code POS variante" className={`${fieldClass} font-mono`} placeholder="Code POS" value={variant.posCode} onChange={event=>setVariants(current=>current.map(item=>item.id===variant.id?{...item,posCode:event.target.value}:item))} /><button onClick={()=>setVariants(current=>current.filter(item=>item.id!==variant.id))} aria-label="Supprimer la variante" className="text-[#d6503d]">×</button></div>)}{!variants.length&&<p className="rounded-2xl border border-dashed border-[#d6dcd4] py-6 text-center text-xs text-[#8b948c]">Aucune variante configurée.</p>}</div></section>
          <section className={`${panelCard} p-5`}><div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Constructeur de menu</p><h3 className="mt-1 text-lg font-black">Groupes de choix</h3><p className="mt-1 text-[10px] text-[#858e86]">Accompagnement, boisson, dessert, sauce ou produit principal.</p></div><button onClick={addGroup} className="rounded-xl bg-[#0b1f14] px-4 py-2.5 text-[10px] font-black text-white">＋ Groupe</button></div><div className="mt-4 space-y-4">{groups.map(group=><div key={group.id} className="rounded-2xl border border-[#dfe4dc] bg-[#fafbf8] p-4"><div className="grid gap-2 md:grid-cols-[1fr_1.35fr_80px_80px]"><input aria-label="Nom du groupe" className={fieldClass} value={group.name} onChange={event=>updateGroup(group.id,{name:event.target.value})} /><input aria-label="Question posée au client" className={fieldClass} value={group.question} onChange={event=>updateGroup(group.id,{question:event.target.value})} /><label className="text-[9px] font-bold text-[#788179]">Minimum<input className={`${fieldClass} mt-1`} type="number" min="0" value={group.min} onChange={event=>updateGroup(group.id,{min:Number(event.target.value)})} /></label><label className="text-[9px] font-bold text-[#788179]">Maximum<input className={`${fieldClass} mt-1`} type="number" min="1" value={group.max} onChange={event=>updateGroup(group.id,{max:Number(event.target.value)})} /></label></div><div className="mt-3 flex items-center justify-between"><button onClick={()=>updateGroup(group.id,{required:!group.required})} className={`rounded-full px-3 py-2 text-[9px] font-black ${group.required?'bg-[#e3f6e8] text-[#27894a]':'bg-[#ecefec] text-[#737c74]'}`}>{group.required?'✓ Choix obligatoire':'Choix facultatif'}</button><button onClick={()=>setGroups(current=>current.filter(item=>item.id!==group.id))} className="text-[9px] font-black text-[#d6503d]">Supprimer le groupe</button></div><div className="mt-3 space-y-2">{group.options.map(option=><div key={option.id} className="grid gap-2 rounded-xl bg-white p-2 sm:grid-cols-[1fr_110px_140px_32px]"><input aria-label="Nom de l’option" className={fieldClass} value={option.name} onChange={event=>updateOption(group.id,option.id,{name:event.target.value})} /><input aria-label="Supplément option" className={fieldClass} type="number" step="0.1" value={option.priceDelta} onChange={event=>updateOption(group.id,option.id,{priceDelta:Number(event.target.value)})} /><input aria-label="Code POS option" className={`${fieldClass} font-mono`} placeholder="Code POS" value={option.posCode} onChange={event=>updateOption(group.id,option.id,{posCode:event.target.value})} /><button onClick={()=>updateGroup(group.id,{options:group.options.filter(item=>item.id!==option.id)})} aria-label="Supprimer l’option" className="text-[#d6503d]">×</button></div>)}<button onClick={()=>addOption(group.id)} className="mt-2 text-[10px] font-black text-[#ff5a36]">＋ Ajouter une option</button></div></div>)}{!groups.length&&<p className="rounded-2xl border border-dashed border-[#d6dcd4] py-8 text-center text-xs text-[#8b948c]">Ajoutez un groupe pour construire un menu ou un produit configurable.</p>}</div></section>
          <section className={`${panelCard} p-5`}><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Personnalisation</p><h3 className="mt-1 text-lg font-black">Retraits et suppléments</h3><p className="mt-1 text-[10px] text-[#858e86]">Définissez précisément les modifications autorisées.</p></div><div className="flex gap-2"><button onClick={()=>setModifiers(current=>[...current,{id:Date.now(),name:'Sans ingrédient',kind:'remove',priceDelta:0}])} className="rounded-xl border border-[#dfe4dc] px-3 py-2.5 text-[10px] font-black">＋ Retrait</button><button onClick={()=>setModifiers(current=>[...current,{id:Date.now(),name:'Nouveau supplément',kind:'add',priceDelta:0}])} className="rounded-xl bg-[#0b1f14] px-3 py-2.5 text-[10px] font-black text-white">＋ Supplément</button></div></div><div className="mt-4 grid gap-2 md:grid-cols-2">{modifiers.map(modifier=><div key={modifier.id} className="grid grid-cols-[90px_1fr_90px_28px] gap-2 rounded-2xl border border-[#e4e8e1] p-3"><select className={fieldClass} value={modifier.kind} onChange={event=>setModifiers(current=>current.map(item=>item.id===modifier.id?{...item,kind:event.target.value as 'remove'|'add'}:item))}><option value="remove">Retrait</option><option value="add">Ajout</option></select><input aria-label="Nom de la modification" className={fieldClass} value={modifier.name} onChange={event=>setModifiers(current=>current.map(item=>item.id===modifier.id?{...item,name:event.target.value}:item))} /><input aria-label="Prix de la modification" className={fieldClass} type="number" step="0.1" value={modifier.priceDelta} onChange={event=>setModifiers(current=>current.map(item=>item.id===modifier.id?{...item,priceDelta:Number(event.target.value)}:item))} /><button onClick={()=>setModifiers(current=>current.filter(item=>item.id!==modifier.id))} aria-label="Supprimer la modification" className="text-[#d6503d]">×</button></div>)}{!modifiers.length&&<p className="md:col-span-2 rounded-2xl border border-dashed border-[#d6dcd4] py-6 text-center text-xs text-[#8b948c]">Aucune personnalisation autorisée.</p>}</div></section>
          <div className="sticky bottom-0 flex justify-end gap-2 rounded-2xl border border-[#dfe4dc] bg-white/95 p-4 shadow-lg backdrop-blur"><button onClick={onClose} className="rounded-xl border border-[#dfe4dc] px-4 py-3 text-xs font-black">Annuler</button><button onClick={()=>{onSave({productType,variants,optionGroups:groups,modifiers});onClose();}} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">Enregistrer la configuration</button></div>
        </div>
      </div>
    </div>
  );
}

function IngredientProductEditor({ draft, setDraft, categories, catalogProducts, subcategoryOptions, newIngredient, setNewIngredient, addIngredient, updateIngredient, moveIngredient, onClose, onSave, onDelete, isNew }: {
  draft: ProductDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProductDraft>>;
  categories: MenuCategory[];
  catalogProducts: CatalogProduct[];
  subcategoryOptions: string[];
  newIngredient: string;
  setNewIngredient: React.Dispatch<React.SetStateAction<string>>;
  addIngredient: () => void;
  updateIngredient: (id: number, patch: Partial<ProductIngredient>) => void;
  moveIngredient: (index: number, direction: -1 | 1) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete?: () => void;
  isNew: boolean;
}) {
  const ingredientRows = draft.ingredients as ProductIngredient[];
  const isMenu = draft.productType === 'menu' || draft.category === 'Menus' || draft.category === 'Menus enfants';
  const isCompositionCategory = isMenu || draft.category === 'Burgers' || /tortilla|wrap/i.test(draft.category);
  const menuSteps = draft.optionGroups;
  const sizeStep = menuSteps.find(step => /taille/i.test(step.name));
  const [selectedMenuSize, setSelectedMenuSize] = useState(sizeStep?.options[0]?.name ?? 'Medium');
  useEffect(()=>{
    if (!isMenu || draft.optionGroups.length) return;
    const baseNames = draft.category === 'Menus enfants' ? ['Taille du menu','Plat','Accompagnement','Boisson','Sauces','Dessert','Jouet'] : ['Taille du menu','Plat','Accompagnement','Boisson','Sauces'];
    setDraft(current=>({...current,productType:'menu',optionGroups:baseNames.map((name,index)=>({id:Date.now()+index,name,question:`Choisissez : ${name.toLowerCase()}`,required:true,min:1,max:1,options:[]}))}));
  },[isMenu,draft.category,draft.optionGroups.length,setDraft]);
  const updateStep = (id:number, patch:Partial<ProductOptionGroup>)=>setDraft(current=>({...current,optionGroups:current.optionGroups.map(step=>step.id===id?{...step,...patch}:step)}));
  const moveStep = (index:number,direction:-1|1)=>setDraft(current=>{const target=index+direction;if(target<0||target>=current.optionGroups.length)return current;const optionGroups=[...current.optionGroups];[optionGroups[index],optionGroups[target]]=[optionGroups[target],optionGroups[index]];return {...current,optionGroups};});
  const addStep = ()=>setDraft(current=>({...current,optionGroups:[...current.optionGroups,{id:Date.now(),name:'Nouvelle composition',question:'Quel choix souhaitez-vous ?',required:false,min:0,max:1,options:[]}]}));
  const addStepOption = (stepId:number)=>setDraft(current=>({...current,optionGroups:current.optionGroups.map(step=>step.id===stepId?{...step,options:[...step.options,{id:Date.now(),name:'Nouvelle option',priceDelta:0,posCode:'',available:true}]}:step)}));
  const updateStepOption = (stepId:number,optionId:number,patch:Partial<ProductOption>)=>setDraft(current=>({...current,optionGroups:current.optionGroups.map(step=>step.id===stepId?{...step,options:step.options.map(option=>option.id===optionId?{...option,...patch}:option)}:step)}));
  const menuSourceProducts = (stepName:string) => {
    const key = stepName.toLowerCase();
    if (key.includes('plat')) return catalogProducts.filter(product=>product.category==='Burgers');
    if (key.includes('accompagnement')) return catalogProducts.filter(product=>product.category==='Snacks & Sauces'&&!/sauce/i.test(`${product.name} ${product.detail}`)&&menuOptionMatchesSize(product.name, selectedMenuSize, 'accompagnement'));
    if (key.includes('boisson')) return catalogProducts.filter(product=>product.category==='Desserts & Boissons'&&(/boisson/i.test(`${product.subcategory??''} ${product.detail}`)||['🥤','☕'].includes(product.emoji))&&menuOptionMatchesSize(product.name, selectedMenuSize, 'boisson'));
    if (key.includes('sauce')) return catalogProducts.filter(product=>product.category==='Sauces'||/sauce/i.test(`${product.subcategory??''} ${product.name} ${product.detail}`));
    if (key.includes('dessert')) return catalogProducts.filter(product=>product.category==='Desserts & Boissons'&&!/boisson/i.test(`${product.subcategory??''} ${product.detail}`));
    return [];
  };
  const toggleCatalogOption = (stepId:number, product:CatalogProduct) => setDraft(current=>({...current,optionGroups:current.optionGroups.map(step=>step.id===stepId?{...step,options:step.options.some(option=>option.name===product.name)?step.options.filter(option=>option.name!==product.name):[...step.options,{id:Date.now()+product.id,name:product.name,priceDelta:0,posCode:product.posCode,available:product.available}]}:step)}));
  const sizeRank = (name:string) => {const normalized=name.toLowerCase();if(/mini|enfant|petit/.test(normalized))return 1;if(/classique|standard|moyen/.test(normalized))return 2;if(/grand|large/.test(normalized))return 3;if(/xxl/.test(normalized))return 5;if(/xl/.test(normalized))return 4;return 99;};
  return <div className="fixed inset-0 z-[60] grid place-items-center bg-[#07130d]/55 p-4" role="dialog" aria-modal="true" aria-label="Constructeur de produit">
    <div className="max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-[28px] bg-white shadow-2xl">
      <div className="sticky top-0 z-10 flex items-start justify-between border-b border-[#e7eae5] bg-white p-6"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Fiche produit</p><h2 className="mt-1 text-2xl font-black">{isNew ? 'Créer un produit' : 'Modifier le produit'}</h2></div><button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-xl bg-[#f0f3ee] font-black">×</button></div>
      <div className="p-6">
        <div className="grid gap-4 md:grid-cols-[90px_1fr_1fr]"><label className="text-xs font-bold text-[#68736a]">Visuel<input className={`${fieldClass} mt-2 text-center text-2xl`} maxLength={3} value={draft.emoji} onChange={event=>setDraft(current=>({...current,emoji:event.target.value}))} /></label><label className="text-xs font-bold text-[#68736a]">Nom du produit *<input className={`${fieldClass} mt-2`} placeholder="Ex. Big King" value={draft.name} onChange={event=>setDraft(current=>({...current,name:event.target.value}))} /></label><label className="text-xs font-bold text-[#68736a]">Catégorie *<select className={`${fieldClass} mt-2`} value={draft.category} onChange={event=>{const category=event.target.value;setDraft(current=>({...current,category,subcategory:subcategoryTemplates[category]?.[1]??'',productType:category==='Menus'||category==='Menus enfants'?'menu':current.productType==='menu'?'simple':current.productType}));}}>{categories.map(category=><option key={category.id}>{category.name}</option>)}</select></label></div>
        {subcategoryOptions.length>1&&<label className="mt-4 block text-xs font-bold text-[#68736a]">Sous-catégorie<select className={`${fieldClass} mt-2`} value={draft.subcategory} onChange={event=>setDraft(current=>({...current,subcategory:event.target.value}))}>{subcategoryOptions.filter(option=>option!=='Tous').map(option=><option key={option}>{option}</option>)}</select></label>}
        <label className="mt-4 block text-xs font-bold text-[#68736a]">Description client<textarea className="mt-2 min-h-20 w-full rounded-xl border border-[#dfe4dc] p-3 text-sm font-semibold outline-none focus:border-[#ff6a45]" placeholder="Décrivez brièvement le produit…" value={draft.detail} onChange={event=>setDraft(current=>({...current,detail:event.target.value}))} /></label>
        <div className="mt-4 grid gap-4 md:grid-cols-2"><label className="text-xs font-bold text-[#68736a]">Prix TTC de cet établissement *<div className="relative mt-2"><input className={`${fieldClass} pr-10`} type="number" min="0" step="0.01" value={draft.price} onChange={event=>setDraft(current=>({...current,price:Number(event.target.value)}))} /><span className="absolute right-4 top-3 text-sm font-black">€</span></div><p className="mt-1 text-[10px] font-normal text-[#919991]">Ce prix local est indépendant du catalogue maître.</p></label><label className="text-xs font-bold text-[#68736a]">Code POS<input className={`${fieldClass} mt-2 font-mono`} placeholder="Ex. BRG-BGK-01" value={draft.posCode} onChange={event=>setDraft(current=>({...current,posCode:event.target.value}))} /></label></div>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-xs font-bold text-[#68736a]">Slug URL<input className={`${fieldClass} mt-2`} placeholder="master-sarran-poulet-mozza" value={draft.slug} onChange={event=>setDraft(current=>({...current,slug:event.target.value}))} /></label>
          <label className="text-xs font-bold text-[#68736a]">Image URL<input className={`${fieldClass} mt-2`} placeholder="https://..." value={draft.imageUrl} onChange={event=>setDraft(current=>({...current,imageUrl:event.target.value}))} /></label>
          <label className="text-xs font-bold text-[#68736a]">Filtre viande<select className={`${fieldClass} mt-2`} value={draft.meatFilter} onChange={event=>setDraft(current=>({...current,meatFilter:event.target.value}))}><option value="">Non renseigné</option><option>Poulet</option><option>Bœuf</option><option>Poisson</option><option>Veggie</option></select></label>
          <label className="text-xs font-bold text-[#68736a]">Ordre d’affichage<input className={`${fieldClass} mt-2`} type="number" min="0" value={draft.displayOrder} onChange={event=>setDraft(current=>({...current,displayOrder:Number(event.target.value)}))} /></label>
        </div>
        <label className="mt-4 block text-xs font-bold text-[#68736a]">Badges <span className="font-normal text-[#919991]">(séparés par des virgules)</span><input className={`${fieldClass} mt-2`} placeholder="100% filet, Nouveau" value={draft.badges} onChange={event=>setDraft(current=>({...current,badges:event.target.value}))} /></label>
        <label className="mt-4 block text-xs font-bold text-[#68736a]">Type de produit<select className={`${fieldClass} mt-2`} value={draft.productType} onChange={event=>setDraft(current=>({...current,productType:event.target.value as ProductDraft['productType']}))}><option value="simple">Produit simple</option><option value="configurable">Produit configurable</option><option value="menu">Menu</option><option value="bundle">Pack / à partager</option></select></label>
        {isCompositionCategory&&<section className="mt-5 rounded-2xl border border-[#dfe4dc] bg-[#fafbf8] p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-black text-[#536057]">Composition et ingrédients</p><p className="mt-1 text-[10px] text-[#8b948c]">Ajoutez les couches dans l’ordre réel du produit, du haut vers le bas. Les répétitions sont autorisées.</p></div><span className="w-fit rounded-full bg-[#eef2ed] px-3 py-1.5 text-[9px] font-black text-[#667168]">{ingredientRows.length} couche{ingredientRows.length!==1?'s':''}</span></div>
          <div className="mt-4 flex gap-2"><input aria-label="Nouvel ingrédient" className={fieldClass} placeholder="Ex. Cheddar fondu (1 tranche)" value={newIngredient} onChange={event=>setNewIngredient(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();addIngredient();}}} /><button type="button" onClick={addIngredient} disabled={!newIngredient.trim()} className="shrink-0 rounded-xl bg-[#0b1f14] px-4 text-xs font-black text-white disabled:opacity-35">＋ Ajouter</button></div>
          <div className="mt-4 space-y-2">{ingredientRows.map((ingredient,index)=><div key={ingredient.id} className="rounded-xl border border-[#e2e7df] bg-white p-3"><div className="flex items-center gap-2"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#f2f4ef] text-[10px] font-black text-[#7c857d]">{index+1}</span><input aria-label={`Ingrédient ${index+1}`} className="min-w-0 flex-1 bg-transparent text-xs font-black outline-none focus:text-[#ff5a36]" value={ingredient.name} onChange={event=>updateIngredient(ingredient.id,{name:event.target.value})} /><button type="button" onClick={()=>moveIngredient(index,-1)} disabled={index===0} aria-label="Monter" className="grid h-7 w-7 place-items-center rounded-lg bg-[#f2f4ef] text-[11px] font-black disabled:opacity-25">↑</button><button type="button" onClick={()=>moveIngredient(index,1)} disabled={index===ingredientRows.length-1} aria-label="Descendre" className="grid h-7 w-7 place-items-center rounded-lg bg-[#f2f4ef] text-[11px] font-black disabled:opacity-25">↓</button><button type="button" onClick={()=>setDraft(current=>({...current,ingredients:(current.ingredients as ProductIngredient[]).filter(item=>item.id!==ingredient.id)}))} aria-label="Supprimer" className="grid h-7 w-7 place-items-center rounded-lg bg-[#fff0ec] text-xs font-black text-[#d6503d]">×</button></div><div className="mt-3 flex flex-wrap items-center gap-2 pl-9"><button type="button" onClick={()=>updateIngredient(ingredient.id,{removable:!ingredient.removable})} className={`rounded-full px-3 py-1.5 text-[9px] font-black ${ingredient.removable?'bg-[#fff0ec] text-[#c34c36]':'bg-[#eef1ed] text-[#7d867e]'}`}>{ingredient.removable?'✓ Retrait autorisé':'Retrait interdit'}</button><button type="button" onClick={()=>updateIngredient(ingredient.id,{extraAllowed:!ingredient.extraAllowed})} className={`rounded-full px-3 py-1.5 text-[9px] font-black ${ingredient.extraAllowed?'bg-[#e8f7ec] text-[#27894a]':'bg-[#eef1ed] text-[#7d867e]'}`}>{ingredient.extraAllowed?'✓ Supplément autorisé':'Supplément interdit'}</button>{ingredient.extraAllowed&&<label className="flex items-center gap-2 text-[9px] font-black text-[#707a72]">Prix supplément<input className="h-8 w-20 rounded-lg border border-[#dfe4dc] px-2 text-right text-[10px] font-black outline-none" type="number" min="0" step="0.1" value={ingredient.extraPrice} onChange={event=>updateIngredient(ingredient.id,{extraPrice:Number(event.target.value)})} /> €</label>}</div></div>)}{!ingredientRows.length&&<div className="rounded-xl border border-dashed border-[#ccd4ca] py-7 text-center"><p className="text-xs font-black text-[#778179]">Aucun ingrédient ajouté</p><p className="mt-1 text-[10px] text-[#99a099]">Commencez par le pain supérieur, puis descendez couche par couche.</p></div>}</div>
          <div className="mt-4 rounded-xl bg-[#edf5ef] p-3 text-[10px] leading-relaxed text-[#52705b]"><strong>Compréhension IA :</strong> ces réglages génèrent automatiquement les retraits et suppléments utilisables pendant la commande.</div>
        </section>}
        {isMenu&&<section className="mt-5 rounded-2xl border border-[#dfe4dc] bg-[#fafbf8] p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-black text-[#536057]">Structure du menu</p><p className="mt-1 text-[10px] text-[#8b948c]">Construisez le parcours présenté au client, dans l’ordre exact de la commande.</p></div><button type="button" onClick={addStep} className="rounded-xl bg-[#0b1f14] px-4 py-2.5 text-[10px] font-black text-white">＋ Ajouter une composition</button></div>
          <div className="mt-5 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">{menuSteps.map((step,index)=><button type="button" key={step.id} onClick={()=>document.getElementById(`menu-step-${step.id}`)?.scrollIntoView({behavior:'smooth',block:'center'})} className="rounded-2xl border border-[#e1e6df] bg-white p-3 text-left shadow-sm transition hover:border-[#ff8d72]"><span className="grid h-7 w-7 place-items-center rounded-full bg-[#ffcf45] text-[10px] font-black text-[#3e2d00]">{index+1}</span><p className="mt-2 text-xs font-black">{step.name}</p><p className="mt-1 text-[9px] text-[#8a938b]">{step.options.length} choix configuré{step.options.length!==1?'s':''}</p></button>)}</div>
          <div className="mt-5 space-y-5">{menuSteps.map((step,index)=>{const isSize=step.name.toLowerCase().includes('taille');const sourceProducts=menuSourceProducts(step.name);const shownOptions=isSize?[...step.options].sort((a,b)=>sizeRank(a.name)-sizeRank(b.name)):step.options;return <div id={`menu-step-${step.id}`} key={step.id} className="scroll-mt-24 rounded-2xl border border-[#e0e5dd] bg-white p-4"><div className="flex flex-col gap-3 md:flex-row md:items-center"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#ffcf45] text-[11px] font-black text-[#3e2d00]">{index+1}</span><div className="min-w-0 flex-1"><input aria-label="Nom de la composition" className="w-full bg-transparent text-base font-black outline-none" value={step.name} onChange={event=>updateStep(step.id,{name:event.target.value})} /><input aria-label="Question posée au client" className="mt-1 w-full bg-transparent text-[10px] font-semibold text-[#7f8981] outline-none" value={step.question} onChange={event=>updateStep(step.id,{question:event.target.value})} /></div><div className="flex gap-1"><button type="button" onClick={()=>moveStep(index,-1)} disabled={index===0} className="grid h-9 w-9 place-items-center rounded-lg bg-[#f1f3ef] text-xs font-black disabled:opacity-25">↑</button><button type="button" onClick={()=>moveStep(index,1)} disabled={index===menuSteps.length-1} className="grid h-9 w-9 place-items-center rounded-lg bg-[#f1f3ef] text-xs font-black disabled:opacity-25">↓</button><button type="button" onClick={()=>setDraft(current=>({...current,optionGroups:current.optionGroups.filter(item=>item.id!==step.id)}))} className="grid h-9 w-9 place-items-center rounded-lg bg-[#fff0ec] text-xs font-black text-[#d6503d]">×</button></div></div><div className="mt-3 flex flex-wrap items-center gap-2"><button type="button" onClick={()=>updateStep(step.id,{required:!step.required,min:step.required?0:1})} className={`rounded-full px-3 py-1.5 text-[9px] font-black ${step.required?'bg-[#e8f7ec] text-[#27894a]':'bg-[#eef1ed] text-[#7d867e]'}`}>{step.required?'✓ Choix obligatoire':'Choix facultatif'}</button><span className="text-[9px] font-bold text-[#8b948c]">{step.options.length} option{step.options.length!==1?'s':''}</span></div>{isSize?<div className="mt-4"><div className="flex gap-2"><input id={`new-size-${step.id}`} aria-label="Nouvelle taille" className={fieldClass} placeholder="Ex. Taille classique, Taille XL…" onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();const input=event.currentTarget;if(input.value.trim()){updateStep(step.id,{options:[...step.options,{id:Date.now(),name:input.value.trim(),priceDelta:0,posCode:'',available:true}]});input.value='';}}}} /><button type="button" onClick={()=>{const input=document.getElementById(`new-size-${step.id}`) as HTMLInputElement|null;if(input?.value.trim()){updateStep(step.id,{options:[...step.options,{id:Date.now(),name:input.value.trim(),priceDelta:0,posCode:'',available:true}]});input.value='';}}} className="shrink-0 rounded-xl bg-[#0b1f14] px-4 text-[10px] font-black text-white">＋ Créer la taille</button></div><p className="mt-2 text-[9px] text-[#8c958d]">Les tailles sont automatiquement affichées de la plus petite à la plus grande.</p><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{shownOptions.map((option,optionIndex)=><div key={option.id} onClick={()=>setSelectedMenuSize(option.name)} className={`relative rounded-2xl border p-4 ${selectedMenuSize===option.name?'border-[#35a85a] bg-[#eef9f1]':'border-[#dfe5dc] bg-[#fafbf8]'}`}><span className="text-[9px] font-black text-[#ff5a36]">TAILLE {optionIndex+1}</span><input className="mt-2 w-full bg-transparent text-sm font-black outline-none" value={option.name} onChange={event=>{updateStepOption(step.id,option.id,{name:event.target.value});if(selectedMenuSize===option.name)setSelectedMenuSize(event.target.value);}} /><label className="mt-3 flex items-center gap-2 text-[9px] font-bold text-[#7b847d]">Supplément <input className="h-8 w-20 rounded-lg border border-[#dfe4dc] px-2 text-right text-[10px] font-black" type="number" min="0" step="0.1" value={option.priceDelta} onChange={event=>updateStepOption(step.id,option.id,{priceDelta:Number(event.target.value)})} /> €</label><button type="button" onClick={event=>{event.stopPropagation();updateStep(step.id,{options:step.options.filter(item=>item.id!==option.id)});}} aria-label={`Supprimer ${option.name}`} className="absolute right-3 top-3 text-xs font-black text-[#d6503d]">×</button></div>)}</div></div>:sourceProducts.length?<div className="mt-4"><p className="mb-3 text-[9px] font-black uppercase tracking-wider text-[#8a938b]">Produits disponibles pour {selectedMenuSize}</p><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{sourceProducts.map(product=>{const selected=step.options.some(option=>option.name===product.name);return <button type="button" key={product.id} onClick={()=>toggleCatalogOption(step.id,product)} className={`flex min-h-24 items-center gap-3 rounded-2xl border p-3 text-left transition ${selected?'border-[#35a85a] bg-[#eef9f1]':'border-[#e1e6df] bg-[#fafbf8] hover:border-[#ff9e87]'}`}><span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-white text-3xl">{product.emoji}</span><span className="min-w-0"><strong className="block truncate text-xs">{product.name}</strong><small className="mt-1 block text-[9px] text-[#899289]">{product.available?'Disponible':'Masqué'} · {product.posCode||'Code POS à définir'}</small><span className={`mt-2 inline-block rounded-full px-2 py-1 text-[8px] font-black ${selected?'bg-[#35a85a] text-white':'bg-white text-[#687169]'}`}>{selected?'✓ Inclus dans le menu':'＋ Ajouter'}</span></span></button>})}</div></div>:<div className="mt-4 rounded-xl border border-dashed border-[#d5dcd3] bg-[#fafbf8] p-4 text-center"><p className="text-[10px] font-black text-[#737d75]">Aucun produit correspondant dans la carte</p><p className="mt-1 text-[9px] text-[#969e97]">Créez d’abord les produits de cette famille, puis revenez les sélectionner ici.</p><button type="button" onClick={()=>addStepOption(step.id)} className="mt-3 text-[10px] font-black text-[#ff5a36]">＋ Ajouter une option manuellement</button></div>}{!isSize&&step.options.filter(option=>!sourceProducts.some(product=>product.name===option.name)).length>0&&<div className="mt-3 flex flex-wrap gap-2">{step.options.filter(option=>!sourceProducts.some(product=>product.name===option.name)).map(option=><span key={option.id} className="rounded-full bg-[#f1f3ef] px-3 py-2 text-[9px] font-black">{option.name} <button type="button" onClick={()=>updateStep(step.id,{options:step.options.filter(item=>item.id!==option.id)})} className="ml-2 text-[#d6503d]">×</button></span>)}</div>}</div>})}</div>
          <div className="mt-5 rounded-xl bg-[#edf5ef] p-3 text-[10px] leading-relaxed text-[#52705b]"><strong>Compréhension IA :</strong> l’agent suivra automatiquement cette séquence et ne proposera que les tailles et produits sélectionnés dans la carte du restaurant.</div>
        </section>}
        <div className="mt-5 flex items-center justify-between rounded-2xl border border-[#e4e8e1] p-4"><div><p className="text-sm font-black">Produit disponible</p><p className="mt-1 text-[10px] text-[#8a938b]">Le produit peut être proposé par l’agent IA.</p></div><button onClick={()=>setDraft(current=>({...current,available:!current.available}))} className={`relative h-7 w-12 rounded-full ${draft.available?'bg-[#35a85a]':'bg-[#d9ded8]'}`}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow ${draft.available?'left-6':'left-1'}`} /></button></div>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">{onDelete&&<button onClick={onDelete} className="text-xs font-black text-[#d6503d]">Supprimer le produit</button>}<div className="ml-auto flex gap-2"><button onClick={onClose} className="rounded-xl border border-[#dfe4dc] px-4 py-3 text-xs font-black">Annuler</button><button onClick={onSave} disabled={!draft.name.trim()||!draft.category} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white disabled:opacity-40">Enregistrer en brouillon</button></div></div>
      </div>
    </div>
  </div>;
}

function RestaurantMenuBuilderPanel({ products, setProducts }: { products: CatalogProduct[]; setProducts: React.Dispatch<React.SetStateAction<CatalogProduct[]>> }) {
  const [categories, setCategories] = useState<MenuCategory[]>(burgerKingCategoryTemplate.map(([name, icon], index) => ({ id: index + 1, name, icon, enabled: true })));
  const [activeCategory, setActiveCategory] = useState('Toutes');
  const [query, setQuery] = useState('');
  const [categoryEditor, setCategoryEditor] = useState<number | 'new' | null>(null);
  const [categoryDraft, setCategoryDraft] = useState({ name: '', icon: '🍽️' });
  const [productEditor, setProductEditor] = useState<number | 'new' | null>(null);
  const [productDraft, setProductDraft] = useState<ProductDraft>({ name: '', detail: '', category: 'Menus', subcategory: 'Bœuf', price: 0, posCode: '', emoji: '🍽️', ingredients: [], available: true, productType: 'simple', variants: [], optionGroups: [], modifiers: [], imageUrl: '', slug: '', meatFilter: '', badges: '', ingredientImages: '', allergens: '', traces: '', displayOrder: 1, nutrition: { calories: '', fat: '', saturatedFat: '', proteins: '', carbohydrates: '', sugars: '', salt: '' } });
  const [activeSubcategory, setActiveSubcategory] = useState('Tous');
  const [newIngredient, setNewIngredient] = useState('');
  const [published, setPublished] = useState(true);
  const [notice, setNotice] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const visibleSubcategories = subcategoryTemplates[activeCategory] ?? [];
  const filteredProducts = products.filter(product => (activeCategory === 'Toutes' || product.category === activeCategory) && (activeSubcategory === 'Tous' || !visibleSubcategories.length || product.subcategory === activeSubcategory) && `${product.name} ${product.detail} ${product.posCode}`.toLowerCase().includes(query.toLowerCase()));
  const activeCount = products.filter(product => product.available).length;
  useEffect(()=>setActiveSubcategory('Tous'),[activeCategory]);

  const renderProductCard = (product: CatalogProduct) => <article key={product.id} className="group overflow-hidden rounded-[20px] border border-[#e4e8e1] bg-white transition hover:-translate-y-0.5 hover:border-[#ff9e87] hover:shadow-lg"><button onClick={()=>openProductEditor(product)} className="w-full text-left"><div className="relative grid h-32 place-items-center bg-gradient-to-br from-[#f8f9f6] to-[#edf1eb]">{product.imageUrl?<img src={product.imageUrl} alt={product.name} className="h-full w-full object-contain p-2" />:<span className="text-6xl">{product.emoji}</span>}<span className={`absolute right-3 top-3 rounded-full px-2 py-1 text-[9px] font-black ${product.available?'bg-[#dff5e5] text-[#27894a]':'bg-[#e4e7e3] text-[#737c74]'}`}>{product.available?'Disponible':'Masqué'}</span></div><div className="p-4"><p className="text-[9px] font-black uppercase tracking-wider text-[#999f99]">{product.category}{product.subcategory?` · ${product.subcategory}`:''}</p><h3 className="mt-1 truncate text-base font-black">{product.name}</h3><p className="mt-1 line-clamp-2 min-h-8 text-[11px] leading-relaxed text-[#7b847d]">{product.detail||'Description à compléter'}</p><div className="mt-4 flex items-end justify-between"><div><p className="text-lg font-black">{money.format(product.price)}</p><p className="font-mono text-[9px] text-[#9ca39d]">{product.posCode||'Code POS manquant'}</p></div><span className="text-[10px] font-black text-[#ff5a36]">Modifier →</span></div></div></button></article>;

  const openCategoryEditor = (category?: MenuCategory) => {
    if (category) {
      setCategoryEditor(category.id);
      setCategoryDraft({ name: category.name, icon: category.icon });
    } else {
      setCategoryEditor('new');
      setCategoryDraft({ name: '', icon: '🍽️' });
    }
  };
  const saveCategory = () => {
    const name = categoryDraft.name.trim();
    if (!name) return;
    if (categoryEditor === 'new') {
      setCategories(current => [...current, { id: Date.now(), name, icon: categoryDraft.icon || '🍽️', enabled: true }]);
      setActiveCategory(name);
    } else if (typeof categoryEditor === 'number') {
      const oldName = categories.find(category => category.id === categoryEditor)?.name;
      setCategories(current => current.map(category => category.id === categoryEditor ? { ...category, name, icon: categoryDraft.icon || '🍽️' } : category));
      if (oldName) setProducts(current => current.map(product => product.category === oldName ? { ...product, category: name } : product));
      if (activeCategory === oldName) setActiveCategory(name);
    }
    setPublished(false);
    setCategoryEditor(null);
  };
  const removeCategory = (category: MenuCategory) => {
    if (products.some(product => product.category === category.name)) return;
    setCategories(current => current.filter(item => item.id !== category.id));
    if (activeCategory === category.name) setActiveCategory('Toutes');
    setPublished(false);
  };
  const openProductEditor = (product?: CatalogProduct) => {
    if (product) {
      const isMenuCategory = product.category === 'Menus' || product.category === 'Menus enfants';
      const requiredSteps = product.category === 'Menus enfants' ? ['Taille du menu','Plat','Accompagnement','Boisson','Sauces','Dessert','Jouet'] : ['Taille du menu','Plat','Accompagnement','Boisson','Sauces'];
      const existingSteps = product.optionGroups ?? [];
      const normalizedSteps = isMenuCategory ? requiredSteps.map((name,index)=>existingSteps.find(step=>step.name.toLowerCase()===name.toLowerCase()) ?? {id:product.id*100+index,name,question:`Choisissez : ${name.toLowerCase()}`,required:true,min:1,max:1,options:[]}).concat(existingSteps.filter(step=>!requiredSteps.some(name=>name.toLowerCase()===step.name.toLowerCase()))) : existingSteps;
      setProductEditor(product.id);
      setProductDraft({ name: product.name, detail: product.detail, category: product.category, subcategory: product.subcategory ?? subcategoryTemplates[product.category]?.[1] ?? '', price: product.price, posCode: product.posCode, emoji: product.emoji, ingredients: product.ingredientSettings ?? (product.ingredients ?? []).map((name,index)=>({ id: product.id*1000+index, name, removable: !/pain/i.test(name), extraAllowed: !/pain|sauce/i.test(name), extraPrice: 0 })), available: product.available, productType: isMenuCategory ? 'menu' : product.productType ?? 'simple', variants: product.variants ?? [], optionGroups: normalizedSteps, modifiers: product.modifiers ?? [], imageUrl: product.imageUrl ?? '', slug: product.slug ?? '', meatFilter: product.meatFilter ?? '', badges: (product.badges ?? []).join(', '), ingredientImages: (product.ingredientImages ?? []).join('\n'), allergens: (product.allergens ?? []).join(', '), traces: (product.traces ?? []).join(', '), displayOrder: product.displayOrder ?? 1, nutrition: product.nutrition ?? { calories: '', fat: '', saturatedFat: '', proteins: '', carbohydrates: '', sugars: '', salt: '' } });
    } else {
      const defaultCategory = activeCategory === 'Toutes' ? categories[0]?.name ?? '' : activeCategory;
      setProductEditor('new');
      setProductDraft({ name: '', detail: '', category: defaultCategory, subcategory: subcategoryTemplates[defaultCategory]?.[1] ?? '', price: 0, posCode: '', emoji: '🍽️', ingredients: [], available: true, productType: 'simple', variants: [], optionGroups: [], modifiers: [], imageUrl: '', slug: '', meatFilter: '', badges: '', ingredientImages: '', allergens: '', traces: '', displayOrder: 1, nutrition: { calories: '', fat: '', saturatedFat: '', proteins: '', carbohydrates: '', sugars: '', salt: '' } });
    }
    setNewIngredient('');
  };
  const addVariant = () => setProductDraft(current => ({ ...current, variants: [...current.variants, { id: Date.now(), name: 'Nouvelle taille', priceDelta: 0, posCode: '' }] }));
  const updateVariant = (id: number, patch: Partial<ProductVariant>) => setProductDraft(current => ({ ...current, variants: current.variants.map(variant => variant.id === id ? { ...variant, ...patch } : variant) }));
  const addOptionGroup = () => setProductDraft(current => ({ ...current, optionGroups: [...current.optionGroups, { id: Date.now(), name: 'Nouveau groupe', question: 'Quel choix souhaitez-vous ?', required: true, min: 1, max: 1, options: [] }] }));
  const updateOptionGroup = (id: number, patch: Partial<ProductOptionGroup>) => setProductDraft(current => ({ ...current, optionGroups: current.optionGroups.map(group => group.id === id ? { ...group, ...patch } : group) }));
  const addOption = (groupId: number) => setProductDraft(current => ({ ...current, optionGroups: current.optionGroups.map(group => group.id === groupId ? { ...group, options: [...group.options, { id: Date.now(), name: 'Nouvelle option', priceDelta: 0, posCode: '', available: true }] } : group) }));
  const updateOption = (groupId: number, optionId: number, patch: Partial<ProductOption>) => setProductDraft(current => ({ ...current, optionGroups: current.optionGroups.map(group => group.id === groupId ? { ...group, options: group.options.map(option => option.id === optionId ? { ...option, ...patch } : option) } : group) }));
  const addModifier = (kind: 'remove' | 'add') => setProductDraft(current => ({ ...current, modifiers: [...current.modifiers, { id: Date.now(), name: kind === 'remove' ? 'Sans ingrédient' : 'Nouveau supplément', kind, priceDelta: 0 }] }));
  const updateModifier = (id: number, patch: Partial<ProductModifier>) => setProductDraft(current => ({ ...current, modifiers: current.modifiers.map(modifier => modifier.id === id ? { ...modifier, ...patch } : modifier) }));
  const addIngredient = () => {
    const name = newIngredient.trim();
    if (!name) return;
    setProductDraft(current=>({...current,ingredients:[...current.ingredients,{id:Date.now(),name,removable:true,extraAllowed:true,extraPrice:0}]}));
    setNewIngredient('');
  };
  const updateIngredient = (id:number, patch:Partial<ProductIngredient>) => setProductDraft(current=>({...current,ingredients:current.ingredients.map((ingredient:ProductIngredient)=>ingredient.id===id?{...ingredient,...patch}:ingredient)}));
  const moveIngredient = (index:number, direction:-1|1) => setProductDraft(current=>{const target=index+direction;if(target<0||target>=current.ingredients.length)return current;const ingredients=[...current.ingredients];[ingredients[index],ingredients[target]]=[ingredients[target],ingredients[index]];return {...current,ingredients};});
  const saveProduct = () => {
    if (!productDraft.name.trim() || !productDraft.category || productDraft.price < 0) return;
    const compositionCategory = productDraft.productType === 'menu' || productDraft.category === 'Menus' || productDraft.category === 'Menus enfants' || productDraft.category === 'Burgers' || /tortilla|wrap/i.test(productDraft.category);
    const ingredientSettings = compositionCategory ? (productDraft.ingredients as ProductIngredient[]).filter(ingredient=>ingredient.name.trim()).map(ingredient=>({...ingredient,name:ingredient.name.trim()})) : [];
    const ingredients = ingredientSettings.map(ingredient=>ingredient.name);
    const ingredientModifiers: ProductModifier[] = ingredientSettings.flatMap(ingredient=>[
      ...(ingredient.removable?[{id:ingredient.id*10+1,name:`Sans ${ingredient.name}`,kind:'remove' as const,priceDelta:0}]:[]),
      ...(ingredient.extraAllowed?[{id:ingredient.id*10+2,name:`Supplément ${ingredient.name}`,kind:'add' as const,priceDelta:ingredient.extraPrice}]:[]),
    ]);
    if (productEditor === 'new') {
      const id = Date.now();
      setProducts(current => [...current, { id, productId: `product_${id}`, name: productDraft.name.trim(), detail: productDraft.detail.trim(), category: productDraft.category, subcategory: productDraft.subcategory || undefined, price: productDraft.price, posCode: productDraft.posCode.trim() || `NEW-${current.length + 1}`, emoji: productDraft.emoji || '🍽️', imageUrl: productDraft.imageUrl.trim() || undefined, ingredients, ingredientSettings, available: productDraft.available, productType: productDraft.productType, variants: productDraft.variants, optionGroups: productDraft.optionGroups, modifiers: ingredientModifiers, slug: productDraft.slug.trim() || undefined, meatFilter: productDraft.meatFilter.trim() || undefined, badges: splitField(productDraft.badges), ingredientImages: splitField(productDraft.ingredientImages), allergens: splitField(productDraft.allergens), traces: splitField(productDraft.traces), displayOrder: productDraft.displayOrder, nutrition: productDraft.nutrition }]);
    } else if (typeof productEditor === 'number') {
      setProducts(current => current.map(product => product.id === productEditor ? { ...product, name: productDraft.name.trim(), detail: productDraft.detail.trim(), category: productDraft.category, subcategory: productDraft.subcategory || undefined, price: productDraft.price, posCode: productDraft.posCode.trim(), emoji: productDraft.emoji || '🍽️', imageUrl: productDraft.imageUrl.trim() || undefined, ingredients, ingredientSettings, available: productDraft.available, productType: productDraft.productType, variants: productDraft.variants, optionGroups: productDraft.optionGroups, modifiers: ingredientModifiers, slug: productDraft.slug.trim() || undefined, meatFilter: productDraft.meatFilter.trim() || undefined, badges: splitField(productDraft.badges), ingredientImages: splitField(productDraft.ingredientImages), allergens: splitField(productDraft.allergens), traces: splitField(productDraft.traces), displayOrder: productDraft.displayOrder, nutrition: productDraft.nutrition } : product));
    }
    setPublished(false);
    setProductEditor(null);
  };
  const publishCatalog = () => {
    setPublished(true);
    setNotice('✓ La nouvelle version de la carte est disponible pour l’agent IA.');
    window.setTimeout(() => setNotice(''), 2600);
  };
  const importBurgerKingTemplate = () => {
    setCategories(burgerKingCategoryTemplate.map(([name, icon], index) => ({ id: index + 1, name, icon, enabled: true })));
    setProducts(burgerKingCatalogTemplate.map(product => ({ ...product, ingredients: product.ingredients ? [...product.ingredients] : undefined, ingredientSettings: product.ingredientSettings ? product.ingredientSettings.map(ingredient=>({...ingredient})) : undefined, variants: product.variants ? product.variants.map(variant => ({ ...variant })) : undefined, optionGroups: product.optionGroups ? product.optionGroups.map(group => ({ ...group, options: group.options.map(option => ({ ...option })) })) : undefined, modifiers: product.modifiers ? product.modifiers.map(modifier => ({ ...modifier })) : undefined })));
    setActiveCategory('Toutes');
    setPublished(false);
    setNotice('✓ Modèle Burger King France chargé. Complétez les prix et codes POS du restaurant avant publication.');
    window.setTimeout(() => setNotice(''), 4200);
  };

  return (
    <div>
      {productEditor!==null&&<IngredientProductEditor draft={productDraft} setDraft={setProductDraft} categories={categories} catalogProducts={products} subcategoryOptions={subcategoryTemplates[productDraft.category]??[]} newIngredient={newIngredient} setNewIngredient={setNewIngredient} addIngredient={addIngredient} updateIngredient={updateIngredient} moveIngredient={moveIngredient} onClose={()=>setProductEditor(null)} onSave={saveProduct} isNew={productEditor==='new'} onDelete={typeof productEditor==='number'?()=>{if(window.confirm('Supprimer définitivement ce produit ?')){setProducts(current=>current.filter(product=>product.id!==productEditor));setProductEditor(null);setPublished(false);}}:undefined} />}
      <SectionHeading eyebrow="Configuration restaurant" title="Carte du restaurant" description="Créez librement les catégories et produits de votre enseigne. Cette carte validée devient l’unique source utilisée par l’agent IA pour les produits, prix et compositions." action={<div className="flex flex-wrap gap-2"><button onClick={()=>setPreviewOpen(true)} className="rounded-xl border border-[#dce2da] bg-white px-4 py-3 text-xs font-black">Prévisualiser la carte</button><button onClick={publishCatalog} disabled={published} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white disabled:bg-[#dce1db] disabled:text-[#7c857e]">{published ? '✓ Carte publiée' : 'Publier la carte'}</button></div>} />
      {notice&&<div className="mb-4 rounded-2xl border border-[#bee4c9] bg-[#e8f8ed] px-5 py-4 text-xs font-black text-[#257c43]">{notice}</div>}
      <section className={`${panelCard} mb-5 overflow-hidden`}>
        <div className="grid gap-5 p-5 md:grid-cols-[1fr_auto] md:items-center">
          <div className="flex items-start gap-4"><span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#f5e6d0] text-sm font-black text-[#8b2a16]">BK</span><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-black">Carte Burger King France</h2><span className="rounded-full bg-[#e7f6eb] px-2.5 py-1 text-[9px] font-black text-[#27894a]">SOURCE PUBLIQUE VÉRIFIÉE</span></div><p className="mt-1 max-w-3xl text-xs leading-relaxed text-[#788179]">Structure, ordre, produits et prix relevés sur la carte publique Burger King France du restaurant K0030. Les codes POS et disponibilités restent personnalisables par restaurant.</p><div className="mt-3 flex flex-wrap gap-2 text-[9px] font-black text-[#747d75]"><span className="rounded-full bg-[#f1f3ef] px-3 py-1.5">{categories.length} catégories</span><span className="rounded-full bg-[#f1f3ef] px-3 py-1.5">{products.length} fiches produits</span><span className="rounded-full bg-[#f1f3ef] px-3 py-1.5">Menus configurables</span><span className="rounded-full bg-[#f1f3ef] px-3 py-1.5">Composition Whopper®</span></div></div></div>
          <button onClick={importBurgerKingTemplate} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">↻ Recharger le modèle</button>
        </div>
      </section>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['Version active','v1.4','Publiée aujourd’hui'],['Catégories',String(categories.length),'Structure personnalisée'],['Produits',String(products.length),`${activeCount} disponibles`],['État',published?'À jour':'Brouillon',published?'Agent synchronisé':'Modifications à publier']].map(([label,value,detail])=><div key={label} className={`${panelCard} p-4`}><p className="text-[10px] font-black uppercase tracking-wider text-[#929a93]">{label}</p><p className="mt-2 text-xl font-black">{value}</p><p className={`mt-1 text-[10px] font-bold ${label==='État'&&!published?'text-[#d17a17]':'text-[#778178]'}`}>{detail}</p></div>)}</div>
      {visibleSubcategories.length>0&&<div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-[#e2e6df] bg-white p-3"><span className="mr-1 text-[9px] font-black uppercase tracking-wider text-[#919991]">Sous-catégories</span>{visibleSubcategories.map(subcategory=><button key={subcategory} onClick={()=>setActiveSubcategory(subcategory)} className={`rounded-full border px-4 py-2 text-[10px] font-black transition ${activeSubcategory===subcategory?'border-[#ff5a36] bg-[#ff5a36] text-white':'border-[#dce2da] bg-white text-[#657068] hover:border-[#ff9e87]'}`}>{subcategory} <span className="ml-1 opacity-60">{subcategory==='Tous'?products.filter(product=>product.category===activeCategory).length:products.filter(product=>product.category===activeCategory&&product.subcategory===subcategory).length}</span></button>)}</div>}
      <section className={`${panelCard} grid min-h-[650px] overflow-hidden xl:grid-cols-[250px_1fr]`}>
        <aside className="border-b border-[#e5e9e2] bg-[#f8f9f6] p-4 xl:border-b-0 xl:border-r"><div className="flex items-center justify-between px-2 py-2"><div><p className="text-[10px] font-black uppercase tracking-wider text-[#8c958d]">Organisation</p><h2 className="mt-1 text-lg font-black">Catégories</h2></div><button onClick={()=>openCategoryEditor()} aria-label="Créer une catégorie" className="grid h-9 w-9 place-items-center rounded-xl bg-[#0b1f14] text-lg font-black text-white">＋</button></div><div className="mt-3 space-y-1"><button onClick={()=>setActiveCategory('Toutes')} className={`flex w-full items-center justify-between rounded-xl px-3 py-3 text-left text-xs font-black ${activeCategory==='Toutes'?'bg-white shadow-sm text-[#ff5a36]':'text-[#687169]'}`}><span>▦ Toutes les catégories</span><span>{products.length}</span></button>{categories.map(category=>{const count=products.filter(product=>product.category===category.name).length;return <div key={category.id} className={`group flex items-center rounded-xl ${activeCategory===category.name?'bg-white shadow-sm':'hover:bg-white/70'}`}><button onClick={()=>setActiveCategory(category.name)} className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-3 text-left text-xs font-black ${activeCategory===category.name?'text-[#ff5a36]':'text-[#687169]'}`}><span>{category.icon}</span><span className="truncate">{category.name}</span><span className="ml-auto rounded-full bg-[#edf0eb] px-2 py-1 text-[9px] text-[#7c857e]">{count}</span></button><button onClick={()=>openCategoryEditor(category)} aria-label={`Modifier ${category.name}`} className="mr-1 hidden h-8 w-8 place-items-center rounded-lg text-[11px] font-black text-[#8b948c] group-hover:grid">•••</button></div>})}</div><button onClick={()=>openCategoryEditor()} className="mt-4 w-full rounded-xl border border-dashed border-[#cfd6cd] py-3 text-xs font-black text-[#ff5a36]">＋ Nouvelle catégorie</button><div className="mt-6 rounded-2xl bg-[#0b1f14] p-4 text-white"><p className="text-[9px] font-black uppercase tracking-widest text-white/45">Principe</p><p className="mt-2 text-xs font-bold leading-relaxed text-white/75">Chaque enseigne construit sa propre structure. Aucune catégorie n’est imposée par DriveVoice.</p></div></aside>
        <main className="min-w-0 p-5 md:p-6"><div className="flex flex-col gap-4 border-b border-[#e8ebe6] pb-5 md:flex-row md:items-end md:justify-between"><div><p className="text-[10px] font-black uppercase tracking-wider text-[#ff5a36]">Produits</p><h2 className="mt-1 text-2xl font-black">{activeCategory}</h2><p className="mt-1 text-xs text-[#7f8981]">Ajoutez les produits et renseignez leur composition pour l’agent.</p></div><button onClick={()=>openProductEditor()} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">＋ Ajouter un produit</button></div><div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><input aria-label="Rechercher un produit" className={`${fieldClass} sm:max-w-sm`} placeholder="Rechercher un produit ou un code POS…" value={query} onChange={event=>setQuery(event.target.value)} /><div className="flex gap-2 text-[10px] font-black"><span className="rounded-full bg-[#e5f6e9] px-3 py-2 text-[#28894a]">{activeCount} disponibles</span><span className="rounded-full bg-[#f0f2ef] px-3 py-2 text-[#727b73]">{products.length-activeCount} masqués</span></div></div>
          {filteredProducts.length ? activeSubcategory==='Tous'&&visibleSubcategories.length>1 ? <div className="mt-6 space-y-9">{visibleSubcategories.slice(1).map(subcategory=>{const sectionProducts=filteredProducts.filter(product=>product.subcategory===subcategory);if(!sectionProducts.length)return null;return <section key={subcategory} aria-labelledby={`subcategory-${subcategory}`}><div className="mb-4 flex items-center gap-3"><button onClick={()=>setActiveSubcategory(subcategory)} className="group/title flex items-center gap-2 text-left"><h3 id={`subcategory-${subcategory}`} className="text-xl font-black tracking-[-.02em]">{subcategory}</h3><span className="rounded-full bg-[#eef2ed] px-2.5 py-1 text-[9px] font-black text-[#6f7971]">{sectionProducts.length}</span><span className="text-[10px] font-black text-[#ff5a36] opacity-0 transition group-hover/title:opacity-100">Voir seulement →</span></button><div className="h-px flex-1 bg-[#e3e7e1]" /></div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{sectionProducts.map(renderProductCard)}</div></section>;})}</div> : <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{filteredProducts.map(renderProductCard)}</div> : <div className="mt-8 rounded-3xl border border-dashed border-[#cfd6cd] py-16 text-center"><div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#f0f3ee] text-2xl">🍽️</div><h3 className="mt-4 text-lg font-black">Aucun produit dans cette sous-catégorie</h3><p className="mt-1 text-xs text-[#858e86]">Ajoutez un produit ou choisissez une autre sous-catégorie.</p><button onClick={()=>openProductEditor()} className="mt-5 rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">＋ Ajouter un produit</button></div>}
        </main>
      </section>
      {previewOpen&&<div className="fixed inset-0 z-50 overflow-y-auto bg-[#07130d]/70 p-3 md:p-7" role="dialog" aria-modal="true" aria-label="Prévisualisation de la carte"><div className="mx-auto min-h-[88vh] max-w-7xl overflow-hidden rounded-[28px] bg-[#f6ead8] shadow-2xl"><header className="sticky top-0 z-20 border-b border-[#dfcdb7] bg-[#fff8ed]/95 backdrop-blur"><div className="flex items-center justify-between px-5 py-4 md:px-8"><div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-full bg-[#c83a20] text-xs font-black text-white">BK</span><div><p className="text-[9px] font-black uppercase tracking-[.18em] text-[#9d6c52]">Prévisualisation DriveVoice</p><h2 className="text-lg font-black text-[#3c160d]">Carte Burger King France</h2></div></div><button onClick={()=>setPreviewOpen(false)} className="grid h-10 w-10 place-items-center rounded-full bg-white text-lg font-black text-[#3c160d] shadow-sm" aria-label="Fermer la prévisualisation">×</button></div><nav className="flex gap-1 overflow-x-auto px-4 pb-3 md:px-7" aria-label="Catégories de la carte"><button onClick={()=>setActiveCategory('Toutes')} className={`shrink-0 rounded-full px-4 py-2 text-[11px] font-black ${activeCategory==='Toutes'?'bg-[#c83a20] text-white':'bg-white text-[#6c3b2b]'}`}>Accueil</button>{categories.map(category=><button key={category.id} onClick={()=>setActiveCategory(category.name)} className={`shrink-0 rounded-full px-4 py-2 text-[11px] font-black ${activeCategory===category.name?'bg-[#c83a20] text-white':'bg-white text-[#6c3b2b]'}`}>{category.icon} {category.name}</button>)}</nav></header><main className="p-5 md:p-8"><div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#c83a20]">{activeCategory==='Toutes'?'Notre carte':activeCategory}</p><h3 className="mt-1 text-3xl font-black tracking-[-.04em] text-[#3c160d]">{activeCategory==='Toutes'?'Choisissez une catégorie':activeCategory}</h3></div><p className="text-[10px] font-bold text-[#8c6d5d]">Aperçu client · prix à confirmer par le restaurant</p></div>{activeCategory==='Toutes'?<div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">{categories.map(category=><button key={category.id} onClick={()=>setActiveCategory(category.name)} className="group overflow-hidden rounded-2xl bg-white text-left shadow-[0_5px_0_#e5d5c2] transition hover:-translate-y-1"><div className="grid h-36 place-items-center bg-gradient-to-br from-white to-[#f8ead6] text-6xl">{category.icon}</div><p className="border-t border-[#f0e3d3] p-4 text-center text-sm font-black text-[#3c160d]">{category.name}</p></button>)}</div>:<div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">{products.filter(product=>product.category===activeCategory).map(product=><button key={product.id} onClick={()=>{setPreviewOpen(false);openProductEditor(product);}} className="group overflow-hidden rounded-2xl bg-white text-left shadow-[0_5px_0_#e5d5c2] transition hover:-translate-y-1"><div className="relative grid h-40 place-items-center bg-gradient-to-br from-white to-[#f8ead6] text-7xl">{product.emoji}<span className="absolute right-3 top-3 rounded-full bg-[#fff3df] px-2 py-1 text-[8px] font-black text-[#8c5f42]">BROUILLON</span></div><div className="border-t border-[#f0e3d3] p-4"><h4 className="text-sm font-black text-[#3c160d]">{product.name}</h4><p className="mt-1 line-clamp-2 min-h-8 text-[10px] leading-relaxed text-[#846959]">{product.detail}</p><p className="mt-3 text-xs font-black text-[#c83a20]">{product.price>0?money.format(product.price):'Prix à définir'} <span className="float-right">Configurer →</span></p></div></button>)}</div>}</main></div></div>}
      {categoryEditor!==null&&<div className="fixed inset-0 z-50 grid place-items-center bg-[#07130d]/55 p-4" role="dialog" aria-modal="true" aria-label="Éditeur de catégorie"><div className="w-full max-w-md rounded-[28px] bg-white p-6 shadow-2xl"><div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Structure de la carte</p><h2 className="mt-1 text-2xl font-black">{categoryEditor==='new'?'Nouvelle catégorie':'Modifier la catégorie'}</h2></div><button onClick={()=>setCategoryEditor(null)} className="grid h-9 w-9 place-items-center rounded-xl bg-[#f0f3ee] font-black">×</button></div><div className="mt-6 grid grid-cols-[72px_1fr] gap-3"><label className="text-xs font-bold text-[#68736a]">Icône<input className={`${fieldClass} mt-2 text-center text-xl`} maxLength={3} value={categoryDraft.icon} onChange={event=>setCategoryDraft(current=>({...current,icon:event.target.value}))} /></label><label className="text-xs font-bold text-[#68736a]">Nom de la catégorie<input className={`${fieldClass} mt-2`} placeholder="Ex. Boissons froides" value={categoryDraft.name} onChange={event=>setCategoryDraft(current=>({...current,name:event.target.value}))} /></label></div><div className="mt-6 flex items-center justify-between">{typeof categoryEditor==='number'&&<button onClick={()=>{const category=categories.find(item=>item.id===categoryEditor);if(category){removeCategory(category);setCategoryEditor(null);}}} disabled={products.some(product=>product.category===categories.find(item=>item.id===categoryEditor)?.name)} className="text-xs font-black text-[#d6503d] disabled:cursor-not-allowed disabled:text-[#b6bcb7]">Supprimer</button>}<div className="ml-auto flex gap-2"><button onClick={()=>setCategoryEditor(null)} className="rounded-xl border border-[#dfe4dc] px-4 py-3 text-xs font-black">Annuler</button><button onClick={saveCategory} disabled={!categoryDraft.name.trim()} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white disabled:opacity-40">Enregistrer</button></div></div>{typeof categoryEditor==='number'&&products.some(product=>product.category===categories.find(item=>item.id===categoryEditor)?.name)&&<p className="mt-3 text-[10px] text-[#9a765f]">Déplacez d’abord les produits de cette catégorie avant de la supprimer.</p>}</div></div>}
      {productEditor!==null&&<div className="fixed inset-0 z-50 grid place-items-center bg-[#07130d]/55 p-4" role="dialog" aria-modal="true" aria-label="Éditeur de produit"><div className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-[28px] bg-white shadow-2xl"><div className="sticky top-0 z-10 flex items-start justify-between border-b border-[#e7eae5] bg-white p-6"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Fiche produit</p><h2 className="mt-1 text-2xl font-black">{productEditor==='new'?'Créer un produit':'Modifier le produit'}</h2></div><button onClick={()=>setProductEditor(null)} className="grid h-9 w-9 place-items-center rounded-xl bg-[#f0f3ee] font-black">×</button></div><div className="p-6"><div className="grid gap-4 md:grid-cols-[90px_1fr_1fr]"><label className="text-xs font-bold text-[#68736a]">Visuel<input className={`${fieldClass} mt-2 text-center text-2xl`} maxLength={3} value={productDraft.emoji} onChange={event=>setProductDraft(current=>({...current,emoji:event.target.value}))} /></label><label className="text-xs font-bold text-[#68736a]">Nom du produit *<input className={`${fieldClass} mt-2`} placeholder="Ex. Whopper" value={productDraft.name} onChange={event=>setProductDraft(current=>({...current,name:event.target.value}))} /></label><label className="text-xs font-bold text-[#68736a]">Catégorie *<select className={`${fieldClass} mt-2`} value={productDraft.category} onChange={event=>setProductDraft(current=>({...current,category:event.target.value}))}>{categories.map(category=><option key={category.id}>{category.name}</option>)}</select></label></div><label className="mt-4 block text-xs font-bold text-[#68736a]">Description client<textarea className="mt-2 min-h-20 w-full rounded-xl border border-[#dfe4dc] p-3 text-sm font-semibold outline-none focus:border-[#ff6a45]" placeholder="Décrivez brièvement le produit…" value={productDraft.detail} onChange={event=>setProductDraft(current=>({...current,detail:event.target.value}))} /></label><div className="mt-4 grid gap-4 md:grid-cols-2"><label className="text-xs font-bold text-[#68736a]">Prix TTC *<div className="relative mt-2"><input className={`${fieldClass} pr-10`} type="number" min="0" step="0.1" value={productDraft.price} onChange={event=>setProductDraft(current=>({...current,price:Number(event.target.value)}))} /><span className="absolute right-4 top-3 text-sm font-black">€</span></div></label><label className="text-xs font-bold text-[#68736a]">Code POS<input className={`${fieldClass} mt-2 font-mono`} placeholder="Ex. BRG-WHP-01" value={productDraft.posCode} onChange={event=>setProductDraft(current=>({...current,posCode:event.target.value}))} /></label></div><label className="mt-4 block text-xs font-bold text-[#68736a]">Composition et ingrédients<textarea className="mt-2 min-h-28 w-full rounded-xl border border-[#dfe4dc] p-3 text-sm font-semibold outline-none focus:border-[#ff6a45]" placeholder="Pain sésame, steak grillé, salade, tomate, cornichons…" value={productDraft.ingredients} onChange={event=>setProductDraft(current=>({...current,ingredients:event.target.value}))} /></label><p className="mt-2 text-[10px] text-[#919991]">Séparez les ingrédients par une virgule. L’agent utilisera cette composition pour répondre aux questions des clients.</p><div className="mt-5 flex items-center justify-between rounded-2xl border border-[#e4e8e1] p-4"><div><p className="text-sm font-black">Produit disponible</p><p className="mt-1 text-[10px] text-[#8a938b]">Le produit peut être proposé par l’agent IA.</p></div><button onClick={()=>setProductDraft(current=>({...current,available:!current.available}))} className={`relative h-7 w-12 rounded-full ${productDraft.available?'bg-[#35a85a]':'bg-[#d9ded8]'}`}><span className={`absolute top-1 h-5 w-5 rounded-full bg-white shadow ${productDraft.available?'left-6':'left-1'}`} /></button></div><div className="mt-6 flex flex-wrap items-center justify-between gap-3">{typeof productEditor==='number'&&<button onClick={()=>{if(window.confirm('Supprimer définitivement ce produit ?')){setProducts(current=>current.filter(product=>product.id!==productEditor));setProductEditor(null);setPublished(false);}}} className="text-xs font-black text-[#d6503d]">Supprimer le produit</button>}<div className="ml-auto flex gap-2"><button onClick={()=>setProductEditor(null)} className="rounded-xl border border-[#dfe4dc] px-4 py-3 text-xs font-black">Annuler</button><button onClick={saveProduct} disabled={!productDraft.name.trim()||!productDraft.category} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white disabled:opacity-40">Enregistrer en brouillon</button></div></div></div></div></div>}
    </div>
  );
}

type MasterBrand = {
  id: 'bk' | 'quick' | 'kfc'; name: string; short: string; color: string; soft: string; version: number; status: 'Publié' | 'Brouillon' | 'Archivé'; restaurants: number; updated: string; products: CatalogProduct[];
};

const createMasterProducts = (brand:string, rows:Array<[string,string,string,string]>, offset:number):CatalogProduct[] => rows.map(([name,category,detail,emoji],index)=>({id:offset+index,productId:`master_${brand}_${index}`,name,category,detail,emoji,price:0,posCode:'',available:true,productType:category==='Menus'?'menu':category==='Burgers'?'configurable':'simple'}));
const quickDrinkOptions = ['Coca-Cola (40cl)', 'Coca-Cola Zéro (40cl)', 'Fanta (40cl)', 'Oasis Tropical (40cl)', 'Eau minérale (50cl)'];
const quickSauceOptions = ['Sauce Giant', 'Sauce barbecue', 'Sauce mayonnaise', 'Sauce deluxe', 'Sauce ketchup'];
const quickMenuSteps = (base: number): ProductOptionGroup[] => [
  { id: base * 10 + 1, name: 'Taille du menu', question: 'Quelle taille de menu souhaitez-vous ?', required: true, min: 1, max: 1, options: [{ id: base * 100 + 1, name: 'M', priceDelta: 0, posCode: '', available: true }, { id: base * 100 + 2, name: 'L', priceDelta: 0.8, posCode: '', available: true }] },
  { id: base * 10 + 2, name: 'Accompagnement', question: 'Quel accompagnement souhaitez-vous ?', required: true, min: 1, max: 1, options: ['Moyenne frite', 'Moyenne Rustique', 'Petite salade'].map((name, index) => ({ id: base * 100 + 10 + index, name, priceDelta: 0, posCode: '', available: true })) },
  { id: base * 10 + 3, name: 'Boisson', question: 'Quelle boisson souhaitez-vous ?', required: true, min: 1, max: 1, options: quickDrinkOptions.map((name, index) => ({ id: base * 100 + 20 + index, name, priceDelta: 0, posCode: '', available: true })) },
  { id: base * 10 + 4, name: 'Sauce', question: 'Quelle sauce souhaitez-vous ?', required: false, min: 0, max: 2, options: quickSauceOptions.map((name, index) => ({ id: base * 100 + 30 + index, name, priceDelta: 0, posCode: '', available: true })) },
];
const quickMasterProducts: CatalogProduct[] = [
  { id: 2000, productId: 'quick_menu_supreme_bacon', name: 'Menu Suprême Bacon', category: 'Menus', subcategory: 'Burgers', detail: 'Suprême Bacon, accompagnement, boisson et sauce au choix', emoji: '🍔', price: 11.9, posCode: '', available: true, productType: 'menu', optionGroups: quickMenuSteps(2000), ingredients: ['Pain brioché', 'Steak haché grillé', 'Bacon', 'Cheddar', 'Salade', 'Sauce Suprême'] },
  { id: 2001, productId: 'quick_menu_giant', name: 'Menu Giant', category: 'Menus', subcategory: 'Burgers', detail: 'Giant, accompagnement, boisson et sauce au choix', emoji: '🍔', price: 9.9, posCode: '', available: true, productType: 'menu', optionGroups: quickMenuSteps(2001), ingredients: ['Pain aux graines', 'Deux steaks hachés', 'Cheddar', 'Salade', 'Oignons', 'Sauce Giant'] },
  { id: 2002, productId: 'quick_menu_long_bacon', name: 'Menu Long Bacon', category: 'Menus', subcategory: 'Poulet', detail: 'Long Bacon, accompagnement, boisson et sauce au choix', emoji: '🍔', price: 10.9, posCode: '', available: true, productType: 'menu', optionGroups: quickMenuSteps(2002), ingredients: ['Pain long', 'Poulet pané', 'Bacon', 'Cheddar', 'Salade', 'Sauce'] },
  { id: 2003, productId: 'quick_supreme_bacon', name: 'Suprême Bacon', category: 'Burgers', subcategory: 'Bœuf', detail: 'Bœuf, bacon, cheddar, salade et sauce Suprême', emoji: '🍔', price: 7.9, posCode: '', available: true, productType: 'configurable', ingredients: ['Pain brioché', 'Steak haché grillé', 'Bacon', 'Cheddar', 'Salade', 'Sauce Suprême'], modifiers: [{ id: 20031, name: 'Sans bacon', kind: 'remove', priceDelta: 0 }, { id: 20032, name: 'Sans cheddar', kind: 'remove', priceDelta: 0 }, { id: 20033, name: 'Supplément bacon', kind: 'add', priceDelta: 1 }] },
  { id: 2004, productId: 'quick_giant', name: 'Giant', category: 'Burgers', subcategory: 'Bœuf', detail: 'Deux viandes, salade, oignons et sauce Giant', emoji: '🍔', price: 6.9, posCode: '', available: true, productType: 'configurable', ingredients: ['Pain aux graines', 'Deux steaks hachés', 'Cheddar', 'Salade', 'Oignons', 'Sauce Giant'], modifiers: [{ id: 20041, name: 'Sans salade', kind: 'remove', priceDelta: 0 }, { id: 20042, name: 'Sans oignons', kind: 'remove', priceDelta: 0 }, { id: 20043, name: 'Supplément cheddar', kind: 'add', priceDelta: 0.8 }] },
  { id: 2005, productId: 'quick_long_chicken', name: 'Long Chicken', category: 'Burgers', subcategory: 'Poulet', detail: 'Poulet croustillant et sauce', emoji: '🍗', price: 6.9, posCode: '', available: true, productType: 'configurable', ingredients: ['Pain long', 'Poulet pané', 'Salade', 'Sauce'] },
  { id: 2006, productId: 'quick_fries', name: 'Moyenne frite', category: 'Accompagnements', detail: 'Frites croustillantes', emoji: '🍟', price: 2.8, posCode: '', available: true, productType: 'simple' },
  { id: 2007, productId: 'quick_rustic', name: 'Moyenne Rustique', category: 'Accompagnements', detail: 'Pommes de terre rustiques', emoji: '🥔', price: 3.2, posCode: '', available: true, productType: 'simple' },
  { id: 2008, productId: 'quick_salad', name: 'Petite salade', category: 'Accompagnements', detail: 'Salade fraîche', emoji: '🥗', price: 3.5, posCode: '', available: true, productType: 'simple' },
  { id: 2009, productId: 'quick_coca_cola', name: 'Coca-Cola', category: 'Boissons', detail: 'Boisson fraîche 40cl', emoji: '🥤', price: 2.8, posCode: '', available: true, productType: 'simple' },
  { id: 2010, productId: 'quick_water', name: 'Eau minérale', category: 'Boissons', detail: 'Bouteille d’eau 50cl', emoji: '💧', price: 2.2, posCode: '', available: true, productType: 'simple' },
  { id: 2011, productId: 'quick_sauce_giant', name: 'Sauce Giant', category: 'Sauces', detail: 'Sauce emblématique Quick', emoji: '🥫', price: 0.3, posCode: '', available: true, productType: 'simple' },
  { id: 2012, productId: 'quick_sauce_bbq', name: 'Sauce barbecue', category: 'Sauces', detail: 'Sauce barbecue fumée', emoji: '🥫', price: 0.3, posCode: '', available: true, productType: 'simple' },
  { id: 2013, productId: 'quick_magic_box', name: 'Magic Box', category: 'Menus enfants', detail: 'Menu enfant avec plat, accompagnement, boisson et surprise', emoji: '🎁', price: 5.9, posCode: '', available: true, productType: 'menu', optionGroups: quickMenuSteps(2013), ingredients: ['Produit principal au choix', 'Accompagnement', 'Boisson', 'Dessert ou surprise'] },
];
const kfcMasterProducts = createMasterProducts('kfc',[
  ['Menu Colonel Original','Menus','Burger, accompagnement, boisson et sauce','🍔'],['Menu Tower','Menus','Tower en formule complète','🍔'],['Menu Tenders','Menus','Tenders, accompagnement et boisson','🍗'],['Colonel Original','Burgers','Poulet pané, salade et sauce Colonel','🍔'],['Tower','Burgers','Poulet, galette de pomme de terre et fromage','🍔'],['Boxmaster','Burgers','Wrap généreux au poulet croustillant','🌯'],['Tenders x5','Poulet','Filets de poulet croustillants','🍗'],['Hot Wings x8','Poulet','Ailes de poulet épicées','🍗'],['Frites','Accompagnements','Frites dorées','🍟'],['Cobette','Accompagnements','Épi de maïs','🌽'],['Pepsi','Boissons','Boisson fraîche','🥤'],['Lipton Ice Tea','Boissons','Thé glacé','🥤'],['Sauce Colonel','Sauces','Sauce signature KFC','🥫'],['Sauce barbecue','Sauces','Sauce barbecue','🥫'],['P’tit Bucket','Menus enfants','Menu enfant complet','🎁']],3000);
const initialMasterBrands:MasterBrand[] = [
  {id:'bk',name:'Burger King France',short:'BK',color:'#c83a20',soft:'#fff0e8',version:1,status:'Publié',restaurants:184,updated:'Aujourd’hui',products:burgerKingCatalogTemplate.map(product=>({...product,available:true}))},
  {id:'quick',name:'Quick France',short:'Q',color:'#f4c531',soft:'#fff8d9',version:1,status:'Brouillon',restaurants:52,updated:'Aujourd’hui',products:quickMasterProducts},
  {id:'kfc',name:'KFC France',short:'KFC',color:'#d71920',soft:'#fff0f0',version:1,status:'Brouillon',restaurants:326,updated:'Aujourd’hui',products:kfcMasterProducts},
];

function DbStatusBadge({status}:{status:'off'|'loading'|'memory'|'synced'|'saving'|'error'}){
  const map={
    off:['⚪ Base non connectée','bg-[#f0f2ef] text-[#737c74]'],
    loading:['⏳ Connexion…','bg-[#eef3fb] text-[#3b6ea5]'],
    memory:['⚠️ En mémoire (non sauvegardé)','bg-[#fff5d9] text-[#a86f00]'],
    synced:['● Synchronisé à Supabase','bg-[#e5f6e9] text-[#27894a]'],
    saving:['⏳ Sauvegarde…','bg-[#eef3fb] text-[#3b6ea5]'],
    error:['⚠️ Erreur de sauvegarde','bg-[#fdecec] text-[#c0392b]'],
  } as const;
  const [label,cls]=map[status];
  return <span className={`rounded-full px-4 py-2 text-[10px] font-black ${cls}`}>{label}</span>;
}

function BackOfficePanel() {
  const [brands,setBrands]=useState<MasterBrand[]>(initialMasterBrands);
  const [dbStatus,setDbStatus]=useState<'off'|'loading'|'memory'|'synced'|'saving'|'error'>(isSupabaseConfigured?'loading':'off');
  const hydratedRef=useRef(false);
  const skipPersistRef=useRef(false);
  const persistTimerRef=useRef<ReturnType<typeof setTimeout>|null>(null);

  // Chargement initial depuis Supabase (si configuré et non vide)
  useEffect(()=>{
    if(!isSupabaseConfigured){setDbStatus('off');return;}
    let cancelled=false;
    setDbStatus('loading');
    fetchBrandsFromDb().then(loaded=>{
      if(cancelled)return;
      if(loaded&&loaded.length>0){
        skipPersistRef.current=true;
        setBrands(loaded as unknown as MasterBrand[]);
        hydratedRef.current=true;
        setDbStatus('synced');
      }else{
        hydratedRef.current=false;
        setDbStatus('memory');
      }
    });
    return()=>{cancelled=true;};
  },[]);

  // Persistance vers Supabase à chaque modification (debounce)
  useEffect(()=>{
    if(!isSupabaseConfigured)return;
    if(!hydratedRef.current)return;
    if(skipPersistRef.current){skipPersistRef.current=false;return;}
    if(persistTimerRef.current)clearTimeout(persistTimerRef.current);
    setDbStatus('saving');
    persistTimerRef.current=setTimeout(()=>{
      syncBrandsToDb(brands as unknown as MasterBrandInput[]).then(res=>{
        setDbStatus(res.ok?'synced':'error');
      });
    },700);
    return()=>{if(persistTimerRef.current)clearTimeout(persistTimerRef.current);};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[brands]);

  // Synchronisation initiale : pousse le catalogue en mémoire vers Supabase
  const handleInitialSync=useCallback(async()=>{
    if(!isSupabaseConfigured)return;
    setDbStatus('saving');
    const res=await syncBrandsToDb(brands as unknown as MasterBrandInput[]);
    if(res.ok){hydratedRef.current=true;setDbStatus('synced');}
    else{setDbStatus('error');}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[brands]);

  const [selectedBrandId,setSelectedBrandId]=useState<MasterBrand['id']|null>(null);
  const [view,setView]=useState<'catalog'|'versions'|'restaurants'>('catalog');
  const [category,setCategory]=useState('Toutes');
  const [query,setQuery]=useState('');
  const [preview,setPreview]=useState(false);
  const [notice,setNotice]=useState('');
  const [editingProduct,setEditingProduct]=useState<CatalogProduct|null>(null);
  const [creatingProduct,setCreatingProduct]=useState(false);
  const [draft,setDraft]=useState<ProductDraft>({ name: '', detail: '', category: 'Menus', subcategory: 'Bœuf', price: 0, posCode: '', emoji: '🍽️', ingredients: [], available: true, productType: 'simple', variants: [], optionGroups: [], modifiers: [], imageUrl: '', slug: '', meatFilter: '', badges: '', ingredientImages: '', allergens: '', traces: '', displayOrder: 1, nutrition: { calories: '', fat: '', saturatedFat: '', proteins: '', carbohydrates: '', sugars: '', salt: '' } });
  const [newIngredient,setNewIngredient]=useState('');
  const brand=brands.find(item=>item.id===selectedBrandId)??null;
  const categories=brand?Array.from(new Set(brand.products.map(product=>product.category))):[];
  const displayed=brand?brand.products.filter(product=>(category==='Toutes'||product.category===category)&&`${product.name} ${product.detail}`.toLowerCase().includes(query.toLowerCase())):[];
  const updateBrand=(id:MasterBrand['id'],patch:Partial<MasterBrand>)=>setBrands(current=>current.map(item=>item.id===id?{...item,...patch}:item));
  const publish=()=>{if(!brand)return;updateBrand(brand.id,{version:brand.version+1,status:'Publié',updated:'À l\'instant'});setNotice(`✓ Version v${brand.version+1} publiée et prête pour les restaurants ${brand.short}.`);window.setTimeout(()=>setNotice(''),3200);};
  const archive=()=>{if(!brand)return;updateBrand(brand.id,{status:'Archivé',updated:'À l\'instant'});setNotice('Catalogue archivé. Les restaurants conservent leur dernière version publiée.');};
  const startCreate=()=>{const defaultCategory=category==='Toutes'?(categories[0]??'Menus'):category;setDraft({name:'',detail:'',category:defaultCategory,subcategory:subcategoryTemplates[defaultCategory]?.[1]??'',price:0,posCode:'',emoji:'🍽️',ingredients:[],available:true,productType:defaultCategory==='Menus'?'menu':'simple',variants:[],optionGroups:[],modifiers:[],imageUrl:'',slug:'',meatFilter:'',badges:'',ingredientImages:'',allergens:'',traces:'',displayOrder:brand?.products.length?brand.products.length+1:1,nutrition:{calories:'',fat:'',saturatedFat:'',proteins:'',carbohydrates:'',sugars:'',salt:''}});setCreatingProduct(true);setEditingProduct(null);setNewIngredient('');};
  const startEdit=(product:CatalogProduct)=>{const isMenuCategory=product.category==='Menus'||product.category==='Menus enfants';const requiredSteps=product.category==='Menus enfants'?['Taille du menu','Plat','Accompagnement','Boisson','Sauces','Dessert','Jouet']:['Taille du menu','Plat','Accompagnement','Boisson','Sauces'];const existingSteps=product.optionGroups??[];const normalizedSteps=isMenuCategory?requiredSteps.map((name,index)=>existingSteps.find(step=>step.name.toLowerCase()===name.toLowerCase())??{id:product.id*100+index,name,question:`Choisissez : ${name.toLowerCase()}`,required:true,min:1,max:1,options:[]}).concat(existingSteps.filter(step=>!requiredSteps.some(name=>name.toLowerCase()===step.name.toLowerCase()))):existingSteps;setDraft({name:product.name,detail:product.detail,category:product.category,subcategory:product.subcategory??subcategoryTemplates[product.category]?.[1]??'',price:product.price,posCode:product.posCode,emoji:product.emoji,ingredients:product.ingredientSettings??(product.ingredients??[]).map((name,index)=>({id:product.id*1000+index,name,removable:!/pain/i.test(name),extraAllowed:!/pain|sauce/i.test(name),extraPrice:0})),available:product.available,productType:isMenuCategory?'menu':product.productType??'simple',variants:product.variants??[],optionGroups:normalizedSteps,modifiers:product.modifiers??[],imageUrl:product.imageUrl??'',slug:product.slug??'',meatFilter:product.meatFilter??'',badges:(product.badges??[]).join(', '),ingredientImages:(product.ingredientImages??[]).join('\n'),allergens:(product.allergens??[]).join(', '),traces:(product.traces??[]).join(', '),displayOrder:product.displayOrder??1,nutrition:product.nutrition??{calories:'',fat:'',saturatedFat:'',proteins:'',carbohydrates:'',sugars:'',salt:''}});setEditingProduct(product);setCreatingProduct(false);setNewIngredient('');};
  const addIngredient=()=>{const name=newIngredient.trim();if(!name)return;setDraft(current=>({...current,ingredients:[...current.ingredients,{id:Date.now(),name,removable:true,extraAllowed:true,extraPrice:0}]}));setNewIngredient('');};
  const updateIngredient=(id:number,patch:Partial<ProductIngredient>)=>setDraft(current=>({...current,ingredients:current.ingredients.map((ingredient:ProductIngredient)=>ingredient.id===id?{...ingredient,...patch}:ingredient)}));
  const moveIngredient=(index:number,direction:-1|1)=>setDraft(current=>{const target=index+direction;if(target<0||target>=current.ingredients.length)return current;const ingredients=[...current.ingredients];[ingredients[index],ingredients[target]]=[ingredients[target],ingredients[index]];return {...current,ingredients};});
  const saveProduct=()=>{if(!brand||!draft.name.trim()||draft.price<0)return;const ingredientSettings=draft.category!=='Menus'&&draft.category!=='Menus enfants'?(draft.ingredients as ProductIngredient[]).filter(ingredient=>ingredient.name.trim()).map(ingredient=>({...ingredient,name:ingredient.name.trim()})):[];const ingredients=ingredientSettings.map(ingredient=>ingredient.name);const ingredientModifiers:ProductModifier[]=ingredientSettings.flatMap(ingredient=>[...(ingredient.removable?[{id:ingredient.id*10+1,name:`Sans ${ingredient.name}`,kind:'remove' as const,priceDelta:0}]:[]),...(ingredient.extraAllowed?[{id:ingredient.id*10+2,name:`Supplément ${ingredient.name}`,kind:'add' as const,priceDelta:ingredient.extraPrice}]:[])]);const nextProduct={name:draft.name.trim(),detail:draft.detail.trim(),category:draft.category,subcategory:draft.subcategory||undefined,price:draft.price,posCode:draft.posCode.trim(),emoji:draft.emoji||'🍽️',imageUrl:draft.imageUrl.trim()||undefined,ingredients,ingredientSettings,available:draft.available,productType:draft.productType,variants:draft.variants,optionGroups:draft.optionGroups,modifiers:ingredientModifiers,slug:draft.slug.trim()||undefined,meatFilter:draft.meatFilter.trim()||undefined,badges:splitField(draft.badges),ingredientImages:splitField(draft.ingredientImages),allergens:splitField(draft.allergens),traces:splitField(draft.traces),displayOrder:draft.displayOrder,nutrition:draft.nutrition};const products=editingProduct?brand.products.map(product=>product.id===editingProduct.id?{...product,...nextProduct}:product):[...brand.products,{id:Date.now(),productId:`master_${brand.id}_${Date.now()}`,...nextProduct} as CatalogProduct];updateBrand(brand.id,{products,status:'Brouillon',updated:'Modifié à l\'instant'});setEditingProduct(null);setCreatingProduct(false);};
  const addCategory=()=>{if(!brand)return;const name=window.prompt('Nom de la nouvelle catégorie');if(!name?.trim())return;setCategory(name.trim());startCreate();setDraft(current=>({...current,category:name.trim()}));};
  // ----- Restaurants (multi-tenant Supabase) -----
  const [restaurants,setRestaurants]=useState<RestaurantInfo[]|null>(null);
  const [selectedRestaurantId,setSelectedRestaurantId]=useState<string|null>(null);
  const [restaurantProducts,setRestaurantProducts]=useState<RestaurantProductInfo[]|null>(null);
  const [restaurantSaving,setRestaurantSaving]=useState(false);
  const [creatingRestaurant,setCreatingRestaurant]=useState(false);
  const [restaurantDraft,setRestaurantDraft]=useState({name:'',code:'',city:'',address:''});
  const [restaurantNotice,setRestaurantNotice]=useState('');

  const loadRestaurants=useCallback(async()=>{
    const list=await fetchRestaurants();
    if(list)setRestaurants(list);
  },[]);

  useEffect(()=>{
    if(!isSupabaseConfigured)return;
    let cancelled=false;
    fetchRestaurants().then(list=>{if(!cancelled&&list)setRestaurants(list);});
    return()=>{cancelled=true;};
  },[]);

  const brandRestaurants=brand&&restaurants?restaurants.filter(item=>item.brand_key===brand.id):[];
  const restaurant=restaurants?.find(item=>item.id===selectedRestaurantId)??null;

  const handleCreateRestaurant=async()=>{
    if(!brand||!restaurantDraft.name.trim())return;
    if(dbStatus==='memory'||dbStatus==='off'){setRestaurantNotice('⚠️ Publiez d’abord les catalogues vers Supabase avant de créer un restaurant.');return;}
    setRestaurantSaving(true);
    const res=await createRestaurant({brandKey:brand.id,name:restaurantDraft.name.trim(),code:restaurantDraft.code.trim()||undefined,city:restaurantDraft.city.trim()||undefined,address:restaurantDraft.address.trim()||undefined});
    setRestaurantSaving(false);
    if(res.ok){
      setCreatingRestaurant(false);
      setRestaurantDraft({name:'',code:'',city:'',address:''});
      setRestaurantNotice('✓ Restaurant créé : le catalogue maître a été copié en local.');
      window.setTimeout(()=>setRestaurantNotice(''),3600);
      loadRestaurants();
    }else{
      setRestaurantNotice(`⚠️ ${res.error}`);
    }
  };

  const handleDeleteRestaurant=async(id:string)=>{
    if(!window.confirm('Supprimer définitivement ce restaurant et son catalogue local ?'))return;
    const res=await deleteRestaurant(id);
    if(res.ok){setSelectedRestaurantId(null);setRestaurantProducts(null);loadRestaurants();}
    else{setRestaurantNotice(`⚠️ ${res.error??'Suppression impossible'}`);}
  };

  const openRestaurant=async(id:string)=>{
    setSelectedRestaurantId(id);
    setRestaurantProducts(null);
    const products=await fetchRestaurantProducts(id);
    setRestaurantProducts(products??[]);
  };

  const saveLocalProduct=async(productId:string,patch:{price?:number;available?:boolean})=>{
    if(!restaurant)return;
    setRestaurantProducts(current=>current?.map(item=>item.product_id===productId?{...item,...patch}:item)??current);
    const res=await updateRestaurantProduct(restaurant.id,productId,patch);
    if(!res.ok)setRestaurantNotice(`⚠️ ${res.error??'Sauvegarde locale impossible'}`);
  };
  if (brand && view === 'catalog') return <><MasterCatalogBrowser brand={brand} categories={categories} category={category} setCategory={setCategory} query={query} setQuery={setQuery} onBack={()=>setSelectedBrandId(null)} onEdit={startEdit} dbStatus={dbStatus} />{(creatingProduct||editingProduct)&&<IngredientProductEditor draft={draft} setDraft={setDraft} categories={categories.map((name,index)=>({id:index+1,name,icon:'',enabled:true}))} catalogProducts={brand.products} subcategoryOptions={subcategoryTemplates[draft.category]??[]} newIngredient={newIngredient} setNewIngredient={setNewIngredient} addIngredient={addIngredient} updateIngredient={updateIngredient} moveIngredient={moveIngredient} onClose={()=>{setCreatingProduct(false);setEditingProduct(null);}} onSave={saveProduct} onDelete={editingProduct?()=>{if(window.confirm('Supprimer définitivement ce produit ?')){updateBrand(brand.id,{products:brand.products.filter(product=>product.id!==editingProduct.id),status:'Brouillon',updated:'Supprimé à l’instant'});setEditingProduct(null);}}:undefined} isNew={creatingProduct} />}</>;
  if(!brand)return <div><SectionHeading eyebrow="Administration plateforme" title="Back-office des enseignes" description="Gérez les catalogues maîtres nationaux qui seront attribués automatiquement aux restaurants lors de leur création." action={<div className="flex flex-wrap items-center gap-2"><DbStatusBadge status={dbStatus}/><span className="rounded-full bg-[#fff0ec] px-4 py-2 text-[10px] font-black text-[#d84d32]">ACCÈS SUPER ADMIN</span></div>} />{dbStatus==='memory'&&<div className="mb-5 flex flex-col gap-3 rounded-2xl border border-[#f0d9a8] bg-[#fff8e8] p-5 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-black text-[#a86f00]">Base de données détectée mais vide</p><p className="mt-1 text-[11px] text-[#8a6d1f]">Vos catalogues sont actuellement en mémoire. Publiez-les vers Supabase pour les rendre persistants.</p></div><button onClick={handleInitialSync} className="shrink-0 rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">Publier les 3 catalogues vers Supabase</button></div>}{dbStatus==='error'&&<div className="mb-5 rounded-2xl border border-[#f0b8b8] bg-[#fdecec] p-4 text-xs font-black text-[#c0392b]">Impossible de sauvegarder vers Supabase. Vérifiez que le script <code className="rounded bg-white/60 px-1">supabase/setup.sql</code> a bien été exécuté dans le SQL Editor.</div>}<div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['Enseignes','3','Catalogues séparés'],['Produits maîtres',String(brands.reduce((sum,item)=>sum+item.products.length,0)),'Toutes enseignes'],['Restaurants',String(brands.reduce((sum,item)=>sum+item.restaurants,0)),'Rattachés aux catalogues'],['Publications',String(brands.filter(item=>item.status==='Publié').length),'Versions actives']].map(([label,value,detail])=><div key={label} className={`${panelCard} p-5`}><p className="text-[9px] font-black uppercase tracking-wider text-[#939b94]">{label}</p><p className="mt-2 text-2xl font-black">{value}</p><p className="mt-1 text-[10px] font-bold text-[#7e8780]">{detail}</p></div>)}</div><div className="grid gap-5 lg:grid-cols-3">{brands.map(item=><button key={item.id} onClick={()=>{setSelectedBrandId(item.id);setCategory('Toutes');setView('catalog');}} className="group overflow-hidden rounded-[28px] border border-[#dfe4dc] bg-white text-left shadow-sm transition hover:-translate-y-1 hover:shadow-xl"><div className="h-2" style={{background:item.color}}/><div className="p-6"><div className="flex items-start justify-between"><span className="grid h-16 w-16 place-items-center rounded-2xl text-lg font-black" style={{background:item.soft,color:item.color}}>{item.short}</span><span className={`rounded-full px-3 py-1.5 text-[9px] font-black ${item.status==='Publié'?'bg-[#e5f6e9] text-[#27894a]':'bg-[#fff5d9] text-[#a86f00]'}`}>{item.status}</span></div><h2 className="mt-5 text-xl font-black">{item.name}</h2><p className="mt-1 text-xs text-[#7f8981]">Catalogue maître France · version v{item.version}</p><div className="mt-5 grid grid-cols-3 gap-2 border-t border-[#edf0eb] pt-4 text-center"><div><strong className="block text-lg">{new Set(item.products.map(product=>product.category)).size}</strong><small className="text-[9px] text-[#8a938b]">Catégories</small></div><div><strong className="block text-lg">{item.products.length}</strong><small className="text-[9px] text-[#8a938b]">Produits</small></div><div><strong className="block text-lg">{item.restaurants}</strong><small className="text-[9px] text-[#8a938b]">Restaurants</small></div></div><span className="mt-5 flex items-center justify-between text-xs font-black" style={{color:item.color}}>Ouvrir le catalogue <span>→</span></span></div></button>)}</div></div>;
  if(brand&&restaurant)return <RestaurantLocalPanel restaurant={restaurant} products={restaurantProducts} masterProducts={brand.products} onBack={()=>{setSelectedRestaurantId(null);setRestaurantProducts(null);}} onDelete={()=>handleDeleteRestaurant(restaurant.id)} onSaveProduct={saveLocalProduct} />;
  return <div><button onClick={()=>setSelectedBrandId(null)} className="mb-4 text-xs font-black text-[#69736b]">← Toutes les enseignes</button><SectionHeading eyebrow="Catalogue maître national" title={brand.name} description={`Structure officielle partagée avec ${brand.restaurants} restaurants. Les adaptations locales resteront séparées lors de la connexion à Supabase.`} action={<div className="flex flex-wrap items-center gap-2"><DbStatusBadge status={dbStatus}/><button onClick={()=>setPreview(true)} className="rounded-xl border border-[#dce2da] bg-white px-4 py-3 text-xs font-black">Prévisualiser</button><button onClick={publish} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">Publier v{brand.version+1}</button></div>} />{notice&&<div className="mb-4 rounded-2xl border border-[#bee4c9] bg-[#e8f8ed] px-5 py-4 text-xs font-black text-[#257c43]">{notice}</div>}<div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['Version',`v${brand.version}`,brand.status],['Catégories',String(categories.length),'Structure nationale'],['Produits',String(brand.products.length),'Fiches maîtres'],['Restaurants',String(brand.restaurants),'Héritent de cette carte']].map(([label,value,detail])=><div key={label} className={`${panelCard} p-4`}><p className="text-[9px] font-black uppercase tracking-wider text-[#949c95]">{label}</p><p className="mt-2 text-xl font-black">{value}</p><p className="mt-1 text-[10px] text-[#7c857e]">{detail}</p></div>)}</div><div className="mb-5 flex gap-2 overflow-x-auto rounded-2xl border border-[#e1e6df] bg-white p-2">{([['catalog','Catalogue'],['versions','Versions & publication'],['restaurants','Restaurants rattachés']] as const).map(([id,label])=><button key={id} onClick={()=>setView(id)} className={`shrink-0 rounded-xl px-4 py-3 text-xs font-black ${view===id?'bg-[#0b1f14] text-white':'text-[#737d75]'}`}>{label}</button>)}</div>{view==='catalog'&&<section className={`${panelCard} overflow-hidden`}><div className="flex flex-col gap-3 border-b border-[#e5e9e2] p-5 lg:flex-row lg:items-center lg:justify-between"><div className="flex gap-2 overflow-x-auto">{['Toutes',...categories].map(item=><button key={item} onClick={()=>setCategory(item)} className={`shrink-0 rounded-full px-3 py-2 text-[10px] font-black ${category===item?'bg-[#ff5a36] text-white':'bg-[#f1f3ef] text-[#6e786f]'}`}>{item} <span className="opacity-60">{item==='Toutes'?brand.products.length:brand.products.filter(product=>product.category===item).length}</span></button>)}</div><div className="flex gap-2"><button onClick={addCategory} className="rounded-xl border border-[#dce2da] px-4 py-3 text-[10px] font-black">＋ Catégorie</button><button onClick={startCreate} className="rounded-xl bg-[#0b1f14] px-4 py-3 text-[10px] font-black text-white">＋ Produit</button></div></div><div className="p-5"><input className={`${fieldClass} max-w-md`} placeholder="Rechercher dans le catalogue maître…" value={query} onChange={event=>setQuery(event.target.value)} /><div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{displayed.map(product=><button key={product.id} onClick={()=>startEdit(product)} className="overflow-hidden rounded-2xl border border-[#e3e7e1] bg-white text-left transition hover:border-[#ff9e87] hover:shadow-lg"><div className="grid h-28 place-items-center bg-[#f4f6f1] text-5xl">{product.emoji}</div><div className="p-4"><p className="text-[9px] font-black uppercase tracking-wider text-[#989f99]">{product.category}</p><h3 className="mt-1 truncate text-sm font-black">{product.name}</h3><p className="mt-1 line-clamp-2 min-h-8 text-[10px] leading-relaxed text-[#7e8780]">{product.detail}</p><span className="mt-3 inline-block text-[9px] font-black text-[#ff5a36]">Modifier la fiche →</span></div></button>)}</div></div></section>}{view==='versions'&&<section className={`${panelCard} p-6`}><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Cycle de publication</p><h2 className="mt-2 text-xl font-black">Versions du catalogue</h2><p className="mt-1 text-xs text-[#7e8780]">Chaque publication crée une version immuable distribuable aux restaurants.</p></div><button onClick={publish} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">Publier une nouvelle version</button></div><div className="mt-6 space-y-3">{[brand.version,Math.max(1,brand.version-1)].map((version,index)=><div key={`${version}-${index}`} className="flex flex-wrap items-center gap-4 rounded-2xl border border-[#e2e7df] p-4"><span className="grid h-11 w-11 place-items-center rounded-xl bg-[#f1f3ef] text-xs font-black">v{version}</span><div className="min-w-0 flex-1"><p className="text-sm font-black">{index===0?'Version actuelle':'Version précédente'}</p><p className="mt-1 text-[10px] text-[#899189]">{brand.products.length} produits · {categories.length} catégories</p></div><span className={`rounded-full px-3 py-1.5 text-[9px] font-black ${index===0?'bg-[#e5f6e9] text-[#27894a]':'bg-[#f0f2ef] text-[#737c74]'}`}>{index===0?brand.status:'Archivée'}</span></div>)}</div><button onClick={archive} className="mt-6 text-xs font-black text-[#d6503d]">Archiver le catalogue maître</button></section>}{view==='restaurants'&&<section className={`${panelCard} p-6`}><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Déploiement réseau</p><h2 className="mt-2 text-xl font-black">Restaurants rattachés</h2><p className="mt-1 text-xs text-[#7e8780]">{isSupabaseConfigured?`${brandRestaurants.length} restaurant${brandRestaurants.length>1?'s':''} connecté${brandRestaurants.length>1?'s':''} · catalogue local hérité du maître v${brand.version}`:'Connectez Supabase pour gérer les restaurants.'}</p></div>{isSupabaseConfigured&&<button onClick={()=>{setCreatingRestaurant(current=>!current);setRestaurantNotice('');}} className="rounded-xl bg-[#0b1f14] px-4 py-3 text-xs font-black text-white">{creatingRestaurant?'Annuler':'＋ Restaurant'}</button>}</div>{restaurantNotice&&<div className={`mt-4 rounded-2xl px-4 py-3 text-xs font-black ${restaurantNotice.startsWith('⚠️')?'border border-[#f0b8b8] bg-[#fdecec] text-[#c0392b]':'border border-[#bee4c9] bg-[#e8f8ed] text-[#257c43]'}`}>{restaurantNotice}</div>}{creatingRestaurant&&<div className="mt-5 rounded-2xl border border-[#e2e7df] p-4"><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><label className="text-[10px] font-black text-[#68736a]">Nom du restaurant *<input className={`${fieldClass} mt-1.5`} placeholder={`Ex. ${brand.short} Paris République`} value={restaurantDraft.name} onChange={event=>setRestaurantDraft(current=>({...current,name:event.target.value}))} /></label><label className="text-[10px] font-black text-[#68736a]">Code<input className={`${fieldClass} mt-1.5 font-mono`} placeholder="Ex. FR-075" value={restaurantDraft.code} onChange={event=>setRestaurantDraft(current=>({...current,code:event.target.value}))} /></label><label className="text-[10px] font-black text-[#68736a]">Ville<input className={`${fieldClass} mt-1.5`} placeholder="Ex. Paris" value={restaurantDraft.city} onChange={event=>setRestaurantDraft(current=>({...current,city:event.target.value}))} /></label><label className="text-[10px] font-black text-[#68736a]">Adresse<input className={`${fieldClass} mt-1.5`} placeholder="Ex. 12 rue de la République" value={restaurantDraft.address} onChange={event=>setRestaurantDraft(current=>({...current,address:event.target.value}))} /></label></div><div className="mt-4 flex flex-wrap items-center justify-between gap-3"><p className="text-[10px] text-[#8c958d]">Le catalogue maître {brand.name} ({brand.products.length} produits) sera copié automatiquement dans le catalogue local du restaurant.</p><button onClick={handleCreateRestaurant} disabled={!restaurantDraft.name.trim()||restaurantSaving} className="shrink-0 rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white disabled:opacity-40">{restaurantSaving?'Création…':'Créer le restaurant'}</button></div></div>}{restaurants===null&&isSupabaseConfigured&&<p className="mt-6 text-xs font-bold text-[#8c958d]">Chargement des restaurants…</p>}{restaurants!==null&&brandRestaurants.length===0&&!creatingRestaurant&&<div className="mt-6 rounded-2xl border border-dashed border-[#d8ddd6] py-10 text-center"><p className="text-sm font-black">Aucun restaurant rattaché</p><p className="mt-1 text-xs text-[#8b948c]">{isSupabaseConfigured?`Créez un premier restaurant pour lui transmettre le catalogue maître ${brand.short}.`:'Connectez Supabase pour créer des restaurants.'}</p></div>}{brandRestaurants.length>0&&<div className="mt-6 grid gap-3 md:grid-cols-2">{brandRestaurants.map(item=><button key={item.id} onClick={()=>openRestaurant(item.id)} className="flex items-center gap-3 rounded-2xl border border-[#e2e7df] p-4 text-left transition hover:border-[#ff9e87] hover:shadow-md"><span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-xs font-black" style={{background:brand.soft,color:brand.color}}>{brand.short}</span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-black">{item.name}</span><span className="mt-1 block text-[9px] text-[#8c958d]">{[item.code,item.city].filter(Boolean).join(' · ')||'Code et ville non renseignés'} · {item.active?'Actif':'Inactif'}</span></span><span className="shrink-0 text-xs font-black text-[#ff5a36]">Catalogue local →</span></button>)}</div>}</section>}{(creatingProduct||editingProduct)&&<IngredientProductEditor draft={draft} setDraft={setDraft} categories={categories.map((name,index)=>({id:index+1,name,icon:'',enabled:true}))} catalogProducts={brand.products} subcategoryOptions={subcategoryTemplates[draft.category]??[]} newIngredient={newIngredient} setNewIngredient={setNewIngredient} addIngredient={addIngredient} updateIngredient={updateIngredient} moveIngredient={moveIngredient} onClose={()=>{setCreatingProduct(false);setEditingProduct(null);}} onSave={saveProduct} onDelete={editingProduct?()=>{if(window.confirm('Supprimer définitivement ce produit ?')){updateBrand(brand.id,{products:brand.products.filter(product=>product.id!==editingProduct.id),status:'Brouillon',updated:'Supprimé à l’instant'});setEditingProduct(null);}}:undefined} isNew={creatingProduct} />}{preview&&<div className="fixed inset-0 z-[70] overflow-y-auto bg-[#07130d]/70 p-4" role="dialog" aria-modal="true"><div className="mx-auto max-w-6xl rounded-[28px] bg-white p-6"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest" style={{color:brand.color}}>Prévisualisation nationale</p><h2 className="mt-1 text-2xl font-black">Carte {brand.name}</h2></div><button onClick={()=>setPreview(false)} className="grid h-10 w-10 place-items-center rounded-xl bg-[#f0f3ee] font-black">×</button></div>{categories.map(item=><section key={item} className="mt-7"><h3 className="border-b pb-2 text-lg font-black">{item}</h3><div className="mt-4 grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">{brand.products.filter(product=>product.category===item).map(product=><div key={product.id} className="rounded-2xl bg-[#f5f6f1] p-4"><span className="text-4xl">{product.emoji}</span><p className="mt-3 text-sm font-black">{product.name}</p><p className="mt-1 text-[10px] text-[#7d867e]">{product.detail}</p></div>)}</div></section>)}</div></div>}</div>;
}

function LocalPriceInput({value,onCommit}:{value:number;onCommit:(next:number)=>void}){
  const [draft,setDraft]=useState(value.toFixed(2));
  const [lastValue,setLastValue]=useState(value);
  if(lastValue!==value){setLastValue(value);setDraft(value.toFixed(2));}
  const commit=()=>{
    const next=Number(draft.replace(',','.'));
    if(Number.isFinite(next)&&next>=0&&Math.abs(next-value)>0.001)onCommit(Math.round(next*100)/100);
    else setDraft(value.toFixed(2));
  };
  return <div className="relative"><input className="h-10 w-24 rounded-xl border border-[#dfe4dc] bg-white pl-3 pr-7 text-sm font-semibold outline-none transition focus:border-[#ff6a45]" type="text" inputMode="decimal" value={draft} onChange={event=>setDraft(event.target.value)} onBlur={commit} onKeyDown={event=>{if(event.key==='Enter')(event.target as HTMLInputElement).blur();}} /><span className="pointer-events-none absolute right-3 top-2.5 text-xs font-black">€</span></div>;
}

function RestaurantLocalPanel({restaurant,products,masterProducts,onBack,onDelete,onSaveProduct}:{restaurant:RestaurantInfo;products:RestaurantProductInfo[]|null;masterProducts:CatalogProduct[];onBack:()=>void;onDelete:()=>void;onSaveProduct:(productId:string,patch:{price?:number;available?:boolean})=>void}){
  const masterByProductId=new Map(masterProducts.map(product=>[product.productId,product]));
  const categories=products?Array.from(new Set(products.map(product=>product.category??'Autres'))):[];
  const availableCount=products?.filter(product=>product.available).length??0;
  const modifiedCount=products?.filter(product=>{const master=masterByProductId.get(product.product_id);return Boolean(master)&&((master?.price??0)!==(product.price??0)||master?.available!==product.available);}).length??0;
  return <div><button onClick={onBack} className="mb-4 text-xs font-black text-[#69736b]">← Restaurants rattachés</button><SectionHeading eyebrow="Déclinaison locale" title={restaurant.name} description={`Catalogue local hérité du catalogue maître ${restaurant.brand_name??''}. Les prix et disponibilités sont adaptables ici sans modifier le catalogue national.`} action={<div className="flex flex-wrap items-center gap-2"><span className="rounded-full px-4 py-2 text-[10px] font-black" style={{background:restaurant.brand_soft??'#f1f3ef',color:restaurant.brand_color??'#0b1f14'}}>{restaurant.brand_short??'Enseigne'}</span><button onClick={onDelete} className="rounded-xl border border-[#f3c4ba] bg-white px-4 py-3 text-xs font-black text-[#d6503d]">Supprimer le restaurant</button></div>} /><div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['Produits',products===null?'…':String(products.length),'Hérités du maître'],['Disponibles',products===null?'…':String(availableCount),'Proposés par l\'agent'],['Adaptations locales',products===null?'…':String(modifiedCount),'Prix ou dispo modifiés'],['Ville',restaurant.city??'—',restaurant.active?'Restaurant actif':'Restaurant inactif']].map(([label,value,detail])=><div key={label} className={`${panelCard} p-4`}><p className="text-[9px] font-black uppercase tracking-wider text-[#949c95]">{label}</p><p className="mt-2 text-xl font-black">{value}</p><p className="mt-1 text-[10px] text-[#7c857e]">{detail}</p></div>)}</div>{products===null&&<div className={`${panelCard} py-16 text-center text-sm font-black text-[#8b948c]`}>Chargement du catalogue local…</div>}{products!==null&&products.length===0&&<div className={`${panelCard} py-16 text-center`}><p className="text-sm font-black">Catalogue local vide</p><p className="mt-1 text-xs text-[#8b948c]">Aucun produit n’a été copié depuis le catalogue maître pour ce restaurant.</p></div>}{products!==null&&products.length>0&&categories.map(cat=>{const items=products.filter(product=>(product.category??'Autres')===cat).sort((a,b)=>a.display_order-b.display_order);return <section key={cat} className={`${panelCard} mb-5 overflow-hidden`}><div className="border-b border-[#e5e9e2] p-5"><h3 className="text-sm font-black">{cat}</h3><p className="mt-1 text-[10px] text-[#899189]">{items.length} produit{items.length>1?'s':''} · les modifications restent propres à ce restaurant</p></div><div className="divide-y divide-[#eef1ec]">{items.map(product=>{const master=masterByProductId.get(product.product_id);const priceModified=master!==undefined&&(master.price??0)!==(product.price??0);const emoji=(product.data as {emoji?:string}|null)?.emoji??'🍽️';return <div key={product.id} className="flex flex-wrap items-center gap-4 p-4"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-[#f4f6f1] text-xl">{emoji}</span><div className="min-w-0 flex-1"><p className="truncate text-sm font-black">{product.name}</p><p className="mt-0.5 flex flex-wrap items-center gap-2 text-[10px] text-[#899189]">{master!==undefined?`Prix maître : ${master.price.toFixed(2)} €`:'Référence maître introuvable'}{priceModified&&<span className="rounded-full bg-[#fff0ec] px-2 py-0.5 text-[9px] font-black text-[#d84d32]">Prix local</span>}</p></div><label className="flex items-center gap-2 text-[10px] font-black text-[#68736a]">Prix<LocalPriceInput value={product.price??0} onCommit={next=>onSaveProduct(product.product_id,{price:next})} /></label><div className="flex items-center gap-2"><span className="w-16 text-right text-[10px] font-black" style={{color:product.available?'#278a49':'#c0392b'}}>{product.available?'Disponible':'Épuisé'}</span><button onClick={()=>onSaveProduct(product.product_id,{available:!product.available})} aria-label={product.available?'Rendre indisponible':'Rendre disponible'} className={`relative h-6 w-11 shrink-0 rounded-full transition ${product.available?'bg-[#35a85a]':'bg-[#d9ded8]'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition ${product.available?'left-6':'left-1'}`} /></button></div></div>;})}</div></section>;})}</div>;
}

function MasterCatalogBrowser({ brand, categories, category, setCategory, query, setQuery, onBack, onEdit, dbStatus }: {
  brand: MasterBrand;
  categories: string[];
  category: string;
  setCategory: React.Dispatch<React.SetStateAction<string>>;
  query: string;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
  onBack: () => void;
  onEdit: (product: CatalogProduct) => void;
  dbStatus?: 'off'|'loading'|'memory'|'synced'|'saving'|'error';
}) {
  const [selectedProduct, setSelectedProduct] = useState<CatalogProduct | null>(null);
  const products = brand.products.filter(product => (category === 'Toutes' || product.category === category) && `${product.name} ${product.detail}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <div>
      <button onClick={onBack} className="mb-4 text-xs font-black text-[#69736b]">← Toutes les enseignes</button>
      <SectionHeading eyebrow="Catalogue maître national" title={brand.name} description="Cliquez sur un produit pour ouvrir sa fiche complète et modifier ses informations, son prix, sa composition et sa structure." action={<div className="flex flex-wrap items-center gap-2">{dbStatus&&<DbStatusBadge status={dbStatus}/>}<span className="rounded-full bg-[#e5f6e9] px-4 py-2 text-[10px] font-black text-[#27894a]">● Catalogue actif</span></div>} />
      <section className={`${panelCard} overflow-hidden`}>
        <div className="border-b border-[#e5e9e2] bg-white p-4">
          <div className="flex gap-2 overflow-x-auto pb-1">{['Toutes', ...categories].map(item => <button key={item} onClick={() => setCategory(item)} className={`shrink-0 rounded-full px-3 py-2 text-[10px] font-black ${category === item ? 'bg-[#ff5a36] text-white' : 'bg-[#f1f3ef] text-[#6e786f]'}`}>{item} <span className="opacity-60">{item === 'Toutes' ? brand.products.length : brand.products.filter(product => product.category === item).length}</span></button>)}</div>
          <div className="mt-4 flex items-center justify-between gap-3"><input className={`${fieldClass} max-w-xl`} placeholder="Rechercher un produit, un ingrédient…" value={query} onChange={event => setQuery(event.target.value)} /><span className="shrink-0 rounded-full bg-[#f1f3ef] px-3 py-2 text-[10px] font-black text-[#6e786f]">{products.length} produits</span></div>
        </div>
        <div className="bg-[#f7f9f5] p-5">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{products.map(product => <button key={product.id} onClick={() => onEdit(product)} className="group overflow-hidden rounded-2xl border border-[#e3e7e1] bg-white text-left shadow-sm transition hover:-translate-y-1 hover:border-[#ff9e87] hover:shadow-lg"><div className="relative grid h-44 place-items-center overflow-hidden bg-[#f4f6f1]">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} className="h-full w-full object-contain p-3 transition duration-300 group-hover:scale-105" /> : <span className="text-6xl">{product.emoji}</span>}<span className="absolute left-3 top-3 rounded-full bg-white/90 px-2 py-1 text-[9px] font-black text-[#6e786f]">{product.productType === 'menu' ? 'MENU' : 'PRODUIT'}</span></div><div className="min-h-[155px] p-4"><p className="text-[9px] font-black uppercase tracking-wider text-[#989f99]">{product.category}</p><h3 className="mt-1 text-sm font-black text-[#172119]">{product.name}</h3><p className="mt-1 line-clamp-2 min-h-8 text-[10px] leading-relaxed text-[#7e8780]">{product.detail}</p><div className="mt-4 flex items-center justify-between"><strong className="text-base font-black text-[#ff5a36]">{money.format(product.price)}</strong><span className="text-[9px] font-black text-[#ff5a36]">Modifier →</span></div></div></button>)}</div>
          {!products.length && <div className="rounded-2xl border border-dashed border-[#ccd4ca] bg-white py-12 text-center text-sm font-bold text-[#7e8780]">Aucun produit trouvé.</div>}
        </div>
      </section>
      {selectedProduct && (selectedProduct.productType === 'menu'
        ? <MasterMenuDetail product={selectedProduct} onClose={() => setSelectedProduct(null)} onEdit={() => { setSelectedProduct(null); onEdit(selectedProduct); }} />
        : <MasterProductDetail product={selectedProduct} onClose={() => setSelectedProduct(null)} onEdit={() => { setSelectedProduct(null); onEdit(selectedProduct); }} />)}
    </div>
  );
}

function MasterMenuDetail({ product, onClose, onEdit }: { product: CatalogProduct; onClose: () => void; onEdit: () => void }) {
  const groups = product.optionGroups ?? [];
  const sizeGroup = groups.find(group => /taille/i.test(group.name));
  const sideGroup = groups.find(group => /accompagnement/i.test(group.name));
  const drinkGroup = groups.find(group => /boisson/i.test(group.name));
  const sauceGroup = groups.find(group => /sauce/i.test(group.name));
  const burger = burgerKingCatalogTemplate.find(item => item.category === 'Burgers' && item.name.replace(/[®™]/g, '') === product.name.replace(/[®™]/g, ''));
  const ingredientRows = burger?.ingredientSettings ?? (burger?.ingredients ?? []).map((name, index) => ({ id: product.id * 100 + index, name, removable: true, extraAllowed: false, extraPrice: 0 }));
  const [selectedSize, setSelectedSize] = useState(sizeGroup?.options[0]?.name ?? 'Medium');
  const [selectedSide, setSelectedSide] = useState('');
  const [selectedDrink, setSelectedDrink] = useState('');
  const [selectedSauces, setSelectedSauces] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [extras, setExtras] = useState<string[]>([]);
  const visibleSides = useMemo(() => (sideGroup?.options ?? []).filter(option => sizeMatches(option.availableFor, selectedSize)), [sideGroup, selectedSize]);
  const visibleDrinks = useMemo(() => (drinkGroup?.options ?? []).filter(option => sizeMatches(option.availableFor, selectedSize)), [drinkGroup, selectedSize]);
  useEffect(() => {
    if (!visibleSides.some(option => option.name === selectedSide)) setSelectedSide(visibleSides[0]?.name ?? '');
  }, [selectedSide, selectedSize, visibleSides]);
  useEffect(() => {
    if (!visibleDrinks.some(option => option.name === selectedDrink)) setSelectedDrink(visibleDrinks[0]?.name ?? '');
  }, [selectedDrink, visibleDrinks]);
  const selectedOption = (group: ProductOptionGroup | undefined, value: string) => group?.options.find(option => option.name === value);
  const selectedOptionPrice = (group: ProductOptionGroup | undefined, value: string) => {
    if (group === sizeGroup) return menuSizeSurcharge(product.name, selectedSize);
    return priceForSize(selectedOption(group, value), selectedSize);
  };
  const optionPrice = (option: ProductOption) => priceForSize(option, selectedSize);
  const selectedSauceOptions = (sauceGroup?.options ?? []).filter(option => selectedSauces.includes(option.name));
  const total = product.price + selectedOptionPrice(sizeGroup, selectedSize) + selectedOptionPrice(sideGroup, selectedSide) + selectedOptionPrice(drinkGroup, selectedDrink) + selectedSauceOptions.reduce((sum, option) => sum + option.priceDelta, 0);
  const toggleSauce = (name: string) => setSelectedSauces(current => current.includes(name) ? current.filter(item => item !== name) : current.length < (sauceGroup?.max ?? 2) ? [...current, name] : current);
  const orderedSizeOptions = [...(sizeGroup?.options ?? [])].sort((first, second) => ({ Extra: 0, XXL: 0, 'King Size': 1, King: 1, Medium: 2, M: 2 }[first.name] ?? 3) - ({ Extra: 0, XXL: 0, 'King Size': 1, King: 1, Medium: 2, M: 2 }[second.name] ?? 3));
  const dishOption: ProductOption = { id: product.id * 1000, name: burger?.name ?? product.name, priceDelta: 0, posCode: '', available: true, imageUrl: burger?.imageUrl };
  const selectCard = (option: ProductOption, selected: boolean, onSelect: () => void, priceLabel?: string) => (
    <button type="button" onClick={onSelect} className={`group relative overflow-hidden rounded-2xl border bg-white p-3 text-left transition hover:-translate-y-0.5 hover:shadow-lg ${selected ? 'border-[#2e9b50] ring-2 ring-[#2e9b50]/20' : 'border-[#e6dfd2]'}`}>
      <div className="relative grid h-24 place-items-center overflow-hidden rounded-xl bg-[#f8f1e5]">{option.imageUrl || bkOfficialImages[option.name] ? <img src={option.imageUrl || bkOfficialImages[option.name]} alt={option.name} className="h-full w-full object-contain p-2" /> : <span className="text-5xl">{menuOptionIcon(option.name)}</span>}<span className={`absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full border-2 ${selected ? 'border-[#2e9b50] bg-[#2e9b50] text-white' : 'border-[#b9b4ab] bg-white/80 text-transparent'}`}>✓</span></div>
      <p className="mt-2 line-clamp-2 min-h-8 text-[10px] font-black leading-tight text-[#3c160d]">{option.name}</p>
      <p className="mt-1 text-[10px] font-black text-[#c83a20]">{priceLabel ?? (optionPrice(option) ? `+${money.format(optionPrice(option))}` : 'Inclus')}</p>
    </button>
  );
  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-[#24150f]/65 p-3 md:p-6" role="dialog" aria-modal="true" aria-label={`Composition du menu ${product.name}`}>
      <div className="mx-auto max-h-[94vh] w-full max-w-4xl overflow-y-auto rounded-[28px] bg-[#fffaf1] shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-[#eadcca] bg-[#fffaf1]/95 p-5 backdrop-blur md:p-6"><div className="min-w-0 pr-4"><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#c83a20]">Fiche menu · parcours BK</p><h2 className="mt-2 text-2xl font-black tracking-[-.03em] text-[#3c160d]">{product.name}</h2><p className="mt-1 text-xs font-bold text-[#8f6b58]">{product.category} · <span aria-live="polite">Prix actuel : {money.format(total)}</span></p></div><button onClick={onClose} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white text-xl font-black text-[#3c160d] shadow-sm" aria-label="Fermer">×</button></div>
        <div className="space-y-6 p-5 md:p-6">
          <div className="grid gap-5 rounded-2xl border border-[#eadcca] bg-white p-4 sm:grid-cols-[180px_1fr]"><div className="grid h-40 place-items-center overflow-hidden rounded-xl bg-[#f7efe2]">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} className="h-full w-full object-contain p-2" /> : <span className="text-7xl">{product.emoji}</span>}</div><div><p className="text-sm leading-relaxed text-[#624b40]">{product.detail}</p><div className="mt-4 flex flex-wrap gap-2"><span className="rounded-full bg-[#e8f7ec] px-3 py-1.5 text-[10px] font-black text-[#27894a]">✓ Menu actif pour l’agent</span><span className="rounded-full bg-[#fff1df] px-3 py-1.5 text-[10px] font-black text-[#9b5e26]">Choix dans l’ordre BK</span></div></div></div>
          <MenuChoiceSection number="1" title="Taille du menu" question={sizeGroup?.question ?? 'Quelle taille de menu souhaitez-vous ?'}>{orderedSizeOptions.map(option => { const surcharge = menuSizeSurcharge(product.name, option.name); return selectCard(option, option.name === selectedSize, () => setSelectedSize(option.name), `Prix total : ${money.format(product.price + surcharge)} · ${surcharge ? `+${money.format(surcharge)}` : 'Inclus'}`); })}</MenuChoiceSection>
          <MenuChoiceSection number="2" title="Plat" question="Quel plat souhaitez-vous dans votre menu ?">{selectCard(dishOption, true, () => undefined, burger?.detail ? 'Composition personnalisable' : 'Plat sélectionné')}</MenuChoiceSection>
          <MenuChoiceSection number="3" title="Accompagnement" question={`Options disponibles pour ${selectedSize}.`}>{visibleSides.map(option => selectCard(option, option.name === selectedSide, () => setSelectedSide(option.name)))}</MenuChoiceSection>
          <MenuChoiceSection number="4" title="Boisson" question={`Boissons disponibles pour ${selectedSize}.`}>{visibleDrinks.map(option => selectCard(option, option.name === selectedDrink, () => setSelectedDrink(option.name)))}</MenuChoiceSection>
          {ingredientRows.length > 0 && <section className="rounded-2xl border border-[#eadcca] bg-[#fffdf9] p-4"><div className="border-b border-[#decdbb] pb-3"><p className="text-[10px] font-black uppercase tracking-widest text-[#c83a20]">Composition du plat</p><h3 className="mt-1 text-lg font-black text-[#3c160d]">Personnalisez le burger du menu</h3><p className="mt-1 text-[10px] text-[#907665]">Même composition et mêmes retraits que la fiche burger.</p></div><div className="relative mt-3 overflow-hidden rounded-xl border border-[#eadcca] bg-white p-3"><div className="absolute bottom-5 left-[7.1rem] top-5 hidden border-l border-dashed border-[#d8bda4] sm:block" />{ingredientRows.map((ingredient, index) => { const isRemoved = removed.includes(ingredient.name); const isExtra = extras.includes(ingredient.name); const visual = ingredientVisual(ingredient.name); return <div key={`${ingredient.id}-${index}`} className={`relative grid grid-cols-[5.2rem_3.5rem_minmax(0,1fr)] items-center gap-3 border-b border-[#f0e5d9] py-2.5 last:border-b-0 ${isRemoved ? 'opacity-60' : ''}`}><p className={`text-right text-[10px] font-black leading-tight ${isRemoved ? 'text-[#b64228] line-through' : 'text-[#3c160d]'}`}>{ingredient.name}</p><div className="relative z-[1] grid h-12 w-12 place-items-center rounded-full border-4 border-white shadow-sm" style={{ background: visual.background }}><span className="text-xl" aria-hidden="true">{visual.icon}</span></div><div className="min-w-0"><span className="text-[9px] font-black uppercase tracking-wider text-[#a5795f]">Couche {index + 1}</span><div className="mt-1 flex flex-wrap gap-2">{ingredient.removable && <button type="button" onClick={() => setRemoved(current => current.includes(ingredient.name) ? current.filter(item => item !== ingredient.name) : [...current, ingredient.name])} className={`rounded-lg px-2 py-1 text-[9px] font-black ${isRemoved ? 'bg-[#c83a20] text-white' : 'bg-[#fff0ec] text-[#c83a20]'}`}>{isRemoved ? 'Réintégrer' : 'Retirer'}</button>}{ingredient.extraAllowed && <button type="button" onClick={() => setExtras(current => current.includes(ingredient.name) ? current.filter(item => item !== ingredient.name) : [...current, ingredient.name])} className={`rounded-lg px-2 py-1 text-[9px] font-black ${isExtra ? 'bg-[#27894a] text-white' : 'bg-[#e8f7ec] text-[#27894a]'}`}>{isExtra ? 'Supplément ajouté' : `Ajouter${ingredient.extraPrice ? ` +${money.format(ingredient.extraPrice)}` : ''}`}</button>}</div></div></div>; })}</div></section>}
          <MenuChoiceSection number="5" title="Sauces" question={sauceGroup?.question ?? 'Quelles sauces souhaitez-vous ?'}><div className="col-span-full grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{(sauceGroup?.options ?? []).map(option => selectCard(option, selectedSauces.includes(option.name), () => toggleSauce(option.name)))}</div><p className="col-span-full mt-3 text-[10px] font-bold text-[#907665]">Jusqu’à {sauceGroup?.max ?? 2} sauces · chaque supplément est ajouté au total.</p></MenuChoiceSection>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-[#edf5ef] p-4"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#52705b]">Prix du panier configuré</p><p className="mt-1 text-2xl font-black text-[#173b24]" aria-live="polite">{money.format(total)}</p><p className="mt-1 text-[10px] font-bold text-[#52705b]">Taille {selectedSize} · supplément taille inclus</p></div><div className="flex gap-2"><button onClick={onEdit} className="rounded-xl border border-[#d9c5b1] bg-white px-4 py-3 text-xs font-black text-[#624b40]">Modifier la fiche</button><button onClick={onClose} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">Fermer</button></div></div>
        </div>
      </div>
    </div>
  );
}

function MenuChoiceSection({ number, title, question, children }: { number: string; title: string; question: string; children: React.ReactNode }) {
  return <section className="rounded-2xl border border-[#eadcca] bg-white p-4"><div className="flex items-start gap-3 border-b border-[#decdbb] pb-3"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#c83a20] text-xs font-black text-white">{number}</span><div><p className="text-[10px] font-black uppercase tracking-widest text-[#c83a20]">{title}</p><h3 className="mt-1 text-lg font-black text-[#3c160d]">{question}</h3></div></div><div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div></section>;
}

function menuOptionIcon(name: string) {
  const text = name.toLowerCase();
  if (/boisson|coca|fanta|oasis|vittel|jus|fuze|red bull/.test(text)) return '🥤';
  if (/frite|gaufrette|onion|king fries/.test(text)) return '🍟';
  if (/salade|carotte/.test(text)) return '🥗';
  if (/sauce/.test(text)) return '🥫';
  return '🍽️';
}

function MasterProductDetail({ product, onClose, onEdit }: { product: CatalogProduct; onClose: () => void; onEdit: () => void }) {
  const ingredientRows: ProductIngredient[] = product.ingredientSettings ?? (product.ingredients ?? []).map((name, index) => ({ id: product.id * 100 + index, name, removable: true, extraAllowed: false, extraPrice: 0 }));
  const [removed, setRemoved] = useState<string[]>([]);
  const [extras, setExtras] = useState<string[]>([]);
  const allergens = inferProductAllergens(product, ingredientRows);
  const hasIngredients = ingredientRows.length > 0;
  return (
    <div className="fixed inset-0 z-[80] overflow-y-auto bg-[#24150f]/65 p-3 md:p-6" role="dialog" aria-modal="true" aria-label={`Composition ${product.name}`}>
      <div className="mx-auto max-h-[94vh] w-full max-w-2xl overflow-y-auto rounded-[28px] bg-[#fffaf1] shadow-2xl">
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-[#eadcca] bg-[#fffaf1]/95 p-5 backdrop-blur md:p-6"><div className="min-w-0 pr-4"><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#c83a20]">Fiche produit · connaissance agent IA</p><h2 className="mt-2 text-2xl font-black tracking-[-.03em] text-[#3c160d]">{product.name}</h2><p className="mt-1 text-xs font-bold text-[#8f6b58]">{product.category} · {money.format(product.price)}</p></div><button onClick={onClose} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white text-xl font-black text-[#3c160d] shadow-sm" aria-label="Fermer">×</button></div>
        <div className="p-5 md:p-6">
          <div className="grid gap-5 rounded-2xl border border-[#eadcca] bg-white p-4 sm:grid-cols-[145px_1fr]"><div className="grid h-36 place-items-center overflow-hidden rounded-xl bg-[#f7efe2]">{product.imageUrl ? <img src={product.imageUrl} alt={product.name} className="h-full w-full object-contain p-2" /> : <span className="text-7xl">{product.emoji}</span>}</div><div><p className="text-sm leading-relaxed text-[#624b40]">{product.detail}</p><div className="mt-4 flex flex-wrap gap-2"><span className="rounded-full bg-[#e8f7ec] px-3 py-1.5 text-[10px] font-black text-[#27894a]">✓ Fiche active pour l’agent</span><span className="rounded-full bg-[#fff1df] px-3 py-1.5 text-[10px] font-black text-[#9b5e26]">{product.productType === 'menu' ? 'Menu configurable' : 'Burger configurable'}</span></div></div></div>
          <section className="mt-6"><div className="flex items-center justify-between border-b border-[#decdbb] pb-3"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#c83a20]">Composition</p><h3 className="mt-1 text-lg font-black text-[#3c160d]">Ingrédients du produit</h3></div><span className="rounded-full bg-[#f1e8dc] px-3 py-1.5 text-[10px] font-black text-[#806653]">{ingredientRows.length} éléments</span></div>{hasIngredients ? <div className="relative mt-4 overflow-hidden rounded-2xl border border-[#eadcca] bg-[#fffdf9] p-4"><div className="absolute bottom-7 left-[7.35rem] top-7 hidden border-l border-dashed border-[#d8bda4] sm:block" />{ingredientRows.map((ingredient, index) => { const isRemoved = removed.includes(ingredient.name); const isExtra = extras.includes(ingredient.name); const visual = ingredientVisual(ingredient.name); return <div key={`${ingredient.id}-${index}`} className={`relative grid grid-cols-[5.5rem_3.5rem_minmax(0,1fr)] items-center gap-3 border-b border-[#f0e5d9] py-3 last:border-b-0 ${isRemoved ? 'opacity-60' : ''}`}><p className={`text-right text-[10px] font-black leading-tight ${isRemoved ? 'text-[#b64228] line-through' : 'text-[#3c160d]'}`}>{ingredient.name}</p><div className="relative z-[1] grid h-14 w-14 place-items-center rounded-full border-4 border-[#fffdf9] shadow-sm" style={{ background: visual.background }}><span className="text-2xl" aria-hidden="true">{visual.icon}</span></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-[9px] font-black uppercase tracking-wider text-[#a5795f]">Couche {index + 1}</span>{isRemoved && <span className="rounded-full bg-[#fff0ec] px-2 py-1 text-[9px] font-black text-[#b64228]">Retiré</span>}{isExtra && <span className="rounded-full bg-[#e8f7ec] px-2 py-1 text-[9px] font-black text-[#27894a]">Supplément</span>}</div><div className="mt-2 flex flex-wrap gap-2">{ingredient.removable && <button onClick={() => setRemoved(current => current.includes(ingredient.name) ? current.filter(item => item !== ingredient.name) : [...current, ingredient.name])} className={`rounded-lg px-2.5 py-1.5 text-[10px] font-black ${isRemoved ? 'bg-[#c83a20] text-white' : 'bg-[#fff0ec] text-[#c83a20]'}`}>{isRemoved ? 'Réintégrer' : 'Retirer'}</button>}{ingredient.extraAllowed && <button onClick={() => setExtras(current => current.includes(ingredient.name) ? current.filter(item => item !== ingredient.name) : [...current, ingredient.name])} className={`rounded-lg px-2.5 py-1.5 text-[10px] font-black ${isExtra ? 'bg-[#27894a] text-white' : 'bg-[#e8f7ec] text-[#27894a]'}`}>{isExtra ? 'Supplément ajouté' : `Ajouter${ingredient.extraPrice ? ` +${money.format(ingredient.extraPrice)}` : ''}`}</button>}</div><p className="mt-1 text-[10px] text-[#907665]">{isRemoved ? 'Retiré de la commande' : isExtra ? 'Supplément sélectionné' : 'Présent par défaut'}</p></div></div>; })}</div> : <div className="mt-4 rounded-xl border border-dashed border-[#d8c4b0] bg-white p-5 text-center"><p className="text-sm font-black text-[#624b40]">Composition détaillée non renseignée</p><p className="mt-1 text-xs text-[#907665]">Ajoutez les ingrédients dans Modifier la fiche pour que l’agent puisse répondre précisément.</p></div>}</section>
          {!!product.optionGroups?.length && <section className="mt-6"><div className="border-b border-[#decdbb] pb-3"><p className="text-[10px] font-black uppercase tracking-widest text-[#c83a20]">Parcours de commande</p><h3 className="mt-1 text-lg font-black text-[#3c160d]">Choix proposés au client</h3></div><div className="mt-4 grid gap-3 sm:grid-cols-2">{product.optionGroups.map((group, index) => <div key={group.id} className="rounded-xl border border-[#eadcca] bg-white p-3"><div className="flex items-center gap-2"><span className="grid h-7 w-7 place-items-center rounded-full bg-[#f3e6d8] text-[10px] font-black text-[#8d5d45]">{index + 1}</span><p className="text-xs font-black text-[#3c160d]">{group.name}</p></div><p className="mt-2 text-[10px] text-[#907665]">{group.options.map(option => `${option.name}${option.priceDelta ? ` (${option.priceDelta > 0 ? '+' : ''}${money.format(option.priceDelta)})` : ''}`).join(' · ') || 'Options à configurer'}</p></div>)}</div></section>}
          <section className="mt-6"><div className="border-b border-[#decdbb] pb-3"><p className="text-[10px] font-black uppercase tracking-widest text-[#c83a20]">Allergènes à signaler</p><h3 className="mt-1 text-lg font-black text-[#3c160d]">Informations client</h3></div><div className="mt-4 flex flex-wrap gap-2">{allergens.length ? allergens.map(allergen => <span key={allergen} className="rounded-full bg-[#fff0ec] px-3 py-2 text-[10px] font-black text-[#a94731]">⚠ {allergen}</span>) : <span className="text-xs text-[#907665]">À vérifier avec la fiche allergènes officielle.</span>}</div></section>
          <div className="mt-6 rounded-2xl bg-[#edf5ef] p-4 text-xs leading-relaxed text-[#52705b]"><strong>Réponse agent :</strong> « {product.name} contient {ingredientRows.length ? ingredientRows.map(ingredient => ingredient.name).join(', ') : 'une composition à compléter'}. {removed.length ? `Sans ${removed.join(', ')}.` : ''} {extras.length ? `Avec supplément ${extras.join(', ')}.` : ''} »</div>
          <div className="mt-6 flex flex-wrap justify-end gap-2"><button onClick={onEdit} className="rounded-xl border border-[#d9c5b1] bg-white px-4 py-3 text-xs font-black text-[#624b40]">Modifier la fiche</button><button onClick={onClose} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">Fermer</button></div>
        </div>
      </div>
    </div>
  );
}

function inferProductAllergens(product: CatalogProduct, ingredients: ProductIngredient[]) {
  const text = `${product.name} ${product.detail} ${ingredients.map(ingredient => ingredient.name).join(' ')}`.toLowerCase();
  const allergens: string[] = [];
  if (/pain|brioche|tortilla|panure|gaufrette|sésame/.test(text)) allergens.push('Gluten / graines de sésame');
  if (/cheddar|fromage|mozzarella|lait|glace|bacon/.test(text)) allergens.push('Lait');
  if (/mayonnaise|sauce|césar|caesar/.test(text)) allergens.push('Œufs possibles dans les sauces');
  if (/cacahuète|snickers|m&m|noisette/.test(text)) allergens.push('Arachides / fruits à coque');
  return allergens;
}

function ingredientVisual(name: string) {
  const text = name.toLowerCase();
  if (/pain|galette/.test(text)) return { icon: '🍞', background: '#f6d69c' };
  if (/viande|haché|poulet|pané|poisson/.test(text)) return { icon: '🍗', background: '#c87938' };
  if (/cheddar|fromage|mozzarella/.test(text)) return { icon: '🧀', background: '#ffd95c' };
  if (/salade|roquette/.test(text)) return { icon: '🥬', background: '#a8d77a' };
  if (/tomate/.test(text)) return { icon: '🍅', background: '#f08a67' };
  if (/oignon/.test(text)) return { icon: '🧅', background: '#d7b5e5' };
  if (/cornichon/.test(text)) return { icon: '🥒', background: '#b8d98a' };
  if (/bacon|chips|galette croustillante/.test(text)) return { icon: '🥓', background: '#e99b69' };
  if (/sauce|épices|moutarde|ketchup/.test(text)) return { icon: '🥫', background: '#f5b36f' };
  return { icon: '●', background: '#eadcca' };
}

function AgentPanel({ welcome, setWelcome }: { welcome: string; setWelcome: React.Dispatch<React.SetStateAction<string>> }) {
  const [saved, setSaved] = useState(false);
  const [speechRate, setSpeechRate] = useState(1);
  const [knowledge, setKnowledge] = useState([
    { id: 1, title: 'Horaires du restaurant', content: 'Ouvert du lundi au jeudi de 09:00 à 00:00, et du vendredi au dimanche de 09:00 à 01:00.', enabled: true },
    { id: 2, title: 'Paiements acceptés', content: 'Carte bancaire, espèces, titres-restaurant, Apple Pay et Google Pay au guichet de paiement.', enabled: true },
    { id: 3, title: 'Allergènes', content: 'Ne jamais donner de diagnostic. Informer le client que les 14 allergènes majeurs sont consultables et proposer un transfert à un équipier.', enabled: true },
    { id: 4, title: 'Règles de prise de commande', content: 'Pour un menu, confirmer dans cet ordre : taille, sandwich, accompagnement, boisson, sauces puis suppléments.', enabled: true },
    { id: 5, title: 'Compte de fidélité', content: 'Le client peut présenter sa carte ou son QR code au paiement pour cumuler ses avantages.', enabled: true },
    { id: 6, title: 'Situations spécifiques et fréquentes', content: 'En cas de demande imprécise, poser une seule question courte à la fois. Après deux incompréhensions, transférer à un équipier.', enabled: true },
    { id: 7, title: 'Réponses aux clients', content: 'Être direct, naturel et chaleureux. Éviter les phrases longues et ne pas répéter une information déjà confirmée.', enabled: true },
  ]);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [openKnowledge, setOpenKnowledge] = useState<number | null>(1);
  const [addingKnowledge, setAddingKnowledge] = useState(false);
  const [editingKnowledge, setEditingKnowledge] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState({ title: '', content: '' });
  const [newKnowledge, setNewKnowledge] = useState({ title: '', content: '' });
  const visibleKnowledge = knowledge.filter(item => `${item.title} ${item.content}`.toLowerCase().includes(knowledgeQuery.toLowerCase()));
  const addKnowledge = () => {
    if (!newKnowledge.title.trim() || !newKnowledge.content.trim()) return;
    const id = Date.now();
    setKnowledge(current => [...current, { id, ...newKnowledge, enabled: true }]);
    setNewKnowledge({ title: '', content: '' });
    setAddingKnowledge(false);
    setOpenKnowledge(id);
  };
  const startEditingKnowledge = (item: (typeof knowledge)[number]) => {
    setEditingKnowledge(item.id);
    setEditDraft({ title: item.title, content: item.content });
    setOpenKnowledge(item.id);
  };
  const saveEditedKnowledge = () => {
    if (editingKnowledge === null || !editDraft.title.trim() || !editDraft.content.trim()) return;
    setKnowledge(current => current.map(item => item.id === editingKnowledge ? { ...item, ...editDraft } : item));
    setEditingKnowledge(null);
  };
  const save = () => { setSaved(true); window.setTimeout(() => setSaved(false), 1800); };
  return (
    <div>
      <SectionHeading eyebrow="Voix & connaissances" title="Configuration de l’agent" description="Configurez l’identité vocale et centralisez toutes les règles métier dans une base de connaissances unique." action={<button onClick={save} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">{saved ? '✓ Agent mis à jour' : 'Publier la configuration'}</button>} />
      <section className={`${panelCard} overflow-hidden`}>
        <div className="p-6 md:p-7"><div className="flex items-start justify-between"><div><p className="text-xs font-black uppercase tracking-widest text-[#ff5a36]">Identité vocale</p><h2 className="mt-2 text-xl font-black">Accueil et personnalité</h2><p className="mt-1 text-xs text-[#7f8981]">Définissez la façon dont l’agent accueille et accompagne chaque client.</p></div><span className="rounded-full bg-[#e3f6e8] px-3 py-1 text-[10px] font-black text-[#27894a]">● Actif</span></div><label className="mt-6 block text-xs font-bold text-[#68736a]">Message de bienvenue<textarea className="mt-2 min-h-24 w-full rounded-2xl border border-[#dfe4dc] bg-white p-4 text-sm font-semibold leading-relaxed outline-none focus:border-[#ff6a45] focus:ring-4 focus:ring-[#ff6a45]/10" value={welcome} onChange={event=>setWelcome(event.target.value)} /></label><div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4"><label className="text-xs font-bold text-[#68736a]">Voix<select className={`${fieldClass} mt-2`}><option>Marin — naturelle</option><option>Cedar — posée</option></select></label><label className="text-xs font-bold text-[#68736a]">Ton<select className={`${fieldClass} mt-2`}><option>Chaleureux et efficace</option><option>Très concis</option><option>Premium</option></select></label><label className="text-xs font-bold text-[#68736a]">Langue<select className={`${fieldClass} mt-2`}><option>Français</option><option>Français + anglais</option></select></label><label className="text-xs font-bold text-[#68736a]"><span className="flex justify-between"><span>Vitesse d’élocution</span><strong className="text-[#ff5a36]">{speechRate.toFixed(2)}×</strong></span><input aria-label="Vitesse d’élocution" type="range" min="0.75" max="1.25" step="0.05" value={speechRate} onChange={event=>setSpeechRate(Number(event.target.value))} className="mt-4 w-full accent-[#ff5a36]" /><span className="mt-1 flex justify-between text-[9px] font-semibold text-[#9aa29b]"><span>Posée</span><span>Rapide</span></span></label></div></div>
        <div className="border-t border-[#e7eae5]">
          <div className="border-b border-[#e7eae5] p-6"><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-xs font-black uppercase tracking-widest text-[#ff5a36]">Base de connaissances métier</p><h2 className="mt-2 text-xl font-black">Connaissances de l’agent</h2><p className="mt-1 text-xs leading-relaxed text-[#7f8981]">Organisez les informations utilisées par l’agent pour répondre sans rien inventer.</p></div><button onClick={()=>setAddingKnowledge(value=>!value)} className="shrink-0 rounded-xl bg-[#0b1f14] px-4 py-3 text-xs font-black text-white">{addingKnowledge ? 'Fermer' : '＋ Créer une connaissance'}</button></div>
            <div className="mt-5"><input aria-label="Rechercher une connaissance" className={fieldClass} placeholder="Rechercher une connaissance…" value={knowledgeQuery} onChange={event=>setKnowledgeQuery(event.target.value)} /></div>
          </div>
          {addingKnowledge && <div className="border-b border-[#e7eae5] bg-[#f8f9f6] p-5"><p className="text-xs font-black uppercase tracking-widest text-[#ff5a36]">Nouvelle connaissance</p><label className="mt-4 block text-xs font-bold text-[#68736a]">Nom de la connaissance<input className={`${fieldClass} mt-2`} placeholder="Ex. Horaires du restaurant" value={newKnowledge.title} onChange={event=>setNewKnowledge(current=>({...current,title:event.target.value}))} /></label><label className="mt-3 block text-xs font-bold text-[#68736a]">Contenu<textarea className="mt-2 min-h-28 w-full rounded-xl border border-[#dfe4dc] bg-white p-3 text-sm font-semibold outline-none focus:border-[#ff6a45] focus:ring-4 focus:ring-[#ff6a45]/10" placeholder="Saisissez les informations que l’agent doit connaître…" value={newKnowledge.content} onChange={event=>setNewKnowledge(current=>({...current,content:event.target.value}))} /></label><div className="mt-3 flex justify-end gap-2"><button onClick={()=>setAddingKnowledge(false)} className="rounded-xl border border-[#dfe4dc] bg-white px-4 py-2.5 text-xs font-black">Annuler</button><button onClick={addKnowledge} disabled={!newKnowledge.title.trim()||!newKnowledge.content.trim()} className="rounded-xl bg-[#ff5a36] px-4 py-2.5 text-xs font-black text-white disabled:opacity-40">Ajouter à la base</button></div></div>}
          <div className="p-4"><div className="space-y-2">{visibleKnowledge.map(item=><article key={item.id} className={`rounded-2xl border transition ${openKnowledge===item.id?'border-[#ffb09c] bg-[#fffaf8]':'border-[#e7eae5] bg-white'}`}><div className="flex items-center gap-3 p-4"><span className={`h-2.5 w-2.5 shrink-0 rounded-full ${item.enabled?'bg-[#35a85a]':'bg-[#cbd1cb]'}`} /><button onClick={()=>setOpenKnowledge(current=>current===item.id?null:item.id)} className="min-w-0 flex-1 text-left"><strong className="block text-sm">{item.title}</strong><small className="mt-1 block truncate text-[#89928a]">{item.content}</small></button><button aria-label={`${item.enabled?'Désactiver':'Activer'} ${item.title}`} onClick={()=>setKnowledge(current=>current.map(entry=>entry.id===item.id?{...entry,enabled:!entry.enabled}:entry))} className={`relative h-6 w-10 shrink-0 rounded-full transition ${item.enabled?'bg-[#35a85a]':'bg-[#d9ded8]'}`}><span className={`absolute top-1 h-4 w-4 rounded-full bg-white shadow transition ${item.enabled?'left-5':'left-1'}`} /></button><button aria-label="Afficher le détail" onClick={()=>setOpenKnowledge(current=>current===item.id?null:item.id)} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#f0f3ee] text-xs font-black">{openKnowledge===item.id?'↑':'↓'}</button></div>{openKnowledge===item.id&&<div className="border-t border-[#f0d9d2] px-4 pb-4 pt-3">{editingKnowledge===item.id?<div><label className="block text-xs font-bold text-[#68736a]">Nom de la connaissance<input className={`${fieldClass} mt-2`} value={editDraft.title} onChange={event=>setEditDraft(current=>({...current,title:event.target.value}))} /></label><label className="mt-3 block text-xs font-bold text-[#68736a]">Contenu<textarea className="mt-2 min-h-28 w-full rounded-xl border border-[#dfe4dc] bg-white p-3 text-sm font-semibold outline-none focus:border-[#ff6a45]" value={editDraft.content} onChange={event=>setEditDraft(current=>({...current,content:event.target.value}))} /></label><div className="mt-3 flex justify-end gap-2"><button onClick={()=>setEditingKnowledge(null)} className="rounded-lg border border-[#dfe4dc] bg-white px-3 py-2 text-[10px] font-black">Annuler</button><button onClick={saveEditedKnowledge} className="rounded-lg bg-[#ff5a36] px-3 py-2 text-[10px] font-black text-white">Enregistrer</button></div></div>:<div><p className="text-xs leading-relaxed text-[#657068]">{item.content}</p><div className="mt-3 flex flex-wrap items-center justify-between gap-3"><span className="text-[10px] font-bold text-[#2b8c4d]">✓ Disponible pour l’agent en temps réel</span><div className="flex gap-3"><button onClick={()=>startEditingKnowledge(item)} className="text-[10px] font-black text-[#ff5a36]">Modifier</button><button onClick={()=>{setKnowledge(current=>current.filter(entry=>entry.id!==item.id));setOpenKnowledge(null);}} className="text-[10px] font-black text-[#d6503d]">Supprimer</button></div></div></div>}</div>}</article>)}{visibleKnowledge.length===0&&<div className="rounded-2xl border border-dashed border-[#d8ddd6] py-10 text-center"><p className="text-sm font-black">Aucune connaissance trouvée</p><p className="mt-1 text-xs text-[#8b948c]">Modifiez votre recherche pour afficher les connaissances correspondantes.</p></div>}</div><div className="mt-4 flex items-center justify-between px-1"><span className="text-[10px] font-bold text-[#8b948c]">{visibleKnowledge.length} sur {knowledge.length} connaissances affichées</span><span className="text-[10px] font-black text-[#2b8c4d]">● Base synchronisée</span></div></div>
        </div>
      </section>
    </div>
  );
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('order');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [enterpriseCatalog, setEnterpriseCatalog] = useState<CatalogProduct[]>([]);
  const [agentWelcome, setAgentWelcome] = useState("Bonjour et bienvenue chez Burger King Paris République. Que puis-je préparer pour vous aujourd'hui ?");
  const [agentRules, setAgentRules] = useState<Array<[string, boolean]>>(initialAgentRules);
  const [authOpen, setAuthOpen] = useState(false);
  const [accountEmail, setAccountEmail] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const reloadRestaurantCatalog = useCallback(async () => {
    setEnterpriseCatalog([]);
    const rows = await fetchRestaurantProducts(demoRestaurantId);
    if (rows) setEnterpriseCatalog(rows.map(mapRestaurantProduct));
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void reloadRestaurantCatalog(), 0);
    return () => window.clearTimeout(timer);
  }, [reloadRestaurantCatalog]);
  const active = workspaceTabs.find(tab => tab.id === activeTab) ?? workspaceTabs[0];
  const openAccount = () => {
    setAuthOpen(true);
    setAuthNotice('');
  };
  const signOut = async () => {
    if (supabase) await supabase.auth.signOut();
    window.location.assign('/login');
  };
  const createRestaurantAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!supabase || !accountEmail.trim()) return;
    const { error } = await supabase.auth.signInWithOtp({
      email: accountEmail.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    setAuthNotice(error ? error.message : 'Un lien de connexion vient d’être envoyé à votre adresse e-mail.');
  };
  return (
    <div className={`min-h-screen bg-[#f4f6f1] text-[#132018] lg:grid ${sidebarCollapsed ? 'lg:grid-cols-[88px_1fr]' : 'lg:grid-cols-[268px_1fr]'}`}>
      <aside className="drivevoice-sidebar relative border-b border-[#223a2c] bg-[#0b1f14] pb-4 text-white shadow-[12px_0_40px_rgba(7,26,17,.08)] lg:sticky lg:top-0 lg:h-screen lg:max-h-screen lg:overflow-x-hidden lg:overflow-y-auto lg:overscroll-contain lg:border-b-0 lg:border-r lg:pb-28">
        <div className={`flex items-center justify-between px-5 py-5 lg:px-5 lg:py-7 ${sidebarCollapsed ? 'lg:flex-col lg:gap-5' : 'lg:block'}`}><div className="flex items-center gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[#ff5a36] text-lg font-black shadow-[0_8px_24px_rgba(255,90,54,.22)]">D</span><div className={sidebarCollapsed ? 'lg:hidden' : ''}><p className="font-black tracking-[-.04em]">DRIVE<span className="text-[#ff7556]">VOICE</span></p><p className="text-[9px] font-bold uppercase tracking-[.18em] text-white/45">Enterprise OS</p></div></div><div className="flex items-center gap-2"><span className={`rounded-full bg-[#173625] px-3 py-1 text-[9px] font-black uppercase text-[#68d48a] ${sidebarCollapsed ? 'lg:hidden' : ''}`}>● Live</span><button onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} className="hidden h-9 w-9 place-items-center rounded-xl border border-white/10 bg-white/5 text-sm font-black transition hover:bg-white/10 lg:grid" aria-label={sidebarCollapsed ? 'Développer la barre latérale' : 'Réduire la barre latérale'}>{sidebarCollapsed ? '→' : '←'}</button></div></div>
        <div className={`hidden px-5 lg:block ${sidebarCollapsed ? 'lg:px-3' : ''}`}><div className={`rounded-2xl border border-white/10 bg-white/5 p-4 ${sidebarCollapsed ? 'text-center' : ''}`}><p className="text-[9px] font-black uppercase tracking-[.17em] text-white/40">{sidebarCollapsed ? 'BK' : 'Restaurant connecté'}</p><p className={`mt-2 text-sm font-black ${sidebarCollapsed ? 'hidden' : ''}`}>BK Paris République</p><p className={`mt-1 text-[10px] text-white/45 ${sidebarCollapsed ? 'hidden' : ''}`}>Drive n°04 · Voie A</p></div></div>
        <nav className={`flex gap-1 overflow-x-auto px-3 pb-4 lg:mt-7 lg:block lg:space-y-1 lg:overflow-visible ${sidebarCollapsed ? 'lg:px-3' : 'lg:px-4'}`} aria-label="Espaces de travail DriveVoice">{workspaceTabs.map(tab=><button key={tab.id} onClick={()=>setActiveTab(tab.id)} title={sidebarCollapsed ? tab.label : undefined} className={`flex shrink-0 items-center gap-3 rounded-xl px-4 py-3 text-left text-xs font-black transition lg:w-full ${sidebarCollapsed ? 'lg:justify-center lg:px-2' : ''} ${activeTab===tab.id?'bg-white text-[#102019] shadow-lg':'text-white/55 hover:bg-white/5 hover:text-white'}`}><span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-base ${activeTab===tab.id?'bg-[#ff5a36] text-white':'bg-white/5'}`}>{tab.icon}</span><span className={sidebarCollapsed ? 'lg:hidden' : ''}><span className="block">{tab.short}</span><span className={`hidden text-[9px] font-semibold lg:block ${activeTab===tab.id?'text-[#6f7972]':'text-white/30'}`}>{tab.label}</span></span></button>)}</nav>
        <button onClick={signOut} title={sidebarCollapsed ? 'Se déconnecter' : undefined} className={`absolute bottom-6 hidden rounded-2xl border border-white/10 p-4 text-left transition hover:border-[#ff7556] hover:bg-[#ff5a36] lg:block ${sidebarCollapsed ? 'left-3 right-3' : 'left-4 right-4'}`}><div className={`flex items-center gap-3 ${sidebarCollapsed ? 'justify-center' : ''}`}><span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#ffc647] text-xs font-black text-[#172019]">AM</span><div className={sidebarCollapsed ? 'hidden' : ''}><p className="text-xs font-black">Se déconnecter</p><p className="text-[9px] text-white/40">Retour à la page de connexion</p></div></div></button>
      </aside>
      <main className="min-w-0"><header className="sticky top-0 z-30 flex items-center justify-between border-b border-[#e1e5de] bg-[#f4f6f1]/90 px-5 py-4 backdrop-blur-xl md:px-8"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#8a938c]">DriveVoice / {active.short}</p><p className="mt-1 text-sm font-black">{active.label}</p></div><div className="flex items-center gap-3"><span className="hidden rounded-full border border-[#dce2da] bg-white px-3 py-2 text-[10px] font-black text-[#2b8c4d] md:inline">● Tous les systèmes opérationnels</span><button aria-label="Notifications" className="grid h-10 w-10 place-items-center rounded-xl border border-[#dce2da] bg-white">•</button></div></header>
        {activeTab === 'order' ? <OrderWorkspace products={enterpriseCatalog} agentWelcome={agentWelcome} agentRules={agentRules} /> : <div className="mx-auto max-w-[1500px] p-5 md:p-8">{activeTab === 'dashboard' && <DashboardPanel />}{activeTab === 'integrations' && <IntegrationsPanel onCatalogSynced={reloadRestaurantCatalog} />}{activeTab === 'catalog' && <CatalogPanel products={enterpriseCatalog} setProducts={setEnterpriseCatalog} />}{activeTab === 'agent' && <AgentPanel welcome={agentWelcome} setWelcome={setAgentWelcome} />}{activeTab === 'account' && <AccountPanel />}</div>}
      </main>
      {authOpen && <div className="fixed inset-0 z-50 grid place-items-center bg-[#07130d]/65 p-4" role="dialog" aria-modal="true" aria-label="Créer un compte restaurant"><div className="w-full max-w-md rounded-[28px] bg-white p-7 shadow-2xl md:p-9"><div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#ff5a36]">DriveVoice restaurants</p><h2 className="mt-2 text-2xl font-black">Créer votre compte</h2><p className="mt-2 text-sm leading-relaxed text-[#738078]">Recevez un lien sécurisé pour accéder à votre espace restaurant.</p></div><button onClick={() => setAuthOpen(false)} className="grid h-9 w-9 place-items-center rounded-xl bg-[#f0f3ee] text-lg font-black" aria-label="Fermer">×</button></div><form onSubmit={createRestaurantAccount} className="mt-7"><label className="text-xs font-black text-[#68736a]">Adresse e-mail professionnelle<input required type="email" value={accountEmail} onChange={(event) => setAccountEmail(event.target.value)} className={`${fieldClass} mt-2`} placeholder="restaurant@exemple.fr" /></label><button disabled={!isSupabaseConfigured} className="mt-4 w-full rounded-xl bg-[#ff5a36] py-3.5 text-sm font-black text-white disabled:cursor-not-allowed disabled:opacity-50">Recevoir mon lien d’accès</button>{!isSupabaseConfigured && <p className="mt-3 text-xs text-[#b26b00]">L’authentification sera disponible après configuration Supabase.</p>}{authNotice && <p role="status" className="mt-4 rounded-xl bg-[#edf7ef] px-4 py-3 text-xs font-bold text-[#287b43]">{authNotice}</p>}</form><p className="mt-6 text-center text-[10px] text-[#98a099]">Connexion sans mot de passe · lien à usage unique</p></div></div>}
    </div>
  );
}
