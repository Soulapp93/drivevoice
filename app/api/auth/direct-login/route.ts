import { createClient } from '@supabase/supabase-js';

const ADMIN_EMAIL = 'admin@drivevoice.ai';
const ADMIN_PASSWORD = 'Admin2026!';

export async function POST() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY;

  if (!url || !anonKey) {
    return Response.json({ error: 'La configuration serveur Supabase est incomplète.' }, { status: 500 });
  }

  const client = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });

  if (error || !data.session) {
    return Response.json({ error: error?.message || 'Session administrateur impossible.' }, { status: 401 });
  }

  return Response.json({
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
  });
}