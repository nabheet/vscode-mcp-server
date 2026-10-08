/**
 * LeaderCoordinator — the single process that owns the HTTP/SSE port.
 *
 * Responsibilities:
 *  - Serve the HTTP endpoint via McpServer (health, metrics, SSE, direct
 *    JSON-RPC) and execute calls targeting its own workspace locally.
 *  - Serve the HTTP member channel that Workers connect over.
 *  - Keep a routing table of connected Workers and proxy tool calls to the
 *    Worker whose workspace the request targets.
 *  - Respond to Worker heartbeats (PING → PONG).
 *
 * Pure Node (no vscode API): workspace identity and the tool executor are
 * injected by extension.ts, which keeps this layer unit-testable.
 */

import { randomUUID } from "node:crypto";
import type * as http from "node:http";
import { isIP } from "node:net";
import type { Metrics } from "../../utils/metrics";
import type { ServerLog } from "../../utils/serverLog";
import type { JsonRpcResponse, ToolDefinition } from "../../utils/types";
import type { ToolExecutor } from "../executor";
import { type McpRouter, type McpRouterResult, McpServer, type MemberChannel } from "../server";
import { defineTool } from "../tools/index";
import {
  HEARTBEAT_INTERVAL_MS,
  LEADER_REGISTER_TIMEOUT_MS,
  MAX_MEMBER_PEERS,
  MSG,
  PROXY_TIMEOUT_MS,
} from "./constants";
import type { IpcMessage, WindowState } from "./protocol";

/**
 * Thrown when a cluster member would expose the member channel beyond
 * loopback without a bearer token (C1). The member channel proxies
 * tools/call — including shell commands — to every connected worker, so an
 * unauthenticated non-loopback bind is remote code execution for anything
 * that can reach those addresses.
 */
export class ClusterAuthError extends Error {
  constructor(readonly binds: string[]) {
    super(
      `Refusing to start: non-loopback bind (${binds.join(", ")}) without an authToken. ` +
        "Set the vscode-mcp-server.authToken setting (or the MCP_AUTH_TOKEN " +
        "environment variable) to a shared token on every cluster window — " +
        "all windows must use the same one.",
    );
    this.name = "ClusterAuthError";
  }
}

/** Loopback bind addresses that need no bearer token (C1). */
export function isLoopbackHost(host: string): boolean {
  if (host === "127.0.0.1" || host === "localhost") return true;
  // 127/8 loopback (any 127.x.y.z), used by some proxies/tunnels.
  if (host.startsWith("127.")) return true;
  // IPv6 loopback, with or without brackets, plus IPv4-mapped forms.
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return (
    bare === "::1" ||
    bare === "0:0:0:0:0:0:0:1" ||
    bare === "::ffff:127.0.0.1" ||
    bare.startsWith("::ffff:127.")
  );
}

/**
 * True when `host` can be handed to `server.listen`: an IPv4/IPv6 literal
 * (brackets allowed) or a hostname. A typo — most often stray whitespace or a
 * stray character — would otherwise fail at bind time and be retried forever
 * as if it were a transient failure.
 */
export function isUsableBindHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (bare.length === 0) return false;
  if (isIP(bare) !== 0) return true;
  return /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(bare);
}

/**
 * Thrown for a permanent cluster configuration error — an unusable bind
 * address, say. Like C1 it cannot fix itself, so startup refuses once instead
 * of retrying forever with exponential backoff.
 */
export class ClusterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClusterConfigError";
  }
}

/**
 * A connected member (Worker) from the Leader's point of view. Every member
 * connects over the HTTP member channel (SSE receive leg + POST send leg).
 */
interface MemberPeer {
  readonly kind: "http";
  send(msg: IpcMessage): void;
  close(): void;
  readonly destroyed: boolean;
}

/** HTTP peer: SSE frames (`event: message`) on the member-channel stream. */
class HttpPeer implements MemberPeer {
  readonly kind = "http" as const;
  constructor(private readonly res: http.ServerResponse) {}
  get destroyed(): boolean {
    return this.res.destroyed;
  }
  send(msg: IpcMessage): void {
    try {
      this.res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
    } catch {
      /* peer gone */
    }
  }
  close(): void {
    try {
      this.res.end();
    } catch {
      /* peer gone */
    }
  }
}

