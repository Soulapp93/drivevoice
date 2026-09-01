import { createClient } from '@supabase/supabase-js';
import {
  VERDENT_SUPABASE_PUBLISHABLE_KEY,
  VERDENT_SUPABASE_URL,
} from './env';
import type { Database } from './database.types';

const isBrowser = typeof window !== 'undefined';

function getSupabaseConfig() {
  if (isBrowser) {
    return {
      url: window.location.origin,
      key: 'verdent-baas-proxy',
    };
  }
  return {
    url: process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? VERDENT_SUPABASE_URL,
    key:
      process.env.SUPABASE_ANON_KEY ??
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
      VERDENT_SUPABASE_PUBLISHABLE_KEY,
  };
}

export const supabase = createClient<Database>(getSupabaseConfig().url, getSupabaseConfig().key, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});

export async function getCurrentUser() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function getCurrentSession() {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  return session;
}
