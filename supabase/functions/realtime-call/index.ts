const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, authorization, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const realtimeTools = [
  {
    type: 'function',
    name: 'update_order',
    description: 'Synchronise le panier officiel après chaque modification.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              product_id: { type: 'string' },
              quantity: { type: 'integer', minimum: 1, maximum: 20 },
              selections: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    group: { type: 'string' },
                    options: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['group', 'options'],
                  additionalProperties: false,
                },
              },
            },
            required: ['product_id', 'quantity'],
            additionalProperties: false,
          },
        },
        status: { type: 'string', enum: ['editing', 'ready_to_confirm', 'confirmed'] },
      },
      required: ['items', 'status'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_basket',
    description: 'Récupère le panier officiel après une reconnexion.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    type: 'function',
    name: 'submit_order',
    description: 'Transmet une commande explicitement confirmée une seule fois.',
    parameters: {
      type: 'object',
      properties: { confirmation: { type: 'string', enum: ['explicit'] } },
      required: ['confirmation'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'request_human',
    description: 'Demande un transfert humain si la récupération échoue.',
    parameters: {
      type: 'object',
      properties: { reason: { type: 'string', minLength: 1, maxLength: 240 } },
      required: ['reason'],
      additionalProperties: false,
    },
  },
];

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders });

  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) return Response.json({ error: "L'agent vocal n'est pas configuré." }, { status: 500, headers: corsHeaders });

  const sdp = await request.text();
  if (!sdp.startsWith('v=0') || sdp.length > 100_000) {
    return Response.json({ error: 'Session audio invalide.' }, { status: 400, headers: corsHeaders });
  }

  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify({
    type: 'realtime',
    model: 'gpt-realtime-2.1-mini',
    output_modalities: ['audio'],
    max_output_tokens: 4096,
    instructions: 'Tu es DriveVoice, un équipier français qui prend les commandes au drive. Prends la commande naturellement, comprends les corrections et les interruptions, pose une seule question à la fois et ne récite pas de longs paragraphes.',
    audio: {
      input: {
        transcription: { model: 'gpt-live-transcribe', languages: ['fr'], delay: 'low' },
        noise_reduction: { type: 'near_field' },
        turn_detection: { type: 'server_vad', threshold: 0.45, prefix_padding_ms: 300, silence_duration_ms: 550, create_response: true, interrupt_response: true },
      },
      output: { voice: 'marin', speed: 1.04 },
    },
    tools: realtimeTools,
    tool_choice: 'auto',
  }));

  try {
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { ...corsHeaders, 'Content-Type': response.headers.get('content-type') || 'application/sdp' },
    });
  } catch {
    return Response.json({ error: "Le service vocal est momentanément indisponible." }, { status: 502, headers: corsHeaders });
  }
});