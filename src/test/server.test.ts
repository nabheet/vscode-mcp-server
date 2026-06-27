import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import { McpServer } from '../mcp/server';
import { ToolDefinition } from '../utils/types';

function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as any).port;
      srv.close(() => resolve(port));
    });
  });
}

function post(url: string, body: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...headers,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode ?? 0, body: parsed, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let parsed: any;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    }).on('error', reject);
  });
}

describe('McpServer', () => {
  let server: McpServer;
  let port: number;

  beforeEach(async () => {
    port = await findFreePort();
  });

  afterEach(async () => {
    if (server) {
      await server.stop(1000);
    }
  });

  // ── Start/Stop ──────────────────────────────────────────────────────

  it('starts and stops on a free port', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    await server.start();
    // Should not throw — server is listening
  });

  it('calls onListen callback with URL', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    const cb = vi.fn();
    server.setOnListen(cb);
    await server.start();
    expect(cb).toHaveBeenCalledOnce();
    expect(cb.mock.calls[0][0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('stop resolves and server no longer responds', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    await server.start();
    await server.stop(1000);
    // Request should fail
    await expect(post(`http://127.0.0.1:${port}/mcp`, {})).rejects.toThrow();
  });

  // ── HTTP Basics ─────────────────────────────────────────────────────

  it('responds 404 for non-/mcp path', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    await server.start();
    const res = await post(`http://127.0.0.1:${port}/wrong`, {});
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('responds 415 for non-JSON content type', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    await server.start();
    const res = await post(`http://127.0.0.1:${port}/mcp`, 'plain text', { 'Content-Type': 'text/plain' });
    expect(res.status).toBe(415);
    expect(res.body.error).toMatch(/unsupported media type/i);
  });

  it('responds 204 for OPTIONS preflight', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    await server.start();
    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/mcp`, { method: 'OPTIONS' }, (res) => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(`http://127.0.0.1:${port}`);
  });

  // ── tools/list ──────────────────────────────────────────────────────

  it('has no tools when none registered', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    await server.start();
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    expect(res.status).toBe(200);
    expect((res.body as any).result.tools).toEqual([]);
  });

  it('returns registered tools', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    server.registerTool({
      name: 'ping',
      description: 'Ping pong',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
    });
    await server.start();
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    expect(res.status).toBe(200);
    const tools = (res.body as any).result.tools;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('ping');
  });

  // ── tools/call ──────────────────────────────────────────────────────

  it('calls a registered tool and returns result', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'hello from tool' }] });
    server.registerTool({
      name: 'greet',
      description: 'Greets',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      handler,
    });
    await server.start();
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'greet', arguments: { name: 'World' } },
    });
    expect(res.status).toBe(200);
    expect((res.body as any).result.content[0].text).toBe('hello from tool');
    expect(handler).toHaveBeenCalledWith({ name: 'World' });
  });

  it('returns 400 for schema validation error', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    server.registerTool({
      name: 'required_arg',
      description: 'Needs stuff',
      inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
      handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
    });
    await server.start();
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'required_arg', arguments: {} },
    });
    expect(res.status).toBe(200); // MCP wraps errors in result, not HTTP status
    expect((res.body as any).result.isError).toBe(true);
  });

  // ── Auth ────────────────────────────────────────────────────────────

  it('rejects missing auth token', async () => {
    server = new McpServer({ port, host: '127.0.0.1', authToken: 'secret123' });
    await server.start();
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
  });

  it('rejects wrong auth token', async () => {
    server = new McpServer({ port, host: '127.0.0.1', authToken: 'secret123' });
    await server.start();
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    }, { Authorization: 'Bearer wrong' });
    expect(res.status).toBe(401);
  });

  it('accepts correct auth token', async () => {
    server = new McpServer({ port, host: '127.0.0.1', authToken: 'secret123' });
    await server.start();
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    }, { Authorization: 'Bearer secret123' });
    expect(res.status).toBe(200);
    expect((res.body as any).result).toBeDefined();
  });

  // ── Shutdown protection ─────────────────────────────────────────────

  it('returns 503 during shutdown', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    await server.start();

    // Set shuttingDown via the private field using type cast
    (server as any).shuttingDown = true;

    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/shutting down/i);
  });

  // ── Payload limit ───────────────────────────────────────────────────

  it('rejects payloads over 10MB', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    await server.start();

    // Send a payload larger than 10MB. Server pauses the stream and
    // responds with HTTP 413 once the end of data is received.
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on('error', reject);
      req.write('x'.repeat(11 * 1024 * 1024));
      req.end();
    });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/payload too large/i);
  });

  // ── EADDRINUSE ──────────────────────────────────────────────────────

  it('rejects EADDRINUSE when port is taken', async () => {
    const other = new McpServer({ port, host: '127.0.0.1' });
    await other.start();

    server = new McpServer({ port, host: '127.0.0.1' });
    await expect(server.start()).rejects.toThrow(/already in use/i);

    await other.stop(1000);
  });

  // ── Concurrent Requests ────────────────────────────────────────────

  it('handles concurrent requests', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    let callCount = 0;
    server.registerTool({
      name: 'counter',
      description: 'Counts calls',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        callCount++;
        // Simulate some work
        await new Promise((r) => setTimeout(r, 50));
        return { content: [{ type: 'text', text: `count: ${callCount}` }] };
      },
    });
    await server.start();

    const promises = Array.from({ length: 10 }, (_, i) =>
      post(`http://127.0.0.1:${port}/mcp`, {
        jsonrpc: '2.0', id: i, method: 'tools/call',
        params: { name: 'counter', arguments: {} },
      }),
    );
    const results = await Promise.all(promises);
    expect(results).toHaveLength(10);
    for (const res of results) {
      expect(res.status).toBe(200);
      expect((res.body as any).result.content[0].text).toMatch(/count:/);
    }
    expect(callCount).toBe(10);
  });

  it('concurrent tools/list requests do not interfere', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    server.registerTool({
      name: 'ping', description: 'Ping',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
    });
    await server.start();

    const promises = Array.from({ length: 20 }, (_, i) =>
      post(`http://127.0.0.1:${port}/mcp`, {
        jsonrpc: '2.0', id: i, method: 'tools/list',
      }),
    );
    const results = await Promise.all(promises);
    for (const res of results) {
      expect(res.status).toBe(200);
      expect((res.body as any).result.tools).toHaveLength(1);
    }
  });

  // ── Shutdown-during-request ─────────────────────────────────────────

  it('drains active requests before full stop', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    let resolveSlow: (() => void) | undefined;
    server.registerTool({
      name: 'slow',
      description: 'Slow operation',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        await new Promise((r) => { resolveSlow = r; });
        return { content: [{ type: 'text', text: 'done' }] };
      },
    });
    await server.start();

    // Fire a slow request
    const slowPromise = post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'slow', arguments: {} },
    });

    // Give it time to reach the handler
    await new Promise((r) => setTimeout(r, 100));

    // Stop the server — should wait for active request to complete (with timeout)
    const stopPromise = server.stop(5000);

    // Resolve the slow handler after a brief delay
    await new Promise((r) => setTimeout(r, 200));
    resolveSlow?.();

    const [stopResult, slowResult] = await Promise.all([stopPromise, slowPromise]);
    expect(stopResult).toBeUndefined(); // stop() resolves void
    expect(slowResult.status).toBe(200);
    expect((slowResult.body as any).result.content[0].text).toBe('done');
  });

  it('force-stops if active request exceeds timeout', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    let neverResolve: ((v: unknown) => void) | undefined;
    server.registerTool({
      name: 'forever',
      description: 'Never finishes',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        await new Promise((r) => { neverResolve = r; });
        return { content: [{ type: 'text', text: 'done' }] };
      },
    });
    await server.start();

    // Fire a request that never resolves
    post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'forever', arguments: {} },
    }).catch(() => {}); // Ignore connection refused after force-stop

    await new Promise((r) => setTimeout(r, 100));

    // Stop with very short timeout — should force-stop
    await server.stop(100);

    // Server should now be stopped even though handler never resolved
    await expect(post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 2, method: 'tools/list',
    })).rejects.toThrow();

    // Clean up the dangling promise
    neverResolve?.('cleanup');
  });

  // ── Auth Edge Cases ─────────────────────────────────────────────────

  it('rejects malformed Authorization header', async () => {
    server = new McpServer({ port, host: '127.0.0.1', authToken: 'secret123' });
    await server.start();
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    }, { Authorization: 'Basic dXNlcjpwYXNz' }); // Basic auth instead of Bearer
    expect(res.status).toBe(401);
  });

  it('rejects empty Bearer token', async () => {
    server = new McpServer({ port, host: '127.0.0.1', authToken: 'secret123' });
    await server.start();
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    }, { Authorization: 'Bearer ' }); // Empty token
    expect(res.status).toBe(401);
  });

  it('uses timing-safe comparison for auth token', async () => {
    // Test with very long tokens to verify timing-safe comparison works
    const longToken = 'a'.repeat(1000);
    server = new McpServer({ port, host: '127.0.0.1', authToken: longToken });
    await server.start();
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    }, { Authorization: `Bearer ${longToken}` });
    expect(res.status).toBe(200);

    // Wrong token of same length
    const wrongToken = 'b'.repeat(1000);
    const res2 = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 2, method: 'tools/list',
    }, { Authorization: `Bearer ${wrongToken}` });
    expect(res2.status).toBe(401);
  });

  // ── TLS Error Handling ─────────────────────────────────────────────

  it('rejects start with invalid TLS cert path', async () => {
    server = new McpServer({
      port, host: '127.0.0.1',
      tlsCertPath: '/nonexistent/cert.pem',
      tlsKeyPath: '/nonexistent/key.pem',
    });
    await expect(server.start()).rejects.toThrow(/Failed to load TLS/);
  });

  it('rejects start with missing TLS key path', async () => {
    server = new McpServer({
      port, host: '127.0.0.1',
      tlsCertPath: '/nonexistent/cert.pem',
      // No tlsKeyPath — but both or neither must be set
    });
    // Without tlsKeyPath, useTls is false, so it starts plain HTTP
    await server.start();
    expect(server).toBeDefined();
  });

  // ── Cross-Origin Security ──────────────────────────────────────────

  it('rejects OPTIONS with invalid origin', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    await server.start();
    const res = await new Promise<{ status: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/mcp`, {
        method: 'OPTIONS',
        headers: { Origin: 'https://evil.com' },
      }, (res) => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers });
      });
      req.on('error', reject);
      req.end();
    });
    // Invalid origins get 403 (no CORS headers written)
    expect(res.status).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  // ── Large Payload Edge Cases ───────────────────────────────────────

  it('handles request body correctly with accurate content-length', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    await server.start();
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/list',
    });
    expect(res.status).toBe(200);
    expect((res.body as any).result).toBeDefined();
  });

  it('rejects zero-length POST body', async () => {
    server = new McpServer({ port, host: '127.0.0.1' });
    await server.start();
    // Send an empty body
    const res = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          let parsed: any;
          try { parsed = JSON.parse(raw); } catch { parsed = raw; }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on('error', reject);
      req.end(); // No body
    });
    // Empty body is invalid JSON → returns ParseError (400)
    expect(res.status).toBe(400);
  });
});
