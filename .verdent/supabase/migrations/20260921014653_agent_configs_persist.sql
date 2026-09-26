-- Configuration persistante de l'agent vocal par restaurant
-- Survit au refresh de page et synchronise tous les postes drive.

CREATE TABLE IF NOT EXISTS public.agent_configs (
  restaurant_id UUID PRIMARY KEY,
  welcome TEXT NOT NULL DEFAULT 'Bonjour et bienvenue. Que puis-je préparer pour vous aujourd''hui ?',
  voice TEXT NOT NULL DEFAULT 'Marin — naturelle',
  tone TEXT NOT NULL DEFAULT 'Chaleureux et efficace',
  language TEXT NOT NULL DEFAULT 'Français',
  speech_rate NUMERIC(4,2) NOT NULL DEFAULT 1.00 CHECK (speech_rate BETWEEN 0.75 AND 1.25),
  rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  knowledge JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index utile si d'autres tables viennent à référencer la config
CREATE INDEX IF NOT EXISTS idx_agent_configs_updated ON public.agent_configs(updated_at);

-- Mise à jour automatique de updated_at
CREATE OR REPLACE FUNCTION public.agent_configs_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS agent_configs_updated_at ON public.agent_configs;
CREATE TRIGGER agent_configs_updated_at
  BEFORE UPDATE ON public.agent_configs
  FOR EACH ROW EXECUTE FUNCTION public.agent_configs_set_updated_at();

-- Récupération de la configuration (appelable par le client anonyme via RPC)
CREATE OR REPLACE FUNCTION public.get_agent_config(p_restaurant_id UUID)
RETURNS TABLE (
  welcome TEXT,
  voice TEXT,
  tone TEXT,
  language TEXT,
  speech_rate NUMERIC,
  rules JSONB,
  knowledge JSONB,
  updated_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    ac.welcome,
    ac.voice,
    ac.tone,
    ac.language,
    ac.speech_rate,
    ac.rules,
    ac.knowledge,
    ac.updated_at
  FROM public.agent_configs ac
  WHERE ac.restaurant_id = p_restaurant_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Insertion / mise à jour idempotente de la configuration
CREATE OR REPLACE FUNCTION public.upsert_agent_config(
  p_restaurant_id UUID,
  p_welcome TEXT,
  p_voice TEXT,
  p_tone TEXT,
  p_language TEXT,
  p_speech_rate NUMERIC,
  p_rules JSONB,
  p_knowledge JSONB
) RETURNS VOID AS $$
BEGIN
  INSERT INTO public.agent_configs (
    restaurant_id, welcome, voice, tone, language, speech_rate, rules, knowledge
  ) VALUES (
    p_restaurant_id, p_welcome, p_voice, p_tone, p_language, p_speech_rate, p_rules, p_knowledge
  )
  ON CONFLICT (restaurant_id)
  DO UPDATE SET
    welcome = EXCLUDED.welcome,
    voice = EXCLUDED.voice,
    tone = EXCLUDED.tone,
    language = EXCLUDED.language,
    speech_rate = EXCLUDED.speech_rate,
    rules = EXCLUDED.rules,
    knowledge = EXCLUDED.knowledge,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- RLS : la table n'est accessible directement qu'au service role.
-- Le client passe par les RPC SECURITY DEFINER ci-dessus.
ALTER TABLE public.agent_configs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "agent_configs_service_only" ON public.agent_configs;
CREATE POLICY "agent_configs_service_only" ON public.agent_configs
  FOR ALL USING (auth.role() = 'service_role');