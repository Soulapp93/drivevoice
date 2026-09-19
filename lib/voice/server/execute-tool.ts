import { jsonToolOutput, type ToolResult } from '@/lib/realtime/tool-protocol';
import { verifyToolSessionToken } from '@/lib/realtime/session-token';
import type { AuthenticatedToolContext, ToolHandler, ToolRequest, ToolResponse, VoiceToolName } from './types';
import { handleGetBasket } from './handlers/get-basket';
import { handleRequestHuman } from './handlers/request-human';
import { handleSubmitOrder } from './handlers/submit-order';
import { handleUpdateOrder } from './handlers/update-order';

const handlers: Record<VoiceToolName, ToolHandler> = {
  update_order: handleUpdateOrder,
  get_basket: handleGetBasket,
  submit_order: handleSubmitOrder,
  request_human: handleRequestHuman,
};

const failure = (errorCode: string, message: string, retryable = false): ToolResult<never> => ({
  success: false,
  errorCode,
  message,
  retryable,
});

export function isVoiceToolName(value: string): value is VoiceToolName {
  return value === 'update_order' || value === 'get_basket' || value === 'submit_order' || value === 'request_human';
}

export async function executeTool(request: ToolRequest): Promise<ToolResponse> {
  const claims = verifyToolSessionToken(request.token);
  if (!claims || !request.callId || !isVoiceToolName(request.tool)) {
    const result = failure('UNAUTHORIZED_TOOL_CALL', 'Cette opération n’est pas autorisée pour la session en cours.');
    return { result, output: jsonToolOutput(result) };
  }

  const ctx: AuthenticatedToolContext = {
    conversationId: claims.conversationId,
    restaurantId: claims.restaurantId,
    callId: request.callId,
    args: request.arguments,
  };

  const handler = handlers[request.tool];
  const result = await handler(ctx);
  return { result, output: jsonToolOutput(result) };
}
