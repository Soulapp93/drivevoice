import WebSocket from 'ws';
import fs from 'node:fs';

// Load .env.local manually (no dotenv dep needed)
const envRaw = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envRaw.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error('OPENAI_API_KEY manquant');
  process.exit(1);
}

const model = 'gpt-realtime-2.1-mini';
const url = `wss://api.openai.com/v1/realtime?model=${model}`;

const ws = new WebSocket(url, {
  headers: {
    Authorization: `Bearer ${apiKey}`,
  },
});

const tools = [
  {
    type: 'function',
    name: 'update_order',
    description: "Met à jour le panier officiel du client avec les articles complets.",
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              productId: { type: 'string' },
              quantity: { type: 'number' },
              customizations: { type: 'array', items: { type: 'object' } },
            },
            required: ['productId', 'quantity'],
          },
        },
        status: { type: 'string', enum: ['editing', 'ready_to_confirm', 'confirmed'] },
      },
      required: ['items', 'status'],
    },
  },
  {
    type: 'function',
    name: 'get_basket',
    description: 'Récupère le panier officiel actuel.',
    parameters: { type: 'object', properties: {} },
  },
];

const session = {
  type: 'realtime',
  model,
  output_modalities: ['audio'],
  max_output_tokens: 4096,
  instructions: `Tu es DriveVoice, un équipier français qui prend les commandes au drive de Burger King.
CARTE: signature_menu (12,90€), tenders_6 (8,50€), medium_fries (3,20€), zero_cola (2,80€).
Après chaque ajout, appelle update_order avec le panier complet.`,
  audio: {
    input: {
      transcription: { model: 'gpt-live-transcribe', languages: ['fr'] },
      turn_detection: { type: 'server_vad', threshold: 0.45, prefix_padding_ms: 300, silence_duration_ms: 550, create_response: true, interrupt_response: true },
    },
    output: { voice: 'marin', speed: 1.04 },
  },
  tools,
  tool_choice: 'auto',
};

let turn = 0;
let toolContinuationPending = false;
let responseDoneWaitingForTool = false;
let toolOutputSent = false;
const log = (label, obj) => console.log(`\n=== ${label} ===\n${JSON.stringify(obj, null, 2)}`);

ws.on('open', () => {
  console.log('WS connecté');
  ws.send(JSON.stringify({ type: 'session.update', session }));
});

ws.on('message', (raw) => {
  const evt = JSON.parse(raw.toString());
  if (evt.type === 'response.output_audio.delta' || evt.type === 'response.audio.delta') return; // trop verbeux
  log(evt.type, evt.type === 'response.done' || evt.type === 'error' || evt.type === 'response.function_call_arguments.done' ? evt : { type: evt.type });

  if (evt.type === 'session.updated' && turn === 0) {
    turn = 1;
    ws.send(JSON.stringify({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Bonjour, je voudrais un menu signature.' }] },
    }));
    ws.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['audio'] } }));
  }

  if (evt.type === 'response.function_call_arguments.done') {
    // Simule le backend qui répond après un court délai
    toolContinuationPending = true;
    toolOutputSent = false;
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: evt.call_id, output: JSON.stringify({ success: true, data: { items: [{ productId: 'signature_menu', quantity: 1, price: 12.9 }], total: 12.9, status: 'editing' } }) },
      }));
      toolOutputSent = true;
      if (responseDoneWaitingForTool) {
        responseDoneWaitingForTool = false;
        toolContinuationPending = false;
        ws.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['audio'] } }));
      }
    }, 300);
  }

  if (evt.type === 'response.done' && turn === 1) {
    if (toolContinuationPending) {
      if (toolOutputSent) {
        toolContinuationPending = false;
        ws.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['audio'] } }));
      } else {
        responseDoneWaitingForTool = true;
      }
      return;
    }
    turn = 2;
    setTimeout(() => {
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: "C'est tout, je confirme." }] },
      }));
      ws.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['audio'] } }));
    }, 500);
  } else if (evt.type === 'response.done' && turn >= 2) {
    setTimeout(() => { ws.close(); process.exit(0); }, 500);
  }

  if (evt.type === 'error') {
    console.error('ERREUR OPENAI:', JSON.stringify(evt, null, 2));
  }
});

ws.on('error', (err) => console.error('WS error', err));
ws.on('close', (code, reason) => console.log('WS fermé', code, reason?.toString()));

setTimeout(() => {
  console.log('Timeout diagnostic atteint, fermeture.');
  ws.close();
  process.exit(0);
}, 45_000);
