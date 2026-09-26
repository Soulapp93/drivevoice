import WebSocket from 'ws';
import fs from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const envRaw = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envRaw.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const apiKey = process.env.OPENAI_API_KEY;
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const RESTAURANT_ID = '31065664-a449-4fe3-a311-de880b436726';

const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
const { data, error } = await supabase.rpc('voice_tool_get_catalog', { p_restaurant_id: RESTAURANT_ID });
if (error) {
  console.error('catalog error', error.message);
  process.exit(1);
}
const catalog = (Array.isArray(data) ? data : []).filter((r) => r && r.available !== false && typeof r.name === 'string');
console.log('catalog products:', catalog.length);
const productIds = catalog.map((r) => String(r.productId));

const model = 'gpt-realtime-2.1';
const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});

const productIdSchema = { type: 'string', enum: productIds };
const selectionSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: { group: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } },
    required: ['group', 'options'],
    additionalProperties: false,
  },
};
const tools = [
  {
    type: 'function',
    name: 'add_item',
    description: "Ajoute immédiatement un produit au panier du client. À utiliser dès que le client demande un article.",
    parameters: {
      type: 'object',
      properties: { product_id: productIdSchema, quantity: { type: 'integer', minimum: 1, maximum: 20 }, selections: selectionSchema },
      required: ['product_id', 'quantity'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'confirm_order_intent',
    description: "Valide le panier actuel sans l'envoyer au restaurant, et retourne un résumé.",
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'submit_order',
    description: "Transmet une seule fois au restaurant une commande explicitement confirmée par le client.",
    parameters: { type: 'object', properties: { confirmation: { type: 'string', enum: ['explicit'] } }, required: ['confirmation'], additionalProperties: false },
  },
];

const catalogLines = catalog
  .slice(0, 40)
  .map((entry) => `- ${entry.productId} : ${entry.name} — ${Number(entry.price ?? 0).toFixed(2)} €`)
  .join('\n');

const instructions = `Tu es DriveVoice, un équipier français qui prend les commandes au drive de Burger King Loire.
OBJECTIF
- Prends la commande en français, naturellement, avec des phrases courtes adaptées à un drive.
- Ne récite pas de longs paragraphes. Pose une seule question à la fois.
CARTE OFFICIELLE (extrait)
${catalogLines}
RÈGLES DU PANIER — OBLIGATOIRES
- Quand le client demande un produit, utilise IMMÉDIATEMENT l'outil add_item avec le product_id exact et la quantité.
- Après chaque add_item, confirme brièvement à l'oral ce qui vient d'être fait.
- Après cette confirmation, demande toujours exactement : "Votre commande est-elle complète ?" Une seule question, puis attends la réponse.`;

const session = {
  type: 'realtime',
  model,
  output_modalities: ['audio'],
  max_output_tokens: 4096,
  instructions,
  audio: {
    input: {
      transcription: {
        model: 'gpt-live-transcribe',
        languages: ['fr'],
        delay: 'low',
        keywords: ['DriveVoice', 'Burger King', 'Whopper', 'frites', 'menu', 'boisson', 'c’est tout', 'je confirme'],
        prompt: 'Commande Burger King en français : Whopper, Big King, menus, burgers, nuggets, frites, sauces, desserts, boissons, confirmation et c’est tout.',
      },
      noise_reduction: { type: 'near_field' },
      turn_detection: {
        type: 'server_vad',
        threshold: 0.45,
        prefix_padding_ms: 300,
        silence_duration_ms: 550,
        create_response: false,
        interrupt_response: true,
      },
    },
    output: { voice: 'marin', speed: 1.04 },
  },
  tools,
  tool_choice: 'auto',
};

const send = (obj) => ws.send(JSON.stringify(obj));
const log = (label, obj) => console.log(`\n=== ${label} ===\n${JSON.stringify(obj)}`);
let stage = 0;
let basket = { items: [], total: 0 };
const handledCalls = new Set();

const userTurn = (text) => {
  send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
  send({ type: 'response.create', response: { output_modalities: ['audio'] } });
  console.log(`\n>>> USER TURN: "${text}" + response.create`);
};

ws.on('open', () => {
  console.log('WS connecté');
  send({ type: 'session.update', session });
});

ws.on('message', (raw) => {
  const evt = JSON.parse(raw.toString());
  const t = evt.type;
  if (t === 'response.output_audio.delta' || t === 'response.audio.delta' || t === 'response.audio_transcript.delta' || t === 'response.output_audio_transcript.delta') return;

  if (t === 'response.done' || t === 'response.failed' || t === 'response.cancelled') {
    const resp = evt.response ?? {};
    log(t, { status: resp.status, status_details: resp.status_details ?? null, usage: resp.usage ?? null, output_types: (resp.output ?? []).map((o) => o.type) });
  } else if (t === 'error') {
    log('ERROR', evt.error ?? evt);
  } else if (t === 'response.function_call_arguments.done') {
    log(t, { name: evt.item?.name, call_id: evt.call_id, arguments: evt.arguments });
  } else if (t === 'response.audio_transcript.done' || t === 'response.output_audio_transcript.done') {
    log(t, { text: evt.transcript ?? evt.text });
  } else {
    console.log(`--- ${t}`);
  }

  if (t === 'session.updated' && stage === 0) {
    stage = 1;
    send({ type: 'response.create', response: { output_modalities: ['audio'] } });
    console.log('\n>>> GREETING response.create');
  }

  if (t === 'response.done' && stage === 1) {
    stage = 2;
    setTimeout(() => userTurn('Un chicken louisiane.'), 400);
  }

  if (t === 'response.function_call_arguments.done' && !handledCalls.has(evt.call_id)) {
    handledCalls.add(evt.call_id);
    const name = evt.item?.name;
    setTimeout(() => {
      if (name === 'add_item') {
        const args = JSON.parse(evt.arguments || '{}');
        const product = catalog.find((p) => p.productId === args.product_id) ?? catalog[0];
        basket = { items: [{ productId: product.productId, name: product.name, price: Number(product.price), quantity: args.quantity ?? 1 }], total: Number(product.price) * (args.quantity ?? 1), status: 'editing' };
      }
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: evt.call_id, output: JSON.stringify({ success: true, data: basket, message: 'Panier mis à jour.' }) } });
      send({ type: 'response.create', response: { output_modalities: ['audio'] } });
      console.log(`\n>>> TOOL OUTPUT (${name}) + continuation response.create`);
      if (name === 'confirm_order_intent') stage = 5;
    }, 450);
  }

  if (t === 'response.done' && stage === 2) {
    const resp = evt.response ?? {};
    const hadTool = (resp.output ?? []).some((o) => o.type === 'function_call');
    if (!hadTool) {
      stage = 3;
      setTimeout(() => {
        send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Oui, c’est tout.' }] } });
        send({ type: 'response.create', response: { output_modalities: ['audio'], tool_choice: { type: 'function', name: 'confirm_order_intent' }, instructions: 'Le client vient d’indiquer que sa commande est terminée. Appelle maintenant confirm_order_intent sans parler avant le résultat de l’outil.' } });
        console.log('\n>>> USER TURN 2 (confirm forcé)');
      }, 400);
    }
  }

  if (t === 'response.done' && stage === 5) {
    console.log('\nSIMULATION COMPLETE - flux récapitulatif atteint');
    setTimeout(() => process.exit(0), 500);
  }
});

ws.on('error', (err) => {
  console.error('WS error', err.message);
});

setTimeout(() => {
  console.log('\nSIMULATION TIMEOUT - fin');
  process.exit(0);
}, 90000);
