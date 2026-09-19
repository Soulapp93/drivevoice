import type { ToolResult } from '@/lib/realtime/tool-protocol';

export type { ToolResult };

export type VoiceToolName = 'update_order' | 'get_basket' | 'submit_order' | 'request_human';

export type ToolRequest = {
  token: string;
  callId: string;
  tool: VoiceToolName;
  arguments: string;
};

export type ToolResponse = {
  result: ToolResult<unknown>;
  output: string;
};

export type AuthenticatedToolContext = {
  conversationId: string;
  restaurantId: string;
  callId: string;
  args: string;
};

export type ToolHandler = (ctx: AuthenticatedToolContext) => Promise<ToolResult<unknown>>;
