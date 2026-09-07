export async function POST(request: Request) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json({ error: 'Stockage des audits non configuré.' }, { status: 503 });
  }

  const payload = await request.json() as {
    conversationId?: string;
    restaurantId?: string;
    startedAt?: string | null;
    endedAt?: string;
    messages?: Array<{
      id: string;
      speaker: 'client' | 'agent';
      text: string;
      status: 'partial' | 'final';
      timestamp: number;
    }>;
  };
  if (!payload.conversationId || !payload.restaurantId || !Array.isArray(payload.messages) || payload.messages.length === 0) {
    return Response.json({ error: 'Audit de conversation invalide.' }, { status: 400 });
  }
  if (payload.messages.length > 1000 || payload.messages.some((message) => typeof message.text !== 'string' || message.text.length > 10_000)) {
    return Response.json({ error: 'Audit de conversation trop volumineux.' }, { status: 413 });
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/conversation_audits`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({
      conversation_id: payload.conversationId,
      restaurant_id: payload.restaurantId,
      started_at: payload.startedAt ?? null,
      ended_at: payload.endedAt ?? new Date().toISOString(),
      messages: payload.messages,
    }),
  });
  if (!response.ok) {
    console.error('[audit] Enregistrement impossible', response.status);
    return Response.json({ error: 'Enregistrement de l’audit impossible.' }, { status: 502 });
  }
  return new Response(null, { status: 204 });
}