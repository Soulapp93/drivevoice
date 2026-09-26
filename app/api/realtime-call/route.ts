import { buildRealtimeToolDefinitions } from '@/lib/realtime/tool-protocol';
import { createToolSessionToken } from '@/lib/realtime/session-token';

export const runtime = 'nodejs';

const supportedBrands = new Set(['Burger King', "McDonald's", 'Quick', 'KFC']);

const demoRestaurantId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

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
  const url = new URL(request.url);
  const configuredRestaurantId = process.env.DRIVEVOICE_RESTAURANT_ID || demoRestaurantId;
  const requestedRestaurantId = url.searchParams.get('restaurantId');
  const restaurantId = requestedRestaurantId || configuredRestaurantId;
  if (restaurantId !== configuredRestaurantId) {
    return Response.json({ error: 'Restaurant non autorisé pour cette session.' }, { status: 403 });
  }
  const conversationId = url.searchParams.get('conversationId') || crypto.randomUUID();
  const session = {
    type: 'realtime',
    model: 'gpt-realtime-2.1-mini',
    output_modalities: ['audio'],
    max_output_tokens: 4096,
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
- Utilise get_basket après une reconnexion ou si l'état du panier n'est pas certain.
- Quand le client dit que c'est tout, appelle update_order avec status ready_to_confirm, récapitule les articles et demande une confirmation explicite.
- Ne mets status confirmed que lorsque le client confirme clairement.
- Après une confirmation explicite, appelle submit_order avec confirmation explicit et n'annonce jamais un numéro inventé.
- Si la transmission échoue, explique-le simplement et propose de réessayer ou un transfert humain.
- Si la demande est ambiguë, pose une question avant de modifier le panier.
- Le bouton de confirmation de l'écran vaut confirmation explicite.

STYLE VOCAL
- Chaleureux, efficace et souriant. Prononce clairement les prix et les quantités.
- Accepte immédiatement que le client t'interrompe et écoute sa correction.`,
    audio: {
      input: {
        noise_reduction: { type: 'near_field' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.45,
          prefix_padding_ms: 400,
          silence_duration_ms: 650,
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        voice: 'marin',
        speed: 1.1,
      },
    },
    tools: buildRealtimeToolDefinitions(),
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
      headers: {
        'Content-Type': 'application/sdp',
        'Cache-Control': 'no-store',
        'x-drivevoice-session': createToolSessionToken({ conversationId, restaurantId }),
      },
    });
  } catch {
    return Response.json({ error: "Le service vocal est momentanément indisponible." }, { status: 502 });
  }
}
