import { createClient } from '@supabase/supabase-js';

export async function POST(request: Request) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.VITE_SUPABASE_URL;
  if (!serviceKey || !url) return Response.json({ error: 'La configuration serveur Supabase est incomplète.' }, { status: 500 });
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return Response.json({ error: 'Authentification requise.' }, { status: 401 });
  const accessToken = authorization.slice(7);
  const caller = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: userData, error: userError } = await caller.auth.getUser(accessToken);
  if (userError || !userData.user) return Response.json({ error: 'Session administrateur invalide.' }, { status: 401 });
  const { data: callerAdmin } = await caller.from('platform_admins').select('id').eq('user_id', userData.user.id).eq('active', true).maybeSingle();
  if (!callerAdmin) return Response.json({ error: 'Accès administrateur requis.' }, { status: 403 });
  const body = await request.json() as { fullName?: string; email?: string; role?: string };
  if (!body.fullName || !body.email || !body.role) return Response.json({ error: 'Nom, e-mail et rôle sont obligatoires.' }, { status: 400 });
  const { data, error } = await caller.auth.admin.inviteUserByEmail(body.email, { data: { full_name: body.fullName, platform_role: body.role } });
  if (error || !data.user) return Response.json({ error: error?.message ?? 'Invitation impossible.' }, { status: 400 });
  const inserted = await caller.from('platform_admins').insert({ user_id: data.user.id, full_name: body.fullName, role: body.role, active: true }).select('id,full_name,role,active,created_at').single();
  if (inserted.error) return Response.json({ error: inserted.error.message }, { status: 400 });
  return Response.json({ admin: inserted.data });
}