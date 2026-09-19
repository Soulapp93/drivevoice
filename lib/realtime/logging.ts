export type RealtimeLogContext = {
  sessionId?: string | null;
  conversationId?: string | null;
  restaurantId?: string | null;
  tool?: string;
  callId?: string;
  responseId?: string | null;
  status?: string;
  durationMs?: number;
  errorType?: string;
};

const allowedKeys = new Set([
  'sessionId',
  'conversationId',
  'restaurantId',
  'tool',
  'callId',
  'responseId',
  'status',
  'durationMs',
  'errorType',
]);

export function logRealtimeEvent(event: string, context: RealtimeLogContext = {}) {
  const safeContext = Object.fromEntries(
    Object.entries(context).filter(([key, value]) => allowedKeys.has(key) && value !== undefined && value !== null),
  );
  console.info(`[drivevoice.realtime] ${event}`, safeContext);
}