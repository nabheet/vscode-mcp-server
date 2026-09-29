import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { Metrics } from "../utils/metrics";
import type { ServerLog } from "../utils/serverLog";
import type { JsonRpcResponse, ToolDefinition, ToolListItem } from "../utils/types";
import { CLUSTER_MESSAGE_PATH, CLUSTER_STREAM_PATH } from "./cluster/constants";
import { BusyError, ToolExecutor } from "./executor";

export { BusyError };

/** Health-check signature used by the cluster to recognize a live Leader. */
export const HEALTH_SERVICE_NAME = "vscode-mcp-server";

interface SseSession {
  id: string;
  res: http.ServerResponse;
  sendEvent: (event: string, data: string) => void;
}

/**
 * Result of the cluster routing hook. When `workerId` is set the response
 * was already produced by proxying to that worker; otherwise the request is
 * executed locally using `body` (which may have had the routing-only
 * `workspace` argument stripped). `null` means "route normally, use the
 * original body".
 */
export interface McpRouterResult {
  body: string;
  response?: JsonRpcResponse;
}

/**
 * Optional cluster hook invoked at the single dispatch chokepoint (covers
 * both direct POST /mcp and SSE session messages). Lets the Leader route a
 * request to the Worker whose workspace it targets instead of executing it
 * in the Leader's own extension host.
 */
export interface McpRouter {
  route(rawBody: string): Promise<McpRouterResult | null>;
}

/**
 * Cluster "member channel" (Leader only). Bridges the Worker↔Leader protocol
 * across mount namespaces (dev container ↔ host) over HTTP/SSE on the same
 * port the server already listens on:
 *
 *   GET  /cluster/stream?id=<sessionId>   SSE — leader→worker
 *   POST /cluster/message?id=<sessionId>  one JSON IpcMessage — worker→leader
 *
 * The Leader's cluster layer owns the routing (who is a member, session
 * bookkeeping); the server only parses the session id and hands off.
 */
export interface MemberChannel {
  /** Leader→worker SSE stream for a worker-chosen session id. */
  handleStream(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void;
  /** Worker→leader protocol message POST. Must write its own response. */
  handleMessage(sessionId: string, rawBody: string, res: http.ServerResponse): void;
}

export interface McpServerOptions {
  port: number;
  host: string;
  /**
   * Additional addresses to bind, on top of `host` (which stays the primary:
   * it is what gets logged and used for origin checks). Used by Linux host
   * leaders so Docker containers can reach them at the bridge gateway while
   * loopback-only exposure is preserved. A secondary bind failure is
   * non-fatal (warned, not rejected); the primary bind failure rejects.
   */
  hosts?: string[];
  /** Path to TLS certificate file (enables HTTPS) */
  tlsCertPath?: string;
  /** Path to TLS private key file (enables HTTPS) */
  tlsKeyPath?: string;
  /** Optional bearer token for authentication */
  authToken?: string;
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
  /** Cluster routing hook (Leader only). */
  router?: McpRouter;
  /** Cluster member channel (Leader only) — HTTP/SSE bridge for
   *  cross-namespace workers (dev container ↔ host). */
  memberChannel?: MemberChannel;
  /**
   * Shared tool executor (single instance per process, created in
   * extension.ts and reused by the Leader's server, the Leader's router,
   * and any Worker coordinator). When omitted the server creates its own
   * private executor with no tools registered — only useful for tests.
   */
  executor?: ToolExecutor;
}

const SSE_KEEPALIVE_MS = 15_000;
const LAG_INTERVAL_MS = 1_000;

export class McpServer {
  private servers: Array<http.Server | https.Server> = [];
  private activeRequests = 0;
  private shuttingDown = false;
  private options: McpServerOptions;
  private bindHosts: string[];
  private onListen?: (url: string) => void;
  private useTls: boolean;
  private sessions = new Map<string, SseSession>();
  private metrics: Metrics;
  private readonly fileLog?: ServerLog;
  private lagMs = 0;
  private lastLagSample = Date.now();
  private lagTimer: NodeJS.Timeout | null = null;
  private readonly executor: ToolExecutor;

