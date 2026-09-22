/**
 * LeaderCoordinator — the single process that owns the HTTP/SSE port.
 *
 * Responsibilities:
 *  - Serve the HTTP endpoint via McpServer (health, metrics, SSE, direct
 *    JSON-RPC) and execute calls targeting its own workspace locally.
 *  - Run the local IPC pipe that Workers connect to.
 *  - Keep a routing table of connected Workers and proxy tool calls to the
 *    Worker whose workspace the request targets.
 *  - Respond to Worker heartbeats (PING → PONG).
 *
 * Pure Node (no vscode API): workspace identity and the tool executor are
 * injected by extension.ts, which keeps this layer unit-testable.
 */

import { randomUUID } from "node:crypto";
import type * as net from "node:net";
import type { Metrics } from "../../utils/metrics";
import type { ServerLog } from "../../utils/serverLog";
import type { JsonRpcResponse } from "../../utils/types";
import type { ToolExecutor } from "../executor";
import { type McpRouter, type McpRouterResult, McpServer } from "../server";
import { defineTool } from "../tools/index";
import { getIpcPath, MSG, PROXY_TIMEOUT_MS, REGISTER_TIMEOUT_MS } from "./constants";
import { closeIpcServer, createIpcServer, unlinkStaleSocketFile } from "./ipc";
import { createDecoder, encodeMessage, type IpcMessage, type WindowState } from "./protocol";

interface WorkerEntry {
  id: string;
  workspacePaths: string[];
  displayName: string;
  /** Stable per-window UUID sent in REGISTER (wire-level identity). */
  instanceId?: string;
  instanceName?: string;
  /** Latest window state (active file / open editors) from MSG.UPDATE. */
  state?: WindowState;
  socket: net.Socket;
}

interface PendingCall {
  workerId: string;
  resolve: (r: JsonRpcResponse) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface LeaderOptions {
  port: number;
  host: string;
  ipcPath?: string;
  authToken?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  executor: ToolExecutor;
  metrics?: Metrics;
  logger?: ServerLog;
  workspaceId: string;
  workspacePaths: string[];
  displayName: string;
  /** Stable per-window UUID for the leader's own list_workspaces row. */
  instanceId?: string;
  instanceName?: string;
  /** Initial window state (active file / open editors) for the leader row. */
  state?: WindowState;
  log?: (msg: string) => void;
}

type Target = "local" | { workerId: string } | { error: JsonRpcResponse };

export class LeaderCoordinator implements McpRouter {
  readonly role = "leader" as const;
  private readonly opts: LeaderOptions;
  private readonly ipcPath: string;
  private server: McpServer;
  private ipcServer: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private localState: WindowState = { openEditors: [] };
  /** Per-connection state: registration status + worker id (set on REGISTER). */
  private ipcPeer = new Map<net.Socket, { registered: boolean; entryId: string | null }>();
  private workers = new Map<string, WorkerEntry>();
  private pending = new Map<string, PendingCall>();

  constructor(opts: LeaderOptions) {
    this.opts = opts;
    this.ipcPath = opts.ipcPath ?? getIpcPath();
    if (opts.state) this.localState = opts.state;

    this.server = new McpServer({
      port: opts.port,
      host: opts.host,
      ...(opts.authToken ? { authToken: opts.authToken } : {}),
      ...(opts.tlsCertPath && opts.tlsKeyPath
        ? { tlsCertPath: opts.tlsCertPath, tlsKeyPath: opts.tlsKeyPath }
        : {}),
      metrics: opts.metrics,
      logger: opts.logger,
      executor: opts.executor,
      router: this,
    });

    // Discovery tool: lets MCP clients enumerate the windows in the cluster
    // and target a specific one via the `workspace` argument on tools/call.
    opts.executor.registerTool(
      defineTool(
        "list_workspaces",
        "List all VS Code windows/workspaces served by this MCP endpoint. Each entry has an id, display name, and workspace folders. Pass the id or a folder path as the `workspace` argument to tools/call or tools/list to target that window.",
        { type: "object", properties: {} },
        async () => {
          const rows = [
            {
              id: opts.workspaceId,
              instanceId: opts.instanceId,
              instanceName: opts.instanceName,
              displayName: opts.displayName,
              folders: opts.workspacePaths,
              role: "leader",
              state: this.localState,
            },
            ...Array.from(this.workers.values()).map((w) => ({
              id: w.id,
              instanceId: w.instanceId,
              instanceName: w.instanceName,
              displayName: w.displayName,
              folders: w.workspacePaths,
              role: "worker",
              state: w.state ?? { openEditors: [] },
            })),
          ];
          return {
            content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
            isError: false,
          };
        },
      ),
    );
  }

