import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin/server';
import { estimateRealtimeCost } from '@/lib/voice/pricing';

export async function GET(request: Request) {
  const context = await requirePlatformAdmin(request);
  if (context instanceof Response) return context;

  const days = 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // Récupérer tous les restaurants actifs avec leur catalogue
  const { data: restaurants, error: restaurantsError } = await context.client
    .from('restaurants')
    .select('id, name')
    .eq('active', true)
    .limit(500);

  if (restaurantsError) {
    return NextResponse.json({ error: 'Impossible de charger les restaurants.' }, { status: 502 });
  }

  const restaurantList = restaurants ?? [];

  // Récupérer tous les audits de conversations sur 30 jours
  const { data: audits, error: auditsError } = await context.client
    .from('conversation_audits')
    .select('restaurant_id, messages, usage')
    .gte('ended_at', since);

  if (auditsError) {
    return NextResponse.json({ error: 'Impossible de charger les audits vocaux.' }, { status: 502 });
  }

  // Agréger les métriques vocales par restaurant
  let totalConversations = 0;
  let totalRephrasingHints = 0;
  let totalClientMessages = 0;
  let globalCostEur = 0;

  for (const audit of audits ?? []) {
    totalConversations += 1;
    const usage = audit.usage as {
      input_tokens?: number;
      output_tokens?: number;
      input_token_details?: { audio?: number; text?: number };
      output_token_details?: { audio?: number; text?: number };
    } | null;
    if (usage) globalCostEur += estimateRealtimeCost(usage);
    const messages = Array.isArray(audit.messages) ? audit.messages : [];
    for (const message of messages) {
      if (typeof message !== 'object' || message === null) continue;
      if (message.speaker === 'client') {
        totalClientMessages += 1;
        const text = String(message.text ?? '').toLowerCase();
        if (/(pardon|repe?t(e|é)|comment|repète|n'ai pas compri|pas entendu|encore)/.test(text)) {
          totalRephrasingHints += 1;
        }
      }
    }
  }

  const globalRephrasingRate = totalClientMessages > 0
    ? Number(((totalRephrasingHints / totalClientMessages) * 100).toFixed(1))
    : 0;

  // Détecter les erreurs de catalogue par restaurant (heuristique)
  const catalogErrors: Array<{ restaurantId: string; restaurantName: string; errorCount: number }> = [];

  for (const restaurant of restaurantList) {
    const { data: products } = await context.client
      .from('restaurant_products')
      .select('id, name, price, category, type, menu_sizes')
      .eq('restaurant_id', restaurant.id)
      .limit(500);

    if (!products || products.length === 0) continue;

    let errorCount = 0;
    for (const product of products) {
      const price = typeof product.price === 'number' ? product.price : parseFloat(String(product.price ?? ''));
      const hasInvalidPrice = isNaN(price) || price <= 0;
      const hasMissingCategory = !product.category || String(product.category).trim() === '';
      const isMenu = product.type === 'menu' || product.type === 'configurable';
      const menuSizes = Array.isArray(product.menu_sizes) ? product.menu_sizes : [];
      const hasMissingMenuSizes = isMenu && menuSizes.length === 0;
      if (hasInvalidPrice || hasMissingCategory || hasMissingMenuSizes) errorCount += 1;
    }

    if (errorCount > 0) {
      catalogErrors.push({ restaurantId: restaurant.id, restaurantName: restaurant.name, errorCount });
    }
  }

  return NextResponse.json({
    totalConversations,
    totalRephrasingHints,
    totalClientMessages,
    globalRephrasingRate,
    globalCostEur: Number(globalCostEur.toFixed(4)),
    catalogErrors,
  });
}
