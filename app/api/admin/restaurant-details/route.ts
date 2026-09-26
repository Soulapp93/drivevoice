import { createClient } from '@supabase/supabase-js';

function isoWeekStart(value: string) {
  const match = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return null;
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const start = new Date(januaryFourth);
  start.setUTCDate(januaryFourth.getUTCDate() - ((januaryFourth.getUTCDay() + 6) % 7) + (week - 1) * 7);
  const thursday = new Date(start);
  thursday.setUTCDate(start.getUTCDate() + 3);
  if (thursday.getUTCFullYear() !== year) return null;
  return start;
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value ? null : date;
}

function validMonth(value: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  return new Date(`${value}-01T00:00:00.000Z`);
}

function nextMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

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
    return Response.json({ error: 'Session administrateur invalide.' }, { status: 401 });
  }

  const { data: platformAdmin } = await supabase
    .from('platform_admins')
    .select('id')
    .eq('user_id', userData.user.id)
    .eq('active', true)
    .maybeSingle();
  if (!platformAdmin) {
    return Response.json({ error: 'Accès administrateur requis.' }, { status: 403 });
  }

  const params = new URL(request.url).searchParams;
  const restaurantId = params.get('restaurantId') || '';
  const day = validDate(params.get('day') || '');
  const week = isoWeekStart(params.get('week') || '');
  const month = validMonth(params.get('month') || '');
  if (!/^[0-9a-f-]{36}$/i.test(restaurantId) || !day || !week || !month) {
    return Response.json({ error: 'Identifiant ou période invalide.' }, { status: 400 });
  }

  const dayEnd = new Date(day.getTime() + 86400000);
  const weekEnd = new Date(week.getTime() + 7 * 86400000);
  const monthEnd = nextMonth(month);
  const countOrders = (start?: Date, end?: Date) => {
    let query = supabase.from('orders').select('id', { count: 'exact', head: true }).eq('restaurant_id', restaurantId);
    if (start) query = query.gte('created_at', start.toISOString());
    if (end) query = query.lt('created_at', end.toISOString());
    return query;
  };

  const [products, dayOrders, weekOrders, monthOrders, allOrders, audits] = await Promise.all([
    supabase.from('restaurant_products').select('id', { count: 'exact', head: true }).eq('restaurant_id', restaurantId),
    countOrders(day, dayEnd),
    countOrders(week, weekEnd),
    countOrders(month, monthEnd),
    countOrders(),
    supabase.from('conversation_audits').select('id', { count: 'exact', head: true }).eq('restaurant_id', restaurantId),
  ]);

  const queryError = products.error || dayOrders.error || weekOrders.error || monthOrders.error || allOrders.error;
  if (queryError) {
    return Response.json({ error: 'Impossible de charger les indicateurs du restaurant.' }, { status: 502 });
  }

  return Response.json({
    products: products.count ?? 0,
    orders: {
      day: dayOrders.count ?? 0,
      week: weekOrders.count ?? 0,
      month: monthOrders.count ?? 0,
      total: allOrders.count ?? 0,
    },
    aiAudits: audits.error ? null : audits.count ?? 0,
  }, { headers: { 'Cache-Control': 'no-store' } });
}
