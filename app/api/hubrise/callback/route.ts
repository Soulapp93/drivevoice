const EDGE_FUNCTION_URL = 'https://pfnwodwpefugpcynykga.supabase.co/functions/v1/hubrise-oauth';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (error) {
    return Response.redirect(new URL('/?tab=technical&hubrise=error&reason=' + encodeURIComponent(error), url.origin));
  }
  if (!code || !state) {
    return Response.redirect(new URL('/?tab=technical&hubrise=error&reason=missing_params', url.origin));
  }

  try {
    const res = await fetch(`${EDGE_FUNCTION_URL}?action=callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    });

    const data = await res.json().catch(() => ({ error: 'Réponse invalide de la fonction OAuth.' })) as { success?: boolean; restaurantId?: string; error?: string };

    if (!res.ok || !data.success) {
      console.error('[hubrise callback] Edge function error:', data.error);
      return Response.redirect(new URL('/?tab=technical&hubrise=error&reason=' + encodeURIComponent(data.error || 'oauth_failed'), url.origin));
    }

    return Response.redirect(new URL(`/?tab=technical&hubrise=connected&restaurantId=${encodeURIComponent(data.restaurantId || '')}`, url.origin));
  } catch (err) {
    console.error('[hubrise callback] Network error:', err);
    return Response.redirect(new URL('/?tab=technical&hubrise=error&reason=network_error', url.origin));
  }
}
