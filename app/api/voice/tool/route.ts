import { createClient } from '@supabase/supabase-js';
import { verifyToolSessionToken } from '@/lib/realtime/session-token';
import {
  parseAddItemArguments,
  parseRemoveItemArguments,
  parseSetItemQuantityArguments,
  parseUpdateOrderArguments,
  type ToolResult,
} from '@/lib/realtime/tool-protocol';
import type { ToolRequest } from '@/lib/voice/server/types';
import { submitOrderToRestaurant } from '@/lib/voice/server/submit-to-restaurant';

export const runtime = 'nodejs';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://pfnwodwpefugpcynykga.supabase.co';
const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBmbndvZHdwZWZ1Z3BjeW55a2dhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNjk1NjYsImV4cCI6MjEwMzg0NTU2Nn0.9pjtztv06yFoawUi4ZszCq9XPQ9RqHEOMDlgzmiSCR4';

const failure = (errorCode: string, message: string, retryable = false) => ({
  success: false as const,
  errorCode,
  message,
  retryable,
});

function jsonToolOutput(result: { success: boolean; errorCode?: string; message?: string; retryable?: boolean; data?: unknown }) {
  try {
    return JSON.stringify(result);
  } catch {
    return JSON.stringify(failure('SERIALIZATION_ERROR', 'Le résultat n’a pas pu être sérialisé.', true));
  }
}

type IncrementalToolName = 'add_item' | 'remove_item' | 'update_item_quantity' | 'update_order' | 'get_basket';

const isIncrementalToolName = (value: string): value is IncrementalToolName =>
  value === 'add_item' || value === 'remove_item' || value === 'update_item_quantity' || value === 'update_order' || value === 'get_basket';

