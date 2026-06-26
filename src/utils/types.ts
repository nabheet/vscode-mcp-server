// ── JSON-RPC 2.0 Types ──────────────────────────────────────────────
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

// ── MCP Tool Types ───────────────────────────────────────────────────
export type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<CallToolResult> | CallToolResult;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

export interface TextContent {
  type: 'text';
  text: string;
}

export interface CallToolResult {
  content: TextContent[];
  isError: boolean;
}

// ── MCP Method Names ─────────────────────────────────────────────────
export const MCP_TOOLS_LIST = 'tools/list' as const;
export const MCP_TOOLS_CALL = 'tools/call' as const;
export const MCP_INITIALIZE = 'initialize' as const;
export const MCP_NOTIFICATION_INITIALIZED = 'notifications/initialized' as const;
export type McpMethod = typeof MCP_TOOLS_LIST | typeof MCP_TOOLS_CALL | typeof MCP_INITIALIZE;

// ── Error Codes (JSON-RPC 2.0 standard + MCP range) ─────────────────
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ToolNotFound: -32001,
  ToolExecutionError: -32002,
  VscodeApiError: -32003,
} as const;

// ── Tool call params (tools/call) ────────────────────────────────────
export interface ToolCallParams {
  name: string;
  arguments?: Record<string, unknown>;
}

// ── Tools/list result shape ──────────────────────────────────────────
export interface ToolListItem {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ListToolsResult {
  tools: ToolListItem[];
}
