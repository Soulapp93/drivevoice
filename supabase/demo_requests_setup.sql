-- ============================================================
-- Configuration de la table demo_requests
-- À exécuter dans Supabase Dashboard → SQL Editor
-- ============================================================

-- Créer la table si elle n'existe pas
CREATE TABLE IF NOT EXISTS public.demo_requests (
  id               uuid primary key default gen_random_uuid(),
  full_name        text not null,
  email            text not null,
  phone            text not null,
  restaurant_name  text not null,
  restaurant_count integer not null default 1,
  role             text not null,
  message          text not null,
  received_at      timestamptz not null default now()
);

-- Activer RLS
ALTER TABLE public.demo_requests ENABLE ROW LEVEL SECURITY;

-- Politique d'insertion pour les utilisateurs anonymes et authentifiés
DROP POLICY IF EXISTS "demo_requests_insert_anon" ON public.demo_requests;
CREATE POLICY "demo_requests_insert_anon" ON public.demo_requests
  FOR INSERT TO anon, authenticated WITH CHECK (true);

-- Politique de lecture pour les utilisateurs authentifiés (admin)
DROP POLICY IF EXISTS "demo_requests_select_admin" ON public.demo_requests;
CREATE POLICY "demo_requests_select_admin" ON public.demo_requests
  FOR SELECT TO authenticated USING (true);

-- Vérifier que la table existe
SELECT COUNT(*) as total_requests FROM public.demo_requests;