interface WorkerEntry {
  id: string;
  workspacePaths: string[];
  displayName: string;
  /** Stable per-window UUID sent in REGISTER (wire-level identity). */
  instanceId?: string;
  instanceName?: string;
  /** Latest window state (active file / open editors) from MSG.UPDATE. */
  state?: WindowState;
  peer: MemberPeer;
  /** Session id for the member channel (routes POST /cluster/message). */
  sessionId?: string;
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
  /** Secondary bind addresses for the leader's HTTP server (Linux hosts). */
  hosts?: string[];
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

export class LeaderCoordinator implements McpRouter, MemberChannel {
  readonly role = "leader" as const;
  private readonly opts: LeaderOptions;
  private server: McpServer;
  private localState: WindowState = { openEditors: [] };
  /** Per-peer connection state: registration status + worker id (REGISTER). */
  private peerState = new Map<
    MemberPeer,
    { registered: boolean; entryId: string | null; regTimer: NodeJS.Timeout | null }
  >();
  /** HTTP member-channel peers, keyed by worker-chosen session id. */
  private httpPeers = new Map<string, HttpPeer>();
  private workers = new Map<string, WorkerEntry>();
  private pending = new Map<string, PendingCall>();

  /** The discovery-tool definition this instance registered, for ownership checks. */
  private discoveryTool: ToolDefinition | null = null;

  constructor(opts: LeaderOptions) {
    this.opts = opts;
    if (opts.state) this.localState = opts.state;

    // C1 (defense in depth): extension.ts refuses this configuration before
    // bootstrap, but every construction path — tests, embedders, future
    // callers — must be guarded too. The constructor throw propagates
    // through bootstrap's tryPromote (which does not catch it).
    const binds = [opts.host, ...(opts.hosts ?? [])];
    if (binds.some((h) => !isLoopbackHost(h)) && !opts.authToken) {
      throw new ClusterAuthError(binds);
    }

    this.server = new McpServer({
      port: opts.port,
      host: opts.host,
      ...(opts.hosts && opts.hosts.length > 0 ? { hosts: opts.hosts } : {}),
      ...(opts.authToken ? { authToken: opts.authToken } : {}),
      ...(opts.tlsCertPath && opts.tlsKeyPath
        ? { tlsCertPath: opts.tlsCertPath, tlsKeyPath: opts.tlsKeyPath }
        : {}),
      metrics: opts.metrics,
      logger: opts.logger,
      executor: opts.executor,
      router: this,
      memberChannel: this,
    });
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
    this.registerDiscoveryTool();
    try {
      await this.server.start();
    } catch (err) {
      // Promotion lost (port already bound by a live leader). The window
      // falls back to joining as a worker on the same shared executor, so
      // the leader-only tool must not linger on it.
      this.unregisterDiscoveryTool();
      throw err;
    }
  }

  /**
   * Leader-only discovery tool: lets MCP clients enumerate the windows in the
   * cluster and target a specific one via the `workspace` argument on
   * tools/call. Registered when serving starts (not in the constructor) so a
   * window that loses the promotion race never advertises it.
   */
  private registerDiscoveryTool(): void {
    const def = defineTool(
      "list_workspaces",
      "List all VS Code windows/workspaces served by this MCP endpoint. Each entry has an id, display name, and workspace folders. Pass the id or a folder path as the `workspace` argument to tools/call or tools/list to target that window.",
      { type: "object", properties: {} },
      async () => {
        const rows = [
          {
            id: this.opts.workspaceId,
            instanceId: this.opts.instanceId,
            instanceName: this.opts.instanceName,
            displayName: this.opts.displayName,
            folders: this.opts.workspacePaths,
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
    );
    this.opts.executor.registerTool(def);
    this.discoveryTool = def;
  }

  /**
   * Drop the discovery tool when this window stops serving as leader. Only
   * removes it if this instance's own registration is still the live one: the
   * executor is shared across roles, and a successor leader may have
   * re-registered the same tool after this instance stopped serving (e.g.
   * re-election in the same window), so an unconditional delete would clobber
   * the successor's tool.
   */
  private unregisterDiscoveryTool(): void {
    if (
      this.discoveryTool &&
      this.opts.executor.getTool("list_workspaces") === this.discoveryTool
    ) {
      this.opts.executor.unregisterTool("list_workspaces");
    }
    this.discoveryTool = null;
  }

  async stop(timeoutMs = 5000): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Leader shutting down"));
    }
    this.pending.clear();
    for (const peer of this.httpPeers.values()) peer.close();
    this.httpPeers.clear();
    await this.server.stop(timeoutMs);
    this.workers.clear();
    // The window is no longer a leader; drop the leader-only tool from the
    // shared executor so it does not leak into a subsequent worker role.
    this.unregisterDiscoveryTool();
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
    // Routing refs may also arrive as tool arguments — the only channel real
    // MCP clients (e.g. opencode) use. Resolve id/path/basename/displayName/
    // instanceId; fall through to path inference when unresolved so tools keep
    // their own "folder not found" errors for genuinely unknown names.
    const argRef = extractArgWorkspaceRef(params);
    if (argRef) {
      const t = this.resolveWorkspaceRef(argRef);
      if (t === "local") return "local";
      if (t) return { workerId: t };
    }
    const inferred = this.inferWorker(params);
    return inferred ? { workerId: inferred } : "local";
  }

  /**
   * Resolve a workspace reference: id, instance id, display name, exact folder
   * path, or folder name (basename). Used for the top-level `workspace` param
   * and for `workspace`/`workspaceFolder` tool arguments alike.
   */
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
        const base = basename(ws);
        if (
          norm === ws ||
          norm.startsWith(`${ws}/`) ||
          norm.startsWith(`${ws}\\`) ||
          // Folder-name refs (e.g. `workspaceFolder: "worker"`) and
          // folder-relative paths ("worker/src/main.ts") resolve to the
          // window whose workspace basename matches.
          (base.length > 0 &&
            (norm === base || norm.startsWith(`${base}/`) || norm.startsWith(`${base}\\`)))
        ) {
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
      worker.peer.send({ type: MSG.CALL, callId, rawBody: body });
    });
  }

