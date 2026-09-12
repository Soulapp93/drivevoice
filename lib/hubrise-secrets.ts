import { createClient } from '@supabase/supabase-js';

type HubRiseSecrets = {
  HUBRISE_CLIENT_ID: string;
  HUBRISE_CLIENT_SECRET: string;
  HUBRISE_STATE_SECRET: string;
  HUBRISE_REDIRECT_URI: string;
};

export async function getHubRiseSecrets(origin: string): Promise<HubRiseSecrets | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://pfnwodwpefugpcynykga.supabase.co';
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || '';
  if (!serviceRoleKey) return null;

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await supabase.rpc('get_hubrise_server_secrets');

  if (error || !data) return null;
  const secrets = data as Partial<HubRiseSecrets>;
  if (!secrets.HUBRISE_CLIENT_ID || !secrets.HUBRISE_CLIENT_SECRET || !secrets.HUBRISE_STATE_SECRET) return null;

  return {
    HUBRISE_CLIENT_ID: secrets.HUBRISE_CLIENT_ID,
    HUBRISE_CLIENT_SECRET: secrets.HUBRISE_CLIENT_SECRET,
    HUBRISE_STATE_SECRET: secrets.HUBRISE_STATE_SECRET,
    HUBRISE_REDIRECT_URI: secrets.HUBRISE_REDIRECT_URI || `${origin}/api/hubrise/callback`,
  };
}