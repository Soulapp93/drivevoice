const supportedBrands = new Set(['Burger King', "McDonald's", 'Quick', 'KFC']);

const orderTool = {
  type: 'function',
  name: 'update_order',
  description:
    "Synchronise le panier affiché au client. Appelle cet outil après chaque ajout, retrait, modification ou confirmation, avec l'intégralité du panier actuel.",
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'Tous les produits présents dans le panier après la modification.',
        items: {
          type: 'object',
          properties: {
            product_id: {
              type: 'string',
              enum: ['signature_menu', 'tenders_6', 'medium_fries', 'zero_cola'],
            },
            quantity: { type: 'integer', minimum: 1, maximum: 20 },
          },
          required: ['product_id', 'quantity'],
          additionalProperties: false,
        },
      },
      status: {
        type: 'string',
        enum: ['editing', 'ready_to_confirm', 'confirmed'],
      },
    },
    required: ['items', 'status'],
    additionalProperties: false,
  },
};

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "L'agent vocal n'est pas configuré." }, { status: 500 });
  }

  const sdp = await request.text();
  if (!sdp.startsWith('v=0') || sdp.length > 100_000) {
    return Response.json({ error: 'Session audio invalide.' }, { status: 400 });
  }

  const requestedBrand = new URL(request.url).searchParams.get('brand') ?? '';
  const brand = supportedBrands.has(requestedBrand) ? requestedBrand : 'Burger King';
  const session = {
    type: 'realtime',
    model: 'gpt-realtime-2.1-mini',
    output_modalities: ['audio'],
    max_output_tokens: 700,
    instructions: `Tu es DriveVoice, un équipier français qui prend les commandes au drive de ${brand}.

OBJECTIF
- Prends la commande en français, naturellement, avec des phrases courtes adaptées à un drive.
- Comprends les hésitations, corrections, ajouts, retraits et interruptions.
- Ne récite pas de longs paragraphes. Pose une seule question à la fois.

CARTE DE DÉMONSTRATION
- signature_menu : Menu signature — burger, frites et boisson — 12,90 €
- tenders_6 : Tenders x6 — sauce au choix — 8,50 €
- medium_fries : Frites moyennes — 3,20 €
- zero_cola : Cola zéro moyen 40 cl — 2,80 €

RÈGLES DU PANIER
- N'invente aucun autre produit ou prix. Si un produit n'est pas disponible, dis-le brièvement et propose le choix le plus proche.
- Après CHAQUE ajout, retrait ou changement, appelle update_order avec le panier complet, puis confirme brièvement à l'oral.
- Quand le client dit que c'est tout, appelle update_order avec status ready_to_confirm, récapitule les articles et demande une confirmation explicite.
- Ne mets status confirmed que lorsque le client confirme clairement.
- Si la demande est ambiguë, pose une question avant de modifier le panier.
- Le bouton de confirmation de l'écran vaut confirmation explicite.

STYLE VOCAL
- Chaleureux, efficace et souriant. Prononce clairement les prix et les quantités.
- Accepte immédiatement que le client t'interrompe et écoute sa correction.`,
    audio: {
      input: {
        transcription: {
          model: 'gpt-live-transcribe',
          languages: ['fr'],
          delay: 'low',
          keywords: [
            'DriveVoice',
            'Master des Chefs',
            'Master Sarran Mozzarella',
            'Master Pairet Poivre',
            'Chicken Louisiane',
            'Coca-Cola',
            'frites',
            'menu',
          ],
          prompt: 'Commande de restauration rapide en français : burger, menu, tenders, frites, cola zéro.',
        },
        noise_reduction: { type: 'near_field' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.45,
          prefix_padding_ms: 300,
          silence_duration_ms: 550,
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        voice: 'marin',
        speed: 1.04,
      },
    },
    tools: [orderTool],
    tool_choice: 'auto',
  };

  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify(session));

  try {
    const openAIResponse = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const body = await openAIResponse.text();

    if (!openAIResponse.ok) {
      return Response.json(
        { error: "La connexion à l'agent vocal a échoué.", status: openAIResponse.status },
        { status: openAIResponse.status },
      );
    }

    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/sdp' },
    });
  } catch {
    return Response.json({ error: "Le service vocal est momentanément indisponible." }, { status: 502 });
  }
}
