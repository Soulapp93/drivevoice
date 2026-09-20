import { createClient } from '@supabase/supabase-js';
import { buildRealtimeToolDefinitions } from '@/lib/realtime/tool-protocol';
import { createToolSessionToken } from '@/lib/realtime/session-token';

export const runtime = 'nodejs';

const supportedBrands = new Set(['Burger King', "McDonald's", 'Quick', 'KFC']);
const demoRestaurantId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://pfnwodwpefugpcynykga.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmbndvZHdwZWZ1Z3BjeW55a2dhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNjk1NjYsImV4cCI6MjEwMzg0NTU2Nn0.9pjtztv06yFoawUi4ZszCq9XPQ9RqHEOMDlgzmiSCR4';

type CatalogOption = {
  id?: number;
  name: string;
  priceDelta?: number;
};

type CatalogOptionGroup = {
  id?: number;
  name: string;
  required?: boolean;
  min?: number;
  max?: number;
  options: CatalogOption[];
};

type CatalogEntry = {
  productId: string;
  name: string;
  price: number;
  category?: string;
  optionGroups?: CatalogOptionGroup[];
};

async function fetchCatalog(restaurantId: string): Promise<CatalogEntry[]> {
  try {
    const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await supabase.rpc('voice_tool_get_catalog', { p_restaurant_id: restaurantId });
    if (error) throw new Error(error.message);

    const rows = Array.isArray(data) ? data : [];
    const catalog = rows
      .filter((row: unknown) => {
        const record = row as Record<string, unknown> | null;
        return (
          record !== null &&
          typeof record === 'object' &&
          record.available !== false &&
          typeof record.name === 'string' &&
          typeof record.productId === 'string'
        );
      })
      .map((row: unknown) => {
        const record = row as Record<string, unknown>;
        const rawGroups = Array.isArray(record.optionGroups) ? record.optionGroups : [];
        const optionGroups = rawGroups
          .filter((group): group is Record<string, unknown> => typeof group === 'object' && group !== null && !Array.isArray(group))
          .map((group) => ({
            name: String(group.name ?? ''),
            required: group.required === true,
            options: (Array.isArray(group.options) ? group.options : [])
              .filter((option): option is Record<string, unknown> => typeof option === 'object' && option !== null && !Array.isArray(option))
              .map((option) => ({
                name: String(option.name ?? ''),
                priceDelta: typeof option.priceDelta === 'number' ? option.priceDelta : undefined,
              })),
          }))
          .filter((group) => group.name && group.options.length > 0);

        return {
          productId: String(record.productId),
          name: String(record.name),
          price: Number(record.price ?? 0),
          category: typeof record.category === 'string' ? record.category : undefined,
          ...(optionGroups.length > 0 ? { optionGroups } : {}),
        };
      });

    return catalog;
  } catch (err) {
    console.error('[voice/session] catalog fetch failed', err instanceof Error ? err.message : err);
    return [];
  }
}

function formatCatalog(catalog: CatalogEntry[]): string {
  if (catalog.length === 0) return 'Aucun produit disponible pour le moment.';
  return catalog
    .map((entry) => {
      let line = `- ${entry.productId} : ${entry.name}${entry.category ? ` (${entry.category})` : ''} — ${entry.price.toFixed(2).replace('.', ',')} €`;
      if (entry.optionGroups && entry.optionGroups.length > 0) {
        const groups = entry.optionGroups
          .map((group) => {
            const options = group.options.map((option) => `${option.name}${option.priceDelta ? ` +${option.priceDelta.toFixed(2).replace('.', ',')}€` : ''}`).join(', ');
            return `    · ${group.name}${group.required ? ' (obligatoire)' : ''} : ${options}`;
          })
          .join('\n');
        line += `\n${groups}`;
      }
      return line;
    })
    .join('\n');
}

