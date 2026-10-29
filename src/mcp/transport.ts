import * as pkg from "../../package.json";

import {
  ErrorCode,
  type JsonRpcError,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ListToolsResult,
  MCP_INITIALIZE,
  MCP_NOTIFICATION_INITIALIZED,
  MCP_TOOLS_CALL,
  MCP_TOOLS_LIST,
  type ToolCallParams,
  type ToolDefinition,
  type ToolListItem,
} from "../utils/types";

// ── Schema Validator ─────────────────────────────────────────────────

function validateAgainstSchema(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | null {
  const props = schema.properties as Record<string, { type?: string }> | undefined;
  const required = schema.required as string[] | undefined;

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
      if (prop?.type) {
        const expected = prop.type;
        if (expected === "array" && Array.isArray(value)) continue;
        const actual = typeof value;
        if (expected === "integer" && actual === "number" && Number.isInteger(value as number))
          continue;
        if (expected === "number" && actual === "number") continue;
        if (actual !== expected) {
          return `Argument '${key}' expected type '${expected}', got '${actual}'`;
        }
      }
    }
  }

  return null;
}

// ── Response Helpers ─────────────────────────────────────────────────

// Legacy revisions supported by this initialization-based server. The
// 2026-07-28 revision changes negotiation to per-request metadata and requires
// server/discover, so it needs a separate implementation.
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;
const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];
const SUPPORTED_PROTOCOL_VERSION_SET: ReadonlySet<string> = new Set(SUPPORTED_PROTOCOL_VERSIONS);

function negotiateProtocolVersion(params: unknown): string {
  const requested =
    typeof params === "object" && params !== null && "protocolVersion" in params
      ? params.protocolVersion
      : undefined;
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSION_SET.has(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

function makeResult(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function makeError(id: number | string | null, error: JsonRpcError): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error };
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
    return { error: makeError(null, jrpcError(ErrorCode.ParseError, "Parse error: invalid JSON")) };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      error: makeError(
        null,
        jrpcError(ErrorCode.InvalidRequest, "Invalid Request: body must be a JSON object"),
      ),
    };
  }

  const req = parsed as Record<string, unknown>;

  if (req.jsonrpc !== "2.0") {
    return {
      error: makeError(
        (req.id as string | number | null) ?? null,
        jrpcError(ErrorCode.InvalidRequest, 'Invalid Request: jsonrpc must be "2.0"'),
      ),
    };
  }

  if (typeof req.method !== "string") {
    return {
      error: makeError(
        (req.id as string | number | null) ?? null,
        jrpcError(ErrorCode.InvalidRequest, "Invalid Request: method must be a string"),
      ),
    };
  }

  return {
    req: {
      jsonrpc: "2.0",
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
  id: JsonRpcRequest["id"],
  params: unknown,
): Promise<JsonRpcResponse> {
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    return makeError(
      id,
      jrpcError(ErrorCode.InvalidParams, 'Invalid params: expected object with "name"'),
    );
  }

  const callParams = params as ToolCallParams;
  if (typeof callParams.name !== "string" || callParams.name.length === 0) {
    return makeError(
      id,
      jrpcError(ErrorCode.InvalidParams, 'Invalid params: "name" must be a non-empty string'),
    );
  }

  const tool = tools.get(callParams.name);
  if (!tool) {
    return makeError(id, jrpcError(ErrorCode.InvalidParams, `Unknown tool: ${callParams.name}`));
  }

  if (
    callParams.arguments !== undefined &&
    (typeof callParams.arguments !== "object" ||
      callParams.arguments === null ||
      Array.isArray(callParams.arguments))
  ) {
    return makeError(
      id,
      jrpcError(ErrorCode.InvalidParams, 'Invalid params: "arguments" must be an object'),
    );
  }

  const args = callParams.arguments ?? {};
  const schemaErr = validateAgainstSchema(args, tool.inputSchema);
  if (schemaErr) {
    return makeResult(id, { content: [{ type: "text", text: schemaErr }], isError: true });
  }

  try {
    return makeResult(id, await tool.handler(args));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return makeResult(id, {
      content: [{ type: "text", text: `Tool error: ${msg}` }],
      isError: true,
    });
  }
}

// ── Main Dispatch ────────────────────────────────────────────────────

/**
 * Per-instance identity surfaced to MCP clients via initialize `serverInfo`.
 * `instanceId` is a stable per-window UUID that also appears in
 * `list_workspaces` entries, letting a client correlate the endpoint it is
 * talking to with a specific VS Code window in the cluster.
 */
export interface ServerIdentity {
  instanceId?: string;
  instanceName?: string;
}

export async function handleRequest(
  rawBody: string,
  tools: Map<string, ToolDefinition>,
  identity?: ServerIdentity,
): Promise<JsonRpcResponse> {
  const { req, error: parseError } = parseBody(rawBody);
  if (parseError) return parseError;
  if (!req) throw new Error("parseBody returned neither req nor error");

  const { id, method } = req;

  switch (method) {
    case MCP_INITIALIZE:
      return makeResult(id, {
        protocolVersion: negotiateProtocolVersion(req.params),
        capabilities: { tools: {} },
        serverInfo: {
          name: pkg.name,
          version: pkg.version,
          ...(identity?.instanceId ? { instanceId: identity.instanceId } : {}),
          ...(identity?.instanceName ? { instanceName: identity.instanceName } : {}),
        },
      });
    case MCP_NOTIFICATION_INITIALIZED:
      // Notification — no response expected
      return makeResult(id, {});
    case MCP_TOOLS_LIST:
      return makeResult(id, handleListTools(tools));
    case MCP_TOOLS_CALL:
      return handleCallTool(tools, id, req.params);
    default:
      return makeError(id, jrpcError(ErrorCode.MethodNotFound, `Method not found: '${method}'`));
  }
}
