// Tarifs indicatifs OpenAI Realtime API (gpt-4o-realtime).
// Ce sont des estimations à date, utilisées uniquement pour le tableau de bord.
// Les coûts réels peuvent varier selon les mises à jour tarifaires d’OpenAI.

export const OPENAI_REALTIME_PRICING = {
  input: {
    audio: { eurPer1mTokens: 40.0 }, // 40 € / million de tokens audio en entrée
    text: { eurPer1mTokens: 5.0 },   // 5 € / million de tokens texte en entrée
  },
  output: {
    audio: { eurPer1mTokens: 80.0 }, // 80 € / million de tokens audio en sortie
    text: { eurPer1mTokens: 20.0 },  // 20 € / million de tokens texte en sortie
  },
};

export function estimateRealtimeCost(usage: {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { audio?: number; text?: number };
  output_token_details?: { audio?: number; text?: number };
}): number {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const inputAudio = usage.input_token_details?.audio ?? 0;
  const inputText = usage.input_token_details?.text ?? input - inputAudio;
  const outputAudio = usage.output_token_details?.audio ?? 0;
  const outputText = usage.output_token_details?.text ?? output - outputAudio;

  const inputCost = (Math.max(0, inputAudio) * OPENAI_REALTIME_PRICING.input.audio.eurPer1mTokens +
    Math.max(0, inputText) * OPENAI_REALTIME_PRICING.input.text.eurPer1mTokens) / 1_000_000;
  const outputCost = (Math.max(0, outputAudio) * OPENAI_REALTIME_PRICING.output.audio.eurPer1mTokens +
    Math.max(0, outputText) * OPENAI_REALTIME_PRICING.output.text.eurPer1mTokens) / 1_000_000;

  return Number((inputCost + outputCost).toFixed(4));
}
