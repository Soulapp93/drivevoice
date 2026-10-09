import { supabase } from '@/lib/supabase/client';

export async function adminApiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!supabase) throw new Error('Authentification Supabase indisponible.');
  const current = await supabase.auth.getSession();
  let token = current.data.session?.access_token;
  if (!token) {
    const refreshed = await supabase.auth.refreshSession();
    token = refreshed.data.session?.access_token;
    if (refreshed.error || !token) throw refreshed.error ?? new Error('Session administrateur expirée.');
  }

  const send = (accessToken: string) => fetch(path, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  let response = await send(token);
  if (response.status === 401) {
    const refreshed = await supabase.auth.refreshSession();
    if (refreshed.error || !refreshed.data.session?.access_token) throw refreshed.error ?? new Error('Session administrateur expirée.');
    response = await send(refreshed.data.session.access_token);
  }
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || 'Opération impossible.');
  return result;
}
