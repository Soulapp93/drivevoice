import { createClient } from '@supabase/supabase-js';
import { buildRealtimeToolDefinitions } from '@/lib/realtime/tool-protocol';
import { createToolSessionToken } from '@/lib/realtime/session-token';
import { logRealtimeEvent } from '@/lib/realtime/logging';

export const runtime = 'nodejs';

const demoRestaurantId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const burgerKingDemoRestaurantId = '31065664-a449-4fe3-a311-de880b436726';
const demoRestaurantName = 'La Piazza République';
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://pfnwodwpefugpcynykga.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmbndvZHdwZWZ1Z3BjeW55a2dhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNjk1NjYsImV4cCI6MjEwMzg0NTU2Nn0.9pjtztv06yFoawUi4ZszCq9XPQ9RqHEOMDlgzmiSCR4';

type CatalogOption = {
  id?: number;
  name: string;
  priceDelta?: number;
  priceDeltaBySize?: Record<string, number>;
  availableFor?: string[];
  available?: boolean;
};

type CatalogOptionGroup = {
  id?: number;
  name: string;
  required?: boolean;
  min?: number;
  max?: number;
  rulesBySize?: Record<string, { required: boolean; min: number; max: number }>;
  options: CatalogOption[];
};

type CatalogEntry = {
  productId: string;
  name: string;
  price: number;
  category?: string;
  detail?: string;
  mainProduct?: string;
  optionGroups?: CatalogOptionGroup[];
};

const managerRoles = new Set(['owner', 'admin', 'manager', 'directeur', 'administrateur', 'operator', 'operateur', 'opérateur']);

async function canAccessRestaurant(accessToken: string | null, restaurantId: string): Promise<boolean> {
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!accessToken || !serviceRoleKey) return false;

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await supabase.auth.getUser(accessToken);
  if (userError || !userData.user) return false;

  const { data: restaurant, error: restaurantError } = await supabase
    .from('restaurants')
    .select('id,owner_id,active')
    .eq('id', restaurantId)
    .maybeSingle();
  if (restaurantError || !restaurant || restaurant.active === false) return false;
  if (restaurant.owner_id === userData.user.id) return true;

  const [{ data: admin }, { data: membership }] = await Promise.all([
    supabase.from('platform_admins').select('id').eq('user_id', userData.user.id).eq('active', true).maybeSingle(),
    supabase.from('restaurant_members').select('role').eq('restaurant_id', restaurantId).eq('user_id', userData.user.id).maybeSingle(),
  ]);
  return Boolean(admin || (membership?.role && managerRoles.has(membership.role.toLowerCase())));
}


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
            min: typeof group.min === 'number' ? group.min : 0,
            max: typeof group.max === 'number' ? group.max : 1,
            rulesBySize: group.rulesBySize && typeof group.rulesBySize === 'object' && !Array.isArray(group.rulesBySize)
              ? group.rulesBySize as CatalogOptionGroup['rulesBySize']
              : undefined,
            options: (Array.isArray(group.options) ? group.options : [])
              .filter((option): option is Record<string, unknown> => typeof option === 'object' && option !== null && !Array.isArray(option))
              .map((option) => ({
                name: String(option.name ?? ''),
                priceDelta: typeof option.priceDelta === 'number' ? option.priceDelta : 0,
                priceDeltaBySize: option.priceDeltaBySize && typeof option.priceDeltaBySize === 'object' && !Array.isArray(option.priceDeltaBySize)
                  ? option.priceDeltaBySize as Record<string, number>
                  : undefined,
                availableFor: Array.isArray(option.availableFor) ? option.availableFor.filter((size): size is string => typeof size === 'string') : undefined,
                available: option.available !== false,
              })),
          }))
          .filter((group) => group.name && group.options.length > 0);

        return {
          productId: String(record.productId),
          name: String(record.name),
          price: Number(record.price ?? 0),
          category: typeof record.category === 'string' ? record.category : undefined,
          detail: typeof record.detail === 'string' ? record.detail : undefined,
          mainProduct: typeof record.mainProduct === 'string' ? record.mainProduct : undefined,
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
      const lines = [`- ${entry.productId} : ${entry.name}${entry.mainProduct ? ` (produit principal : ${entry.mainProduct})` : ''}${entry.category ? ` (${entry.category})` : ''} — ${entry.price.toFixed(2).replace('.', ',')} €${entry.detail ? ` — ${entry.detail}` : ''}`];
      for (const group of entry.optionGroups ?? []) {
        const options = group.options.map((option) => {
          const availability = option.availableFor?.length ? ` [tailles : ${option.availableFor.join(', ')}]` : '';
          const prices = Object.entries(option.priceDeltaBySize ?? {}).map(([size, price]) => `${size} +${price.toFixed(2).replace('.', ',')} €`);
          const priceText = prices.length ? ` [${prices.join('; ')}]` : option.priceDelta ? ` [+${option.priceDelta.toFixed(2).replace('.', ',')} €]` : '';
          return `${option.name}${availability}${priceText}`;
        });
        const rules = Object.entries(group.rulesBySize ?? {}).map(([size, rule]) => `${size}: ${rule.required ? 'obligatoire' : 'facultatif'}, ${rule.min} à ${rule.max} choix`);
        lines.push(`  ${group.name}${rules.length ? ` (${rules.join(' | ')})` : ''} : ${options.join(', ')}`);
      }
      return lines.join('\n');
    })
    .join('\n');
}

