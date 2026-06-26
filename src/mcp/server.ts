import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import { handleRequest } from './transport';
import { ToolDefinition } from '../utils/types';

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

export class McpServer {
  private server: http.Server | https.Server | null = null;
  private tools: Map<string, ToolDefinition> = new Map();
  private activeRequests = 0;
  private shuttingDown = false;
  private options: McpServerOptions;
  private onListen?: (url: string) => void;
  private useTls: boolean;

  constructor(options: McpServerOptions) {
    this.options = options;
    this.useTls = !!(options.tlsCertPath && options.tlsKeyPath);
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

    return new Promise((resolve) => {
      this.server!.once('close', () => { this.server = null; resolve(); });

      setTimeout(() => {
        if (this.server) this.server.close();
      }, timeoutMs);

      // Try immediate close — if active requests, timeout will force
      if (this.activeRequests === 0) {
        this.server!.close();
      }
    });
  }

  // ── Request Handler ────────────────────────────────────────────────

  private onRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      this.writeCorsHeaders(res);
      res.writeHead(204);
      res.end();
      return;
    }

    // Only POST /mcp
    if (req.method !== 'POST' || req.url !== '/mcp') {
      this.writeCorsHeaders(res);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found. Use POST /mcp' }));
      return;
    }

    // Content-Type check
    const ctype = req.headers['content-type'] || '';
    if (!ctype.includes('application/json')) {
      this.writeCorsHeaders(res);
      res.writeHead(415, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unsupported Media Type: expected application/json' }));
      return;
    }

    // Auth check (bearer token)
    if (this.options.authToken) {
      const auth = req.headers['authorization'] || '';
      if (!auth.startsWith('Bearer ') || auth.slice(7) !== this.options.authToken) {
        this.writeCorsHeaders(res);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized: invalid or missing bearer token' }));
        return;
      }
    }

    if (this.shuttingDown) {
      this.writeCorsHeaders(res);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server shutting down' }));
      return;
    }

    this.activeRequests++;

    const chunks: Buffer[] = [];
    let bodySize = 0;
    const MAX_BODY = 10 * 1024 * 1024;

    req.on('data', (chunk: Buffer) => {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY) { req.destroy(); return; }
      chunks.push(chunk);
    });

    req.on('end', async () => {
      if (bodySize > MAX_BODY) {
        this.writeCorsHeaders(res);
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload Too Large: max 10 MB' }));
        this.activeRequests--;
        return;
      }

      const rawBody = Buffer.concat(chunks).toString('utf-8');

      try {
        const response = await handleRequest(rawBody, this.tools);
        const body = JSON.stringify(response);
        this.writeCorsHeaders(res);

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
        this.writeCorsHeaders(res);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        const msg = err instanceof Error ? err.message : String(err);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error: ' + msg } }));
      } finally {
        this.activeRequests--;
      }
    });

    req.on('error', () => { /* connection destroyed, e.g. oversized payload */ this.activeRequests--; });
  }

  private writeCorsHeaders(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
}
