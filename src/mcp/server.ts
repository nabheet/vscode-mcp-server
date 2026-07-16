import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { handleRequest } from './transport';
import { ToolDefinition } from '../utils/types';

interface SseSession {
  id: string;
  res: http.ServerResponse;
  sendEvent: (event: string, data: string) => void;
}

export interface McpServerOptions {
  port: number;
  host: string;
  /** Path to TLS certificate file (enables HTTPS) */
  tlsCertPath?: string;
  /** Path to TLS private key file (enables HTTPS) */
  tlsKeyPath?: string;
  /** Optional bearer token for authentication */
  authToken?: string;
}

const SSE_KEEPALIVE_MS = 15_000;

export class McpServer {
  private server: http.Server | https.Server | null = null;
  private tools: Map<string, ToolDefinition> = new Map();
  private activeRequests = 0;
  private shuttingDown = false;
  private options: McpServerOptions;
  private onListen?: (url: string) => void;
  private useTls: boolean;
  private sessions = new Map<string, SseSession>();

  constructor(options: McpServerOptions) {
    this.options = options;
    this.useTls = !!(options.tlsCertPath && options.tlsKeyPath);
    if (options.authToken && !this.useTls) {
      console.warn('[MCP] Warning: authToken is set but TLS is not enabled. Authentication token will be transmitted in cleartext over HTTP. Set tlsCertPath and tlsKeyPath for secure HTTPS.');
    }
  }

  registerTool(def: ToolDefinition): void {
    this.tools.set(def.name, def);
  }

  setOnListen(cb: (url: string) => void): void {
    this.onListen = cb;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.useTls) {
        try {
          const tlsOpts: https.ServerOptions = {
            cert: fs.readFileSync(this.options.tlsCertPath!, 'utf-8'),
            key: fs.readFileSync(this.options.tlsKeyPath!, 'utf-8'),
            minVersion: 'TLSv1.2',
          };
          this.server = https.createServer(tlsOpts, (req, res) => this.onRequest(req, res));
        } catch (err) {
          reject(new Error('Failed to load TLS cert/key: ' + (err instanceof Error ? err.message : String(err))));
          return;
        }
      } else {
        this.server = http.createServer((req, res) => this.onRequest(req, res));
      }

