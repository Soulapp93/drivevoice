import WebSocket from 'ws';
import fs from 'node:fs';

const envRaw = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envRaw.split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const apiKey = process.env.OPENAI_API_KEY;
const model = 'gpt-realtime-2.1';
const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
  headers: { Authorization: `Bearer ${apiKey}` },
});

const session = {
  type: 'realtime',
  model,
  output_modalities: ['audio'],
  max_output_tokens: 4096,
  instructions: 'Tu es DriveVoice au drive Burger King. Réponds en une phrase courte.',
  audio: {
    input: {
      transcription: { model: 'gpt-live-transcribe', languages: ['fr'], delay: 'low' },
      turn_detection: { type: 'server_vad', threshold: 0.45, prefix_padding_ms: 300, silence_duration_ms: 550, create_response: false, interrupt_response: true },
    },
    output: { voice: 'marin', speed: 1.04 },
  },
  tools: [],
  tool_choice: 'auto',
};

const send = (o) => ws.send(JSON.stringify(o));
let stage = 0;
let noiseTimer = null;

const toneChunk = () => {
  const samples = 2400; // 100ms @24kHz
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const t = i / 24000;
    const v = Math.sin(2 * Math.PI * 300 * t) * 0.35 + Math.sin(2 * Math.PI * 700 * t) * 0.2;
    buf.writeInt16LE(Math.max(-1, Math.min(1, v)) * 32767, i * 2);
  }
  return buf.toString('base64');
};

const startNoise = () => {
  let n = 0;
  noiseTimer = setInterval(() => {
    send({ type: 'input_audio_buffer.append', audio: toneChunk() });
    if (++n >= 20) clearInterval(noiseTimer);
  }, 100);
};

ws.on('open', () => send({ type: 'session.update', session }));

ws.on('message', (raw) => {
  const evt = JSON.parse(raw.toString());
  const t = evt.type;
  if (t.includes('.delta')) return;
  if (t === 'response.done' || t === 'response.failed' || t === 'response.cancelled') {
    const r = evt.response ?? {};
    console.log(`\n=== ${t} === status=${r.status} details=${JSON.stringify(r.status_details ?? null)}`);
  } else if (t === 'error') {
    console.log(`\n=== ERROR === ${JSON.stringify(evt.error)}`);
  } else if (t === 'conversation.item.input_audio_transcription.completed') {
    console.log(`\n=== TRANSCRIPT === ${evt.transcript}`);
  } else {
    console.log(`--- ${t}`);
  }

  if (t === 'session.updated' && stage === 0) {
    stage = 1;
    send({ type: 'response.create', response: { output_modalities: ['audio'] } });
    console.log('\n>>> greeting create');
  }
  if (t === 'response.output_audio.done' && stage === 1) {
    stage = 2;
    console.log('\n>>> barge-in: envoie bruit audio');
    startNoise();
  }
  if (t === 'input_audio_buffer.speech_stopped' && stage === 2) {
    stage = 3;
    setTimeout(() => {
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Un whopper.' }] } });
      send({ type: 'response.create', response: { output_modalities: ['audio'] } });
      console.log('\n>>> turn create après barge-in');
    }, 600);
  }
  if (t === 'response.done' && stage === 3) {
    stage = 4;
    setTimeout(() => {
      send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Et des frites.' }] } });
      send({ type: 'response.create', response: { output_modalities: ['audio'] } });
      console.log('\n>>> second turn create');
    }, 600);
  }
});

setTimeout(() => {
  console.log('\nSIM TIMEOUT');
  process.exit(0);
}, 60000);
