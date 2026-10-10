import { NextResponse } from 'next/server';
import { requirePlatformAdmin } from '@/lib/admin/server';
import { estimateRealtimeCost } from '@/lib/voice/pricing';

export async function GET(request: Request) {
  const context = await requirePlatformAdmin(request);
  if (context instanceof Response) return context;

  const { searchParams } = new URL(request.url);
  const restaurantId = searchParams.get('restaurantId');
  if (!restaurantId) {
    return NextResponse.json({ error: 'restaurantId requis.' }, { status: 400 });
  }

  const daysParam = searchParams.get('days') ?? '30';
  const days = Math.min(90, Math.max(1, Number(daysParam) || 30));
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const { data: audits, error } = await context.client
    .from('conversation_audits')
    .select('id, ended_at, messages, usage')
    .eq('restaurant_id', restaurantId)
    .gte('ended_at', since)
    .order('ended_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: 'Impossible de charger les audits vocaux.' }, { status: 502 });
  }

  const rows = audits || [];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCost = 0;
  let totalClientMessages = 0;
  let totalRephrasingHints = 0;
  const conversations = rows.length;

  for (const row of rows) {
    const usage = row.usage as {
      input_tokens?: number;
      output_tokens?: number;
      input_token_details?: { audio?: number; text?: number };
      output_token_details?: { audio?: number; text?: number };
    } | null;
    if (usage) {
      totalInputTokens += usage.input_tokens || 0;
      totalOutputTokens += usage.output_tokens || 0;
      totalCost += estimateRealtimeCost(usage);
    }
    const messages = Array.isArray(row.messages) ? row.messages : [];
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

  return NextResponse.json({
    conversations,
    averageDurationMinutes: conversations ? Number(((days * 24 * 60) / conversations).toFixed(1)) : 0,
    comprehension: {
      clientMessages: totalClientMessages,
      rephrasingHints: totalRephrasingHints,
      rephrasingRate: totalClientMessages ? Number(((totalRephrasingHints / totalClientMessages) * 100).toFixed(1)) : 0,
    },
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
    },
    costEur: Number(totalCost.toFixed(4)),
  });
}