  constructor(options: McpServerOptions) {
    this.options = options;
    this.useTls = !!(options.tlsCertPath && options.tlsKeyPath);
    this.metrics = options.metrics ?? new Metrics();
    this.fileLog = options.logger;
    this.executor =
      options.executor ??
      new ToolExecutor({
        toolTimeoutMs: options.toolTimeoutMs,
        maxConcurrentRequests: options.maxConcurrentRequests,
        metrics: this.metrics,
        logger: options.logger,
      });
    if (options.authToken && !this.useTls) {
      console.warn(
        "[MCP] Warning: authToken is set but TLS is not enabled. Authentication token will be transmitted in cleartext over HTTP. Set tlsCertPath and tlsKeyPath for secure HTTPS.",
      );
    }
    // Primary bind host is always `options.host`; additional `options.hosts`
    // are best-effort secondary binds (see McpServerOptions.hosts).
    const extra = (options.hosts ?? []).filter((h) => h && h !== options.host);
    this.bindHosts = [options.host, ...extra];
  }

  registerTool(def: ToolDefinition): void {
    this.executor.registerTool(def);
  }

  setOnListen(cb: (url: string) => void): void {
    this.onListen = cb;
  }

  get toolCount(): number {
    return this.executor.toolCount;
  }

  listTools(): ToolListItem[] {
    return this.executor.listTools();
  }

