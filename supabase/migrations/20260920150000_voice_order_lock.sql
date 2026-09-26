-- Verrou d'idempotence pour les commandes vocales
-- Empêche les doubles envois simultanés via conversation_id

CREATE TABLE IF NOT EXISTS public.voice_order_locks (
  conversation_id UUID PRIMARY KEY,
  locked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  idempotency_key TEXT NOT NULL
);

-- Index pour nettoyage des locks expirés
CREATE INDEX IF NOT EXISTS idx_voice_order_locks_expires ON public.voice_order_locks(expires_at);

-- Fonction d'acquisition de verrou (atomique)
CREATE OR REPLACE FUNCTION public.voice_acquire_order_lock(
  p_conversation_id UUID,
  p_idempotency_key TEXT,
  p_ttl_seconds INT DEFAULT 30
) RETURNS BOOLEAN AS $$
BEGIN
  -- Nettoyer locks expirés
  DELETE FROM public.voice_order_locks WHERE expires_at < NOW();

  -- Tenter acquisition (INSERT ... ON CONFLICT DO NOTHING)
  INSERT INTO public.voice_order_locks (conversation_id, idempotency_key, expires_at)
  VALUES (p_conversation_id, p_idempotency_key, NOW() + (p_ttl_seconds || ' seconds')::INTERVAL)
  ON CONFLICT (conversation_id) DO NOTHING;

  RETURN FOUND;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Fonction de libération de verrou
CREATE OR REPLACE FUNCTION public.voice_release_order_lock(p_conversation_id UUID)
RETURNS VOID AS $$
BEGIN
  DELETE FROM public.voice_order_locks WHERE conversation_id = p_conversation_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RLS : seul service role peut manipuler les locks
ALTER TABLE public.voice_order_locks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "voice_order_locks_service_only" ON public.voice_order_locks;
CREATE POLICY "voice_order_locks_service_only" ON public.voice_order_locks
  FOR ALL USING (auth.role() = 'service_role');
