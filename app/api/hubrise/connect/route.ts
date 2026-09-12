import { createHmac, randomBytes } from 'node:crypto';

function signState(payload: string, secret: string) {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export async function GET(request: Request) {
  const clientId = process.env.HUBRISE_CLIENT_ID;
  const stateSecret = process.env.HUBRISE_STATE_SECRET ?? process.env.HUBRISE_CLIENT_SECRET;
  const redirectUri = process.env.HUBRISE_REDIRECT_URI ?? `${new URL(request.url).origin}/api/hubrise/callback`;
  const missing = [
    !clientId && 'HUBRISE_CLIENT_ID',
    !stateSecret && 'HUBRISE_STATE_SECRET ou HUBRISE_CLIENT_SECRET',
  ].filter(Boolean);
  if (missing.length) {
    return Response.json({
      error: 'HubRise OAuth n’est pas configuré sur le serveur.',
      missing,
      action: 'Ajoutez les variables secrètes HubRise dans l’hébergement DriveVoice, puis republiez l’application.',
    }, { status: 500 });
  }

  const restaurantId = new URL(request.url).searchParams.get('restaurantId');
  if (!restaurantId) {
    return Response.json({ error: 'Restaurant manquant.' }, { status: 400 });
  }

  const payload = Buffer.from(JSON.stringify({ restaurantId, nonce: randomBytes(24).toString('hex'), issuedAt: Date.now() })).toString('base64url');
  const state = `${payload}.${signState(payload, stateSecret)}`;
  const authorizeUrl = new URL('https://manager.hubrise.com/oauth2/v1/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'location[orders.write,catalog.read,inventory.read]');
  authorizeUrl.searchParams.set('state', state);
  return Response.redirect(authorizeUrl);
}