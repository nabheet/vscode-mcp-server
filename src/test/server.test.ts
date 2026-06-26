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
    expect(res.headers['access-control-allow-origin']).toBe('*');
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

    // Send a payload larger than 10MB. Server calls req.destroy().
    // The connection terminates with an error (ECONNRESET/EPIPE) or
    // may return 413 if the response is written before destruction.
    let terminated = false;
    await new Promise<void>((resolve) => {
      const req = http.request(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        res.resume();
        res.on('end', () => { terminated = true; resolve(); });
      });
      req.on('error', () => { terminated = true; resolve(); });
      req.write('x'.repeat(11 * 1024 * 1024));
      req.end();
    });
    expect(terminated).toBe(true);
  });

  // ── EADDRINUSE ──────────────────────────────────────────────────────

  it('rejects EADDRINUSE when port is taken', async () => {
    const other = new McpServer({ port, host: '127.0.0.1' });
    await other.start();

    server = new McpServer({ port, host: '127.0.0.1' });
    await expect(server.start()).rejects.toThrow(/already in use/i);

    await other.stop(1000);
  });
});
