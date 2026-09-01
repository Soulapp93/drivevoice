import { createClient } from '@supabase/supabase-js';
import {
  VERDENT_SUPABASE_PUBLISHABLE_KEY,
  VERDENT_SUPABASE_URL,
} from './env';
import type { Database } from './database.types';

export function createServerClient(accessToken?: string) {
  const url =
    process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? VERDENT_SUPABASE_URL;
  const key =
    process.env.SUPABASE_ANON_KEY ??
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
    VERDENT_SUPABASE_PUBLISHABLE_KEY;

  return createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: accessToken
      ? {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      : undefined,
  });
}

export function createServiceClient() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!key) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  }
  return createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
