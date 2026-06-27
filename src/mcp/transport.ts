import * as pkg from '../../package.json';

import {
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcError,
  ErrorCode,
  MCP_TOOLS_LIST,
  MCP_TOOLS_CALL,
  MCP_INITIALIZE,
  MCP_NOTIFICATION_INITIALIZED,
  ToolCallParams,
  ToolDefinition,
  ToolListItem,
  CallToolResult,
  ListToolsResult,
} from '../utils/types';

// ── Schema Validator ─────────────────────────────────────────────────

function validateAgainstSchema(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | null {
  const props = (schema as any).properties as Record<string, { type?: string }> | undefined;
  const required = (schema as any).required as string[] | undefined;

  if (required) {
    for (const key of required) {
      if (args[key] === undefined || args[key] === null) {
        return `Missing required argument: '${key}'`;
      }
    }
  }

  if (props) {
    for (const [key, value] of Object.entries(args)) {
      const prop = props[key];
      if (prop && prop.type) {
        const expected = prop.type;
        if (expected === 'array' && Array.isArray(value)) continue;
        const actual = typeof value;
        if (expected === 'integer' && actual === 'number' && Number.isInteger(value as number)) continue;
        if (expected === 'number' && actual === 'number') continue;
        if (actual !== expected) {
          return `Argument '${key}' expected type '${expected}', got '${actual}'`;
        }
      }
    }
  }

  return null;
}

// ── Response Helpers ─────────────────────────────────────────────────

function makeResult(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id: number | string | null, error: JsonRpcError): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error };
}

function jrpcError(code: number, message: string, data?: unknown): JsonRpcError {
  return { code, message, ...(data !== undefined ? { data } : {}) };
}

// ── Body Parser ──────────────────────────────────────────────────────

function parseBody(raw: string): { req?: JsonRpcRequest; error?: JsonRpcResponse } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: makeError(null, jrpcError(ErrorCode.ParseError, 'Parse error: invalid JSON')) };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { error: makeError(null, jrpcError(ErrorCode.InvalidRequest, 'Invalid Request: body must be a JSON object')) };
  }

  const req = parsed as Record<string, unknown>;

  if (req.jsonrpc !== '2.0') {
    return { error: makeError((req.id as string | number | null) ?? null, jrpcError(ErrorCode.InvalidRequest, 'Invalid Request: jsonrpc must be "2.0"')) };
  }

  if (typeof req.method !== 'string') {
    return { error: makeError((req.id as string | number | null) ?? null, jrpcError(ErrorCode.InvalidRequest, 'Invalid Request: method must be a string')) };
  }

  return {
    req: {
      jsonrpc: '2.0',
      id: (req.id as string | number | null) ?? null,
      method: req.method,
      params: req.params,
    },
  };
}

// ── tools/list handler ────────────────────────────────────────────────

function handleListTools(tools: Map<string, ToolDefinition>): ListToolsResult {
  const items: ToolListItem[] = [];
  for (const [, def] of tools) {
    items.push({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema as Record<string, unknown>,
    });
  }
  return { tools: items };
}

// ── tools/call handler ────────────────────────────────────────────────

async function handleCallTool(
  tools: Map<string, ToolDefinition>,
  params: unknown,
): Promise<CallToolResult> {
  if (typeof params !== 'object' || params === null) {
    return { content: [{ type: 'text', text: 'Invalid params: expected object with "name"' }], isError: true };
  }

  const callParams = params as ToolCallParams;
  if (typeof callParams.name !== 'string' || callParams.name.length === 0) {
    return { content: [{ type: 'text', text: 'Invalid params: "name" must be a non-empty string' }], isError: true };
  }

  const tool = tools.get(callParams.name);
  if (!tool) {
    const names = Array.from(tools.keys()).join(', ');
    return { content: [{ type: 'text', text: `Tool not found: '${callParams.name}'. Available: ${names || '(none)'}` }], isError: true };
  }

  const args = callParams.arguments ?? {};
  const schemaErr = validateAgainstSchema(args, tool.inputSchema);
  if (schemaErr) {
    return { content: [{ type: 'text', text: schemaErr }], isError: true };
  }

  try {
    return await tool.handler(args);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Tool error: ${msg}` }], isError: true };
  }
}

// ── Main Dispatch ────────────────────────────────────────────────────

export async function handleRequest(
  rawBody: string,
  tools: Map<string, ToolDefinition>,
): Promise<JsonRpcResponse> {
  const { req, error: parseError } = parseBody(rawBody);
  if (parseError || !req) return parseError!;

  const { id, method } = req;

  switch (method) {
    case MCP_INITIALIZE:
      return makeResult(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: pkg.name, version: pkg.version },
      });
    case MCP_NOTIFICATION_INITIALIZED:
      // Notification — no response expected
      return makeResult(id, {});
    case MCP_TOOLS_LIST:
      return makeResult(id, handleListTools(tools));
    case MCP_TOOLS_CALL:
      return makeResult(id, await handleCallTool(tools, req.params));
    default:
      return makeError(id, jrpcError(ErrorCode.MethodNotFound, `Method not found: '${method}'`));
  }
}
