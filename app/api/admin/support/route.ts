import { isPlatformAdminContext, requirePlatformAdmin } from '@/lib/admin/server';
import { getOrCreateSupportConversation, readSupportMessages } from '@/lib/support/server';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const context = await requirePlatformAdmin(request);
  if (!isPlatformAdminContext(context)) return context;

  const restaurantId = new URL(request.url).searchParams.get('restaurantId');
  if (restaurantId) {
    if (!uuidPattern.test(restaurantId)) return Response.json({ error: 'Restaurant invalide.' }, { status: 400 });
    const { data: conversation, error } = await context.client
      .from('support_conversations')
      .select('id,restaurant_id,status,last_message_at')
      .eq('restaurant_id', restaurantId)
      .maybeSingle();
    if (error) return Response.json({ error: 'Impossible de charger cette conversation.' }, { status: 502 });
    if (!conversation) return Response.json({ conversation: null, messages: [] }, { headers: { 'cache-control': 'no-store' } });

    const { messages, error: messagesError } = await readSupportMessages(context.client, conversation.id);
    if (messagesError || !messages) return Response.json({ error: 'Impossible de charger les messages.' }, { status: 502 });
    await context.client.from('support_messages').update({ read_at: new Date().toISOString() })
      .eq('conversation_id', conversation.id).eq('sender_type', 'restaurant').is('read_at', null);
    return Response.json({ conversation, messages }, { headers: { 'cache-control': 'no-store' } });
  }

  const { data: conversations, error } = await context.client
    .from('support_conversations')
    .select('id,restaurant_id,status,last_message_at,created_at,restaurants(id,name,city,code)')
    .order('last_message_at', { ascending: false, nullsFirst: false })
    .limit(500);
  if (error) return Response.json({ error: 'Impossible de charger la boîte de réception.' }, { status: 502 });

  const conversationIds = (conversations ?? []).map((conversation) => conversation.id);
  const unreadCounts = new Map<string, number>();
  if (conversationIds.length) {
    const { data: unreadMessages, error: unreadError } = await context.client
      .from('support_messages')
      .select('conversation_id')
      .in('conversation_id', conversationIds)
      .eq('sender_type', 'restaurant')
      .is('read_at', null)
      .limit(10000);
    if (unreadError) return Response.json({ error: 'Impossible de calculer les messages non lus.' }, { status: 502 });
    for (const message of unreadMessages ?? []) unreadCounts.set(message.conversation_id, (unreadCounts.get(message.conversation_id) ?? 0) + 1);
  }

  return Response.json({
    conversations: (conversations ?? []).map((conversation) => ({ ...conversation, unreadCount: unreadCounts.get(conversation.id) ?? 0 })),
  }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request) {
  const context = await requirePlatformAdmin(request);
  if (!isPlatformAdminContext(context)) return context;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Corps de requête invalide.' }, { status: 400 });
  }

  const restaurantId = typeof body.restaurantId === 'string' ? body.restaurantId : '';
  const messageBody = typeof body.body === 'string' ? body.body.trim() : '';
  if (!uuidPattern.test(restaurantId) || !messageBody || messageBody.length > 5000) {
    return Response.json({ error: 'Restaurant ou message invalide.' }, { status: 400 });
  }

  const conversation = await getOrCreateSupportConversation(context.client, restaurantId);
  if (!conversation) return Response.json({ error: 'Impossible de démarrer cette conversation.' }, { status: 502 });
  const { data: message, error } = await context.client.from('support_messages').insert({
    conversation_id: conversation.id,
    sender_type: 'platform_admin',
    sender_user_id: context.user.id,
    body: messageBody,
  }).select('id,conversation_id,sender_type,sender_user_id,body,created_at,read_at').single();
  if (error) return Response.json({ error: 'Impossible d’envoyer le message.' }, { status: 502 });
  return Response.json({ conversation, message }, { status: 201, headers: { 'cache-control': 'no-store' } });
}
