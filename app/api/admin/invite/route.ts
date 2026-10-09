import { isPlatformAdminContext, requirePlatformAdmin } from '@/lib/admin/server';

export async function GET(request: Request) {
  const context = await requirePlatformAdmin(request);
  if (!isPlatformAdminContext(context)) return context;
  const { data, error } = await context.client
    .from('platform_admins')
    .select('id,full_name,role,active,created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return Response.json({ error: 'Impossible de charger les administrateurs.' }, { status: 502 });
  return Response.json({ admins: data ?? [] }, { headers: { 'cache-control': 'no-store' } });
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

  const fullName = typeof body.fullName === 'string' ? body.fullName.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const allowedRoles = new Set(['Administrateur', 'Super administrateur', 'Analyste', 'Support']);
  const role = typeof body.role === 'string' && allowedRoles.has(body.role) ? body.role : '';
  if (fullName.length < 2 || fullName.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !role) {
    return Response.json({ error: 'Nom, e-mail valide et rôle autorisé sont obligatoires.' }, { status: 400 });
  }

  const { data, error } = await context.client.auth.admin.inviteUserByEmail(email, {
    data: { full_name: fullName, platform_role: role },
    redirectTo: `${new URL(request.url).origin}/login?mode=admin`,
  });
  if (error || !data.user) return Response.json({ error: error?.message ?? 'Invitation impossible.' }, { status: 400 });

  const inserted = await context.client.from('platform_admins')
    .insert({ user_id: data.user.id, full_name: fullName, role, active: true })
    .select('id,full_name,role,active,created_at')
    .single();
  if (inserted.error) return Response.json({ error: 'Invitation envoyée, mais l’accès administrateur n’a pas pu être enregistré.' }, { status: 502 });
  return Response.json({ admin: inserted.data }, { status: 201 });
}
