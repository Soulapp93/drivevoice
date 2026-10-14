import { createClient } from '@supabase/supabase-js';

const ADMIN_EMAIL = 'admin@drivevoice.ai';
const ADMIN_PASSWORD = 'Admin2026!';
const FALLBACK_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmbndvZHdwZWZ1Z3BjeW55a2dhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNjk1NjYsImV4cCI6MjEwMzg0NTU2Nn0.9pjtztv06yFoawUi4ZszCq9XPQ9RqHEOMDlgzmiSCR4';

export async function POST() {
  const url = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_PUBLISHABLE_KEY || FALLBACK_ANON_KEY;

  if (!url) {
    return Response.json({ error: 'La configuration serveur Supabase est incomplète.' }, { status: 500 });
  }

  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceKey) {
    const adminClient = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: users } = await adminClient.auth.admin.listUsers();
    const existing = users?.users.find((user) => user.email?.toLowerCase() === ADMIN_EMAIL);
    let userId = existing?.id;

    if (!userId) {
      const { data, error } = await adminClient.auth.admin.createUser({
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        email_confirm: true,
      });
      if (error || !data.user) {
        return Response.json({ error: error?.message || 'Compte administrateur impossible à créer.' }, { status: 401 });
      }
      userId = data.user.id;
    } else {
      const { error } = await adminClient.auth.admin.updateUserById(userId, {
        password: ADMIN_PASSWORD,
        email_confirm: true,
      });
      if (error) return Response.json({ error: error.message }, { status: 401 });
    }

    await adminClient
      .from('platform_admins')
      .upsert({ user_id: userId, full_name: 'Fondateur DriveVoice', role: 'owner', active: true }, { onConflict: 'user_id' });
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