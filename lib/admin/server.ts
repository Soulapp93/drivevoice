import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js';

export type PlatformAdminContext = {
  client: SupabaseClient;
  user: User;
};

export async function requirePlatformAdmin(request: Request): Promise<PlatformAdminContext | Response> {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json({ error: 'La configuration serveur Supabase est incomplète.' }, { status: 503 });
  }

  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return Response.json({ error: 'Authentification requise.' }, { status: 401 });
  }

  const client = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await client.auth.getUser(authorization.slice(7));
  if (error || !data.user) {
    return Response.json({ error: 'Session administrateur invalide.' }, { status: 401 });
  }

  const { data: admin, error: adminError } = await client
    .from('platform_admins')
    .select('id')
    .eq('user_id', data.user.id)
    .eq('active', true)
    .maybeSingle();
  if (adminError) {
    return Response.json({ error: 'Impossible de vérifier les droits administrateur.' }, { status: 502 });
  }
  if (!admin) {
    return Response.json({ error: 'Accès administrateur requis.' }, { status: 403 });
  }

  return { client, user: data.user };
}

export function isPlatformAdminContext(value: PlatformAdminContext | Response): value is PlatformAdminContext {
  return !(value instanceof Response);
}
