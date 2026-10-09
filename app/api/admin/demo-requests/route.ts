import { isPlatformAdminContext, requirePlatformAdmin } from '@/lib/admin/server';

const requestStatuses = new Set(['new', 'contacted', 'demo', 'converted', 'rejected']);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const context = await requirePlatformAdmin(request);
  if (!isPlatformAdminContext(context)) return context;

  const { data, error } = await context.client
    .from('demo_requests')
    .select('id,full_name,email,phone,restaurant_name,restaurant_count,role,message,received_at,status,assigned_to,notes,updated_at,organization_id')
    .order('received_at', { ascending: false })
    .limit(500);
  if (error) return Response.json({ error: 'Impossible de charger les demandes d’intégration.' }, { status: 500 });

  return Response.json({ requests: data ?? [] }, { headers: { 'cache-control': 'no-store' } });
}

export async function PATCH(request: Request) {
  const context = await requirePlatformAdmin(request);
  if (!isPlatformAdminContext(context)) return context;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'Corps de requête invalide.' }, { status: 400 });
  }

  const id = typeof body.id === 'string' ? body.id : '';
  if (!uuidPattern.test(id)) return Response.json({ error: 'Demande invalide.' }, { status: 400 });
  const update: Record<string, unknown> = {};
  if (typeof body.status === 'string') {
    if (!requestStatuses.has(body.status)) return Response.json({ error: 'Statut de demande invalide.' }, { status: 400 });
    update.status = body.status;
  }
  if (typeof body.notes === 'string') {
    if (body.notes.length > 10000) return Response.json({ error: 'Les notes dépassent la longueur maximale.' }, { status: 400 });
    update.notes = body.notes;
  }
  if (body.assignedTo === 'me') update.assigned_to = context.user.id;
  else if (body.assignedTo === null || typeof body.assignedTo === 'string') {
    if (body.assignedTo !== null && !uuidPattern.test(body.assignedTo)) return Response.json({ error: 'Responsable de suivi invalide.' }, { status: 400 });
    update.assigned_to = body.assignedTo;
  }
  if (typeof body.organizationId === 'string') {
    if (!uuidPattern.test(body.organizationId)) return Response.json({ error: 'Organisation invalide.' }, { status: 400 });
    update.organization_id = body.organizationId;
  }
  if (!id || !Object.keys(update).length) return Response.json({ error: 'Demande ou modification invalide.' }, { status: 400 });

  const { data, error } = await context.client
    .from('demo_requests')
    .update(update)
    .eq('id', id)
    .select('id,status,assigned_to,notes,updated_at,organization_id')
    .maybeSingle();
  if (error) return Response.json({ error: 'Impossible de mettre à jour cette demande.' }, { status: 502 });
  if (!data) return Response.json({ error: 'Demande introuvable.' }, { status: 404 });
  return Response.json({ request: data }, { headers: { 'cache-control': 'no-store' } });
}