  get url(): string {
    const scheme = this.opts.tlsCertPath && this.opts.tlsKeyPath ? "https" : "http";
    return `${scheme}://${this.opts.host}:${this.opts.port}/mcp`;
  }

  get port(): number {
    return this.opts.port;
  }

  setOnListen(cb: (url: string) => void): void {
    this.server.setOnListen(cb);
  }

  async start(): Promise<void> {
    // NOTE: no pre-unlink here. createIpcServer already recovers stale
    // socket files safely (EADDRINUSE -> isIpcAlive -> unlink only if the
    // holder is dead). Unlinking unconditionally would let a promoting
    // window steal the IPC path from a LIVE leader — the split-brain bug.
    this.ipcServer = await createIpcServer(this.ipcPath);
    this.ipcServer.on("connection", (socket) => this.onIpcConnection(socket));
    try {
      await this.server.start();
    } catch (err) {
      // HTTP bind lost the race — undo the IPC server and let bootstrap
      // re-probe (it will find the winner as a valid leader and join).
      if (this.ipcServer) {
        await closeIpcServer(this.ipcServer, this.sockets);
        this.ipcServer = null;
      }
      throw err;
    }
  }

  async stop(timeoutMs = 5000): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Leader shutting down"));
    }
    this.pending.clear();
    await this.server.stop(timeoutMs);
    if (this.ipcServer) {
      await closeIpcServer(this.ipcServer, this.sockets);
      this.ipcServer = null;
    }
    this.workers.clear();
    if (process.platform !== "win32") {
      unlinkStaleSocketFile(this.ipcPath);
    }
  }

  // ── Cluster routing (McpRouter) ────────────────────────────────────

  async route(rawBody: string): Promise<McpRouterResult | null> {
    const parsed = parseBodyLight(rawBody);
    if (!parsed) return null;
    const { id, method, params } = parsed;
    if (method !== "tools/call" && method !== "tools/list") return null;

    const target = this.resolveTarget(id, method, params);
    if (target === "local") {
      const body = stripWorkspaceArg(rawBody, params);
      return body ? { body } : null;
    }
    if ("error" in target) {
      return { body: rawBody, response: target.error };
    }
    const body = stripWorkspaceArg(rawBody, params) ?? rawBody;
    const response = await this.proxyCall(target.workerId, body).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`[leader] proxy to worker ${target.workerId} failed: ${msg}`);
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: `Worker execution failed: ${msg}` },
      } as JsonRpcResponse;
    });
    return { body, response };
  }

  private resolveTarget(
    id: number | string | null,
    method: string,
    params: Record<string, unknown> | undefined,
  ): Target {
    const workspaceRef = typeof params?.workspace === "string" ? params.workspace : undefined;
    if (workspaceRef) {
      const t = this.resolveWorkspaceRef(workspaceRef);
      if (t === "local") return "local";
      if (t) return { workerId: t };
      return {
        error: {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: `Workspace '${workspaceRef}' not found. Use list_workspaces to enumerate available windows.`,
          },
        },
      };
    }
    if (method === "tools/list") return "local";
    const inferred = this.inferWorker(params);
    return inferred ? { workerId: inferred } : "local";
  }

  /** Resolve a `workspace` argument: id, exact folder path, or folder name. */
  private resolveWorkspaceRef(ref: string): "local" | string | null {
    if (ref === this.opts.workspaceId || ref === this.opts.instanceId) return "local";
    if (this.opts.workspacePaths.some((p) => p === ref || basename(p) === ref)) return "local";
    for (const w of this.workers.values()) {
      if (w.id === ref || w.displayName === ref || w.instanceId === ref) return w.id;
      if (w.workspacePaths.some((p) => p === ref || basename(p) === ref)) return w.id;
    }
    return null;
  }

  /**
   * Path-based inference for tools/call without an explicit workspace arg.
   * Scans path-like arguments (path/uri/file/folder/dir/cwd/workspaceFolder
   * and absolute-looking strings) and routes to the Worker whose workspace
   * path is the longest prefix of the target. Leader wins ties and is the
   * default when nothing matches.
   */
  private inferWorker(params: Record<string, unknown> | undefined): string | null {
    const args =
      params && typeof params.arguments === "object" && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {};
    const candidates = collectPathCandidates(args);
    if (candidates.length === 0) return null;

    const all = [
      { id: "local", path: "" },
      ...Array.from(this.workers.values()).flatMap((w) =>
        w.workspacePaths.map((p) => ({ id: w.id, path: p })),
      ),
    ].filter((e) => e.path.length > 0);

    let best: { id: string; len: number } | null = null;
    for (const candidate of candidates) {
      const norm = normalize(candidate);
      if (!norm) continue;
      for (const e of all) {
        const ws = normalize(e.path);
        if (!ws) continue;
        if (norm === ws || norm.startsWith(`${ws}/`) || norm.startsWith(`${ws}\\`)) {
          if (!best || ws.length > best.len) {
            best = { id: e.id, len: ws.length };
          } else if (ws.length === best.len && best.id !== "local" && e.id === "local") {
            // Equal-length match (same folder open in two windows):
            // the Leader wins the tie — it is the explicit default target.
            best = { id: e.id, len: ws.length };
          }
        }
      }
    }
    return best && best.id !== "local" ? best.id : null;
  }

  private proxyCall(workerId: string, body: string): Promise<JsonRpcResponse> {
    const worker = this.workers.get(workerId);
    if (!worker) {
      return Promise.reject(new Error(`Worker '${workerId}' is no longer connected`));
    }
    const callId = randomUUID();
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new Error("Worker timed out"));
      }, PROXY_TIMEOUT_MS);
      this.pending.set(callId, { workerId, resolve, reject, timer });
      try {
        worker.socket.write(encodeMessage({ type: MSG.CALL, callId, rawBody: body }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(callId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ── IPC server side ────────────────────────────────────────────────

  private onIpcConnection(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.setNoDelay(true);

    const state = { registered: false, entryId: null as string | null };
    this.ipcPeer.set(socket, state);
    const decode = createDecoder((msg) => {
      try {
        this.onIpcMessage(socket, msg);
      } catch (err) {
        this.log(`[leader] IPC handler error: ${err instanceof Error ? err.message : String(err)}`);
        socket.destroy();
      }
    });

    const regTimer = setTimeout(() => {
      if (!state.registered) {
        this.log("[leader] IPC peer did not REGISTER in time — closing");
        socket.destroy();
      }
    }, REGISTER_TIMEOUT_MS);

    socket.on("data", (chunk: Buffer) => {
      try {
        decode(chunk);
      } catch {
        socket.destroy(); // corrupt framing — drop the peer
      }
    });
    socket.on("close", () => {
      clearTimeout(regTimer);
      this.ipcPeer.delete(socket);
      this.sockets.delete(socket);
      if (state.entryId) this.dropWorker(state.entryId);
    });
    socket.on("error", () => {
      /* close handler cleans up */
    });
  }

  private onIpcMessage(socket: net.Socket, msg: IpcMessage): void {
    switch (msg.type) {
      case MSG.REGISTER: {
        const id = typeof msg.id === "string" ? msg.id : undefined;
        const paths = Array.isArray(msg.workspacePaths)
          ? msg.workspacePaths.filter((p): p is string => typeof p === "string")
          : [];
        const displayName =
          typeof msg.displayName === "string" ? msg.displayName : (id ?? "unknown");
        if (!id) {
          this.log("[leader] REGISTER without id — closing peer");
          socket.destroy();
          return;
        }
        // Replace a stale entry for the same window (reconnect after leader
        // restart) and fail any calls that were in flight to it.
        const existing = this.workers.get(id);
        if (existing && existing.socket !== socket) {
          existing.socket.destroy();
        }
        this.dropWorker(id);
        this.workers.set(id, {
          id,
          workspacePaths: paths,
          displayName,
          instanceId: typeof msg.instanceId === "string" ? msg.instanceId : undefined,
          instanceName: typeof msg.instanceName === "string" ? msg.instanceName : undefined,
          state: this.normalizeWindowState(msg.state),
          socket,
        });
        const state = this.ipcPeer.get(socket);
        if (state) {
          state.registered = true;
          state.entryId = id;
        }
        socket.write(encodeMessage({ type: MSG.WELCOME, leaderId: this.opts.workspaceId }));
        this.log(
          `[leader] worker registered: ${displayName} (${paths.join(", ") || "no workspace"})`,
        );
        break;
      }
      case MSG.PING: {
        try {
          socket.write(encodeMessage({ type: MSG.PONG }));
        } catch {
          /* peer gone */
        }
        break;
      }
      case MSG.UPDATE: {
        // Worker publishes window state (active file / open editors).
        const peer = this.ipcPeer.get(socket);
        if (peer?.entryId) {
          const entry = this.workers.get(peer.entryId);
          if (entry) {
            entry.state = this.normalizeWindowState(msg.state);
          }
        }
        break;
      }
      case MSG.RESULT: {
        const callId = typeof msg.callId === "string" ? msg.callId : undefined;
        if (callId) {
          const pending = this.pending.get(callId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(callId);
            pending.resolve(msg.response as JsonRpcResponse);
          }
        }
        break;
      }
      default:
        break; // WELCOME / CALL are worker-only protocol directions
    }
  }

  private dropWorker(workerId: string): void {
    const entry = this.workers.get(workerId);
    if (entry) {
      this.workers.delete(workerId);
      if (!entry.socket.destroyed) entry.socket.destroy();
    }
    for (const [callId, p] of this.pending) {
      if (p.workerId === workerId) {
        clearTimeout(p.timer);
        this.pending.delete(callId);
        p.reject(new Error("Worker disconnected"));
      }
    }
  }

  private log(msg: string): void {
    this.opts.log?.(msg);
  }

  /**
   * Publish the leader window's own state (active file / open editors).
   * The leader row in list_workspaces reflects the latest value. No IPC
   * message is needed — the leader already owns its row locally.
   */
  updateState(state: WindowState): void {
    this.localState = state;
  }

  /** Coerce an untrusted wire value into a valid WindowState. */
  private normalizeWindowState(value: unknown): WindowState {
    if (typeof value !== "object" || value === null) return { openEditors: [] };
    const v = value as Record<string, unknown>;
    const openEditors = Array.isArray(v.openEditors)
      ? v.openEditors.filter((p): p is string => typeof p === "string")
      : [];
    const activeFile = typeof v.activeFile === "string" ? v.activeFile : undefined;
    return { openEditors, ...(activeFile !== undefined ? { activeFile } : {}) };
  }
}

// ── Request parsing / rewriting helpers ──────────────────────────────

interface LightRequest {
  id: number | string | null;
  method: string;
  params: Record<string, unknown> | undefined;
}

function parseBodyLight(rawBody: string): LightRequest | null {
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof parsed.method !== "string") return null;
    const params = parsed.params;
    return {
      id: (parsed.id as number | string | null) ?? null,
      method: parsed.method,
      params:
        typeof params === "object" && params !== null
          ? (params as Record<string, unknown>)
          : undefined,
    };
  } catch {
    return null;
  }
}

/** Remove the routing-only `workspace` argument before local/worker dispatch. */
function stripWorkspaceArg(
  rawBody: string,
  params: Record<string, unknown> | undefined,
): string | null {
  if (!params || !("workspace" in params)) return null;
  const parsed = JSON.parse(rawBody) as Record<string, unknown>;
  const newParams: Record<string, unknown> = { ...params };
  delete newParams.workspace;
  return JSON.stringify({
    jsonrpc: "2.0",
    id: parsed.id,
    method: parsed.method,
    ...(Object.keys(newParams).length > 0 ? { params: newParams } : {}),
  });
}

const PATH_KEY_RE = /(path|uri|file|folder|dir|cwd|root)/i;
const ABS_RE = /^(\/|[a-zA-Z]:[\\/])/;

function collectPathCandidates(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string" || value.length === 0) continue;
    if (PATH_KEY_RE.test(key) || ABS_RE.test(value)) {
      out.push(value);
    }
  }
  return out;
}

function normalize(p: string): string {
  return p.replace(/[\\/]+$/, "");
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}
