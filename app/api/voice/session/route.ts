import { createClient } from '@supabase/supabase-js';
import { buildRealtimeToolDefinitions } from '@/lib/realtime/tool-protocol';
import { createToolSessionToken } from '@/lib/realtime/session-token';
import { logRealtimeEvent } from '@/lib/realtime/logging';

export const runtime = 'nodejs';

const supportedBrands = new Set(['La Piazza République', 'Burger King', 'Burger King Loire', "McDonald's", 'Quick', 'KFC']);
const demoRestaurantId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const burgerKingDemoRestaurantId = '31065664-a449-4fe3-a311-de880b436726';
const demoRestaurantName = 'La Piazza République';
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

const demoProductIds = new Set([
  // Menus phares
  'bkfr_18','bkfr_19','bkfr_20','bkfr_21','bkfr_22','bkfr_23','bkfr_24','bkfr_25','bkfr_26','bkfr_11','bkfr_15',
  // Burgers seuls
  'bkfr_41','bkfr_42','bkfr_43','bkfr_44','bkfr_45','bkfr_46','bkfr_47','bkfr_48','bkfr_49','bkfr_50',
  // Accompagnements
  'bkfr_77','bkfr_78','bkfr_79','bkfr_75','bkfr_76','bkfr_64','bkfr_67','bkfr_83','bkfr_84','bkfr_85','bkfr_62','bkfr_63',
  // Boissons
  'bkfr_123','bkfr_124','bkfr_125','bkfr_114','bkfr_115','bkfr_116','bkfr_117','bkfr_118','bkfr_119','bkfr_126','bkfr_127','bkfr_128','bkfr_120',
  // Desserts
  'bkfr_104','bkfr_107','bkfr_108','bkfr_109',
]);

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
      })
      .filter((entry) => demoProductIds.has(entry.productId));

    return catalog;
  } catch (err) {
    console.error('[voice/session] catalog fetch failed', err instanceof Error ? err.message : err);
    return [];
  }
}

function formatCatalog(catalog: CatalogEntry[]): string {
  if (catalog.length === 0) return 'Aucun produit disponible pour le moment.';
  return catalog
    .map((entry) => `- ${entry.productId} : ${entry.name}${entry.category ? ` (${entry.category})` : ''} — ${entry.price.toFixed(2).replace('.', ',')} €`)
    .join('\n');
}

const instructions = (brand: string, catalog: CatalogEntry[]) => `Tu es un équipier au drive de ${brand}.

CARTE
${formatCatalog(catalog)}

RÈGLES
- Prends les commandes en français, brièvement et naturellement.
- Utilise add_item dès qu'un produit est demandé, avec le product_id exact.
- Corrige avec remove_item ou update_item_quantity.
- Utilise get_basket pour le récap final.
- Quand le client dit "c'est tout" ou "j'ai fini", donne le récap et demande : "Je valide ?".
- N'appelle submit_order que sur confirmation explicite ("oui", "je confirme", "validez").
- Sois concis, chaleureux, et ne récite pas la carte.`;

export async function POST(request: Request) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json({ error: "L'agent vocal n'est pas configuré." }, { status: 500 });
  }

  const sdp = await request.text();
  if (!sdp.startsWith('v=0') || sdp.length > 100_000) {
    logRealtimeEvent('session.sdp_invalid', { errorType: 'invalid_sdp' });
    return Response.json({ error: 'Session audio invalide.' }, { status: 400 });
  }

  const url = new URL(request.url);
  const requestedBrand = url.searchParams.get('brand') ?? '';
  const brand = supportedBrands.has(requestedBrand) ? requestedBrand : demoRestaurantName;
  const configuredRestaurantId = process.env.DRIVEVOICE_RESTAURANT_ID || demoRestaurantId;
  const requestedRestaurantId = url.searchParams.get('restaurantId');
  const restaurantId = requestedRestaurantId || configuredRestaurantId;
  const allowedRestaurantIds = new Set([configuredRestaurantId, burgerKingDemoRestaurantId]);
  if (!allowedRestaurantIds.has(restaurantId)) {
    logRealtimeEvent('session.unauthorized_restaurant', { restaurantId, errorCode: 'FORBIDDEN' });
    return Response.json({ error: 'Restaurant non autorisé pour cette session.' }, { status: 403 });
  }
  const conversationId = url.searchParams.get('conversationId') || crypto.randomUUID();
  const traceId = crypto.randomUUID();

  const catalog = await fetchCatalog(restaurantId);
  if (catalog.length === 0) {
    logRealtimeEvent('session.catalog_empty', { traceId, restaurantId, errorCode: 'CATALOG_UNAVAILABLE' });
    return Response.json(
      { error: 'Le catalogue officiel de ce restaurant est indisponible. La session vocale n’a pas été ouverte pour éviter de proposer de faux produits.' },
      { status: 503 },
    );
  }

  const session = {
    type: 'realtime',
    model: 'gpt-realtime-2.1',
    output_modalities: ['audio'],
    max_output_tokens: 2048,
    instructions: instructions(brand, catalog),
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
      output: { voice: 'marin', speed: 1.1 },
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

    if (!openAIResponse.ok) {
      logRealtimeEvent('session.openai_failed', { traceId, restaurantId, status: String(openAIResponse.status), errorType: body.slice(0, 200) });
      return Response.json(
        { error: "La connexion à l'agent vocal a échoué.", status: openAIResponse.status },
        { status: openAIResponse.status },
      );
    }

    logRealtimeEvent('session.created', { traceId, restaurantId, conversationId, status: 'success' });
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/sdp',
        'Cache-Control': 'no-store',
        'x-drivevoice-session': createToolSessionToken({ conversationId, restaurantId }),
        'x-drivevoice-conversation': conversationId,
        'x-trace-id': traceId,
      },
    });
  } catch {
    logRealtimeEvent('session.error', { traceId, restaurantId, errorCode: 'NETWORK_ERROR' });
    return Response.json({ error: "Le service vocal est momentanément indisponible." }, { status: 502 });
  }
}
