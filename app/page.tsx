'use client';

import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

type ProductId = string;
type OrderItem = { id: number; productId: ProductId; name: string; detail: string; price: number; emoji: string };
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';
type RealtimeEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  text?: string;
  name?: string;
  arguments?: string;
  call_id?: string;
  error?: { message?: string };
  item?: {
    type?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
    content?: Array<{ type?: string; transcript?: string; text?: string }>;
  };
};

const brands = [
  { name: 'Burger King', mark: 'BK', color: '#e32725', ink: '#fff' },
  { name: "McDonald's", mark: 'M', color: '#ffcc00', ink: '#1d1d1b' },
  { name: 'Quick', mark: 'Q', color: '#e31c3d', ink: '#fff' },
  { name: 'KFC', mark: 'K', color: '#e4002b', ink: '#fff' },
];

const money = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' });

function OrderWorkspace({ products, agentWelcome, agentRules }: { products: CatalogProduct[]; agentWelcome: string; agentRules: Array<[string, boolean]> }) {
  const [brand, setBrand] = useState(brands[0]);
  const [started, setStarted] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [customerText, setCustomerText] = useState('');
  const [voiceInput, setVoiceInput] = useState('');
  const [voiceError, setVoiceError] = useState('');
  const [agentText, setAgentText] = useState('Bonjour ! Je suis prêt à prendre votre commande.');
  const [items, setItems] = useState<OrderItem[]>([]);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const outputTranscriptRef = useRef('');
  const handledCallsRef = useRef(new Set<string>());
  const microphoneReadyRef = useRef(false);
  const nextId = useRef(1);

  const total = useMemo(() => items.reduce((sum, item) => sum + item.price, 0), [items]);

  const sendEvent = (event: object) => {
    const channel = dataChannelRef.current;
    if (channel?.readyState !== 'open') return false;
    channel.send(JSON.stringify(event));
    return true;
  };

  const cleanupSession = () => {
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
    setListening(false);
    setSpeaking(false);
  };

  const sendTextToAgent = (text: string) => {
    const message = text.trim();
    if (!message) return false;
    setCustomerText(message);
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

  const handleOrderTool = (name: string | undefined, rawArguments: string | undefined, callId: string | undefined) => {
    if (name !== 'update_order' || !callId || handledCallsRef.current.has(callId)) return;
    handledCallsRef.current.add(callId);

    let output: { ok: boolean; item_count?: number; total?: number; error?: string };
    try {
      const parsed = JSON.parse(rawArguments ?? '{}') as {
        items?: Array<{ product_id?: ProductId; quantity?: number }>;
        status?: 'editing' | 'ready_to_confirm' | 'confirmed';
      };
      const nextItems: OrderItem[] = [];
      for (const requested of parsed.items ?? []) {
        const product = products.find((entry) => entry.productId === requested.product_id && entry.available);
        const quantity = Math.min(20, Math.max(0, Math.trunc(Number(requested.quantity) || 0)));
        if (!product) continue;
        for (let index = 0; index < quantity; index += 1) {
          nextItems.push({ ...product, id: nextId.current++ });
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
    switch (event.type) {
      case 'session.created':
      case 'session.updated':
        setConnectionState('connected');
        break;
      case 'input_audio_buffer.speech_started':
        setListening(microphoneReadyRef.current);
        setSpeaking(false);
        setCustomerText('…');
        break;
      case 'input_audio_buffer.speech_stopped':
        setListening(false);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.transcript) setCustomerText(event.transcript);
        break;
      case 'response.created':
        outputTranscriptRef.current = '';
        setSpeaking(true);
        setListening(false);
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta':
        if (event.delta) {
          outputTranscriptRef.current += event.delta;
          setAgentText(outputTranscriptRef.current);
        }
        break;
      case 'response.output_audio_transcript.done':
        if (event.transcript) setAgentText(event.transcript);
        break;
      case 'response.output_text.done':
        if (event.text) setAgentText(event.text);
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
        }
        break;
      }
      case 'response.done':
        setSpeaking(false);
        setListening(microphoneReadyRef.current);
        break;
      case 'error':
        setSpeaking(false);
        setVoiceError(event.error?.message ?? "L'agent vocal a rencontré une erreur. Réessayez.");
        break;
    }
  };

  const startOrder = async () => {
    cleanupSession();
    setStarted(true);
    setConfirmed(false);
    setItems([]);
    setCustomerText('');
    setVoiceError('');
    setAgentText("Connexion à l'équipier vocal…");
    setConnectionState('connecting');
    handledCallsRef.current.clear();

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
      audio.playsInline = true;
      audioRef.current = audio;
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0];
        void audio.play().catch(() => setVoiceError("Touchez l'écran pour autoriser le son de l'agent."));
      };

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
        setConnectionState('connected');
        setListening(microphoneReadyRef.current);
        setAgentText('Bonjour, je vous accueille…');
        const activeProducts = products.filter(product => product.available);
        const productKnowledge = activeProducts.map(product => `- ${product.productId}: ${product.name} — ${product.detail} — ${money.format(product.price)}`).join('\n');
        const behaviorRules = agentRules.filter(([, enabled]) => enabled).map(([rule]) => `- ${rule}`).join('\n');
        sendEvent({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: `Tu es DriveVoice, équipier du drive ${brand.name}. Parle en français avec des phrases courtes.\n\nMESSAGE D'ACCUEIL\n${agentWelcome}\n\nCATALOGUE DISPONIBLE\n${productKnowledge}\n\nRÈGLES MÉTIER\n${behaviorRules}\n\nAprès chaque modification, appelle update_order avec le panier complet. N'invente jamais un produit, un prix ou une disponibilité.`,
            tools: [{
              type: 'function',
              name: 'update_order',
              description: "Synchronise l'intégralité du panier visible après chaque modification.",
              parameters: {
                type: 'object',
                properties: {
                  items: { type: 'array', items: { type: 'object', properties: { product_id: { type: 'string', enum: activeProducts.map(product => product.productId) }, quantity: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['product_id', 'quantity'], additionalProperties: false } },
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
            instructions: `Prononce ce message d'accueil de façon naturelle puis attends la commande : ${agentWelcome}`,
          },
        });
      });
      channel.addEventListener('close', () => {
        setListening(false);
        setSpeaking(false);
      });

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
          setConnectionState('error');
          setVoiceError('La conversation audio a été interrompue. Touchez Recommencer pour vous reconnecter.');
        }
      };

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      const response = await fetch(`/api/realtime-call?brand=${encodeURIComponent(brand.name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: offer.sdp,
      });
      if (!response.ok) throw new Error(`realtime-${response.status}`);
      const answerSdp = await response.text();
      await peer.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    } catch (error) {
      cleanupSession();
      setConnectionState('error');
      setVoiceError("Impossible de joindre l'agent vocal. Vérifiez la connexion puis touchez Recommencer.");
      setAgentText("Je n'ai pas pu ouvrir la ligne audio.");
    }
  };

  const interrupt = () => {
    if (connectionState !== 'connected' || !microphoneReadyRef.current) return;
    sendEvent({ type: 'response.cancel' });
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

      <section className="mx-auto grid max-w-[1540px] gap-5 px-5 pb-8 md:px-10 xl:grid-cols-[1.45fr_.75fr]">
        <div className="relative flex min-h-[720px] flex-col overflow-hidden rounded-[32px] bg-[#0b1f14] p-7 text-white md:p-11">
          <div className="pointer-events-none absolute -right-24 -top-28 h-80 w-80 rounded-full bg-[#ff5a36]" />
          <div className="pointer-events-none absolute right-28 top-20 h-24 w-24 rounded-full bg-[#ffc647]" />

          <div className="relative z-10 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="rounded-full bg-white/10 px-3 py-1.5 text-xs font-bold">FR · LIVE</span>
              <span className="text-xs text-white/55">Drive n°04 · Voie A</span>
            </div>
            <div className="flex rounded-2xl bg-black/15 p-1.5 backdrop-blur-sm" aria-label="Choisir le restaurant">
              {brands.map((option) => (
                <button key={option.name} onClick={() => !started && setBrand(option)} aria-label={option.name} title={option.name} className={`grid h-9 w-10 place-items-center rounded-xl text-xs font-black transition ${brand.name === option.name ? 'scale-105 shadow-lg' : 'opacity-45 hover:opacity-80'}`} style={{ background: option.color, color: option.ink }}>
                  {option.mark}
                </button>
              ))}
            </div>
          </div>

          {!started ? (
            <div className="relative z-10 my-auto max-w-3xl py-16">
              <p className="mb-5 text-sm font-bold uppercase tracking-[0.22em] text-[#ffc647]">Propulsé par OpenAI Realtime</p>
              <h1 className="text-[clamp(3.3rem,7vw,7rem)] font-black leading-[.85] tracking-[-0.07em]">BONJOUR<span className="text-[#ff5a36]">.</span><br />ON COMMANDE ?</h1>
              <p className="mt-7 max-w-xl text-base leading-relaxed text-white/65 md:text-lg">Parlez naturellement, sans attendre un bip. L’agent vous répond en direct et s’arrête dès que vous l’interrompez.</p>
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
                    {[14, 26, 38, 22, 44, 31, 18, 36, 24, 15].map((height, index) => <span key={index} className={`wave-bar w-1.5 rounded-full ${listening || speaking ? 'bg-[#ff5a36]' : 'bg-white/20'}`} style={{ height }} />)}
                  </div>
                </div>
              </div>

              <div className="max-w-3xl rounded-[28px] bg-white/8 p-6 backdrop-blur md:p-8">
                <div className="flex gap-4"><span className="mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#ff5a36] text-xs font-black">DV</span><p aria-live="polite" className="text-xl font-bold leading-snug md:text-3xl">« {agentText} »</p></div>
                {customerText && <div className="mt-6 flex gap-4 border-t border-white/10 pt-5 text-white/60"><span className="text-xs font-bold uppercase tracking-widest">Vous</span><p>{customerText}</p></div>}
              </div>

              {voiceError && <p role="alert" className="mt-4 max-w-3xl rounded-2xl border border-[#ffc647]/30 bg-[#ffc647]/10 px-4 py-3 text-sm text-[#ffe099]">{voiceError}</p>}

              <form onSubmit={submitText} className="mt-5 flex max-w-3xl gap-2 rounded-2xl bg-white p-2 text-[#142018]">
                <label htmlFor="order-text" className="sr-only">Écrire votre commande</label>
                <input id="order-text" value={voiceInput} onChange={(event) => setVoiceInput(event.target.value)} disabled={connectionState !== 'connected'} placeholder="Dites ou écrivez : un menu, des frites…" className="min-w-0 flex-1 bg-transparent px-3 text-sm font-semibold outline-none placeholder:text-[#8d958e] disabled:opacity-50" />
                <button disabled={connectionState !== 'connected'} type="submit" className="rounded-xl bg-[#ff5a36] px-5 py-3 text-sm font-black text-white transition hover:bg-[#e94e2d] disabled:cursor-not-allowed disabled:opacity-45">Envoyer</button>
              </form>

              <div className="mt-6 flex flex-wrap gap-2">
                <span className="mr-2 self-center text-xs font-bold uppercase tracking-wider text-white/40">Suggestions</span>
                {products.filter(product => product.available).slice(0, 5).map((product) => <button disabled={connectionState !== 'connected'} key={product.productId} onClick={() => sendTextToAgent(`Ajoute ${product.name} à ma commande.`)} className="rounded-full border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-bold transition hover:border-white/35 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-35">+ {product.name}</button>)}
              </div>
            </div>
          )}

          {!started ? (
            <button onClick={startOrder} className="relative z-10 flex w-full items-center justify-between rounded-2xl bg-[#ff5a36] px-6 py-5 text-left transition hover:-translate-y-0.5 hover:bg-[#ff6c4d] md:w-[440px]">
              <span><strong className="block text-lg">Passer ma commande</strong><small className="text-white/70">Autorisez le micro, l’agent démarre en direct</small></span><span className="grid h-12 w-12 place-items-center rounded-full bg-white text-2xl text-[#ff5a36]">●</span>
            </button>
          ) : (
            <div className="relative z-10 flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-5"><p className="text-xs text-white/45">Vous pouvez parler par-dessus l’agent ou toucher le cercle pour l’interrompre.</p><button onClick={restart} className="text-xs font-bold text-white/60 underline decoration-white/20 underline-offset-4">Recommencer</button></div>
          )}
        </div>

        <aside className="flex min-h-[720px] flex-col rounded-[32px] bg-white p-7 md:p-9">
          <div className="flex items-center justify-between border-b border-[#e7eae4] pb-7"><div><p className="text-xs font-bold uppercase tracking-[.18em] text-[#899189]">Commande · {brand.mark}</p><h2 className="mt-1 text-2xl font-black tracking-[-0.04em]">Votre panier</h2></div><span className="rounded-full bg-[#f1f3ee] px-3 py-1.5 text-xs font-bold">{items.length} article{items.length !== 1 ? 's' : ''}</span></div>

          {confirmed ? (
            <div className="grid flex-1 place-items-center text-center"><div><div className="mx-auto mb-5 grid h-24 w-24 place-items-center rounded-full bg-[#dff6e5] text-4xl">✓</div><p className="text-xs font-bold uppercase tracking-[.18em] text-[#38a55f]">Commande confirmée</p><p className="mt-2 text-7xl font-black tracking-[-.08em]">47</p><p className="mt-4 max-w-xs text-sm leading-relaxed text-[#758077]">Avancez jusqu’à la prochaine fenêtre. Votre commande a été transmise en cuisine.</p></div></div>
          ) : items.length ? (
            <div className="flex-1 space-y-3 overflow-auto py-6">
              {items.map((item, index) => <div key={item.id} className="group flex items-center gap-4 rounded-2xl border border-[#edf0ea] p-4 transition hover:border-[#d9ded5]"><span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-[#f3f5f0] text-2xl">{item.emoji}</span><div className="min-w-0 flex-1"><p className="truncate font-black">{index + 1}. {item.name}</p><p className="truncate text-xs text-[#8a938b]">{item.detail}</p></div><div className="text-right"><p className="font-black">{money.format(item.price)}</p><button onClick={() => sendTextToAgent(`Retire un ${item.name} de ma commande.`)} className="mt-1 text-[11px] font-bold text-[#ff5a36] opacity-70 hover:opacity-100">Retirer</button></div></div>)}
            </div>
          ) : (
            <div className="grid flex-1 place-items-center text-center"><div className="max-w-[250px]"><div className="mx-auto mb-5 grid h-20 w-20 place-items-center rounded-full bg-[#f3f5f0] text-3xl">🎙️</div><h3 className="text-xl font-black">Prêt à vous écouter</h3><p className="mt-2 text-sm leading-relaxed text-[#7b847d]">Le panier se met à jour pendant votre conversation avec l’agent.</p></div></div>
          )}

          <div className="border-t border-[#e7eae4] pt-6">
            <div className="flex items-end justify-between"><span className="text-sm font-bold text-[#717a73]">Total TTC</span><strong className="text-4xl font-black tracking-[-0.05em]">{money.format(total)}</strong></div>
            <button disabled={!items.length || confirmed || connectionState !== 'connected'} onClick={confirmOrder} className="mt-6 flex h-14 w-full items-center justify-between rounded-2xl bg-[#0b1f14] px-5 font-black text-white transition enabled:hover:bg-[#153623] disabled:cursor-not-allowed disabled:bg-[#edf0ea] disabled:text-[#aeb5ad]"><span>{confirmed ? 'Commande transmise' : 'Confirmer la commande'}</span><span>→</span></button>
            <p className="mt-4 text-center text-[11px] text-[#9aa19a]">Paiement à la prochaine fenêtre · Conversation traitée en temps réel</p>
          </div>
        </aside>
      </section>
    </main>
  );
}

type WorkspaceTab = 'order' | 'dashboard' | 'integrations' | 'catalog' | 'agent' | 'backoffice';
type ProductVariant = { id: number; name: string; priceDelta: number; posCode: string };
type ProductOption = { id: number; name: string; priceDelta: number; posCode: string; available: boolean };
type ProductOptionGroup = { id: number; name: string; question: string; required: boolean; min: number; max: number; options: ProductOption[] };
type ProductModifier = { id: number; name: string; kind: 'remove' | 'add'; priceDelta: number };
type ProductIngredient = { id: number; name: string; removable: boolean; extraAllowed: boolean; extraPrice: number };
type CatalogProduct = {
  id: number;
  productId: ProductId;
  name: string;
  detail: string;
  emoji: string;
  category: string;
  subcategory?: string;
  price: number;
  posCode: string;
  available: boolean;
  ingredients?: string[];
  ingredientSettings?: ProductIngredient[];
  productType?: 'simple' | 'configurable' | 'menu' | 'bundle';
  variants?: ProductVariant[];
  optionGroups?: ProductOptionGroup[];
  modifiers?: ProductModifier[];
};

const workspaceTabs: Array<{ id: WorkspaceTab; label: string; short: string; icon: string }> = [
  { id: 'order', label: 'Prise de commande', short: 'Commande', icon: '◉' },
  { id: 'dashboard', label: 'Tableau de bord', short: 'Pilotage', icon: '▥' },
  { id: 'integrations', label: 'Intégrations POS / KDS', short: 'Technique', icon: '⌁' },
  { id: 'catalog', label: 'Catalogue produits', short: 'Carte', icon: '▦' },
  { id: 'agent', label: "Configuration de l'agent", short: 'Agent IA', icon: '✦' },
  { id: 'backoffice', label: 'Catalogues maîtres', short: 'Back-office', icon: '◆' },
];

const burgerKingCategoryTemplate = [
  ['Nouveautés', '✦'], ['Menus', '▤'], ['Burgers', '🍔'], ['Menus enfants', '♛'], ['À partager', '🍗'],
  ['Tortillas & Wraps', '🌯'], ['Snacks & Sauces', '🍟'], ['Bon et Pas Cher', '€'], ['Salades', '🥗'],
  ['Desserts & Boissons', '🥤'], ['King Breakfast', '☕'], ['Poulet du Dimanche', '🍗'],
] as const;

const subcategoryTemplates: Record<string, string[]> = {
  'Burgers': ['Tous', 'Poulet', 'Bœuf', 'Poisson', 'Veggie'],
  'Menus': ['Tous', 'Poulet', 'Bœuf', 'Poisson', 'Veggie'],
  'Desserts & Boissons': ['Tous', 'Glaces', 'Pâtisseries', 'Boissons froides', 'Boissons chaudes'],
};

const burgerKingCatalogTemplate: CatalogProduct[] = [
  { id: 101, productId: 'bk_master_sarran_mozza', name: 'Master Sarran Mozzarella', detail: 'Burger au poulet de la gamme Masters', emoji: '🍔', category: 'Nouveautés', price: 0, posCode: '', available: false, productType: 'configurable' },
  { id: 102, productId: 'bk_master_des_chefs', name: 'Master des Chefs', detail: 'Burger de la gamme Masters', emoji: '🍔', category: 'Nouveautés', price: 0, posCode: '', available: false, productType: 'configurable' },
  { id: 103, productId: 'bk_menu_whopper', name: 'Menu Whopper®', detail: 'Whopper®, accompagnement et boisson au choix', emoji: '🍔', category: 'Menus', price: 0, posCode: '', available: false, productType: 'menu', optionGroups: [
    { id: 1031, name: 'Accompagnement', question: 'Quel accompagnement souhaitez-vous ?', required: true, min: 1, max: 1, options: [{ id: 10311, name: 'Frites', priceDelta: 0, posCode: '', available: true }, { id: 10312, name: 'Onion Rings', priceDelta: 0, posCode: '', available: true }] },
    { id: 1032, name: 'Boisson', question: 'Quelle boisson souhaitez-vous ?', required: true, min: 1, max: 1, options: [{ id: 10321, name: 'Coca-Cola®', priceDelta: 0, posCode: '', available: true }, { id: 10322, name: 'Coca-Cola® Zéro Sucres', priceDelta: 0, posCode: '', available: true }] },
  ] },
  { id: 104, productId: 'bk_whopper', name: 'Whopper®', detail: 'Viande de bœuf grillée à la flamme, sauce onctueuse et légumes frais', emoji: '🍔', category: 'Burgers', price: 0, posCode: '', available: false, ingredients: ['Pain aux graines de sésame', 'Sauce', 'Salade', 'Tranches de tomates fraîches', "Rondelles d’oignons frais", 'Ketchup', 'Rondelles de cornichons', 'Viande grillée à la flamme'], productType: 'configurable', modifiers: [{ id: 1041, name: 'Sans sauce', kind: 'remove', priceDelta: 0 }, { id: 1042, name: 'Sans salade', kind: 'remove', priceDelta: 0 }, { id: 1043, name: 'Sans tomates', kind: 'remove', priceDelta: 0 }, { id: 1044, name: 'Sans oignons', kind: 'remove', priceDelta: 0 }, { id: 1045, name: 'Sans cornichons', kind: 'remove', priceDelta: 0 }] },
  ...['Double Whopper® Cheese','Big King XXL®','Big King®','Steakhouse','Double Steakhouse','Double Cheese Bacon XXL','Double Cheese Bacon','Cheeseburger','Hamburger','Master Cantal Bacon'].map((name,index)=>({ id: 105+index, productId: `bk_beef_${index}`, name, detail: 'Burger au bœuf grillé à la flamme', emoji: '🍔', category: 'Burgers', price: 0, posCode: '', available: false, productType: 'configurable' as const })),
  ...['CBK','Double CBK','Smoky Chicken','Chicken Louisiane Steakhouse'].map((name,index)=>({ id: 120+index, productId: `bk_chicken_${index}`, name, detail: 'Burger au poulet', emoji: '🍔', category: 'Burgers', price: 0, posCode: '', available: false, productType: 'configurable' as const })),
  { id: 130, productId: 'bk_big_fish', name: 'Big Fish', detail: 'Burger au poisson pané croustillant', emoji: '🐟', category: 'Burgers', price: 0, posCode: '', available: false, productType: 'configurable' },
  { id: 131, productId: 'bk_veggie_whopper', name: 'Veggie Whopper®', detail: 'Alternative végétarienne du Whopper®', emoji: '🌱', category: 'Burgers', price: 0, posCode: '', available: false, productType: 'configurable' },
  { id: 140, productId: 'bk_king_jr', name: 'Menu King Junior', detail: 'Menu enfant avec plat, accompagnement, boisson et surprise', emoji: '♛', category: 'Menus enfants', price: 0, posCode: '', available: false, productType: 'menu' },
  { id: 150, productId: 'bk_king_nuggets_20', name: 'King Nuggets x20', detail: 'À partager avec les sauces au choix', emoji: '🍗', category: 'À partager', price: 0, posCode: '', available: false, productType: 'bundle' },
  { id: 160, productId: 'bk_wrap_louisiane', name: 'Wrap Chicken Louisiane', detail: 'Wrap au poulet croustillant', emoji: '🌯', category: 'Tortillas & Wraps', price: 0, posCode: '', available: false, productType: 'configurable' },
  { id: 170, productId: 'bk_fries', name: 'Frites', detail: 'Frites croustillantes', emoji: '🍟', category: 'Snacks & Sauces', price: 0, posCode: '', available: false, productType: 'simple', variants: [{ id: 1701, name: 'Petites', priceDelta: 0, posCode: '' }, { id: 1702, name: 'Moyennes', priceDelta: 0, posCode: '' }, { id: 1703, name: 'Grandes', priceDelta: 0, posCode: '' }] },
  { id: 171, productId: 'bk_onion_rings', name: 'Onion Rings', detail: 'Rondelles d’oignon panées', emoji: '🧅', category: 'Snacks & Sauces', price: 0, posCode: '', available: false, productType: 'simple' },
  { id: 180, productId: 'bk_bpc', name: 'Menu Bon et Pas Cher', detail: 'Formule à configurer selon le restaurant', emoji: '🍔', category: 'Bon et Pas Cher', price: 0, posCode: '', available: false, productType: 'menu' },
  { id: 190, productId: 'bk_caesar_bowl', name: 'Caesar Chicken Bowl', detail: 'Salade Caesar au poulet', emoji: '🥗', category: 'Salades', price: 0, posCode: '', available: false, productType: 'configurable' },
  ...['King Fusion','King Sundae','Shakes','Baby Churros','Pâtisseries','Coca-Cola®','Coca-Cola® Zéro Sucres','Oasis Tropical','Fuze Tea Pêche Hibiscus','Vittel®','Perrier®','Cafés','Thés','Boisson Cacaotée'].map((name,index)=>({ id: 200+index, productId: `bk_drink_dessert_${index}`, name, detail: index < 5 ? 'Dessert' : index < 11 ? 'Boisson froide' : 'Boisson chaude', emoji: index < 5 ? '🍨' : index < 11 ? '🥤' : '☕', category: 'Desserts & Boissons', price: 0, posCode: '', available: false, productType: index===3||index===4||index>10 ? 'configurable' as const : 'simple' as const })),
];

const bigKingLayers = [
  'Pain aux graines de sésame', 'Sauce Big King', 'Salade', "Rondelles d’oignons frais", 'Cheddar fondu (1 tranche)',
  'Rondelles de cornichons', 'Viande grillée à la flamme', 'Cheddar fondu (1 tranche)', 'Viande grillée à la flamme', 'Pain aux graines de sésame',
];
const bigKingTemplate = burgerKingCatalogTemplate.find(product=>product.name==='Big King®');
if (bigKingTemplate) {
  bigKingTemplate.detail = 'Deux viandes grillées à la flamme, cheddar, sauce Big King, salade, oignons et cornichons';
  bigKingTemplate.ingredients = bigKingLayers;
  bigKingTemplate.ingredientSettings = bigKingLayers.map((name,index)=>({ id: 113000+index, name, removable: !/pain/i.test(name), extraAllowed: /salade|oignons|cheddar|cornichons|viande/i.test(name), extraPrice: 0 }));
  bigKingTemplate.modifiers = bigKingTemplate.ingredientSettings.flatMap(ingredient=>[
    ...(ingredient.removable?[{id:ingredient.id*10+1,name:`Sans ${ingredient.name}`,kind:'remove' as const,priceDelta:0}]:[]),
    ...(ingredient.extraAllowed?[{id:ingredient.id*10+2,name:`Supplément ${ingredient.name}`,kind:'add' as const,priceDelta:ingredient.extraPrice}]:[]),
  ]);
}
burgerKingCatalogTemplate.forEach(product=>{
  if (product.category === 'Burgers') {
    if (/veggie/i.test(product.name)) product.subcategory = 'Veggie';
    else if (/fish/i.test(product.name)) product.subcategory = 'Poisson';
    else if (/chicken|poulet|cbk/i.test(product.name)) product.subcategory = 'Poulet';
    else product.subcategory = 'Bœuf';
  } else if (product.category === 'Menus') {
    product.subcategory = /veggie/i.test(product.name) ? 'Veggie' : /fish/i.test(product.name) ? 'Poisson' : /chicken|poulet/i.test(product.name) ? 'Poulet' : 'Bœuf';
  } else if (product.category === 'Desserts & Boissons') {
    product.subcategory = /fusion|sundae|shake/i.test(product.name) ? 'Glaces' : /churros|pâtisserie/i.test(product.name) ? 'Pâtisseries' : /café|thé|cacaotée/i.test(product.name) ? 'Boissons chaudes' : 'Boissons froides';
  }
});

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
  const hourly = [24, 38, 48, 62, 78, 91, 86, 70, 58, 81, 96, 74];
  const recentOrders = [
    ['#DV-1048', '12:42', 'Vocal', '18,60 €', 'Préparation'],
    ['#DV-1047', '12:39', 'Vocal', '12,90 €', 'Remise'],
    ['#DV-1046', '12:36', 'Texte', '21,40 €', 'Terminée'],
    ['#DV-1045', '12:31', 'Vocal', '15,70 €', 'Terminée'],
  ];

  return (
    <div>
      <SectionHeading eyebrow="Pilotage temps réel" title="Tableau de bord opérationnel" description="Suivez les performances de la voie drive, la qualité des conversations et les ventes générées par l'agent vocal." action={<div className="flex gap-2"><button className="rounded-xl border border-[#dfe4dc] bg-white px-4 py-2 text-xs font-black">Aujourd'hui⌄</button><button className="rounded-xl bg-[#0b1f14] px-4 py-2 text-xs font-black text-white">Exporter</button></div>} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {[
          ['Commandes', '248', '+12,4 %', '◉'],
          ['Chiffre d’affaires', '4 286 €', '+8,7 %', '€'],
          ['Panier moyen', '17,28 €', '+1,4 %', '↗'],
          ['Temps de prise', '1 min 42', '-18 sec', '◷'],
          ['Résolution vocale', '96,8 %', '+2,1 pts', '✦'],
        ].map(([label, value, trend, icon]) => <div key={label} className={`${panelCard} p-5`}><div className="flex items-center justify-between"><span className="text-xs font-bold text-[#7e887f]">{label}</span><span className="grid h-9 w-9 place-items-center rounded-xl bg-[#f1f4ef] font-black text-[#ff5a36]">{icon}</span></div><p className="mt-5 text-3xl font-black tracking-[-.05em]">{value}</p><p className={`mt-2 text-xs font-black ${trend.startsWith('-') && label !== 'Temps de prise' ? 'text-[#e04d39]' : 'text-[#2a9b55]'}`}>{trend} <span className="font-semibold text-[#a0a8a1]">vs. hier</span></p></div>)}
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
      <section className={`${panelCard} mt-5 overflow-hidden`}><div className="flex items-center justify-between border-b border-[#e8ebe6] p-6"><div><h2 className="text-lg font-black">Dernières commandes</h2><p className="mt-1 text-xs text-[#879088]">Synchronisation KDS instantanée</p></div><button className="text-xs font-black text-[#ff5a36]">Voir toutes →</button></div><div className="overflow-x-auto"><table className="w-full min-w-[650px] text-left text-sm"><thead className="bg-[#f8f9f6] text-[10px] uppercase tracking-widest text-[#8d968e]"><tr>{['Commande','Heure','Canal','Montant','Statut'].map(x=><th key={x} className="px-6 py-3">{x}</th>)}</tr></thead><tbody>{recentOrders.map(row=><tr key={row[0]} className="border-t border-[#edf0eb]"><td className="px-6 py-4 font-black">{row[0]}</td><td className="px-6 py-4 text-[#6f7971]">{row[1]}</td><td className="px-6 py-4"><span className="rounded-full bg-[#eef2ed] px-3 py-1 text-xs font-bold">{row[2]}</span></td><td className="px-6 py-4 font-black">{row[3]}</td><td className="px-6 py-4"><span className="text-xs font-black text-[#2e9553]">● {row[4]}</span></td></tr>)}</tbody></table></div></section>
    </div>
  );
}

function IntegrationsPanel() {
  const [testState, setTestState] = useState<'idle' | 'testing' | 'success'>('idle');
  const runTest = () => { setTestState('testing'); window.setTimeout(() => setTestState('success'), 900); };
  return (
    <div>
      <SectionHeading eyebrow="Infrastructure restaurant" title="Intégrations POS & KDS" description="Connectez DriveVoice à votre caisse, votre écran cuisine et vos webhooks. Les secrets restent chiffrés et les flux sont supervisés." action={<button onClick={runTest} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">{testState === 'testing' ? 'Test en cours…' : testState === 'success' ? '✓ Connexion validée' : 'Tester le flux complet'}</button>} />
      <div className="grid gap-5 xl:grid-cols-3">
        {[['POS principal','Oracle Simphony','Connecté','Dernière synchronisation il y a 18 s','▣'],['KDS cuisine','Deliverect KDS','Connecté','File active · 6 commandes','▤'],['Paiement','Adyen Terminal API','À configurer','Aucun terminal associé','€']].map(([type,name,status,detail,icon])=><section key={type} className={`${panelCard} p-6`}><div className="flex items-start justify-between"><span className="grid h-12 w-12 place-items-center rounded-2xl bg-[#102a1b] text-xl font-black text-white">{icon}</span><span className={`rounded-full px-3 py-1 text-[10px] font-black uppercase ${status==='Connecté'?'bg-[#e1f6e7] text-[#278a49]':'bg-[#fff2d4] text-[#a16c00]'}`}>● {status}</span></div><p className="mt-6 text-xs font-black uppercase tracking-widest text-[#8d958e]">{type}</p><h2 className="mt-1 text-xl font-black">{name}</h2><p className="mt-2 text-xs text-[#7f8981]">{detail}</p><button className="mt-6 w-full rounded-xl border border-[#dfe4dc] py-2.5 text-xs font-black">Configurer →</button></section>)}
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-[1.1fr_.9fr]">
        <section className={`${panelCard} p-6`}><div className="flex items-center justify-between"><div><h2 className="text-lg font-black">Paramètres de connexion</h2><p className="mt-1 text-xs text-[#828b83]">Environnement de production</p></div><span className="rounded-full bg-[#f0f3ee] px-3 py-1 text-[10px] font-black">TLS 1.3</span></div><div className="mt-6 grid gap-4 md:grid-cols-2"><label className="text-xs font-bold text-[#68736a]">URL de l’API POS<input className={`${fieldClass} mt-2`} defaultValue="https://pos.restaurant.fr/api/v2" /></label><label className="text-xs font-bold text-[#68736a]">Identifiant du point de vente<input className={`${fieldClass} mt-2`} defaultValue="BK-PARIS-DRIVE-04" /></label><label className="text-xs font-bold text-[#68736a]">Clé d’API<input className={`${fieldClass} mt-2 font-mono`} type="password" defaultValue="drivevoice-secret-key" /></label><label className="text-xs font-bold text-[#68736a]">Délai d’expiration<select className={`${fieldClass} mt-2`} defaultValue="8"><option value="5">5 secondes</option><option value="8">8 secondes</option><option value="15">15 secondes</option></select></label></div><div className="mt-6 flex justify-end"><button className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">Enregistrer la connexion</button></div></section>
        <section className={`${panelCard} p-6`}><h2 className="text-lg font-black">Supervision des flux</h2><p className="mt-1 text-xs text-[#828b83]">Santé des échanges sur les dernières 24 h</p><div className="mt-6 space-y-5">{[['Création commande POS','99,98 %','248 / 248'],['Transmission KDS','99,60 %','247 / 248'],['Mise à jour disponibilité','100 %','1 426 / 1 426']].map(([label,score,count])=><div key={label}><div className="mb-2 flex items-center justify-between text-xs"><span className="font-bold">{label}</span><strong>{score}</strong></div><div className="h-2 rounded-full bg-[#edf0eb]"><div className="h-full rounded-full bg-[#39a75e]" style={{width:score}} /></div><p className="mt-1 text-[10px] text-[#9aa29b]">{count} événements</p></div>)}</div><div className="mt-7 rounded-2xl bg-[#0e2418] p-4 font-mono text-[11px] text-[#b9d8c3]"><p><span className="text-[#56d17d]">200</span> POST /orders · 142 ms</p><p className="mt-2"><span className="text-[#56d17d]">200</span> PATCH /kds/1048 · 88 ms</p><p className="mt-2"><span className="text-[#ffc647]">RETRY</span> inventory/sync · 1.2 s</p></div></section>
      </div>
    </div>
  );
}

function CatalogPanel({ products, setProducts }: { products: CatalogProduct[]; setProducts: React.Dispatch<React.SetStateAction<CatalogProduct[]>> }) {
  const [query, setQuery] = useState('');
  const [saved, setSaved] = useState(false);
  const filtered = products.filter(product => `${product.name} ${product.category} ${product.posCode}`.toLowerCase().includes(query.toLowerCase()));
  const updateProduct = (id: number, patch: Partial<CatalogProduct>) => setProducts(current => current.map(product => product.id === id ? { ...product, ...patch } : product));
  const addProduct = () => setProducts(current => [...current, { id: Date.now(), productId: `product_${Date.now()}`, name: 'Nouveau produit', detail: 'Description à compléter', emoji: '🍽️', category: 'Menus', price: 0, posCode: `NEW-${current.length + 1}`, available: true }]);
  const save = () => { setSaved(true); window.setTimeout(() => setSaved(false), 1800); };
  return (
    <div>
      <SectionHeading eyebrow="Carte restaurant" title="Catalogue produits" description="Gérez les produits compris par l’agent, leurs prix, codes caisse et disponibilités en temps réel." action={<div className="flex gap-2"><button onClick={addProduct} className="rounded-xl border border-[#d9dfd7] bg-white px-4 py-3 text-xs font-black">＋ Nouveau produit</button><button onClick={save} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">{saved ? '✓ Catalogue enregistré' : 'Enregistrer les modifications'}</button></div>} />
      <section className={`${panelCard} overflow-hidden`}><div className="flex flex-col gap-4 border-b border-[#e7ebe5] p-5 md:flex-row md:items-center md:justify-between"><div className="flex items-center gap-3"><input aria-label="Rechercher dans le catalogue" className={`${fieldClass} md:w-80`} placeholder="Rechercher un produit, code POS…" value={query} onChange={event=>setQuery(event.target.value)} /><span className="rounded-full bg-[#eef2ed] px-3 py-2 text-xs font-black">{products.length} produits</span></div><div className="flex gap-2 text-xs"><span className="rounded-full bg-[#e5f6e9] px-3 py-2 font-black text-[#28894a]">{products.filter(p=>p.available).length} disponibles</span><span className="rounded-full bg-[#f3f4f1] px-3 py-2 font-black text-[#737d75]">{products.filter(p=>!p.available).length} masqué</span></div></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left"><thead className="bg-[#f8f9f6] text-[10px] font-black uppercase tracking-[.14em] text-[#8f9790]"><tr>{['Produit','Catégorie','Prix TTC','Code POS','Disponibilité'].map(label=><th key={label} className="px-5 py-3">{label}</th>)}</tr></thead><tbody>{filtered.map(product=><tr key={product.id} className="border-t border-[#edf0eb]"><td className="px-5 py-4"><input aria-label={`Nom de ${product.name}`} className="w-full min-w-48 bg-transparent font-black outline-none focus:text-[#ff5a36]" value={product.name} onChange={event=>updateProduct(product.id,{name:event.target.value})} /></td><td className="px-5 py-4"><select className="rounded-lg border border-[#e0e4de] bg-white px-3 py-2 text-xs font-bold" value={product.category} onChange={event=>updateProduct(product.id,{category:event.target.value})}>{['Menus','Burgers','Poulet','Accompagnements','Boissons','Desserts'].map(c=><option key={c}>{c}</option>)}</select></td><td className="px-5 py-4"><div className="flex items-center gap-1"><input aria-label={`Prix de ${product.name}`} className="w-20 rounded-lg border border-[#e0e4de] px-3 py-2 text-sm font-black" type="number" step="0.1" value={product.price} onChange={event=>updateProduct(product.id,{price:Number(event.target.value)})} /><span className="font-black">€</span></div></td><td className="px-5 py-4"><input aria-label={`Code POS de ${product.name}`} className="rounded-lg bg-[#f3f5f1] px-3 py-2 font-mono text-xs font-bold outline-none" value={product.posCode} onChange={event=>updateProduct(product.id,{posCode:event.target.value})} /></td><td className="px-5 py-4"><button onClick={()=>updateProduct(product.id,{available:!product.available})} className={`flex items-center gap-2 rounded-full px-3 py-2 text-xs font-black ${product.available?'bg-[#e3f6e8] text-[#258848]':'bg-[#eff1ee] text-[#7f8880]'}`}><span className={`h-2 w-2 rounded-full ${product.available?'bg-[#34a759]':'bg-[#a6ada7]'}`} />{product.available?'Disponible':'Masqué'}</button></td></tr>)}</tbody></table></div>
      </section>
      <div className="mt-5 grid gap-5 lg:grid-cols-3">{[['Synchronisation POS','Il y a 18 secondes','Les prix et stocks sont alignés.'],['Règles de vente','4 règles actives','Menus, suppléments et horaires.'],['Compréhension agent','100 % indexé','Le catalogue est prêt pour la voix.']].map(([title,value,detail])=><div key={title} className={`${panelCard} p-5`}><p className="text-xs font-bold text-[#828c84]">{title}</p><p className="mt-2 text-xl font-black">{value}</p><p className="mt-1 text-xs text-[#919991]">{detail}</p></div>)}</div>
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
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">{displayedProducts.map(product=><button key={product.id} onClick={()=>setSelectedProduct(product)} className="group overflow-hidden rounded-[20px] border border-[#eadfce] bg-white text-left shadow-[0_10px_30px_rgba(70,42,20,.06)] transition hover:-translate-y-1 hover:border-[#ff9a81]"><div className="grid h-40 place-items-center bg-gradient-to-br from-[#fffdf9] to-[#f5ead9]"><span className="text-7xl transition group-hover:scale-110">{product.emoji}</span></div><div className="border-t border-[#f0e8dc] p-4"><span className="text-[9px] font-black uppercase tracking-wider text-[#a37459]">{product.category}</span><h3 className="mt-1 text-base font-black">{product.name}</h3><p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[#7d817c]">{product.detail}</p><div className="mt-4 flex items-center justify-between"><strong>{money.format(product.price)}</strong><span className="rounded-full bg-[#e5f6e9] px-2 py-1 text-[9px] font-black text-[#27894a]">Disponible</span></div></div></button>)}</div>
        </div>
      </section>
      {selectedProduct&&<div className="fixed inset-0 z-50 grid place-items-center bg-[#07130d]/55 p-4" role="dialog" aria-modal="true" aria-label={`Fiche ${selectedProduct.name}`}><div className="w-full max-w-xl overflow-hidden rounded-[28px] bg-white shadow-2xl"><div className="flex items-start justify-between bg-[#fff7eb] p-6"><div><span className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Fiche produit importée</span><h2 className="mt-2 text-2xl font-black">{selectedProduct.name}</h2><p className="mt-1 text-xs text-[#7d817c]">{selectedProduct.category} · {selectedProduct.posCode}</p></div><button onClick={()=>setSelectedProduct(null)} aria-label="Fermer" className="grid h-10 w-10 place-items-center rounded-xl bg-white font-black">×</button></div><div className="p-6"><div className="grid gap-5 sm:grid-cols-[110px_1fr]"><div className="grid h-28 place-items-center rounded-2xl bg-[#f7efe2] text-6xl">{selectedProduct.emoji}</div><div><p className="text-xs leading-relaxed text-[#6f7971]">{selectedProduct.detail}</p><p className="mt-4 text-[10px] font-black uppercase tracking-widest text-[#9a7966]">Composition</p><div className="mt-2 flex flex-wrap gap-2">{(selectedProduct.ingredients??['Composition à vérifier']).map(ingredient=><span key={ingredient} className="rounded-full bg-[#f1f3ee] px-3 py-2 text-[10px] font-bold">{ingredient}</span>)}</div></div></div><div className="mt-6 grid gap-3 sm:grid-cols-3">{[['Prix TTC',money.format(selectedProduct.price)],['Code POS',selectedProduct.posCode],['Statut','Disponible']].map(([label,value])=><div key={label} className="rounded-xl border border-[#e5e9e2] p-3"><p className="text-[9px] font-black uppercase tracking-wider text-[#949c95]">{label}</p><p className="mt-1 text-sm font-black">{value}</p></div>)}</div><div className="mt-6 flex justify-end gap-2"><button className="rounded-xl border border-[#dfe4dc] px-4 py-3 text-xs font-black">Modifier</button><button onClick={()=>setSelectedProduct(null)} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">Valider la fiche</button></div></div></div></div>}
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
  const isBurger = draft.category === 'Burgers';
  const isMenu = draft.category === 'Menus' || draft.category === 'Menus enfants';
  const menuSteps = draft.optionGroups;
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
    if (key.includes('accompagnement')) return catalogProducts.filter(product=>product.category==='Snacks & Sauces'&&!/sauce/i.test(`${product.name} ${product.detail}`));
    if (key.includes('boisson')) return catalogProducts.filter(product=>product.category==='Desserts & Boissons'&&(/boisson/i.test(`${product.subcategory??''} ${product.detail}`)||['🥤','☕'].includes(product.emoji)));
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
        <div className="grid gap-4 md:grid-cols-[90px_1fr_1fr]"><label className="text-xs font-bold text-[#68736a]">Visuel<input className={`${fieldClass} mt-2 text-center text-2xl`} maxLength={3} value={draft.emoji} onChange={event=>setDraft(current=>({...current,emoji:event.target.value}))} /></label><label className="text-xs font-bold text-[#68736a]">Nom du produit *<input className={`${fieldClass} mt-2`} placeholder="Ex. Big King" value={draft.name} onChange={event=>setDraft(current=>({...current,name:event.target.value}))} /></label><label className="text-xs font-bold text-[#68736a]">Catégorie *<select className={`${fieldClass} mt-2`} value={draft.category} onChange={event=>{const category=event.target.value;setDraft(current=>({...current,category,subcategory:subcategoryTemplates[category]?.[1]??''}));}}>{categories.map(category=><option key={category.id}>{category.name}</option>)}</select></label></div>
        {subcategoryOptions.length>1&&<label className="mt-4 block text-xs font-bold text-[#68736a]">Sous-catégorie<select className={`${fieldClass} mt-2`} value={draft.subcategory} onChange={event=>setDraft(current=>({...current,subcategory:event.target.value}))}>{subcategoryOptions.filter(option=>option!=='Tous').map(option=><option key={option}>{option}</option>)}</select></label>}
        <label className="mt-4 block text-xs font-bold text-[#68736a]">Description client<textarea className="mt-2 min-h-20 w-full rounded-xl border border-[#dfe4dc] p-3 text-sm font-semibold outline-none focus:border-[#ff6a45]" placeholder="Décrivez brièvement le produit…" value={draft.detail} onChange={event=>setDraft(current=>({...current,detail:event.target.value}))} /></label>
        <div className="mt-4 grid gap-4 md:grid-cols-2"><label className="text-xs font-bold text-[#68736a]">Prix TTC *<div className="relative mt-2"><input className={`${fieldClass} pr-10`} type="number" min="0" step="0.1" value={draft.price} onChange={event=>setDraft(current=>({...current,price:Number(event.target.value)}))} /><span className="absolute right-4 top-3 text-sm font-black">€</span></div></label><label className="text-xs font-bold text-[#68736a]">Code POS<input className={`${fieldClass} mt-2 font-mono`} placeholder="Ex. BRG-BGK-01" value={draft.posCode} onChange={event=>setDraft(current=>({...current,posCode:event.target.value}))} /></label></div>
        {isBurger&&<section className="mt-5 rounded-2xl border border-[#dfe4dc] bg-[#fafbf8] p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-black text-[#536057]">Composition et ingrédients</p><p className="mt-1 text-[10px] text-[#8b948c]">Ajoutez les couches dans l’ordre réel du produit, du haut vers le bas. Les répétitions sont autorisées.</p></div><span className="w-fit rounded-full bg-[#eef2ed] px-3 py-1.5 text-[9px] font-black text-[#667168]">{ingredientRows.length} couche{ingredientRows.length!==1?'s':''}</span></div>
          <div className="mt-4 flex gap-2"><input aria-label="Nouvel ingrédient" className={fieldClass} placeholder="Ex. Cheddar fondu (1 tranche)" value={newIngredient} onChange={event=>setNewIngredient(event.target.value)} onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();addIngredient();}}} /><button type="button" onClick={addIngredient} disabled={!newIngredient.trim()} className="shrink-0 rounded-xl bg-[#0b1f14] px-4 text-xs font-black text-white disabled:opacity-35">＋ Ajouter</button></div>
          <div className="mt-4 space-y-2">{ingredientRows.map((ingredient,index)=><div key={ingredient.id} className="rounded-xl border border-[#e2e7df] bg-white p-3"><div className="flex items-center gap-2"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#f2f4ef] text-[10px] font-black text-[#7c857d]">{index+1}</span><input aria-label={`Ingrédient ${index+1}`} className="min-w-0 flex-1 bg-transparent text-xs font-black outline-none focus:text-[#ff5a36]" value={ingredient.name} onChange={event=>updateIngredient(ingredient.id,{name:event.target.value})} /><button type="button" onClick={()=>moveIngredient(index,-1)} disabled={index===0} aria-label="Monter" className="grid h-7 w-7 place-items-center rounded-lg bg-[#f2f4ef] text-[11px] font-black disabled:opacity-25">↑</button><button type="button" onClick={()=>moveIngredient(index,1)} disabled={index===ingredientRows.length-1} aria-label="Descendre" className="grid h-7 w-7 place-items-center rounded-lg bg-[#f2f4ef] text-[11px] font-black disabled:opacity-25">↓</button><button type="button" onClick={()=>setDraft(current=>({...current,ingredients:(current.ingredients as ProductIngredient[]).filter(item=>item.id!==ingredient.id)}))} aria-label="Supprimer" className="grid h-7 w-7 place-items-center rounded-lg bg-[#fff0ec] text-xs font-black text-[#d6503d]">×</button></div><div className="mt-3 flex flex-wrap items-center gap-2 pl-9"><button type="button" onClick={()=>updateIngredient(ingredient.id,{removable:!ingredient.removable})} className={`rounded-full px-3 py-1.5 text-[9px] font-black ${ingredient.removable?'bg-[#fff0ec] text-[#c34c36]':'bg-[#eef1ed] text-[#7d867e]'}`}>{ingredient.removable?'✓ Retrait autorisé':'Retrait interdit'}</button><button type="button" onClick={()=>updateIngredient(ingredient.id,{extraAllowed:!ingredient.extraAllowed})} className={`rounded-full px-3 py-1.5 text-[9px] font-black ${ingredient.extraAllowed?'bg-[#e8f7ec] text-[#27894a]':'bg-[#eef1ed] text-[#7d867e]'}`}>{ingredient.extraAllowed?'✓ Supplément autorisé':'Supplément interdit'}</button>{ingredient.extraAllowed&&<label className="flex items-center gap-2 text-[9px] font-black text-[#707a72]">Prix supplément<input className="h-8 w-20 rounded-lg border border-[#dfe4dc] px-2 text-right text-[10px] font-black outline-none" type="number" min="0" step="0.1" value={ingredient.extraPrice} onChange={event=>updateIngredient(ingredient.id,{extraPrice:Number(event.target.value)})} /> €</label>}</div></div>)}{!ingredientRows.length&&<div className="rounded-xl border border-dashed border-[#ccd4ca] py-7 text-center"><p className="text-xs font-black text-[#778179]">Aucun ingrédient ajouté</p><p className="mt-1 text-[10px] text-[#99a099]">Commencez par le pain supérieur, puis descendez couche par couche.</p></div>}</div>
          <div className="mt-4 rounded-xl bg-[#edf5ef] p-3 text-[10px] leading-relaxed text-[#52705b]"><strong>Compréhension IA :</strong> ces réglages génèrent automatiquement les retraits et suppléments utilisables pendant la commande.</div>
        </section>}
        {isMenu&&<section className="mt-5 rounded-2xl border border-[#dfe4dc] bg-[#fafbf8] p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-black text-[#536057]">Structure du menu</p><p className="mt-1 text-[10px] text-[#8b948c]">Construisez le parcours présenté au client, dans l’ordre exact de la commande.</p></div><button type="button" onClick={addStep} className="rounded-xl bg-[#0b1f14] px-4 py-2.5 text-[10px] font-black text-white">＋ Ajouter une composition</button></div>
          <div className="mt-5 grid gap-2 sm:grid-cols-3 lg:grid-cols-5">{menuSteps.map((step,index)=><button type="button" key={step.id} onClick={()=>document.getElementById(`menu-step-${step.id}`)?.scrollIntoView({behavior:'smooth',block:'center'})} className="rounded-2xl border border-[#e1e6df] bg-white p-3 text-left shadow-sm transition hover:border-[#ff8d72]"><span className="grid h-7 w-7 place-items-center rounded-full bg-[#ffcf45] text-[10px] font-black text-[#3e2d00]">{index+1}</span><p className="mt-2 text-xs font-black">{step.name}</p><p className="mt-1 text-[9px] text-[#8a938b]">{step.options.length} choix configuré{step.options.length!==1?'s':''}</p></button>)}</div>
          <div className="mt-5 space-y-5">{menuSteps.map((step,index)=>{const isSize=step.name.toLowerCase().includes('taille');const sourceProducts=menuSourceProducts(step.name);const shownOptions=isSize?[...step.options].sort((a,b)=>sizeRank(a.name)-sizeRank(b.name)):step.options;return <div id={`menu-step-${step.id}`} key={step.id} className="scroll-mt-24 rounded-2xl border border-[#e0e5dd] bg-white p-4"><div className="flex flex-col gap-3 md:flex-row md:items-center"><span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[#ffcf45] text-[11px] font-black text-[#3e2d00]">{index+1}</span><div className="min-w-0 flex-1"><input aria-label="Nom de la composition" className="w-full bg-transparent text-base font-black outline-none" value={step.name} onChange={event=>updateStep(step.id,{name:event.target.value})} /><input aria-label="Question posée au client" className="mt-1 w-full bg-transparent text-[10px] font-semibold text-[#7f8981] outline-none" value={step.question} onChange={event=>updateStep(step.id,{question:event.target.value})} /></div><div className="flex gap-1"><button type="button" onClick={()=>moveStep(index,-1)} disabled={index===0} className="grid h-9 w-9 place-items-center rounded-lg bg-[#f1f3ef] text-xs font-black disabled:opacity-25">↑</button><button type="button" onClick={()=>moveStep(index,1)} disabled={index===menuSteps.length-1} className="grid h-9 w-9 place-items-center rounded-lg bg-[#f1f3ef] text-xs font-black disabled:opacity-25">↓</button><button type="button" onClick={()=>setDraft(current=>({...current,optionGroups:current.optionGroups.filter(item=>item.id!==step.id)}))} className="grid h-9 w-9 place-items-center rounded-lg bg-[#fff0ec] text-xs font-black text-[#d6503d]">×</button></div></div><div className="mt-3 flex flex-wrap items-center gap-2"><button type="button" onClick={()=>updateStep(step.id,{required:!step.required,min:step.required?0:1})} className={`rounded-full px-3 py-1.5 text-[9px] font-black ${step.required?'bg-[#e8f7ec] text-[#27894a]':'bg-[#eef1ed] text-[#7d867e]'}`}>{step.required?'✓ Choix obligatoire':'Choix facultatif'}</button><span className="text-[9px] font-bold text-[#8b948c]">{step.options.length} option{step.options.length!==1?'s':''}</span></div>{isSize?<div className="mt-4"><div className="flex gap-2"><input id={`new-size-${step.id}`} aria-label="Nouvelle taille" className={fieldClass} placeholder="Ex. Taille classique, Taille XL…" onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();const input=event.currentTarget;if(input.value.trim()){updateStep(step.id,{options:[...step.options,{id:Date.now(),name:input.value.trim(),priceDelta:0,posCode:'',available:true}]});input.value='';}}}} /><button type="button" onClick={()=>{const input=document.getElementById(`new-size-${step.id}`) as HTMLInputElement|null;if(input?.value.trim()){updateStep(step.id,{options:[...step.options,{id:Date.now(),name:input.value.trim(),priceDelta:0,posCode:'',available:true}]});input.value='';}}} className="shrink-0 rounded-xl bg-[#0b1f14] px-4 text-[10px] font-black text-white">＋ Créer la taille</button></div><p className="mt-2 text-[9px] text-[#8c958d]">Les tailles sont automatiquement affichées de la plus petite à la plus grande.</p><div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{shownOptions.map((option,optionIndex)=><div key={option.id} className="relative rounded-2xl border border-[#dfe5dc] bg-[#fafbf8] p-4"><span className="text-[9px] font-black text-[#ff5a36]">TAILLE {optionIndex+1}</span><input className="mt-2 w-full bg-transparent text-sm font-black outline-none" value={option.name} onChange={event=>updateStepOption(step.id,option.id,{name:event.target.value})} /><label className="mt-3 flex items-center gap-2 text-[9px] font-bold text-[#7b847d]">Supplément <input className="h-8 w-20 rounded-lg border border-[#dfe4dc] px-2 text-right text-[10px] font-black" type="number" min="0" step="0.1" value={option.priceDelta} onChange={event=>updateStepOption(step.id,option.id,{priceDelta:Number(event.target.value)})} /> €</label><button type="button" onClick={()=>updateStep(step.id,{options:step.options.filter(item=>item.id!==option.id)})} aria-label={`Supprimer ${option.name}`} className="absolute right-3 top-3 text-xs font-black text-[#d6503d]">×</button></div>)}</div></div>:sourceProducts.length?<div className="mt-4"><p className="mb-3 text-[9px] font-black uppercase tracking-wider text-[#8a938b]">Produits disponibles dans la carte</p><div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{sourceProducts.map(product=>{const selected=step.options.some(option=>option.name===product.name);return <button type="button" key={product.id} onClick={()=>toggleCatalogOption(step.id,product)} className={`flex min-h-24 items-center gap-3 rounded-2xl border p-3 text-left transition ${selected?'border-[#35a85a] bg-[#eef9f1]':'border-[#e1e6df] bg-[#fafbf8] hover:border-[#ff9e87]'}`}><span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl bg-white text-3xl">{product.emoji}</span><span className="min-w-0"><strong className="block truncate text-xs">{product.name}</strong><small className="mt-1 block text-[9px] text-[#899289]">{product.available?'Disponible':'Masqué'} · {product.posCode||'Code POS à définir'}</small><span className={`mt-2 inline-block rounded-full px-2 py-1 text-[8px] font-black ${selected?'bg-[#35a85a] text-white':'bg-white text-[#687169]'}`}>{selected?'✓ Inclus dans le menu':'＋ Ajouter'}</span></span></button>})}</div></div>:<div className="mt-4 rounded-xl border border-dashed border-[#d5dcd3] bg-[#fafbf8] p-4 text-center"><p className="text-[10px] font-black text-[#737d75]">Aucun produit correspondant dans la carte</p><p className="mt-1 text-[9px] text-[#969e97]">Créez d’abord les produits de cette famille, puis revenez les sélectionner ici.</p><button type="button" onClick={()=>addStepOption(step.id)} className="mt-3 text-[10px] font-black text-[#ff5a36]">＋ Ajouter une option manuellement</button></div>}{!isSize&&step.options.filter(option=>!sourceProducts.some(product=>product.name===option.name)).length>0&&<div className="mt-3 flex flex-wrap gap-2">{step.options.filter(option=>!sourceProducts.some(product=>product.name===option.name)).map(option=><span key={option.id} className="rounded-full bg-[#f1f3ef] px-3 py-2 text-[9px] font-black">{option.name} <button type="button" onClick={()=>updateStep(step.id,{options:step.options.filter(item=>item.id!==option.id)})} className="ml-2 text-[#d6503d]">×</button></span>)}</div>}</div>})}</div>
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
  const [productDraft, setProductDraft] = useState<ProductDraft>({ name: '', detail: '', category: 'Menus', subcategory: 'Bœuf', price: 0, posCode: '', emoji: '🍽️', ingredients: [], available: true, productType: 'simple', variants: [], optionGroups: [], modifiers: [] });
  const [activeSubcategory, setActiveSubcategory] = useState('Tous');
  const [newIngredient, setNewIngredient] = useState('');
  const [published, setPublished] = useState(true);
  const [notice, setNotice] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const visibleSubcategories = subcategoryTemplates[activeCategory] ?? [];
  const filteredProducts = products.filter(product => (activeCategory === 'Toutes' || product.category === activeCategory) && (activeSubcategory === 'Tous' || !visibleSubcategories.length || product.subcategory === activeSubcategory) && `${product.name} ${product.detail} ${product.posCode}`.toLowerCase().includes(query.toLowerCase()));
  const activeCount = products.filter(product => product.available).length;
  useEffect(()=>setActiveSubcategory('Tous'),[activeCategory]);

  const renderProductCard = (product: CatalogProduct) => <article key={product.id} className="group overflow-hidden rounded-[20px] border border-[#e4e8e1] bg-white transition hover:-translate-y-0.5 hover:border-[#ff9e87] hover:shadow-lg"><button onClick={()=>openProductEditor(product)} className="w-full text-left"><div className="relative grid h-32 place-items-center bg-gradient-to-br from-[#f8f9f6] to-[#edf1eb]"><span className="text-6xl">{product.emoji}</span><span className={`absolute right-3 top-3 rounded-full px-2 py-1 text-[9px] font-black ${product.available?'bg-[#dff5e5] text-[#27894a]':'bg-[#e4e7e3] text-[#737c74]'}`}>{product.available?'Disponible':'Masqué'}</span></div><div className="p-4"><p className="text-[9px] font-black uppercase tracking-wider text-[#999f99]">{product.category}{product.subcategory?` · ${product.subcategory}`:''}</p><h3 className="mt-1 truncate text-base font-black">{product.name}</h3><p className="mt-1 line-clamp-2 min-h-8 text-[11px] leading-relaxed text-[#7b847d]">{product.detail||'Description à compléter'}</p><div className="mt-4 flex items-end justify-between"><div><p className="text-lg font-black">{money.format(product.price)}</p><p className="font-mono text-[9px] text-[#9ca39d]">{product.posCode||'Code POS manquant'}</p></div><span className="text-[10px] font-black text-[#ff5a36]">Modifier →</span></div></div></button></article>;

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
      setProductDraft({ name: product.name, detail: product.detail, category: product.category, subcategory: product.subcategory ?? subcategoryTemplates[product.category]?.[1] ?? '', price: product.price, posCode: product.posCode, emoji: product.emoji, ingredients: product.ingredientSettings ?? (product.ingredients ?? []).map((name,index)=>({ id: product.id*1000+index, name, removable: !/pain/i.test(name), extraAllowed: !/pain|sauce/i.test(name), extraPrice: 0 })), available: product.available, productType: isMenuCategory ? 'menu' : product.productType ?? 'simple', variants: product.variants ?? [], optionGroups: normalizedSteps, modifiers: product.modifiers ?? [] });
    } else {
      const defaultCategory = activeCategory === 'Toutes' ? categories[0]?.name ?? '' : activeCategory;
      setProductEditor('new');
      setProductDraft({ name: '', detail: '', category: defaultCategory, subcategory: subcategoryTemplates[defaultCategory]?.[1] ?? '', price: 0, posCode: '', emoji: '🍽️', ingredients: [], available: true, productType: 'simple', variants: [], optionGroups: [], modifiers: [] });
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
  const updateIngredient = (id:number, patch:Partial<ProductIngredient>) => setProductDraft(current=>({...current,ingredients:current.ingredients.map(ingredient=>ingredient.id===id?{...ingredient,...patch}:ingredient)}));
  const moveIngredient = (index:number, direction:-1|1) => setProductDraft(current=>{const target=index+direction;if(target<0||target>=current.ingredients.length)return current;const ingredients=[...current.ingredients];[ingredients[index],ingredients[target]]=[ingredients[target],ingredients[index]];return {...current,ingredients};});
  const saveProduct = () => {
    if (!productDraft.name.trim() || !productDraft.category || productDraft.price < 0) return;
    const ingredientSettings = productDraft.category === 'Burgers' ? (productDraft.ingredients as ProductIngredient[]).filter(ingredient=>ingredient.name.trim()).map(ingredient=>({...ingredient,name:ingredient.name.trim()})) : [];
    const ingredients = ingredientSettings.map(ingredient=>ingredient.name);
    const ingredientModifiers: ProductModifier[] = ingredientSettings.flatMap(ingredient=>[
      ...(ingredient.removable?[{id:ingredient.id*10+1,name:`Sans ${ingredient.name}`,kind:'remove' as const,priceDelta:0}]:[]),
      ...(ingredient.extraAllowed?[{id:ingredient.id*10+2,name:`Supplément ${ingredient.name}`,kind:'add' as const,priceDelta:ingredient.extraPrice}]:[]),
    ]);
    if (productEditor === 'new') {
      const id = Date.now();
      setProducts(current => [...current, { id, productId: `product_${id}`, name: productDraft.name.trim(), detail: productDraft.detail.trim(), category: productDraft.category, subcategory: productDraft.subcategory || undefined, price: productDraft.price, posCode: productDraft.posCode.trim() || `NEW-${current.length + 1}`, emoji: productDraft.emoji || '🍽️', ingredients, ingredientSettings, available: productDraft.available, productType: productDraft.productType, variants: productDraft.variants, optionGroups: productDraft.optionGroups, modifiers: ingredientModifiers }]);
    } else if (typeof productEditor === 'number') {
      setProducts(current => current.map(product => product.id === productEditor ? { ...product, name: productDraft.name.trim(), detail: productDraft.detail.trim(), category: productDraft.category, subcategory: productDraft.subcategory || undefined, price: productDraft.price, posCode: productDraft.posCode.trim(), emoji: productDraft.emoji || '🍽️', ingredients, ingredientSettings, available: productDraft.available, productType: productDraft.productType, variants: productDraft.variants, optionGroups: productDraft.optionGroups, modifiers: ingredientModifiers } : product));
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
          <div className="flex items-start gap-4"><span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-[#f5e6d0] text-sm font-black text-[#8b2a16]">BK</span><div><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-black">Modèle Burger King France</h2><span className="rounded-full bg-[#e7f6eb] px-2.5 py-1 text-[9px] font-black text-[#27894a]">SOURCE PUBLIQUE VÉRIFIÉE</span></div><p className="mt-1 max-w-3xl text-xs leading-relaxed text-[#788179]">Structure des catégories et sélection de produits reprises de la carte publique actuelle. Les prix, codes POS et disponibilités restent volontairement à valider par chaque restaurant.</p><div className="mt-3 flex flex-wrap gap-2 text-[9px] font-black text-[#747d75]"><span className="rounded-full bg-[#f1f3ef] px-3 py-1.5">12 catégories</span><span className="rounded-full bg-[#f1f3ef] px-3 py-1.5">41 produits modèles</span><span className="rounded-full bg-[#f1f3ef] px-3 py-1.5">Menus configurables</span><span className="rounded-full bg-[#f1f3ef] px-3 py-1.5">Composition Whopper®</span></div></div></div>
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
const quickMasterProducts = createMasterProducts('quick',[
  ['Menu Suprême Bacon','Menus','Burger, accompagnement, boisson et sauce au choix','🍔'],['Menu Giant','Menus','Le menu emblématique Quick','🍔'],['Menu Long Bacon','Menus','Burger Long Bacon en formule','🍔'],['Suprême Bacon','Burgers','Bœuf, bacon, cheddar, salade et sauce','🍔'],['Giant','Burgers','Double viande, salade et sauce Giant','🍔'],['Long Chicken','Burgers','Poulet croustillant et sauce','🍗'],['Moyenne frite','Accompagnements','Frites croustillantes','🍟'],['Moyenne Rustique','Accompagnements','Pommes de terre rustiques','🥔'],['Petite salade','Accompagnements','Salade fraîche','🥗'],['Coca-Cola','Boissons','Boisson fraîche','🥤'],['Eau minérale','Boissons','Bouteille d’eau','💧'],['Sauce Giant','Sauces','Sauce emblématique Quick','🥫'],['Sauce barbecue','Sauces','Sauce barbecue fumée','🥫'],['Magic Box','Menus enfants','Menu enfant avec plat et surprise','🎁']],2000);
const kfcMasterProducts = createMasterProducts('kfc',[
  ['Menu Colonel Original','Menus','Burger, accompagnement, boisson et sauce','🍔'],['Menu Tower','Menus','Tower en formule complète','🍔'],['Menu Tenders','Menus','Tenders, accompagnement et boisson','🍗'],['Colonel Original','Burgers','Poulet pané, salade et sauce Colonel','🍔'],['Tower','Burgers','Poulet, galette de pomme de terre et fromage','🍔'],['Boxmaster','Burgers','Wrap généreux au poulet croustillant','🌯'],['Tenders x5','Poulet','Filets de poulet croustillants','🍗'],['Hot Wings x8','Poulet','Ailes de poulet épicées','🍗'],['Frites','Accompagnements','Frites dorées','🍟'],['Cobette','Accompagnements','Épi de maïs','🌽'],['Pepsi','Boissons','Boisson fraîche','🥤'],['Lipton Ice Tea','Boissons','Thé glacé','🥤'],['Sauce Colonel','Sauces','Sauce signature KFC','🥫'],['Sauce barbecue','Sauces','Sauce barbecue','🥫'],['P’tit Bucket','Menus enfants','Menu enfant complet','🎁']],3000);
const initialMasterBrands:MasterBrand[] = [
  {id:'bk',name:'Burger King France',short:'BK',color:'#c83a20',soft:'#fff0e8',version:1,status:'Publié',restaurants:184,updated:'Aujourd’hui',products:burgerKingCatalogTemplate.map(product=>({...product,available:true}))},
  {id:'quick',name:'Quick France',short:'Q',color:'#f4c531',soft:'#fff8d9',version:1,status:'Brouillon',restaurants:52,updated:'Aujourd’hui',products:quickMasterProducts},
  {id:'kfc',name:'KFC France',short:'KFC',color:'#d71920',soft:'#fff0f0',version:1,status:'Brouillon',restaurants:326,updated:'Aujourd’hui',products:kfcMasterProducts},
];

function BackOfficePanel() {
  const [brands,setBrands]=useState<MasterBrand[]>(initialMasterBrands);
  const [selectedBrandId,setSelectedBrandId]=useState<MasterBrand['id']|null>(null);
  const [view,setView]=useState<'catalog'|'versions'|'restaurants'>('catalog');
  const [category,setCategory]=useState('Toutes');
  const [query,setQuery]=useState('');
  const [preview,setPreview]=useState(false);
  const [notice,setNotice]=useState('');
  const [editingProduct,setEditingProduct]=useState<CatalogProduct|null>(null);
  const [creatingProduct,setCreatingProduct]=useState(false);
  const [draft,setDraft]=useState({name:'',category:'Menus',detail:'',emoji:'🍔'});
  const brand=brands.find(item=>item.id===selectedBrandId)??null;
  const categories=brand?Array.from(new Set(brand.products.map(product=>product.category))):[];
  const displayed=brand?brand.products.filter(product=>(category==='Toutes'||product.category===category)&&`${product.name} ${product.detail}`.toLowerCase().includes(query.toLowerCase())):[];
  const updateBrand=(id:MasterBrand['id'],patch:Partial<MasterBrand>)=>setBrands(current=>current.map(item=>item.id===id?{...item,...patch}:item));
  const publish=()=>{if(!brand)return;updateBrand(brand.id,{version:brand.version+1,status:'Publié',updated:'À l’instant'});setNotice(`✓ Version v${brand.version+1} publiée et prête pour les restaurants ${brand.short}.`);window.setTimeout(()=>setNotice(''),3200);};
  const archive=()=>{if(!brand)return;updateBrand(brand.id,{status:'Archivé',updated:'À l’instant'});setNotice('Catalogue archivé. Les restaurants conservent leur dernière version publiée.');};
  const startCreate=()=>{setDraft({name:'',category:category==='Toutes'?(categories[0]??'Menus'):category,detail:'',emoji:'🍔'});setCreatingProduct(true);setEditingProduct(null);};
  const startEdit=(product:CatalogProduct)=>{setDraft({name:product.name,category:product.category,detail:product.detail,emoji:product.emoji});setEditingProduct(product);setCreatingProduct(false);};
  const saveProduct=()=>{if(!brand||!draft.name.trim())return;const products=editingProduct?brand.products.map(product=>product.id===editingProduct.id?{...product,...draft}:product):[...brand.products,{id:Date.now(),productId:`master_${brand.id}_${Date.now()}`,name:draft.name.trim(),category:draft.category,detail:draft.detail,emoji:draft.emoji||'🍽️',price:0,posCode:'',available:true,productType:draft.category==='Menus'?'menu':'simple'} as CatalogProduct];updateBrand(brand.id,{products,status:'Brouillon',updated:'Modifié à l’instant'});setEditingProduct(null);setCreatingProduct(false);};
  const addCategory=()=>{if(!brand)return;const name=window.prompt('Nom de la nouvelle catégorie');if(!name?.trim())return;setCategory(name.trim());startCreate();setDraft(current=>({...current,category:name.trim()}));};
  if(!brand)return <div><SectionHeading eyebrow="Administration plateforme" title="Back-office des enseignes" description="Gérez les catalogues maîtres nationaux qui seront attribués automatiquement aux restaurants lors de leur création." action={<span className="rounded-full bg-[#fff0ec] px-4 py-2 text-[10px] font-black text-[#d84d32]">ACCÈS SUPER ADMIN</span>} /><div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['Enseignes','3','Catalogues séparés'],['Produits maîtres',String(brands.reduce((sum,item)=>sum+item.products.length,0)),'Toutes enseignes'],['Restaurants',String(brands.reduce((sum,item)=>sum+item.restaurants,0)),'Rattachés aux catalogues'],['Publications',String(brands.filter(item=>item.status==='Publié').length),'Versions actives']].map(([label,value,detail])=><div key={label} className={`${panelCard} p-5`}><p className="text-[9px] font-black uppercase tracking-wider text-[#939b94]">{label}</p><p className="mt-2 text-2xl font-black">{value}</p><p className="mt-1 text-[10px] font-bold text-[#7e8780]">{detail}</p></div>)}</div><div className="grid gap-5 lg:grid-cols-3">{brands.map(item=><button key={item.id} onClick={()=>{setSelectedBrandId(item.id);setCategory('Toutes');setView('catalog');}} className="group overflow-hidden rounded-[28px] border border-[#dfe4dc] bg-white text-left shadow-sm transition hover:-translate-y-1 hover:shadow-xl"><div className="h-2" style={{background:item.color}}/><div className="p-6"><div className="flex items-start justify-between"><span className="grid h-16 w-16 place-items-center rounded-2xl text-lg font-black" style={{background:item.soft,color:item.color}}>{item.short}</span><span className={`rounded-full px-3 py-1.5 text-[9px] font-black ${item.status==='Publié'?'bg-[#e5f6e9] text-[#27894a]':'bg-[#fff5d9] text-[#a86f00]'}`}>{item.status}</span></div><h2 className="mt-5 text-xl font-black">{item.name}</h2><p className="mt-1 text-xs text-[#7f8981]">Catalogue maître France · version v{item.version}</p><div className="mt-5 grid grid-cols-3 gap-2 border-t border-[#edf0eb] pt-4 text-center"><div><strong className="block text-lg">{new Set(item.products.map(product=>product.category)).size}</strong><small className="text-[9px] text-[#8a938b]">Catégories</small></div><div><strong className="block text-lg">{item.products.length}</strong><small className="text-[9px] text-[#8a938b]">Produits</small></div><div><strong className="block text-lg">{item.restaurants}</strong><small className="text-[9px] text-[#8a938b]">Restaurants</small></div></div><span className="mt-5 flex items-center justify-between text-xs font-black" style={{color:item.color}}>Ouvrir le catalogue <span>→</span></span></div></button>)}</div></div>;
  return <div><button onClick={()=>setSelectedBrandId(null)} className="mb-4 text-xs font-black text-[#69736b]">← Toutes les enseignes</button><SectionHeading eyebrow="Catalogue maître national" title={brand.name} description={`Structure officielle partagée avec ${brand.restaurants} restaurants. Les adaptations locales resteront séparées lors de la connexion à Supabase.`} action={<div className="flex flex-wrap gap-2"><button onClick={()=>setPreview(true)} className="rounded-xl border border-[#dce2da] bg-white px-4 py-3 text-xs font-black">Prévisualiser</button><button onClick={publish} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">Publier v{brand.version+1}</button></div>} />{notice&&<div className="mb-4 rounded-2xl border border-[#bee4c9] bg-[#e8f8ed] px-5 py-4 text-xs font-black text-[#257c43]">{notice}</div>}<div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[['Version',`v${brand.version}`,brand.status],['Catégories',String(categories.length),'Structure nationale'],['Produits',String(brand.products.length),'Fiches maîtres'],['Restaurants',String(brand.restaurants),'Héritent de cette carte']].map(([label,value,detail])=><div key={label} className={`${panelCard} p-4`}><p className="text-[9px] font-black uppercase tracking-wider text-[#949c95]">{label}</p><p className="mt-2 text-xl font-black">{value}</p><p className="mt-1 text-[10px] text-[#7c857e]">{detail}</p></div>)}</div><div className="mb-5 flex gap-2 overflow-x-auto rounded-2xl border border-[#e1e6df] bg-white p-2">{([['catalog','Catalogue'],['versions','Versions & publication'],['restaurants','Restaurants rattachés']] as const).map(([id,label])=><button key={id} onClick={()=>setView(id)} className={`shrink-0 rounded-xl px-4 py-3 text-xs font-black ${view===id?'bg-[#0b1f14] text-white':'text-[#737d75]'}`}>{label}</button>)}</div>{view==='catalog'&&<section className={`${panelCard} overflow-hidden`}><div className="flex flex-col gap-3 border-b border-[#e5e9e2] p-5 lg:flex-row lg:items-center lg:justify-between"><div className="flex gap-2 overflow-x-auto">{['Toutes',...categories].map(item=><button key={item} onClick={()=>setCategory(item)} className={`shrink-0 rounded-full px-3 py-2 text-[10px] font-black ${category===item?'bg-[#ff5a36] text-white':'bg-[#f1f3ef] text-[#6e786f]'}`}>{item} <span className="opacity-60">{item==='Toutes'?brand.products.length:brand.products.filter(product=>product.category===item).length}</span></button>)}</div><div className="flex gap-2"><button onClick={addCategory} className="rounded-xl border border-[#dce2da] px-4 py-3 text-[10px] font-black">＋ Catégorie</button><button onClick={startCreate} className="rounded-xl bg-[#0b1f14] px-4 py-3 text-[10px] font-black text-white">＋ Produit</button></div></div><div className="p-5"><input className={`${fieldClass} max-w-md`} placeholder="Rechercher dans le catalogue maître…" value={query} onChange={event=>setQuery(event.target.value)} /><div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">{displayed.map(product=><button key={product.id} onClick={()=>startEdit(product)} className="overflow-hidden rounded-2xl border border-[#e3e7e1] bg-white text-left transition hover:border-[#ff9e87] hover:shadow-lg"><div className="grid h-28 place-items-center bg-[#f4f6f1] text-5xl">{product.emoji}</div><div className="p-4"><p className="text-[9px] font-black uppercase tracking-wider text-[#989f99]">{product.category}</p><h3 className="mt-1 truncate text-sm font-black">{product.name}</h3><p className="mt-1 line-clamp-2 min-h-8 text-[10px] leading-relaxed text-[#7e8780]">{product.detail}</p><span className="mt-3 inline-block text-[9px] font-black text-[#ff5a36]">Modifier la fiche →</span></div></button>)}</div></div></section>}{view==='versions'&&<section className={`${panelCard} p-6`}><div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Cycle de publication</p><h2 className="mt-2 text-xl font-black">Versions du catalogue</h2><p className="mt-1 text-xs text-[#7e8780]">Chaque publication crée une version immuable distribuable aux restaurants.</p></div><button onClick={publish} className="rounded-xl bg-[#0b1f14] px-5 py-3 text-xs font-black text-white">Publier une nouvelle version</button></div><div className="mt-6 space-y-3">{[brand.version,Math.max(1,brand.version-1)].map((version,index)=><div key={`${version}-${index}`} className="flex flex-wrap items-center gap-4 rounded-2xl border border-[#e2e7df] p-4"><span className="grid h-11 w-11 place-items-center rounded-xl bg-[#f1f3ef] text-xs font-black">v{version}</span><div className="min-w-0 flex-1"><p className="text-sm font-black">{index===0?'Version actuelle':'Version précédente'}</p><p className="mt-1 text-[10px] text-[#899189]">{brand.products.length} produits · {categories.length} catégories</p></div><span className={`rounded-full px-3 py-1.5 text-[9px] font-black ${index===0?'bg-[#e5f6e9] text-[#27894a]':'bg-[#f0f2ef] text-[#737c74]'}`}>{index===0?brand.status:'Archivée'}</span></div>)}</div><button onClick={archive} className="mt-6 text-xs font-black text-[#d6503d]">Archiver le catalogue maître</button></section>}{view==='restaurants'&&<section className={`${panelCard} p-6`}><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Déploiement réseau</p><h2 className="mt-2 text-xl font-black">Restaurants rattachés</h2><p className="mt-1 text-xs text-[#7e8780]">Aperçu du futur rattachement multi-tenant. Les données sont simulées jusqu’à la phase Supabase.</p><div className="mt-6 grid gap-3 md:grid-cols-2">{['Paris République','Nantes Paridis','Lyon Part-Dieu','Lille Centre'].map((name,index)=><div key={name} className="flex items-center gap-3 rounded-2xl border border-[#e2e7df] p-4"><span className="grid h-10 w-10 place-items-center rounded-xl text-xs font-black" style={{background:brand.soft,color:brand.color}}>{brand.short}</span><div className="flex-1"><p className="text-xs font-black">{brand.short} {name}</p><p className="mt-1 text-[9px] text-[#8c958d]">Version v{brand.version} · {index===2?'Action requise':'Synchronisé'}</p></div><span className={`h-2.5 w-2.5 rounded-full ${index===2?'bg-[#e3a022]':'bg-[#35a85a]'}`} /></div>)}</div></section>}{(creatingProduct||editingProduct)&&<div className="fixed inset-0 z-[70] grid place-items-center bg-[#07130d]/60 p-4" role="dialog" aria-modal="true"><div className="w-full max-w-xl rounded-[28px] bg-white p-6 shadow-2xl"><div className="flex items-start justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest text-[#ff5a36]">Fiche maître</p><h2 className="mt-1 text-2xl font-black">{editingProduct?'Modifier le produit':'Créer un produit'}</h2></div><button onClick={()=>{setCreatingProduct(false);setEditingProduct(null);}} className="grid h-9 w-9 place-items-center rounded-xl bg-[#f0f3ee] font-black">×</button></div><div className="mt-5 grid gap-3 sm:grid-cols-[80px_1fr]"><label className="text-xs font-bold text-[#68736a]">Visuel<input className={`${fieldClass} mt-2 text-center text-xl`} value={draft.emoji} maxLength={3} onChange={event=>setDraft(current=>({...current,emoji:event.target.value}))}/></label><label className="text-xs font-bold text-[#68736a]">Nom du produit<input className={`${fieldClass} mt-2`} value={draft.name} onChange={event=>setDraft(current=>({...current,name:event.target.value}))}/></label></div><label className="mt-4 block text-xs font-bold text-[#68736a]">Catégorie<input className={`${fieldClass} mt-2`} value={draft.category} onChange={event=>setDraft(current=>({...current,category:event.target.value}))}/></label><label className="mt-4 block text-xs font-bold text-[#68736a]">Description<textarea className="mt-2 min-h-24 w-full rounded-xl border border-[#dfe4dc] p-3 text-sm font-semibold outline-none" value={draft.detail} onChange={event=>setDraft(current=>({...current,detail:event.target.value}))}/></label><div className="mt-6 flex justify-end gap-2"><button onClick={()=>{setCreatingProduct(false);setEditingProduct(null);}} className="rounded-xl border border-[#dfe4dc] px-4 py-3 text-xs font-black">Annuler</button><button onClick={saveProduct} className="rounded-xl bg-[#ff5a36] px-5 py-3 text-xs font-black text-white">Enregistrer en brouillon</button></div></div></div>}{preview&&<div className="fixed inset-0 z-[70] overflow-y-auto bg-[#07130d]/70 p-4" role="dialog" aria-modal="true"><div className="mx-auto max-w-6xl rounded-[28px] bg-white p-6"><div className="flex items-center justify-between"><div><p className="text-[10px] font-black uppercase tracking-widest" style={{color:brand.color}}>Prévisualisation nationale</p><h2 className="mt-1 text-2xl font-black">Carte {brand.name}</h2></div><button onClick={()=>setPreview(false)} className="grid h-10 w-10 place-items-center rounded-xl bg-[#f0f3ee] font-black">×</button></div>{categories.map(item=><section key={item} className="mt-7"><h3 className="border-b pb-2 text-lg font-black">{item}</h3><div className="mt-4 grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">{brand.products.filter(product=>product.category===item).map(product=><div key={product.id} className="rounded-2xl bg-[#f5f6f1] p-4"><span className="text-4xl">{product.emoji}</span><p className="mt-3 text-sm font-black">{product.name}</p><p className="mt-1 text-[10px] text-[#7d867e]">{product.detail}</p></div>)}</div></section>)}</div></div>}</div>;
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
  const [enterpriseCatalog, setEnterpriseCatalog] = useState<CatalogProduct[]>(initialCatalog);
  const [agentWelcome, setAgentWelcome] = useState("Bonjour et bienvenue chez Burger King Paris République. Que puis-je préparer pour vous aujourd'hui ?");
  const [agentRules, setAgentRules] = useState<Array<[string, boolean]>>(initialAgentRules);
  const active = workspaceTabs.find(tab => tab.id === activeTab) ?? workspaceTabs[0];
  return (
    <div className="min-h-screen bg-[#f4f6f1] text-[#132018] lg:grid lg:grid-cols-[268px_1fr]">
      <aside className="border-b border-[#223a2c] bg-[#0b1f14] text-white lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between px-5 py-5 lg:block lg:px-6 lg:py-7"><div className="flex items-center gap-3"><span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#ff5a36] text-lg font-black">D</span><div><p className="font-black tracking-[-.04em]">DRIVE<span className="text-[#ff7556]">VOICE</span></p><p className="text-[9px] font-bold uppercase tracking-[.18em] text-white/45">Enterprise OS</p></div></div><span className="rounded-full bg-[#173625] px-3 py-1 text-[9px] font-black uppercase text-[#68d48a]">● Live</span></div>
        <div className="hidden px-6 lg:block"><div className="rounded-2xl border border-white/10 bg-white/5 p-4"><p className="text-[9px] font-black uppercase tracking-[.17em] text-white/40">Établissement actif</p><p className="mt-2 text-sm font-black">BK Paris République</p><p className="mt-1 text-[10px] text-white/45">Drive n°04 · Voie A</p><button className="mt-3 text-[10px] font-black text-[#ffc647]">Changer d’établissement⌄</button></div></div>
        <nav className="flex gap-1 overflow-x-auto px-3 pb-4 lg:mt-7 lg:block lg:space-y-1 lg:overflow-visible lg:px-4" aria-label="Espaces de travail DriveVoice">{workspaceTabs.map(tab=><button key={tab.id} onClick={()=>setActiveTab(tab.id)} className={`flex shrink-0 items-center gap-3 rounded-xl px-4 py-3 text-left text-xs font-black transition lg:w-full ${activeTab===tab.id?'bg-white text-[#102019] shadow-lg':'text-white/55 hover:bg-white/5 hover:text-white'}`}><span className={`grid h-8 w-8 place-items-center rounded-lg text-base ${activeTab===tab.id?'bg-[#ff5a36] text-white':'bg-white/5'}`}>{tab.icon}</span><span><span className="block">{tab.short}</span><span className={`hidden text-[9px] font-semibold lg:block ${activeTab===tab.id?'text-[#6f7972]':'text-white/30'}`}>{tab.label}</span></span></button>)}</nav>
        <div className="absolute bottom-6 left-4 right-4 hidden rounded-2xl border border-white/10 p-4 lg:block"><div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-full bg-[#ffc647] text-xs font-black text-[#172019]">AM</span><div><p className="text-xs font-black">Alex Martin</p><p className="text-[9px] text-white/40">Administrateur réseau</p></div></div></div>
      </aside>
      <main className="min-w-0"><header className="sticky top-0 z-30 flex items-center justify-between border-b border-[#e1e5de] bg-[#f4f6f1]/90 px-5 py-4 backdrop-blur-xl md:px-8"><div><p className="text-[10px] font-black uppercase tracking-[.2em] text-[#8a938c]">DriveVoice / {active.short}</p><p className="mt-1 text-sm font-black">{active.label}</p></div><div className="flex items-center gap-3"><span className="hidden rounded-full border border-[#dce2da] bg-white px-3 py-2 text-[10px] font-black text-[#2b8c4d] md:inline">● Tous les systèmes opérationnels</span><button aria-label="Notifications" className="grid h-10 w-10 place-items-center rounded-xl border border-[#dce2da] bg-white">•</button></div></header>
        {activeTab === 'order' ? <OrderWorkspace products={enterpriseCatalog} agentWelcome={agentWelcome} agentRules={agentRules} /> : <div className="mx-auto max-w-[1500px] p-5 md:p-8">{activeTab === 'dashboard' && <DashboardPanel />}{activeTab === 'integrations' && <IntegrationsPanel />}{activeTab === 'catalog' && <RestaurantMenuBuilderPanel products={enterpriseCatalog} setProducts={setEnterpriseCatalog} />}{activeTab === 'agent' && <AgentPanel welcome={agentWelcome} setWelcome={setAgentWelcome} />}{activeTab === 'backoffice' && <BackOfficePanel />}</div>}
      </main>
    </div>
  );
}
