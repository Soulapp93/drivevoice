import { randomBytes } from 'node:crypto';

export async function GET(request: Request) {
  const clientId = process.env.HUBRISE_CLIENT_ID;
  const redirectUri = process.env.HUBRISE_REDIRECT_URI ?? `${new URL(request.url).origin}/api/hubrise/callback`;
  if (!clientId || !redirectUri) {
    return Response.json({ error: 'HubRise OAuth n’est pas configuré.' }, { status: 500 });
  }

  const restaurantId = new URL(request.url).searchParams.get('restaurantId');
  if (!restaurantId) {
    return Response.json({ error: 'Restaurant manquant.' }, { status: 400 });
  }

  const state = Buffer.from(JSON.stringify({ restaurantId, nonce: randomBytes(24).toString('hex') })).toString('base64url');
  const authorizeUrl = new URL('https://manager.hubrise.com/oauth2/v1/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', 'location[orders.write,catalog.read,inventory.read]');
  authorizeUrl.searchParams.set('state', state);
  return Response.redirect(authorizeUrl);
}