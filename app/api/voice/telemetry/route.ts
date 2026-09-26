import { logRealtimeEvent, type RealtimeLogContext } from '@/lib/realtime/logging';

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { event?: unknown } & Record<string, unknown>;
    const { event, ...context } = body;
    if (typeof event === 'string') {
      logRealtimeEvent(`client.${event}`, context as RealtimeLogContext);
    }
  } catch {
    // Une télémétrie invalide ne doit jamais casser la conversation.
  }
  return new Response(null, { status: 204 });
}
