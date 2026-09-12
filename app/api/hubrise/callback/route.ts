import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyState(state: string, secret: string) {
  const [payload, signature] = state.split('.');
  if (!payload || !signature) return null;
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { restaurantId?: string; issuedAt?: number };
  if (!parsed.restaurantId || !parsed.issuedAt || Date.now() - parsed.issuedAt > 10 * 60 * 1000) return null;
  return parsed;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) return Response.redirect(new URL('/?hubrise=error', url.origin));
  if (!code || !state) return Response.json({ error: 'Réponse HubRise invalide.' }, { status: 400 });

  let stateData: { restaurantId: string };
  try {
    const stateSecret = process.env.HUBRISE_STATE_SECRET ?? process.env.HUBRISE_CLIENT_SECRET;
    if (!stateSecret) throw new Error('HubRise state secret missing');
    const verified = verifyState(state, stateSecret);
    if (!verified) throw new Error('Invalid or expired state');
    stateData = { restaurantId: verified.restaurantId! };
  } catch {
    return Response.json({ error: 'État OAuth invalide.' }, { status: 400 });
  }

  const clientId = process.env.HUBRISE_CLIENT_ID;
  const clientSecret = process.env.HUBRISE_CLIENT_SECRET;
  const redirectUri = process.env.HUBRISE_REDIRECT_URI ?? `${url.origin}/api/hubrise/callback`;
  if (!clientId || !clientSecret || !redirectUri) {
    return Response.json({ error: 'HubRise OAuth n’est pas configuré.' }, { status: 500 });
  }

  const tokenResponse = await fetch('https://manager.hubrise.com/oauth2/v1/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenResponse.ok) return Response.redirect(new URL('/?hubrise=token_error', url.origin));

  const token = await tokenResponse.json() as { access_token?: string; refresh_token?: string; location_id?: string; account_id?: string };
  if (!token.access_token) return Response.redirect(new URL('/?hubrise=token_error', url.origin));

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceKey || !token.location_id) {
    console.error('[hubrise] Configuration de stockage serveur incomplète');
    return Response.redirect(new URL('/?hubrise=storage_error', url.origin));
  }

  const connectionResponse = await fetch(`${supabaseUrl}/rest/v1/restaurant_hubrise_connections?on_conflict=restaurant_id`, {
    method: 'POST',
    headers: {
      apikey: supabaseServiceKey,
      Authorization: `Bearer ${supabaseServiceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      restaurant_id: stateData.restaurantId,
      account_id: token.account_id ?? null,
      location_id: token.location_id,
      access_token: token.access_token,
      refresh_token: token.refresh_token ?? null,
      status: 'connected',
      last_sync_at: new Date().toISOString(),
    }),
  });
  if (!connectionResponse.ok) {
    console.error('[hubrise] Enregistrement de la connexion impossible', connectionResponse.status);
    return Response.redirect(new URL('/?hubrise=storage_error', url.origin));
  }

  return Response.redirect(new URL(`/?hubrise=connected&restaurantId=${encodeURIComponent(stateData.restaurantId)}`, url.origin));
}