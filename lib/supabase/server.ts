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
  const url =
    process.env.SUPABASE_URL ??
    process.env.VITE_SUPABASE_URL ??
    'https://supabase-api-prod.verdent.ai/p/p0aa5f6059f39dd5d8fa8';

  // Try multiple possible service role key names
  let key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SERVICE_ROLE_KEY ||
    process.env.VERDENT_SERVICE_ROLE_KEY ||
    '';

  // For Verdent dev environment, allow using anon key temporarily
  // This should be replaced with real service role in production
  if (!key) {
    const anonKey =
      process.env.SUPABASE_ANON_KEY ||
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoyMTAzODkzMTY3LCJpYXQiOjE3ODgyNzM5NjcsImlzcyI6InN1cGFiYXNlIiwicHJvamVjdF9yZWYiOiJwMGFhNWY2MDU5ZjM5ZGQ1ZDhmYTgiLCJyb2xlIjoiYW5vbiJ9.IwwzZEoR1kjLPfJT8kS3nVQcpFj2sWBg83usg-qlj50';
    console.warn('⚠️  Using anon key for service operations. For production, set SUPABASE_SERVICE_ROLE_KEY.');
    key = anonKey;
  }

  return createClient<Database>(url, key, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
