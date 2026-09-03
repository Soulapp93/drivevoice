export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  if (error) return Response.redirect(new URL('/?hubrise=error', url.origin));
  if (!code || !state) return Response.json({ error: 'Réponse HubRise invalide.' }, { status: 400 });

  let stateData: { restaurantId: string };
  try {
    stateData = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as { restaurantId: string };
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