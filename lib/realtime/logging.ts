export type RealtimeLogContext = {
  traceId?: string | null;
  sessionId?: string | null;
  conversationId?: string | null;
  restaurantId?: string | null;
  tool?: string;
  callId?: string;
  responseId?: string | null;
  status?: string;
  durationMs?: number;
  errorType?: string;
  errorCode?: string;
  lifecycle?: string;
  queueDepth?: number;
};

const allowedKeys = new Set([
  'traceId',
  'sessionId',
  'conversationId',
  'restaurantId',
  'tool',
  'callId',
  'responseId',
  'status',
  'durationMs',
  'errorType',
  'errorCode',
  'lifecycle',
  'queueDepth',
]);

export function logRealtimeEvent(event: string, context: RealtimeLogContext = {}) {
  const safeContext = Object.fromEntries(
    Object.entries(context).filter(([key, value]) => allowedKeys.has(key) && value !== undefined && value !== null),
  );
  console.info(JSON.stringify({ event, ...safeContext }));
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && 'sendBeacon' in navigator) {
    try {
      navigator.sendBeacon(
        '/api/voice/telemetry',
        new Blob([JSON.stringify({ event, ...safeContext })], { type: 'application/json' }),
      );
    } catch {
      // La télémétrie ne doit jamais bloquer la conversation.
    }
  }
}

/**
 * Audit trail asynchrone pour les commandes vocales.
 * Fire-and-forget : ne bloque pas le flux principal.
 */
export function logOrderAudit(
  conversationId: string,
  restaurantId: string,
  event: string,
  payload?: Record<string, unknown>,
): void {
  // Import dynamique pour éviter dépendance circulaire au démarrage
  import('@supabase/supabase-js').then(({ createClient }) => {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !supabaseKey) return;

    const supabase = createClient(supabaseUrl, supabaseKey);
    supabase
      .rpc('voice_insert_order_audit', {
        p_conversation_id: conversationId,
        p_restaurant_id: restaurantId,
        p_event: event,
        p_payload: payload ?? null,
      })
      .catch((err) => {
        console.error('[audit] insert failed', err?.message ?? err);
      });
  }).catch(() => {
    // Supabase non disponible en environnement edge/build
  });
}
