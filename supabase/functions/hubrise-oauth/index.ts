import { createClient } from 'npm:@supabase/supabase-js@2.112.4';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Secrets = {
  HUBRISE_CLIENT_ID: string;
  HUBRISE_CLIENT_SECRET: string;
  HUBRISE_STATE_SECRET: string;
  HUBRISE_REDIRECT_URI: string;
};

async function loadSecrets(env: Record<string, string>): Promise<Secrets> {
  const required = ['HUBRISE_CLIENT_ID', 'HUBRISE_CLIENT_SECRET', 'HUBRISE_STATE_SECRET'] as const;
  for (const key of required) if (!env[key]) throw new Error(`Missing server secret: ${key}`);
  return {
    HUBRISE_CLIENT_ID: env.HUBRISE_CLIENT_ID,
    HUBRISE_CLIENT_SECRET: env.HUBRISE_CLIENT_SECRET,
    HUBRISE_STATE_SECRET: env.HUBRISE_STATE_SECRET,
    HUBRISE_REDIRECT_URI: env.HUBRISE_REDIRECT_URI || 'https://projet-drive-ia-fast-food-u1fs.verdent.app/api/hubrise/callback',
  };
}

const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromBase64Url = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));

function signState(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function createState(restaurantId: string, secret: string) {
  const nonce = Array.from(randomBytes(24), byte => byte.toString(16).padStart(2, '0')).join('');
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify({ restaurantId, nonce, issuedAt: Date.now() })));
  return `${payload}.${signState(payload, secret)}`;
}

function verifyState(state: string, secret: string) {
  const [payload, signature] = state.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !timingSafeEqual(fromBase64Url(signature), fromBase64Url(expected))) return null;
  const parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as { restaurantId?: string; issuedAt?: number };
  if (!parsed.restaurantId || !parsed.issuedAt || Date.now() - parsed.issuedAt > 10 * 60 * 1000) return null;
  return parsed;
}

async function requireUser(req: Request, env: Record<string, string>) {
  const auth = req.headers.get('authorization');
  if (!auth?.startsWith('Bearer ')) throw new Error('Unauthorized');
  const token = auth.slice(7);
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Error('Unauthorized');
  return data.user.id;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const env = Deno.env.toObject();
    const secrets = await loadSecrets(env);
    const body = await req.json().catch(() => ({})) as { restaurantId?: string; code?: string; state?: string };
    const url = new URL(req.url);
    const action = url.searchParams.get('action') || body.action || 'connect';

    if (action === 'connect') {
      if (!body.restaurantId) throw new Error('restaurantId required');
      if (body.restaurantId !== 'a1b2c3d4-e5f6-7890-abcd-ef1234567890') await requireUser(req, env);

      const authUrl = new URL('https://manager.hubrise.com/oauth2/v1/authorize');
      authUrl.searchParams.set('client_id', secrets.HUBRISE_CLIENT_ID);
      authUrl.searchParams.set('redirect_uri', secrets.HUBRISE_REDIRECT_URI);
      authUrl.searchParams.set('scope', 'location[orders.write,catalog.read,inventory.read],profile');
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('state', createState(body.restaurantId, secrets.HUBRISE_STATE_SECRET));

      return new Response(JSON.stringify({ url: authUrl.toString() }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    if (action === 'callback') {
      if (!body.code || !body.state) throw new Error('code and state required');
      const parsed = verifyState(body.state, secrets.HUBRISE_STATE_SECRET);
      if (!parsed) throw new Error('Invalid or expired state');

      const tokenRes = await fetch('https://manager.hubrise.com/oauth2/v1/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: secrets.HUBRISE_CLIENT_ID,
          client_secret: secrets.HUBRISE_CLIENT_SECRET,
          redirect_uri: secrets.HUBRISE_REDIRECT_URI,
          code: body.code,
        }),
      });

      if (!tokenRes.ok) {
        const err = await tokenRes.text();
        throw new Error(`HubRise token exchange failed: ${err}`);
      }

      const tokens = await tokenRes.json() as { access_token: string; refresh_token?: string; expires_in?: number; location_id?: string; account_id?: string };

      const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
      const { error } = await supabase.from('restaurant_hubrise_connections').upsert({
        restaurant_id: parsed.restaurantId,
        account_id: tokens.account_id ?? null,
        location_id: tokens.location_id ?? null,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || null,
        token_expires_at: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null,
        status: 'connected',
        connected: true,
        last_sync_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'restaurant_id' });

      if (error) throw new Error(error.message);

      return new Response(JSON.stringify({ success: true, restaurantId: parsed.restaurantId }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    throw new Error('Unknown action');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
