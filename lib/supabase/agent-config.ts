import { supabase } from './client';

export type AgentKnowledgeItem = { id: number; title: string; content: string; enabled: boolean };

export type RestaurantAgentConfig = {
  welcome_message: string;
  voice: string;
  tone: string;
  language: string;
  speech_rate: number;
  knowledge_base: AgentKnowledgeItem[];
  updated_at?: string;
};

const defaultConfig: RestaurantAgentConfig = {
  welcome_message: "Bonjour et bienvenue. Que puis-je préparer pour vous aujourd'hui ?",
  voice: 'Marin — naturelle',
  tone: 'Chaleureux et efficace',
  language: 'Français',
  speech_rate: 1,
  knowledge_base: [
    { id: 1, title: 'Horaires du restaurant', content: 'Ouvert du lundi au jeudi de 09:00 à 00:00, et du vendredi au dimanche de 09:00 à 01:00.', enabled: true },
    { id: 2, title: 'Paiements acceptés', content: 'Carte bancaire, espèces, titres-restaurant, Apple Pay et Google Pay au guichet de paiement.', enabled: true },
    { id: 3, title: 'Allergènes', content: 'Ne jamais donner de diagnostic. Informer le client que les 14 allergènes majeurs sont consultables et proposer un transfert à un équipier.', enabled: true },
    { id: 4, title: 'Règles de prise de commande', content: 'Pour un menu, confirmer dans cet ordre : taille, sandwich, accompagnement, boisson, sauces puis suppléments.', enabled: true },
    { id: 5, title: 'Compte de fidélité', content: 'Le client peut présenter sa carte ou son QR code au paiement pour cumuler ses avantages.', enabled: true },
    { id: 6, title: 'Situations spécifiques et fréquentes', content: 'En cas de demande imprécise, poser une seule question courte à la fois. Après deux incompréhensions, transférer à un équipier.', enabled: true },
    { id: 7, title: 'Réponses aux clients', content: 'Être direct, naturel et chaleureux. Éviter les phrases longues et ne pas répéter une information déjà confirmée.', enabled: true },
  ],
};

export async function fetchRestaurantAgentConfig(restaurantId: string): Promise<RestaurantAgentConfig> {
  if (!supabase) return defaultConfig;
  const { data, error } = await supabase
    .from('restaurant_agent_configs')
    .select('welcome_message, voice, tone, language, speech_rate, knowledge_base, updated_at')
    .eq('restaurant_id', restaurantId)
    .single();
  if (error || !data) return defaultConfig;
  return {
    welcome_message: data.welcome_message || defaultConfig.welcome_message,
    voice: data.voice || defaultConfig.voice,
    tone: data.tone || defaultConfig.tone,
    language: data.language || defaultConfig.language,
    speech_rate: typeof data.speech_rate === 'number' ? data.speech_rate : defaultConfig.speech_rate,
    knowledge_base: Array.isArray(data.knowledge_base) ? data.knowledge_base : defaultConfig.knowledge_base,
    updated_at: data.updated_at,
  };
}

export async function upsertRestaurantAgentConfig(
  restaurantId: string,
  config: Partial<RestaurantAgentConfig>
): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: true };
  const { error } = await supabase
    .from('restaurant_agent_configs')
    .upsert({
      restaurant_id: restaurantId,
      welcome_message: config.welcome_message,
      voice: config.voice,
      tone: config.tone,
      language: config.language,
      speech_rate: config.speech_rate,
      knowledge_base: config.knowledge_base,
    }, { onConflict: 'restaurant_id' });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
