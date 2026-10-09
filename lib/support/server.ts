import type { SupabaseClient, User } from '@supabase/supabase-js';

export type RestaurantUserContext = {
  client: SupabaseClient;
  user: User;
};

export async function requireRestaurantUser(request: Request): Promise<RestaurantUserContext | Response> {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json({ error: 'La configuration serveur Supabase est incomplète.' }, { status: 503 });
  }

  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return Response.json({ error: 'Authentification requise.' }, { status: 401 });
  }

  const { createClient } = await import('@supabase/supabase-js');
  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await client.auth.getUser(authorization.slice(7));
  if (error || !data.user) return Response.json({ error: 'Session restaurant invalide.' }, { status: 401 });
  return { client, user: data.user };
}

export function isRestaurantUserContext(value: RestaurantUserContext | Response): value is RestaurantUserContext {
  return !(value instanceof Response);
}

export async function canAccessRestaurant(client: SupabaseClient, userId: string, restaurantId: string): Promise<boolean> {
  const { data: restaurant, error: restaurantError } = await client
    .from('restaurants')
    .select('id,owner_id,organization_id')
    .eq('id', restaurantId)
    .maybeSingle();
  if (restaurantError || !restaurant) return false;
  if (restaurant.owner_id === userId) return true;

  const [{ data: restaurantMember, error: restaurantMemberError }, { data: organizationMember, error: organizationMemberError }, { data: platformAdmin, error: adminError }] = await Promise.all([
    client.from('restaurant_members').select('id').eq('restaurant_id', restaurantId).eq('user_id', userId).eq('active', true).maybeSingle(),
    restaurant.organization_id
      ? client.from('organization_members').select('id').eq('organization_id', restaurant.organization_id).eq('user_id', userId).eq('active', true).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    client.from('platform_admins').select('id').eq('user_id', userId).eq('active', true).maybeSingle(),
  ]);

  if (restaurantMemberError || organizationMemberError || adminError) return false;
  return Boolean(restaurantMember || organizationMember || platformAdmin);
}

export async function getOrCreateSupportConversation(client: SupabaseClient, restaurantId: string): Promise<{ id: string } | null> {
  const { data: existing, error: lookupError } = await client
    .from('support_conversations')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .maybeSingle();
  if (lookupError) return null;
  if (existing) return existing;

  const { data: created, error: createError } = await client
    .from('support_conversations')
    .insert({ restaurant_id: restaurantId })
    .select('id')
    .maybeSingle();
  if (created) return created;
  if (createError?.code === '23505') {
    const { data: raced } = await client.from('support_conversations').select('id').eq('restaurant_id', restaurantId).maybeSingle();
    return raced;
  }
  return null;
}

export async function readSupportMessages(client: SupabaseClient, conversationId: string) {
  const { data, error } = await client
    .from('support_messages')
    .select('id,conversation_id,sender_type,sender_user_id,body,created_at,read_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) return { messages: null, error };
  const messages = data ?? [];
  return { messages, error: null };
}
