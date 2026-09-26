-- Audit trail complet pour les commandes vocales
-- Permet traçabilité post-mortem et conformité réglementaire

CREATE TABLE IF NOT EXISTS public.voice_order_audit (
  id BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL,
  restaurant_id UUID NOT NULL,
  event TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index pour recherche par conversation
CREATE INDEX IF NOT EXISTS idx_voice_order_audit_conversation ON public.voice_order_audit(conversation_id);
-- Index pour recherche par date (purge/archivage)
CREATE INDEX IF NOT EXISTS idx_voice_order_audit_created ON public.voice_order_audit(created_at);
-- Index pour recherche par événement
CREATE INDEX IF NOT EXISTS idx_voice_order_audit_event ON public.voice_order_audit(event);

-- Fonction d'insertion asynchrone (fire-and-forget côté client)
CREATE OR REPLACE FUNCTION public.voice_insert_order_audit(
  p_conversation_id UUID,
  p_restaurant_id UUID,
  p_event TEXT,
  p_payload JSONB DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
  INSERT INTO public.voice_order_audit (conversation_id, restaurant_id, event, payload)
  VALUES (p_conversation_id, p_restaurant_id, p_event, p_payload);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RLS : lecture par service role uniquement, écriture via RPC
ALTER TABLE public.voice_order_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "voice_order_audit_service_only" ON public.voice_order_audit;
CREATE POLICY "voice_order_audit_service_only" ON public.voice_order_audit
  FOR ALL USING (auth.role() = 'service_role');