const instructions = (brand: string, catalog: CatalogEntry[]) => `Tu es un équipier de prise de commande pour le restaurant ${JSON.stringify(brand)}.

CARTE OFFICIELLE
${formatCatalog(catalog)}

RÈGLES
- Prends les commandes en français, brièvement et naturellement.
- Pour un menu, demande la taille avant les choix. Propose uniquement les options disponibles pour cette taille et respecte ses règles de sélection.
- Demande chaque choix obligatoire avant d’appeler add_item. Transmets dans selections le nom exact de chaque groupe et toutes les options choisies, y compris la taille.
- Les suppléments de taille et tarifs affichés pour chaque option déterminent le prix; ne promets jamais un prix différent.
- N’invente ni produit, ni option, ni prix. Si une composition requise est indisponible, demande au client de choisir une alternative.
- Utilise add_item dès qu’un produit et toutes ses options requises sont confirmés, avec le product_id exact.
- Corrige avec remove_item ou update_item_quantity.
- Utilise get_basket pour le récapitulatif final.
- Quand le client dit « c’est tout » ou « j’ai fini », donne le récapitulatif et demande : « Je valide ? ».
- N’appelle submit_order qu’après confirmation explicite (« oui », « je confirme », « validez »).
- Sois concis, chaleureux, et ne récite pas toute la carte.`;

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
  const requestedBrand = url.searchParams.get('brand')?.trim().slice(0, 100) ?? '';
  const brand = requestedBrand || demoRestaurantName;
  const configuredRestaurantId = process.env.DRIVEVOICE_RESTAURANT_ID || demoRestaurantId;
  const requestedRestaurantId = url.searchParams.get('restaurantId');
  const restaurantId = requestedRestaurantId || configuredRestaurantId;
  if (!/^[0-9a-f-]{36}$/i.test(restaurantId)) {
    return Response.json({ error: 'Identifiant du restaurant invalide.' }, { status: 400 });
  }
  const demoRestaurantIds = new Set([configuredRestaurantId, burgerKingDemoRestaurantId]);
  const accessToken = request.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
  if (!demoRestaurantIds.has(restaurantId) && !(await canAccessRestaurant(accessToken, restaurantId))) {
    logRealtimeEvent('session.unauthorized_restaurant', { restaurantId, errorCode: 'FORBIDDEN' });
    return Response.json({ error: 'Votre compte n’est pas autorisé à accéder à ce restaurant.' }, { status: 403 });
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
