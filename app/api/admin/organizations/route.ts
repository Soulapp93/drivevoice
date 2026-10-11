import { isPlatformAdminContext, requirePlatformAdmin } from '@/lib/admin/server';

export async function GET(request: Request) {
  const context = await requirePlatformAdmin(request);
  if (!isPlatformAdminContext(context)) return context;

  const { data, error } = await context.client
    .from('organizations')
    .select('id,name,active,created_at,restaurants(id,name,address,city,code,brand_id,active,created_at,owner_id,master_brands(name)),organization_members(id,user_id,role,active,created_at),restaurant_invitations(id,restaurant_id,email,full_name,role,status,invited_at)')
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return Response.json({ error: 'Impossible de charger le portefeuille clients.' }, { status: 502 });
  return Response.json({ organizations: data ?? [] }, { headers: { 'cache-control': 'no-store' } });
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

  const organizationId = typeof body.organizationId === 'string' ? body.organizationId : '';
  const organizationName = typeof body.organizationName === 'string' ? body.organizationName.trim() : '';
  const restaurantName = typeof body.restaurantName === 'string' ? body.restaurantName.trim() : '';
  const managerName = typeof body.managerName === 'string' ? body.managerName.trim() : '';
  const managerEmail = typeof body.managerEmail === 'string' ? body.managerEmail.trim().toLowerCase() : '';
  const managerRole = body.managerRole === 'Manager' ? 'Manager' : body.managerRole === 'Directeur' ? 'Directeur' : '';
  const allowedPosSystems = ['hubrise', 'deliverect', 'direct_pos'];
  const posSystem = allowedPosSystems.includes(body.posSystem as string) ? (body.posSystem as string) : 'hubrise';
  if ((!organizationId && !organizationName) || !restaurantName || managerName.length < 2 || managerName.length > 120 || !managerRole || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(managerEmail)) {
    return Response.json({ error: 'Organisation, restaurant, responsable, rôle et e-mail valide sont obligatoires.' }, { status: 400 });
  }

  const provisionedResult = organizationId
    ? await context.client.rpc('admin_add_client_restaurant', {
      p_admin_id: context.user.id,
      p_organization_id: organizationId,
      p_restaurant_name: restaurantName,
      p_address: typeof body.address === 'string' ? body.address.trim() : '',
      p_city: typeof body.city === 'string' ? body.city.trim() : '',
      p_code: typeof body.code === 'string' ? body.code.trim() : '',
      p_manager_name: managerName,
      p_manager_email: managerEmail,
      p_manager_role: managerRole,
      p_pos_system: posSystem,
    })
    : await context.client.rpc('admin_create_client_account', {
      p_admin_id: context.user.id,
      p_organization_name: organizationName,
      p_restaurant_name: restaurantName,
      p_address: typeof body.address === 'string' ? body.address.trim() : '',
      p_city: typeof body.city === 'string' ? body.city.trim() : '',
      p_code: typeof body.code === 'string' ? body.code.trim() : '',
      p_manager_name: managerName,
      p_manager_email: managerEmail,
      p_manager_role: managerRole,
      p_pos_system: posSystem,
    });
  const { data: provisioned, error: provisionError } = provisionedResult;
  if (provisionError || !provisioned) return Response.json({ error: 'La création du compte client a échoué.' }, { status: 502 });

  const invitationResult = await context.client.auth.admin.inviteUserByEmail(managerEmail, {
    data: {
      full_name: managerName,
      restaurant_id: provisioned.restaurant_id,
      organization_id: provisioned.organization_id,
      restaurant_role: managerRole,
      organization_role: organizationId ? 'manager' : 'owner',
    },
    redirectTo: `${new URL(request.url).origin}/login?mode=invite`,
  });

  if (invitationResult.error || !invitationResult.data.user) {
    return Response.json({
      organizationId: provisioned.organization_id,
      restaurantId: provisioned.restaurant_id,
      invitationSent: false,
      error: `Compte créé et invitation enregistrée, mais l’e-mail n’a pas été envoyé : ${invitationResult.error?.message ?? 'erreur inconnue'}`,
    }, { status: 201 });
  }

  const attachResult = await context.client.rpc('admin_attach_client_invitation', {
    p_admin_id: context.user.id,
    p_invitation_id: provisioned.invitation_id,
    p_auth_user_id: invitationResult.data.user.id,
  });
  if (attachResult.error) {
    return Response.json({
      organizationId: provisioned.organization_id,
      restaurantId: provisioned.restaurant_id,
      invitationSent: true,
      error: 'Invitation envoyée, mais le rattachement du compte nécessite une vérification.',
    }, { status: 201 });
  }

  return Response.json({ organizationId: provisioned.organization_id, restaurantId: provisioned.restaurant_id, invitationSent: true }, { status: 201 });
}
