import { createClient } from '@supabase/supabase-js';

const allowedRoles = ['Propriétaire / franchisé', 'Directeur / directrice', 'Responsable réseau', 'Autre'];

type DemoRequestBody = {
  fullName?: unknown;
  email?: unknown;
  phone?: unknown;
  restaurantName?: unknown;
  restaurantCount?: unknown;
  role?: unknown;
  message?: unknown;
  website?: unknown;
};

function cleanText(value: unknown, maximum: number) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

export async function POST(request: Request) {
  let body: DemoRequestBody;
  try {
    const parsed = await request.json() as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid body');
    body = parsed as DemoRequestBody;
  } catch {
    return Response.json({ error: 'Le formulaire est invalide.' }, { status: 400 });
  }

  if (cleanText(body.website, 200)) return Response.json({ success: true });

  const fullName = cleanText(body.fullName, 120);
  const email = cleanText(body.email, 254).toLowerCase();
  const phone = cleanText(body.phone, 40);
  const restaurantName = cleanText(body.restaurantName, 160);
  const restaurantCount = Number(body.restaurantCount);
  const role = cleanText(body.role, 80);
  const message = cleanText(body.message, 4000);

  if (!fullName || !phone || !restaurantName || !message || !allowedRoles.includes(role)) {
    return Response.json({ error: 'Merci de renseigner tous les champs obligatoires.' }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: 'Saisissez une adresse e-mail valide.' }, { status: 400 });
  }
  if (!Number.isInteger(restaurantCount) || restaurantCount < 1 || restaurantCount > 10000) {
    return Response.json({ error: 'Le nombre de restaurants indiqué est invalide.' }, { status: 400 });
  }
  if (fullName.length < 2 || phone.replace(/\D/g, '').length < 6 || message.length < 10) {
    return Response.json({ error: 'Vérifiez votre nom, votre téléphone et le détail de votre besoin.' }, { status: 400 });
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return Response.json({ error: 'Le formulaire est momentanément indisponible. Réessayez plus tard.' }, { status: 503 });
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await supabase.from('demo_requests').insert({
    full_name: fullName,
    email,
    phone,
    restaurant_name: restaurantName,
    restaurant_count: restaurantCount,
    role,
    message,
  });

  if (error) {
    console.error('Demo request could not be stored:', error.message);
    return Response.json({ error: 'Impossible d’envoyer votre demande pour le moment.' }, { status: 500 });
  }

  return Response.json({ success: true });
}
