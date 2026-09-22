import { Metrics } from "../utils/metrics";
import type { ServerLog } from "../utils/serverLog";
import { withTimeout } from "../utils/timeout";
import type { JsonRpcResponse, ToolDefinition, ToolListItem } from "../utils/types";
import { handleRequest } from "./transport";

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONCURRENT = 10;

/** Thrown when the concurrency cap is exceeded. */
export class BusyError extends Error {
  constructor(
    public readonly current: number,
    public readonly max: number,
  ) {
    super(`Server busy: ${current} tool calls in flight (max ${max})`);
    this.name = "BusyError";
  }
}

export interface ToolExecutorOptions {
  /** Hard deadline for any tool call, ms. Default 30s. Prevents a hung
   *  VS Code / DAP call from freezing the server and killing the port. */
  toolTimeoutMs?: number;
  /** Concurrent tool-call cap. Default 10. Overflow gets an immediate
   *  429 / error response instead of queueing behind a stall. */
  maxConcurrentRequests?: number;
  /** Metrics registry feeding /metrics and /diagnostics. */
  metrics?: Metrics;
  /** JSON-lines file logger (survives process death — hot reload). */
  logger?: ServerLog;
  /** Per-window identity surfaced via initialize `serverInfo` (see ServerIdentity). */
  instanceId?: string;
  instanceName?: string;
}

/**
 * The tool-call execution engine shared by every cluster member.
 *
 * A VS Code extension host owns exactly one window's `vscode` API, so the
 * tools registered here execute against THIS process's workspace. The leader
 * uses a ToolExecutor for local execution and the HTTP layer (McpServer);
 * each worker uses one to execute tool payloads forwarded over the IPC pipe.
 * Keeping the engine separate from the transport is what lets every member
 * run the exact same tool set with the same concurrency / timeout / metrics
 * guarantees regardless of role.
 */
export class ToolExecutor {
  private readonly tools: Map<string, ToolDefinition> = new Map();
  private readonly metrics: Metrics;
  private readonly maxConcurrentLimit: number;
  private readonly toolTimeoutMs?: number;
  private readonly fileLog?: ServerLog;
  private readonly instanceId?: string;
  private readonly instanceName?: string;
  private inFlight = 0;

  constructor(options: ToolExecutorOptions = {}) {
    this.metrics = options.metrics ?? new Metrics();
    this.maxConcurrentLimit = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT;
    this.toolTimeoutMs = options.toolTimeoutMs;
    this.fileLog = options.logger;
    this.instanceId = options.instanceId;
    this.instanceName = options.instanceName;
  }

  get toolCount(): number {
    return this.tools.size;
  }

  /** Number of tool calls currently executing (for gauges / tests). */
  get inflight(): number {
    return this.inFlight;
  }

  /** Concurrency cap (for gauges). */
  get maxConcurrent(): number {
    return this.maxConcurrentLimit;
  }

  registerTool(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  listTools(): ToolListItem[] {
    const items: ToolListItem[] = [];
    for (const [, def] of this.tools) {
      items.push({
        name: def.name,
        description: def.description,
        inputSchema: def.inputSchema as Record<string, unknown>,
      });
    }
    return items;
  }

  /** Resolve a tool's effective timeout: option cap, else per-tool, else default. */
  private effectiveTimeoutMs(toolName: string): number {
    const toolDef = this.tools.get(toolName);
    return this.toolTimeoutMs ?? toolDef?.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  }

  /**
   * Run a JSON-RPC request under the concurrency cap; time it; record
   * metrics and a durable log line per request. Throws BusyError when
   * over the cap, and rethrows tool errors after recording them.
   */
  async dispatch(rawBody: string): Promise<JsonRpcResponse> {
    if (this.inFlight >= this.maxConcurrentLimit) {
      throw new BusyError(this.inFlight, this.maxConcurrentLimit);
    }
    this.inFlight++;
    const started = Date.now();
    const toolName = extractToolName(rawBody);
    try {
      const timeoutMs = this.effectiveTimeoutMs(toolName);
      const response = await withTimeout(
        handleRequest(rawBody, this.tools, {
          instanceId: this.instanceId,
          instanceName: this.instanceName,
        }),
        timeoutMs,
        `Tool call timed out after ${timeoutMs}ms (VS Code/DAP unresponsive)`,
      );
      const durMs = Date.now() - started;
      this.metrics
        .histogram("vscode_mcp_tool_duration_seconds", "Tool call duration (seconds)")
        .observe(durMs / 1000);
      this.metrics.counterInc("vscode_mcp_tool_total", "Total tool calls dispatched");
      if (response.error) {
        const msg = response.error.message || "code " + response.error.code;
        this.metrics.recordError(toolName, msg);
        this.metrics.counterInc("vscode_mcp_tool_errors", "Tool calls that returned an error");
        this.fileLog?.log({ type: "tool", tool: toolName, ok: false, durMs, error: msg });
      } else {
        this.fileLog?.log({ type: "tool", tool: toolName, ok: true, durMs });
      }
      return response;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.metrics.counterInc("vscode_mcp_tool_errors", "Tool calls that threw");
      this.metrics.recordError(toolName, msg);
      this.fileLog?.log({
        type: "tool",
        tool: toolName,
        ok: false,
        durMs: Date.now() - started,
        error: msg,
        threw: true,
      });
      throw err;
    } finally {
      this.inFlight--;
    }
  }
}

/** Best-effort extraction of the MCP method / tool name for metrics and logs. */
export function extractToolName(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { method?: string; params?: { name?: string } };
    if (parsed?.method === "tools/call" && typeof parsed.params?.name === "string") {
      return parsed.params.name;
    }
    if (typeof parsed?.method === "string") return parsed.method;
  } catch {
    /* fall through */
  }
  return "<unparseable>";
}