function okResponse(result: ToolResult<unknown>) {
  return Response.json(
    { result, output: jsonToolOutput(result) },
    { status: 200 },
  );
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({})) as Partial<ToolRequest>;

  if (!body.token || !body.callId || !body.tool || typeof body.arguments !== 'string') {
    return Response.json(
      { result: failure('INVALID_REQUEST', 'Requête invalide.'), output: jsonToolOutput(failure('INVALID_REQUEST', 'Requête invalide.')) },
      { status: 400 },
    );
  }

  const claims = verifyToolSessionToken(body.token);
  if (!claims) {
    return Response.json(
      { result: failure('UNAUTHORIZED', 'Session non authentifiée.'), output: jsonToolOutput(failure('UNAUTHORIZED', 'Session non authentifiée.')) },
      { status: 401 },
    );
  }

  const supabase = createClient(supabaseUrl, supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    // ------------------ Outils incrémentaux du panier ------------------
    if (isIncrementalToolName(body.tool)) {
      if (body.tool === 'get_basket') {
        const { data, error } = await supabase.rpc('voice_tool_get_basket', {
          p_conversation_id: claims.conversationId,
          p_restaurant_id: claims.restaurantId,
        });
        if (error) {
          console.error('[voice/tool] get_basket rpc failed', error.message);
          return okResponse(failure('BASKET_UNAVAILABLE', 'Le panier est momentanément indisponible. Propose au client de réessayer.', true));
        }
        return okResponse(data as ToolResult<unknown>);
      }

      if (body.tool === 'add_item') {
        const parsed = parseAddItemArguments(body.arguments);
        if (!parsed.success) return okResponse(parsed);

        const selections = parsed.data.selections?.flatMap((selection) =>
          selection.options.map((option) => ({ group: selection.group, option })),
        ) ?? [];

        const { data, error } = await supabase.rpc('voice_tool_add_item', {
          p_conversation_id: claims.conversationId,
          p_restaurant_id: claims.restaurantId,
          p_product_id: parsed.data.product_id,
          p_quantity: parsed.data.quantity,
          p_selections_json: selections,
        });

        if (error) {
          console.error('[voice/tool] add_item rpc failed', error.message);
          return okResponse(failure('BASKET_STORAGE_ERROR', 'Le produit n’a pas pu être ajouté. Propose au client de réessayer.', true));
        }
        return okResponse(data as ToolResult<unknown>);
      }

      if (body.tool === 'remove_item') {
        const parsed = parseRemoveItemArguments(body.arguments);
        if (!parsed.success) return okResponse(parsed);

        const { data, error } = await supabase.rpc('voice_tool_remove_item', {
          p_conversation_id: claims.conversationId,
          p_restaurant_id: claims.restaurantId,
          p_product_id: parsed.data.product_id,
          p_quantity: parsed.data.quantity ?? null,
        });

        if (error) {
          console.error('[voice/tool] remove_item rpc failed', error.message);
          return okResponse(failure('BASKET_STORAGE_ERROR', 'Le produit n’a pas pu être retiré. Propose au client de réessayer.', true));
        }
        return okResponse(data as ToolResult<unknown>);
      }

      if (body.tool === 'update_item_quantity') {
        const parsed = parseSetItemQuantityArguments(body.arguments);
        if (!parsed.success) return okResponse(parsed);

        const { data, error } = await supabase.rpc('voice_tool_set_item_quantity', {
          p_conversation_id: claims.conversationId,
          p_restaurant_id: claims.restaurantId,
          p_product_id: parsed.data.product_id,
          p_quantity: parsed.data.quantity,
        });

        if (error) {
          console.error('[voice/tool] set_item_quantity rpc failed', error.message);
          return okResponse(failure('BASKET_STORAGE_ERROR', 'La quantité n’a pas pu être modifiée. Propose au client de réessayer.', true));
        }
        return okResponse(data as ToolResult<unknown>);
      }

      if (body.tool === 'update_order') {
        const parsed = parseUpdateOrderArguments(body.arguments);
        if (!parsed.success) return okResponse(parsed);

        const { data, error } = await supabase.rpc('voice_tool_update_order', {
          p_conversation_id: claims.conversationId,
          p_restaurant_id: claims.restaurantId,
          p_args_json: body.arguments,
        });

        if (error) {
          console.error('[voice/tool] update_order rpc failed', error.message);
          return okResponse(failure('BASKET_STORAGE_ERROR', 'Le panier n’a pas pu être enregistré. Propose au client de réessayer.', true));
        }
        return okResponse(data as ToolResult<unknown>);
      }
    }

    // ------------------ Soumission de commande ------------------
    if (body.tool === 'submit_order') {
      let confirmation = '';
      try {
        confirmation = (JSON.parse(body.arguments) as { confirmation?: string }).confirmation ?? '';
      } catch {
        // ignore
      }
      if (confirmation !== 'explicit') {
        return okResponse(failure('CONFIRMATION_REQUIRED', 'Le client doit confirmer explicitement sa commande avant l’envoi.', false));
      }

      const { data: basketData, error: basketError } = await supabase.rpc('voice_tool_get_basket', {
        p_conversation_id: claims.conversationId,
        p_restaurant_id: claims.restaurantId,
      });

      if (basketError) {
        console.error('[voice/tool] submit_order basket lookup failed', basketError.message);
        return okResponse(failure('BASKET_UNAVAILABLE', 'Le panier est momentanément indisponible. Propose au client de réessayer.', true));
      }

      const basket = (basketData as { success: boolean; data?: { items?: unknown[]; total?: number } } | null)?.data;
      if (!basket || !basket.items || basket.items.length === 0) {
        return okResponse(failure('BASKET_EMPTY', 'Le panier est vide. Demande au client ce qu’il souhaite commander.', false));
      }

      const idempotencyKey = `${claims.conversationId}:${body.callId}`;

      const basketItems = (basket.items ?? []) as Array<{ name?: string; quantity?: number; price?: number; productId?: string }>;
      const submission = await submitOrderToRestaurant({
        restaurantId: claims.restaurantId,
        conversationId: claims.conversationId,
        idempotencyKey,
        items: basketItems.map((item) => ({
          name: item.name ?? item.productId ?? 'Article',
          quantity: item.quantity ?? 1,
          price: item.price ?? 0,
          sku_ref: item.productId,
        })),
        total: basket.total ?? 0,
      });

      if (!submission.success) {
        return okResponse(failure(submission.errorCode, submission.message, submission.retryable));
      }

      return okResponse({
        success: true as const,
        data: { orderId: submission.orderId ?? null, ref: submission.ref, status: 'submitted', via: submission.via },
        message: `La commande référence ${submission.ref} a bien été transmise au restaurant. Annonce cette référence au client.`,
      });
    }

    // ------------------ Transfert humain ------------------
    if (body.tool === 'request_human') {
      let reason = 'Demande du client';
      try {
        const args = JSON.parse(body.arguments) as { reason?: string };
        if (args.reason) reason = args.reason.slice(0, 240);
      } catch {
        // ignore
      }

      const { data, error } = await supabase.rpc('voice_tool_request_human', {
        p_conversation_id: claims.conversationId,
        p_restaurant_id: claims.restaurantId,
        p_reason: reason,
      });

      if (error) {
        console.error('[voice/tool] request_human rpc failed', error.message);
        return okResponse(failure('TRANSFER_STORAGE_ERROR', 'Le transfert n’a pas pu être enregistré.', true));
      }

      const result = (data ?? { success: true, data: { transferred: true, reason } }) as ToolResult<unknown>;
      return okResponse(result);
    }

    return Response.json(
      { result: failure('UNKNOWN_TOOL', 'Cette opération n’est pas disponible.'), output: jsonToolOutput(failure('UNKNOWN_TOOL', 'Cette opération n’est pas disponible.')) },
      { status: 400 },
    );
  } catch (error) {
    console.error('[voice/tool] unhandled error', error instanceof Error ? error.message : error);
    return okResponse(failure('INTERNAL_ERROR', 'Une erreur technique est survenue. Propose au client de réessayer.', true));
  }
}