const instructions = (brand: string, catalog: CatalogEntry[]) => `Tu es DriveVoice, un équipier français qui prend les commandes au drive de ${brand}.

OBJECTIF
- Prends la commande en français, naturellement, avec des phrases courtes adaptées à un drive.
- Comprends les hésitations, corrections, ajouts, retraits et interruptions.
- Ne récite pas de longs paragraphes. Pose une seule question à la fois.

CARTE OFFICIELLE DU RESTAURANT
${formatCatalog(catalog)}

RÈGLES DU PANIER — OBLIGATOIRES
- N'invente AUCUN produit, prix ou option qui ne figure pas dans la CARTE OFFICIELLE ci-dessus.
- Quand le client demande un produit, utilise IMMÉDIATEMENT l'outil add_item avec le product_id exact et la quantité.
- Quand le client retire un produit, utilise remove_item avec le product_id exact.
- Quand le client change une quantité, utilise update_item_quantity.
- Si un produit a des options obligatoires (marquées "obligatoire"), demande-les AUSSI TÔT et inclue-les dans add_item via selections.
- Si un produit n'est pas disponible, dis-le brièvement et propose le choix le plus proche dans la carte.
- Après chaque add_item, remove_item ou update_item_quantity, confirme brièvement à l'oral ce qui vient d'être fait.
- Utilise get_basket après une reconnexion ou si l'état du panier n'est pas certain.
- Utilise update_order UNIQUEMENT si tu doutes de l'état complet du panier après plusieurs corrections.
- Quand le client dit que c'est tout, récapitule les articles, puis appelle update_order avec le panier complet et status ready_to_confirm pour forcer la synchronisation finale.
- Ne mets status confirmed que lorsque le client confirme clairement.
- Après une confirmation explicite, appelle submit_order avec confirmation explicit et n'annonce jamais un numéro inventé.
- Si la transmission échoue, explique-le simplement et propose de réessayer ou un transfert humain.
- Si la demande est ambiguë, pose une question avant de modifier le panier.
- Le bouton de confirmation de l'écran vaut confirmation explicite.

STYLE VOCAL
- Chaleureux, efficace et souriant. Prononce clairement les prix et les quantités.
- Accepte immédiatement que le client t'interrompe et écoute sa correction.`;

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "L'agent vocal n'est pas configuré." }, { status: 500 });
  }

  const sdp = await request.text();
  console.log('[voice/session] received SDP length:', sdp.length, 'starts with v=0:', sdp.startsWith('v=0'));
  if (!sdp.startsWith('v=0') || sdp.length > 100_000) {
    return Response.json({ error: 'Session audio invalide.' }, { status: 400 });
  }

  const url = new URL(request.url);
  const requestedBrand = url.searchParams.get('brand') ?? '';
  const brand = supportedBrands.has(requestedBrand) ? requestedBrand : 'Burger King';
  const configuredRestaurantId = process.env.DRIVEVOICE_RESTAURANT_ID || demoRestaurantId;
  const requestedRestaurantId = url.searchParams.get('restaurantId');
  const restaurantId = requestedRestaurantId || configuredRestaurantId;
  if (restaurantId !== configuredRestaurantId) {
    return Response.json({ error: 'Restaurant non autorisé pour cette session.' }, { status: 403 });
  }
  const conversationId = url.searchParams.get('conversationId') || crypto.randomUUID();

  const catalog = await fetchCatalog(restaurantId);
  if (catalog.length === 0) {
    return Response.json(
      { error: 'Le catalogue officiel de ce restaurant est indisponible. La session vocale n’a pas été ouverte pour éviter de proposer de faux produits.' },
      { status: 503 },
    );
  }

  const session = {
    type: 'realtime',
    model: 'gpt-realtime-2.1',
    output_modalities: ['audio'],
    max_output_tokens: 4096,
    instructions: instructions(brand, catalog),
    audio: {
      input: {
        transcription: {
          model: 'gpt-live-transcribe',
          languages: ['fr'],
          delay: 'low',
          keywords: ['DriveVoice', 'Burger King', 'menu', 'frites', 'tenders', 'cola'],
          prompt: 'Commande de restauration rapide en français : burger, menu, tenders, frites, boisson.',
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
      output: { voice: 'marin', speed: 1.04 },
    },
    tools: buildRealtimeToolDefinitions(catalog.map((entry) => entry.productId)),
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
    console.log('[voice/session] openai response', { status: openAIResponse.status, bodyPreview: body.slice(0, 300) });

    if (!openAIResponse.ok) {
      console.error('[voice/session] openai realtime failed', { status: openAIResponse.status, body: body.slice(0, 500) });
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
        'x-drivevoice-conversation': conversationId,
      },
    });
  } catch {
    return Response.json({ error: "Le service vocal est momentanément indisponible." }, { status: 502 });
  }
}
