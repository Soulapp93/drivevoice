import { createClient } from '@supabase/supabase-js';

export const runtime = 'nodejs';

const managerRoles = new Set(['owner', 'admin', 'manager', 'directeur', 'administrateur', 'operator', 'operateur', 'opérateur']);

export async function GET(request: Request) {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json({ error: 'La configuration serveur Supabase est incomplète.' }, { status: 503 });
  }

  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    return Response.json({ error: 'Authentification requise.' }, { status: 401 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: userData, error: userError } = await supabase.auth.getUser(authorization.slice(7));
  if (userError || !userData.user) {
    return Response.json({ error: 'Session invalide. Reconnectez-vous.' }, { status: 401 });
  }

  const restaurantId = new URL(request.url).searchParams.get('restaurantId') || '';
  if (!/^[0-9a-f-]{36}$/i.test(restaurantId)) {
    return Response.json({ error: 'Identifiant du restaurant invalide.' }, { status: 400 });
  }

  const { data: restaurant, error: restaurantError } = await supabase
    .from('restaurants')
    .select('id,owner_id')
    .eq('id', restaurantId)
    .maybeSingle();
  if (restaurantError) {
    return Response.json({ error: 'Impossible de vérifier l’accès au restaurant.' }, { status: 502 });
  }
  if (!restaurant) {
    return Response.json({ error: 'Restaurant introuvable.' }, { status: 404 });
  }

  const [{ data: platformAdmin, error: adminError }, { data: membership, error: membershipError }] = await Promise.all([
    supabase.from('platform_admins').select('id').eq('user_id', userData.user.id).eq('active', true).maybeSingle(),
    supabase.from('restaurant_members').select('role').eq('restaurant_id', restaurantId).eq('user_id', userData.user.id).eq('active', true).maybeSingle(),
  ]);
  if (adminError || membershipError) {
    return Response.json({ error: 'Impossible de vérifier les droits d’accès.' }, { status: 502 });
  }

  const hasAccess = Boolean(
    platformAdmin
    || restaurant.owner_id === userData.user.id
    || (membership?.role && managerRoles.has(membership.role.toLowerCase())),
  );
  if (!hasAccess) {
    return Response.json({ error: 'Votre compte n’est pas rattaché à ce restaurant.' }, { status: 403 });
  }

  const pageSize = 1000;
  const maximumOrders = 50000;
  const orders: Array<{ id: string; ref: string | null; source: string | null; status: string | null; total: number | null; items: unknown; created_at: string }> = [];
  for (let offset = 0; offset < maximumOrders; offset += pageSize) {
    const { data, error } = await supabase
      .from('orders')
      .select('id,ref,source,status,total,items,created_at')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (error) {
      return Response.json({ error: 'Impossible de charger les commandes réelles.' }, { status: 502 });
    }

    const rows = data ?? [];
    orders.push(...rows.map((row) => ({
      id: row.id,
      ref: row.ref,
      source: row.source,
      status: row.status,
      total: row.total === null ? null : Number(row.total),
      items: Array.isArray(row.items) ? row.items : [],
      created_at: row.created_at,
    })));
    if (rows.length < pageSize) {
      return Response.json({ orders }, { headers: { 'Cache-Control': 'no-store' } });
    }
  }

  return Response.json({ error: 'Le volume de commandes dépasse la limite de chargement.' }, { status: 413 });
}
