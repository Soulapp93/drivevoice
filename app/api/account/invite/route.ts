import { createClient } from '@supabase/supabase-js';

const allowedRoles = new Set(['Manager', 'Opérateur', 'Lecteur']);
const managerRoles = new Set(['owner', 'admin', 'manager', 'directeur', 'administrateur']);

export async function POST(request: Request) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.VITE_SUPABASE_URL;
  const publicKey = process.env.VITE_SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || (!serviceKey && !publicKey)) return Response.json({ error: 'La configuration serveur Supabase est incomplète.' }, { status: 500 });

  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) return Response.json({ error: 'Connectez-vous pour inviter un membre.' }, { status: 401 });

  const accessToken = authorization.slice(7);
  const client = createClient(url, serviceKey || publicKey!, {
    auth: { autoRefreshToken: false, persistSession: false },
    ...(serviceKey ? {} : { global: { headers: { Authorization: `Bearer ${accessToken}` } } }),
  });
  const { data: userData, error: userError } = await client.auth.getUser(accessToken);
  if (userError || !userData.user) return Response.json({ error: 'Votre session a expiré. Reconnectez-vous puis réessayez.' }, { status: 401 });

  const body = await request.json() as { restaurantId?: string; fullName?: string; email?: string; role?: string };
  const restaurantId = body.restaurantId?.trim();
  const fullName = body.fullName?.trim();
  const email = body.email?.trim().toLowerCase();
  const role = body.role?.trim();
  if (!restaurantId || !fullName || !email || !role) return Response.json({ error: 'Nom, e-mail et rôle sont obligatoires.' }, { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return Response.json({ error: 'Saisissez une adresse e-mail valide.' }, { status: 400 });
  if (!allowedRoles.has(role)) return Response.json({ error: 'Le rôle sélectionné n’est pas reconnu.' }, { status: 400 });

  const { data: restaurant } = await client
    .from('restaurants')
    .select('id,organization_id,owner_id')
    .eq('id', restaurantId)
    .maybeSingle();
  if (!restaurant) return Response.json({ error: 'Restaurant introuvable.' }, { status: 404 });

  const [{ data: platformAdmin }, { data: restaurantMember }, { data: organizationMember }] = await Promise.all([
    client.from('platform_admins').select('id').eq('user_id', userData.user.id).eq('active', true).maybeSingle(),
    client.from('restaurant_members').select('role').eq('restaurant_id', restaurantId).eq('user_id', userData.user.id).maybeSingle(),
    client.from('organization_members').select('role').eq('organization_id', restaurant.organization_id).eq('user_id', userData.user.id).maybeSingle(),
  ]);
  const hasAccess = Boolean(
    platformAdmin
    || restaurant.owner_id === userData.user.id
    || (restaurantMember?.role && managerRoles.has(restaurantMember.role.toLowerCase()))
    || (organizationMember?.role && managerRoles.has(organizationMember.role.toLowerCase())),
  );
  if (!hasAccess) return Response.json({ error: 'Vous n’avez pas les droits pour inviter un membre dans ce restaurant.' }, { status: 403 });

  const { data: existingInvitation } = await client
    .from('restaurant_invitations')
    .select('id')
    .eq('restaurant_id', restaurantId)
    .eq('email', email)
    .eq('status', 'pending')
    .maybeSingle();
  if (existingInvitation) return Response.json({ error: 'Une invitation est déjà en attente pour cette adresse.' }, { status: 409 });

  const redirectTo = `${new URL(request.url).origin}/login?mode=invite`;
  if (serviceKey) {
    const { data: invitation, error: invitationError } = await client.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName, restaurant_id: restaurantId, restaurant_role: role },
      redirectTo,
    });
    if (invitationError || !invitation.user) return Response.json({ error: invitationError?.message ?? 'Invitation impossible.' }, { status: 400 });
  } else {
    const { error: invitationError } = await client.auth.signInWithOtp({
      email,
      options: {
        emailRedirectTo: redirectTo,
        shouldCreateUser: true,
        data: { full_name: fullName, restaurant_id: restaurantId, restaurant_role: role },
      },
    });
    if (invitationError) return Response.json({ error: invitationError.message }, { status: 400 });
  }

  const { data: savedInvitation, error: saveError } = await client
    .from('restaurant_invitations')
    .insert({ restaurant_id: restaurantId, email, full_name: fullName, role, status: 'pending' })
    .select('id,email,full_name,role,status,invited_at')
    .single();
  if (saveError) return Response.json({ error: saveError.message }, { status: 400 });

  return Response.json({ invitation: savedInvitation });
}