  /** Public entry for the cluster router to execute a body locally (or via
   *  the configured router hook). Used by the Leader's proxy fallback. */
  async handleRawBody(rawBody: string): Promise<JsonRpcResponse> {
    return this.dispatch(rawBody);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const createServer = (): http.Server | https.Server => {
        if (this.useTls) {
          const tlsOpts: https.ServerOptions = {
            cert: fs.readFileSync(this.options.tlsCertPath!, "utf-8"),
            key: fs.readFileSync(this.options.tlsKeyPath!, "utf-8"),
            minVersion: "TLSv1.2",
          };
          return https.createServer(tlsOpts, (req, res) => this.onRequest(req, res));
        }
        return http.createServer((req, res) => this.onRequest(req, res));
      };

      let primary: http.Server | https.Server;
      try {
        primary = createServer();
      } catch (err) {
        reject(
          new Error(
            `Failed to load TLS cert/key: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        return;
      }
      this.servers.push(primary);

      const cleanup = () => {
        for (const server of this.servers) server.close();
        this.servers = [];
      };

      primary.on("error", (err: NodeJS.ErrnoException) => {
        cleanup();
        if (err.code === "EADDRINUSE") {
          reject(new Error(`Port ${this.options.port} is already in use`));
        } else {
          reject(err);
        }
      });

      primary.listen(this.options.port, this.bindHosts[0], () => {
        const scheme = this.useTls ? "https" : "http";
        this.onListen?.(`${scheme}://${this.options.host}:${this.options.port}/mcp`);
        this.startLagMonitor();
        resolve();
      });

      // Secondary binds are best-effort: a foreign process squatting the
      // bridge port must not take down a leader that still serves loopback.
      for (const host of this.bindHosts.slice(1)) {
        let extra: http.Server | https.Server;
        try {
          extra = createServer();
        } catch (err) {
          console.warn(
            `[mcp] Failed to create secondary listener for ${host}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          continue;
        }
        this.servers.push(extra);
        extra.on("error", (err: NodeJS.ErrnoException) => {
          console.warn(`[mcp] Failed to bind port ${this.options.port} on ${host}: ${err.message}`);
        });
        extra.listen(this.options.port, host);
      }
    });
  }

  /** Event-loop lag monitor — fires late if the loop is blocked. */
  private startLagMonitor(): void {
    this.lastLagSample = Date.now();
    this.lagTimer = setInterval(() => {
      const now = Date.now();
      this.lagMs = Math.max(0, now - this.lastLagSample - LAG_INTERVAL_MS);
      this.lastLagSample = now;
    }, LAG_INTERVAL_MS);
    this.lagTimer.unref();
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    this.shuttingDown = true;
    if (this.lagTimer) {
      clearInterval(this.lagTimer);
      this.lagTimer = null;
    }
    const servers = this.servers;
    this.servers = [];
    if (servers.length === 0) return;

    // server.close() stops accepting new connections and waits for existing
    // ones to finish naturally. We add a timeout fallback to force-close.
    return new Promise((resolve) => {
      let remaining = servers.length;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };

      const timer = setTimeout(() => {
        for (const server of servers) server.close();
        finish();
      }, timeoutMs);

      for (const server of servers) {
        server.once("close", () => {
          remaining -= 1;
          if (remaining === 0) {
            clearTimeout(timer);
            finish();
          }
        });
        server.close();
      }
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /** Get the base URL for the server (scheme + host + port). */
  private getServerBase(): string {
    const scheme = this.useTls ? "https" : "http";
    return `${scheme}://${this.options.host}:${this.options.port}`;
  }

  /** Check if a request origin is allowed. Only loopback origins are valid. */
  private isValidOrigin(reqOrigin: string | undefined): boolean {
    if (!reqOrigin) return true; // No Origin header — non-browser client
    // Allow configured host and common loopback aliases
    const allowed = [
      `http://127.0.0.1:${this.options.port}`,
      `http://localhost:${this.options.port}`,
      `http://0.0.0.0:${this.options.port}`,
    ];
    // Also allow the scheme-specific version if the configured host differs
    if (!allowed.includes(this.getServerBase())) {
      allowed.push(this.getServerBase());
    }
    return allowed.includes(reqOrigin);
  }

  /** Write CORS headers restricted to loopback origin. */
  private writeCorsHeaders(res: http.ServerResponse, origin?: string): void {
    const fallback = `http://127.0.0.1:${this.options.port}`;
    const allowed = origin && this.isValidOrigin(origin) ? origin : fallback;
    res.setHeader("Access-Control-Allow-Origin", allowed);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }

  /** Verify bearer token using timing-safe comparison. */
  private authFailed(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.options.authToken) return false;
    const auth = req.headers.authorization || "";
    const origin = req.headers.origin as string | undefined;
    if (!auth.startsWith("Bearer ")) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: invalid or missing bearer token" }));
      return true;
    }
    const token = auth.slice(7);
    const valid = this.options.authToken;
    const bufToken = Buffer.from(token);
    const bufValid = Buffer.from(valid);
    const match = bufToken.length === bufValid.length && crypto.timingSafeEqual(bufToken, bufValid);
    if (!match) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: invalid or missing bearer token" }));
      return true;
    }
    return false;
  }

  // ── Request Handler ────────────────────────────────────────────────

  /** Refresh process-level gauges before serving /metrics or /diagnostics. */
  private updateGauges(): void {
    const mem = process.memoryUsage();
    this.metrics.gauge("vscode_mcp_memory_rss_bytes", mem.rss, "Resident set size (bytes)");
    this.metrics.gauge("vscode_mcp_memory_heap_used_bytes", mem.heapUsed, "Heap used (bytes)");
    this.metrics.gauge(
      "vscode_mcp_event_loop_lag_ms",
      this.lagMs,
      "Event loop lag (ms), sampled each second",
    );
    this.metrics.gauge(
      "vscode_mcp_inflight_requests",
      this.executor.inflight,
      "Tool calls currently in flight",
    );
    this.metrics.gauge("vscode_mcp_sse_sessions", this.sessions.size, "Open SSE sessions");
    this.metrics.gauge("vscode_mcp_max_concurrent", this.executor.maxConcurrent, "Concurrency cap");
  }

  /**
   * Execute a JSON-RPC body. When a cluster router is configured it gets
   * first shot: a worker-routed call returns a pre-built response, otherwise
   * the (possibly re-serialized) body runs against the local executor.
   */
  private async dispatch(rawBody: string): Promise<JsonRpcResponse> {
    let body = rawBody;
    const router = this.options.router;
    if (router) {
      const routed = await router.route(rawBody);
      if (routed) {
        body = routed.body;
        if (routed.response) return routed.response;
      }
    }
    return this.executor.dispatch(body);
  }

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin as string | undefined;
    const pathname = (req.url || "").split("?")[0];

    // Health check — carries the cluster signature so other instances can
    // recognize this process as a valid Leader (see cluster/election.ts).
    if (req.method === "GET" && pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ service: HEALTH_SERVICE_NAME, status: "ok", uptime: process.uptime() }),
      );
      return;
    }

    // Metrics — Prometheus text format
    if (req.method === "GET" && pathname === "/metrics") {
      this.updateGauges();
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(this.metrics.text());
      return;
    }

    // Diagnostics — human-readable JSON snapshot
    if (req.method === "GET" && pathname === "/diagnostics") {
      this.updateGauges();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(this.metrics.diagnostics(), null, 2));
      return;
    }

    // ── SSE: MCP HTTP transport (GET /mcp) ───────────────────────────
    if (req.method === "GET" && pathname === "/mcp") {
      this.handleSseConnection(req, res);
      return;
    }

    // ── SSE: Message handler (POST /mcp/session/:id/message) ────────
    const msgMatch = pathname.match(/^\/mcp\/session\/([a-f0-9-]+)\/message$/);
    if (req.method === "POST" && msgMatch) {
      this.handleSseMessage(req, res, msgMatch[1]);
      return;
    }

    // ── Cluster member channel (cross-namespace workers) ─────────────
    // Worker→Leader SSE stream (GET) and protocol messages (POST). Mounted
    // only when the Leader opts in via the memberChannel option; the two
    // legs are intentionally cheap to guard: origin checks reject
    // DNS-rebinding browser traffic, and the existing bearer check applies
    // when authToken is configured.
    if (req.method === "GET" && pathname === CLUSTER_STREAM_PATH) {
      this.handleMemberStream(req, res);
      return;
    }
    if (req.method === "POST" && pathname === CLUSTER_MESSAGE_PATH) {
      this.handleMemberMessage(req, res);
      return;
    }

    // CORS preflight — validate origin
    if (req.method === "OPTIONS") {
      if (!this.isValidOrigin(origin)) {
        res.writeHead(403);
        res.end();
        return;
      }
      this.writeCorsHeaders(res, origin);
      res.writeHead(204);
      res.end();
      return;
    }

    // Direct JSON-RPC (POST /mcp) — backward compat with mcp_client.py
    if (req.method === "POST" && pathname === "/mcp") {
      this.handleDirectPost(req, res, origin);
      return;
    }

    // ── 404 catch-all ─────────────────────────────────────────────────
    this.writeCorsHeaders(res, origin);
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found. Use GET /mcp (SSE) or POST /mcp (direct)" }));
  }

  /** SSE connection — open event stream and send endpoint URL. */
  private handleSseConnection(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Check auth for SSE too (security — previously only checked on direct POST)
    if (this.authFailed(req, res)) return;

    const sessionId = crypto.randomUUID();
    const endpoint = `/mcp/session/${sessionId}/message`;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    const sendEvent = (event: string, data: string) => {
      try {
        res.write(`event: ${event}\ndata: ${data}\n\n`);
      } catch {
        /* closed */
      }
    };

    const session: SseSession = { id: sessionId, res, sendEvent };
    this.sessions.set(sessionId, session);

    // Tell client where to POST JSON-RPC messages
    sendEvent("endpoint", endpoint);

    // Keep-alive to prevent proxy timeouts
    const keepAlive = setInterval(() => {
      try {
        res.write(": keepalive\n\n");
      } catch {
        clearInterval(keepAlive);
      }
    }, SSE_KEEPALIVE_MS);

    req.on("close", () => {
      clearInterval(keepAlive);
      this.sessions.delete(sessionId);
    });
  }

  /** Handle a message POSTed to an SSE session endpoint. */
  private handleSseMessage(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }

    const chunks: Buffer[] = [];
    let bodySize = 0;
    const MAX_BODY = 10 * 1024 * 1024;

    req.on("data", (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) return;
      chunks.push(chunk);
    });

    req.on("end", async () => {
      if (bodySize > MAX_BODY) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload Too Large: max 10 MB" }));
        return;
      }

      const rawBody = Buffer.concat(chunks).toString("utf-8");

      // Acknowledge the POST immediately — response goes over SSE
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));

      try {
        const response = await this.dispatch(rawBody);
        if (response) {
          session.sendEvent("message", JSON.stringify(response));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = err instanceof BusyError ? -32050 : -32603;
        const message = err instanceof BusyError ? msg : `Internal error: ${msg}`;
        session.sendEvent(
          "message",
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code, message },
          }),
        );
      }
    });

    req.on("error", () => {});
  }

  /** Member channel SSE leg: leader→worker stream for a session. */
  private handleMemberStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin as string | undefined;
    // Worker GETs carry no Origin (non-browser client) and pass; a webpage
    // EventSource carries one and is rejected unless loopback.
    if (!this.isValidOrigin(origin)) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "Forbidden: CORS requests from this origin are not allowed" }),
      );
      return;
    }
    if (this.authFailed(req, res)) return;

    const member = this.options.memberChannel;
    if (!member) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Cluster member channel is not enabled" }));
      return;
    }

    const sessionId = McpServer.queryId(req.url);
    if (!sessionId) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing session id" }));
      return;
    }

    member.handleStream(req, res, sessionId);
  }

  /** Member channel POST leg: one protocol message from a worker. */
  private handleMemberMessage(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers.origin as string | undefined;
    if (!this.isValidOrigin(origin)) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "Forbidden: CORS requests from this origin are not allowed" }),
      );
      return;
    }
    if (this.authFailed(req, res)) return;

    const member = this.options.memberChannel;
    if (!member) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Cluster member channel is not enabled" }));
      return;
    }

    const sessionId = McpServer.queryId(req.url);
    if (!sessionId) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing session id" }));
      return;
    }

    const chunks: Buffer[] = [];
    let bodySize = 0;
    const MAX_BODY = 10 * 1024 * 1024;

    req.on("data", (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) return;
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (bodySize > MAX_BODY) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload Too Large: max 10 MB" }));
        return;
      }
      const rawBody = Buffer.concat(chunks).toString("utf-8");
      member.handleMessage(sessionId, rawBody, res);
    });

    req.on("error", () => {});
  }

  /** Extract the `id` query param from a request URL ("" when absent). */
  private static queryId(url: string | undefined): string {
    const q = (url || "").indexOf("?");
    if (q === -1) return "";
    return new URLSearchParams(url?.slice(q + 1)).get("id") || "";
  }

  /** Direct POST /mcp — inline JSON-RPC response (backward compat). */
  private handleDirectPost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    origin: string | undefined,
  ): void {
    // CORS: reject non-loopback origins
    if (!this.isValidOrigin(origin)) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "Forbidden: CORS requests from this origin are not allowed" }),
      );
      return;
    }

    // Content-Type check
    const ctype = req.headers["content-type"] || "";
    if (!ctype.includes("application/json")) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(415, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unsupported Media Type: expected application/json" }));
      return;
    }

    // Auth check (bearer token) — timing-safe
    if (this.authFailed(req, res)) return;

    if (this.shuttingDown) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server shutting down" }));
      return;
    }

    this.activeRequests++;
    let requestHandled = false;
    const activeRequestDone = () => {
      if (requestHandled) return;
      requestHandled = true;
      this.activeRequests--;
    };

    const chunks: Buffer[] = [];
    let bodySize = 0;
    const MAX_BODY = 10 * 1024 * 1024;

    req.on("data", (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) return;
      chunks.push(chunk);
    });

    req.on("end", async () => {
      if (bodySize > MAX_BODY) {
        this.writeCorsHeaders(res, origin);
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Payload Too Large: max 10 MB" }));
        activeRequestDone();
        return;
      }

      const rawBody = Buffer.concat(chunks).toString("utf-8");

      try {
        const response = await this.dispatch(rawBody);
        const body = JSON.stringify(response);
        this.writeCorsHeaders(res, origin);

        let status = 200;
        if (response.error) {
          switch (response.error.code) {
            case -32700:
            case -32600:
            case -32602:
              status = 400;
              break;
            case -32601:
              status = 404;
              break;
            case -32603:
              status = 500;
              break;
          }
        }

        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body);
      } catch (err) {
        this.writeCorsHeaders(res, origin);
        if (err instanceof BusyError) {
          res.writeHead(429, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32050, message: err.message },
            }),
          );
          return;
        }
        res.writeHead(500, { "Content-Type": "application/json" });
        const msg = err instanceof Error ? err.message : String(err);
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32603, message: `Internal error: ${msg}` },
          }),
        );
      } finally {
        activeRequestDone();
      }
    });

    req.on("error", () => {
      activeRequestDone();
    });
  }
}