      this.server.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          reject(new Error('Port ' + this.options.port + ' is already in use'));
        } else {
          reject(err);
        }
      });

      this.server.listen(this.options.port, this.options.host, () => {
        const scheme = this.useTls ? 'https' : 'http';
        this.onListen?.(scheme + '://' + this.options.host + ':' + this.options.port + '/mcp');
        resolve();
      });
    });
  }

  async stop(timeoutMs = 10_000): Promise<void> {
    this.shuttingDown = true;
    if (!this.server) return;

    // server.close() stops accepting new connections and waits for existing
    // ones to finish naturally. We add a timeout fallback to force-close.
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.server = null;
        resolve();
      };

      const timer = setTimeout(() => {
        if (this.server) this.server.close();
        finish();
      }, timeoutMs);

      this.server!.once('close', () => {
        clearTimeout(timer);
        finish();
      });

      this.server!.close();
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /** Get the base URL for the server (scheme + host + port). */
  private getServerBase(): string {
    const scheme = this.useTls ? 'https' : 'http';
    return scheme + '://' + this.options.host + ':' + this.options.port;
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
    res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }

  /** Verify bearer token using timing-safe comparison. */
  private authFailed(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.options.authToken) return false;
    const auth = req.headers['authorization'] || '';
    const origin = req.headers['origin'] as string | undefined;
    if (!auth.startsWith('Bearer ')) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing bearer token' }));
      return true;
    }
    const token = auth.slice(7);
    const valid = this.options.authToken;
    const bufToken = Buffer.from(token);
    const bufValid = Buffer.from(valid);
    const match = bufToken.length === bufValid.length && crypto.timingSafeEqual(bufToken, bufValid);
    if (!match) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing bearer token' }));
      return true;
    }
    return false;
  }

  // ── Request Handler ────────────────────────────────────────────────

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const origin = req.headers['origin'] as string | undefined;
    const pathname = (req.url || '').split('?')[0];

    // Health check
    if (req.method === 'GET' && pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }

    // ── SSE: MCP HTTP transport (GET /mcp) ───────────────────────────
    if (req.method === 'GET' && pathname === '/mcp') {
      this.handleSseConnection(req, res);
      return;
    }

    // ── SSE: Message handler (POST /mcp/session/:id/message) ────────
    const msgMatch = pathname.match(/^\/mcp\/session\/([a-f0-9-]+)\/message$/);
    if (req.method === 'POST' && msgMatch) {
      this.handleSseMessage(req, res, msgMatch[1]);
      return;
    }

    // CORS preflight — validate origin
    if (req.method === 'OPTIONS') {
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
    if (req.method === 'POST' && pathname === '/mcp') {
      this.handleDirectPost(req, res, origin);
      return;
    }

    // ── 404 catch-all ─────────────────────────────────────────────────
    this.writeCorsHeaders(res, origin);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found. Use GET /mcp (SSE) or POST /mcp (direct)' }));
  }

  /** SSE connection — open event stream and send endpoint URL. */
  private handleSseConnection(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Check auth for SSE too (security — previously only checked on direct POST)
    if (this.authFailed(req, res)) return;

    const sessionId = crypto.randomUUID();
    const endpoint = `/mcp/session/${sessionId}/message`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const sendEvent = (event: string, data: string) => {
      try { res.write(`event: ${event}\ndata: ${data}\n\n`); } catch { /* closed */ }
    };

    const session: SseSession = { id: sessionId, res, sendEvent };
    this.sessions.set(sessionId, session);

    // Tell client where to POST JSON-RPC messages
    sendEvent('endpoint', endpoint);

    // Keep-alive to prevent proxy timeouts
    const keepAlive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { clearInterval(keepAlive); }
    }, SSE_KEEPALIVE_MS);

    req.on('close', () => {
      clearInterval(keepAlive);
      this.sessions.delete(sessionId);
    });
  }

  /** Handle a message POSTed to an SSE session endpoint. */
  private handleSseMessage(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    const chunks: Buffer[] = [];
    let bodySize = 0;
    const MAX_BODY = 10 * 1024 * 1024;

    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) return;
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (bodySize > MAX_BODY) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload Too Large: max 10 MB' }));
        return;
      }

      const rawBody = Buffer.concat(chunks).toString('utf-8');

      // Acknowledge the POST immediately — response goes over SSE
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ accepted: true }));

      try {
        const response = await handleRequest(rawBody, this.tools);
        if (response) {
          session.sendEvent('message', JSON.stringify(response));
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        session.sendEvent('message', JSON.stringify({
          jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error: ' + msg },
        }));
      }
    });

    req.on('error', () => {});
  }

  /** Direct POST /mcp — inline JSON-RPC response (backward compat). */
  private handleDirectPost(req: http.IncomingMessage, res: http.ServerResponse, origin: string | undefined): void {
    // CORS: reject non-loopback origins
    if (!this.isValidOrigin(origin)) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: CORS requests from this origin are not allowed' }));
      return;
    }

    // Content-Type check
    const ctype = req.headers['content-type'] || '';
    if (!ctype.includes('application/json')) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(415, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unsupported Media Type: expected application/json' }));
      return;
    }

    // Auth check (bearer token) — timing-safe
    if (this.authFailed(req, res)) return;

    if (this.shuttingDown) {
      this.writeCorsHeaders(res, origin);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server shutting down' }));
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

    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) return;
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (bodySize > MAX_BODY) {
        this.writeCorsHeaders(res, origin);
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload Too Large: max 10 MB' }));
        activeRequestDone();
        return;
      }

      const rawBody = Buffer.concat(chunks).toString('utf-8');

      try {
        const response = await handleRequest(rawBody, this.tools);
        const body = JSON.stringify(response);
        this.writeCorsHeaders(res, origin);

        let status = 200;
        if (response.error) {
          switch (response.error.code) {
            case -32700: case -32600: case -32602: status = 400; break;
            case -32601: status = 404; break;
            case -32603: status = 500; break;
          }
        }

        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body);
      } catch (err) {
        this.writeCorsHeaders(res, origin);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        const msg = err instanceof Error ? err.message : String(err);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error: ' + msg } }));
      } finally {
        activeRequestDone();
      }
    });

    req.on('error', () => { activeRequestDone(); });
  }
}