  // ── Peer connection side (HTTP member channel) ──────────────────────

  /** Member channel SSE leg: registers a new HTTP peer for a session. */
  handleStream(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void {
    // Cap concurrent member connections: each holds an open SSE socket plus
    // a worker entry, and a runaway process must not exhaust the leader's
    // file descriptors (N5).
    if (this.httpPeers.size >= MAX_MEMBER_PEERS) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Too many member connections" }));
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Loopback-only: browser pages on other origins were already rejected
      // by the server's origin check before this handler ran.
      "Access-Control-Allow-Origin": `http://127.0.0.1:${this.opts.port}`,
    });
    // First SSE frame must be written immediately: undici's fetch() does not
    // resolve its promise until the first body chunk arrives. A comment line
    // is ignored by the transport parser but flushes the chunked stream so
    // connect() completes and REGISTER can follow.
    res.write(": connected\n\n");

    const peer = new HttpPeer(res);
    const state = {
      registered: false,
      entryId: null as string | null,
      regTimer: null as NodeJS.Timeout | null,
    };
    this.httpPeers.set(sessionId, peer);
    this.peerState.set(peer, state);

    // Keep the stream alive through silent periods (worker heartbeats only
    // arrive every HEARTBEAT_INTERVAL_MS) so proxies don't kill it.
    const keepAlive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        clearInterval(keepAlive);
      }
    }, HEARTBEAT_INTERVAL_MS);

    const regTimer = setTimeout(() => {
      if (!state.registered) {
        this.log(`[leader] member ${sessionId} did not REGISTER in time — closing`);
        this.dropHttpPeer(sessionId, peer);
      }
    }, LEADER_REGISTER_TIMEOUT_MS);
    state.regTimer = regTimer;

    const cleanup = () => {
      clearTimeout(regTimer);
      clearInterval(keepAlive);
      this.httpPeers.delete(sessionId);
      this.peerState.delete(peer);
      // Only drop the worker if this peer is still the one attached to it:
      // a stream close must not evict a worker that already re-registered
      // through a different peer (M3).
      if (state.entryId && this.workers.get(state.entryId)?.peer === peer) {
        this.dropWorker(state.entryId);
      }
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", () => {
      /* close handler cleans up */
    });
  }

  /** Member channel POST leg: one protocol message from a worker. */
  handleMessage(sessionId: string, rawBody: string, res: http.ServerResponse): void {
    const peer = this.httpPeers.get(sessionId);
    if (!peer) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown member session" }));
      return;
    }
    let msg: IpcMessage;
    try {
      msg = JSON.parse(rawBody) as IpcMessage;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ accepted: true }));
    try {
      this.onPeerMessage(peer, msg);
    } catch (err) {
      this.log(
        `[leader] member handler error: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.dropHttpPeer(sessionId, peer);
    }
  }

  private dropHttpPeer(sessionId: string, peer: HttpPeer): void {
    peer.close();
    this.httpPeers.delete(sessionId);
    const state = this.peerState.get(peer);
    this.peerState.delete(peer);
    // Only drop the worker if this peer is still the one attached to it
    // (M3): a re-registered worker must survive its old peer's teardown.
    if (state?.entryId && this.workers.get(state.entryId)?.peer === peer) {
      this.dropWorker(state.entryId);
    }
  }

  /**
   * Remove a peer's bookkeeping synchronously and close it. Unlike
   * dropHttpPeer it does not require the concrete HttpPeer type (it works for
   * any MemberPeer) and does not touch workers — used to reject a peer that
   * never became a legitimate member (e.g. self-registration), where the
   * stream's async 'close' cleanup has not run yet.
   */
  private evictPeer(peer: MemberPeer): void {
    const sessionId = this.httpSessionId(peer);
    if (sessionId !== undefined) this.httpPeers.delete(sessionId);
    const state = this.peerState.get(peer);
    if (state?.regTimer) clearTimeout(state.regTimer);
    this.peerState.delete(peer);
    peer.close();
  }

  private onPeerMessage(peer: MemberPeer, msg: IpcMessage): void {
    // A first POST proves the worker is alive and actively registering; the
    // registration deadline only guards a peer that opened a stream and then
    // went silent. Clear the timer so a slow-but-live REGISTER (e.g. busy
    // leader during an election) is never cut off mid-flight (F4).
    const peerState = this.peerState.get(peer);
    if (peerState?.regTimer) {
      clearTimeout(peerState.regTimer);
      peerState.regTimer = null;
    }
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
          peer.close();
          return;
        }
        // Defense in depth: reject a REGISTER that claims THIS window's own
        // identity. A window that lost its leader role must not re-register as
        // a worker of its own (now orphaned) server. Key on the stable
        // per-window `instanceId` (a UUID), not `id`/workspaceId — the latter
        // is only unique by convention (extension.ts appends the pid), so
        // keying on it would wrongly refuse a legitimate member that shares a
        // workspace folder (multi-root / duplicated window). Fall back to the
        // workspaceId only when either side lacks an instanceId.
        const instanceId = typeof msg.instanceId === "string" ? msg.instanceId : undefined;
        const selfByIdentity =
          this.opts.instanceId !== undefined && instanceId !== undefined
            ? instanceId === this.opts.instanceId
            : id === this.opts.workspaceId;
        if (selfByIdentity) {
          this.log(
            "[leader] refusing self-registration (worker identity matches this leader) — closing peer",
          );
          // Evict the session immediately (not just on the async 'close'
          // event) so a follow-up POST on this session id 404s.
          this.evictPeer(peer);
          return;
        }
        // Replace a stale entry for the same window (reconnect after leader
        // restart) and fail any calls that were in flight to it. A REGISTER
        // re-sent from the SAME peer (POST retry, N1) must NOT drop the
        // worker: dropWorker() closes entry.peer, which would kill the
        // worker's own SSE stream and race it out of the cluster.
        const existing = this.workers.get(id);
        if (existing && existing.peer !== peer) {
          existing.peer.close();
          this.dropWorker(id);
        }
        const entry: WorkerEntry = {
          id,
          workspacePaths: paths,
          displayName,
          instanceId: typeof msg.instanceId === "string" ? msg.instanceId : undefined,
          instanceName: typeof msg.instanceName === "string" ? msg.instanceName : undefined,
          state: this.normalizeWindowState(msg.state),
          peer,
          sessionId: this.httpSessionId(peer),
        };
        this.workers.set(id, entry);
        const state = this.peerState.get(peer);
        if (state) {
          state.registered = true;
          state.entryId = id;
        }
        peer.send({ type: MSG.WELCOME, leaderId: this.opts.workspaceId });
        this.log(
          `[leader] worker registered: ${displayName} (${paths.join(", ") || "no workspace"})`,
        );
        break;
      }
      case MSG.PING: {
        peer.send({ type: MSG.PONG });
        break;
      }
      case MSG.UPDATE: {
        // Worker publishes window state (active file / open editors).
        const peerState = this.peerState.get(peer);
        if (peerState?.entryId) {
          const entry = this.workers.get(peerState.entryId);
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

  /** Find the session id routing to a member peer (for REGISTER bookkeeping). */
  private httpSessionId(peer: MemberPeer): string | undefined {
    for (const [sessionId, p] of this.httpPeers) {
      if (p === peer) return sessionId;
    }
    return undefined;
  }

  private dropWorker(workerId: string): void {
    const entry = this.workers.get(workerId);
    if (entry) {
      this.workers.delete(workerId);
      if (entry.sessionId) this.httpPeers.delete(entry.sessionId);
      if (!entry.peer.destroyed) entry.peer.close();
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
   * The leader row in list_workspaces reflects the latest value. No
   * member-channel message is needed — the leader already owns its row
   * locally.
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

/**
 * Routing refs may arrive as tool arguments — the only channel standard MCP
 * clients have. Prefers an explicit `workspace` argument over `workspaceFolder`
 * so the routing contract works from either the top-level param or the args.
 */
function extractArgWorkspaceRef(params: Record<string, unknown> | undefined): string | undefined {
  if (!params || typeof params.arguments !== "object" || params.arguments === null) {
    return undefined;
  }
  const args = params.arguments as Record<string, unknown>;
  for (const key of ["workspace", "workspaceFolder"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

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
