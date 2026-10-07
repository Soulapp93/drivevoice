import { createClient } from '@supabase/supabase-js';

export async function GET(request: Request) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return Response.json({ error: 'La configuration serveur Supabase est incomplète.' }, { status: 500 });

  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return Response.json({ error: 'Authentification requise.' }, { status: 401 });

  const supabase = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: userData, error: userError } = await supabase.auth.getUser(authorization.slice(7));
  if (userError || !userData.user) return Response.json({ error: 'Session administrateur invalide.' }, { status: 401 });

  const { data: platformAdmin } = await supabase
    .from('platform_admins')
    .select('id')
    .eq('user_id', userData.user.id)
    .eq('active', true)
    .maybeSingle();
  if (!platformAdmin) return Response.json({ error: 'Accès administrateur requis.' }, { status: 403 });

  const { data, error } = await supabase
    .from('demo_requests')
    .select('id,full_name,email,phone,restaurant_name,restaurant_count,role,message,received_at')
    .order('received_at', { ascending: false })
    .limit(500);
  if (error) return Response.json({ error: 'Impossible de charger les demandes d’intégration.' }, { status: 500 });

  return Response.json({ requests: data ?? [] }, { headers: { 'cache-control': 'no-store' } });
}
