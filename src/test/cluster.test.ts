import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { McpServer } from '../mcp/server';
import { ToolExecutor } from '../mcp/executor';
import { ToolDefinition } from '../utils/types';
import { encodeMessage, createDecoder, FrameDecodeError, IpcMessage } from '../mcp/cluster/protocol';
import { probePort, PortProbe } from '../mcp/cluster/election';
import { createIpcServer, closeIpcServer, isIpcAlive } from '../mcp/cluster/ipc';
import { MasterCoordinator } from '../mcp/cluster/master';
import { WorkerCoordinator } from '../mcp/cluster/worker';
import { bootstrapCluster } from '../mcp/cluster/bootstrap';
import { MSG, MAX_FRAME_BYTES } from '../mcp/cluster/constants';

// ── Helpers ──────────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as any).port;
      srv.close(() => resolve(port));
    });
  });
}

function findFreeIpcPath(): string {
  return path.join(os.tmpdir(), `vscode-mcp-cluster-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

function post(url: string, body: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
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

function makeTool(name: string, handler: (args: Record<string, unknown>) => string): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    handler: async (args) => ({ content: [{ type: 'text', text: handler(args) }], isError: false }),
  };
}

// ── Framing protocol ─────────────────────────────────────────────────

describe('cluster protocol framing', () => {
  it('round-trips a message through encode + decode in one chunk', () => {
    const seen: IpcMessage[] = [];
    const decode = createDecoder((m) => seen.push(m));
    decode(encodeMessage({ type: MSG.REGISTER, id: 'w1', workspacePaths: ['/a'], displayName: 'W1' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: MSG.REGISTER, id: 'w1', workspacePaths: ['/a'], displayName: 'W1' });
  });

  it('decodes a message fed byte-by-byte across many chunks', () => {
    const seen: IpcMessage[] = [];
    const decode = createDecoder((m) => seen.push(m));
    const frame = encodeMessage({ type: MSG.CALL, callId: 'abc', rawBody: '{"jsonrpc":"2.0","id":1}' });
    for (let i = 0; i < frame.length; i++) {
      decode(frame.subarray(i, i + 1));
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: MSG.CALL, callId: 'abc' });
  });

  it('decodes multiple messages packed into one chunk', () => {
    const seen: IpcMessage[] = [];
    const decode = createDecoder((m) => seen.push(m));
    decode(Buffer.concat([
      encodeMessage({ type: MSG.PING }),
      encodeMessage({ type: MSG.PONG }),
      encodeMessage({ type: MSG.PING }),
    ]));
    expect(seen.map((m) => m.type)).toEqual([MSG.PING, MSG.PONG, MSG.PING]);
  });

  it('decodes a split message where the length header spans two chunks', () => {
    const seen: IpcMessage[] = [];
    const decode = createDecoder((m) => seen.push(m));
    const frame = encodeMessage({ type: MSG.RESULT, callId: 'x', response: { jsonrpc: '2.0', id: 1 } });
    // Header = 4 bytes; split after 2 bytes so the header itself is partial.
    decode(frame.subarray(0, 2));
    decode(frame.subarray(2));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: MSG.RESULT, callId: 'x' });
  });

  it('round-trips a large (1 MB) payload', () => {
    const big = 'x'.repeat(1024 * 1024);
    const seen: IpcMessage[] = [];
    const decode = createDecoder((m) => seen.push(m));
    const frame = encodeMessage({ type: MSG.RESULT, callId: 'big', response: { jsonrpc: '2.0', id: 1, result: { text: big } } });
    expect(frame.length).toBeGreaterThan(1024 * 1024);
    // Feed in 64 KB chunks like a real socket would.
    for (let i = 0; i < frame.length; i += 64 * 1024) {
      decode(frame.subarray(i, i + 64 * 1024));
    }
    expect(seen).toHaveLength(1);
    expect((seen[0].response as any).result.text).toBe(big);
  });

  it('rejects frames whose header declares a size over the cap', () => {
    const decode = createDecoder(() => {});
    const bad = Buffer.alloc(8);
    bad.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => decode(bad)).toThrow(FrameDecodeError);
  });

  it('rejects non-JSON frame bodies', () => {
    const decode = createDecoder(() => {});
    const body = Buffer.from('not json at all');
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    expect(() => decode(frame)).toThrow(/not valid JSON/);
  });

  it('rejects frame bodies that are not IPC messages', () => {
    const decode = createDecoder(() => {});
    const body = Buffer.from(JSON.stringify({ hello: 'world' }));
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    expect(() => decode(frame)).toThrow(/missing string "type"/);
  });
});

// ── Port probing ─────────────────────────────────────────────────────

describe('cluster port probing', () => {
  it('probePort returns valid for a live MCP server', async () => {
    const port = await findFreePort();
    const srv = new McpServer({ port, host: '127.0.0.1' });
    await srv.start();
    try {
      const probe = await probePort(port, findFreeIpcPath());
      expect(probe.status).toBe('valid');
    } finally {
      await srv.stop(1000);
    }
  });

  it('probePort returns free for an unbound port', async () => {
    const port = await findFreePort();
    const probe = await probePort(port, findFreeIpcPath());
    expect(probe.status).toBe('free');
  });

  it('probePort returns foreign for an occupied non-MCP HTTP server', async () => {
    const port = await findFreePort();
    const srv = http.createServer((req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'nothing here' }));
    });
    await new Promise<void>((resolve) => srv.listen(port, '127.0.0.1', resolve));
    try {
      const probe = await probePort(port, findFreeIpcPath());
      expect(probe.status).toBe('foreign');
    } finally {
      srv.close();
    }
  });

  it('probePort returns zombie for a silent port with a live IPC pipe', async () => {
    const port = await findFreePort();
    const ipcPath = findFreeIpcPath();
    // A TCP server that accepts but never answers HTTP → health probe times out.
    const silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(port, '127.0.0.1', resolve));
    const ipc = await createIpcServer(ipcPath);
    try {
      const probe = await probePort(port, ipcPath);
      expect(probe.status).toBe('zombie');
    } finally {
      silent.close();
      await closeIpcServer(ipc, new Set());
    }
  }, 10_000);

  it('probePort returns foreign for a silent port with no IPC pipe', async () => {
    const port = await findFreePort();
    const silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(port, '127.0.0.1', resolve));
    try {
      const probe = await probePort(port, findFreeIpcPath());
      expect(probe.status).toBe('foreign');
    } finally {
      silent.close();
    }
  }, 10_000);
});

// ── IPC helpers ──────────────────────────────────────────────────────

describe('cluster IPC helpers', () => {
  it('isIpcAlive is false when nothing listens on the path', async () => {
    expect(await isIpcAlive(findFreeIpcPath(), 300)).toBe(false);
  });

  it('createIpcServer recovers from a stale socket file left by a crash', async () => {
    const ipcPath = findFreeIpcPath();
    // Simulate a hard crash: a child binds the socket then SIGKILLs itself.
    // Node's normal close() auto-unlinks, so only a real crash leaves a
    // stale socket file behind — this is the exact scenario the recovery
    // path guards against.
    const readyFile = ipcPath + '.ready';
    const child = spawn(process.execPath, ['-e', `
      const net = require('net');
      const fs = require('fs');
      const s = net.createServer(() => {});
      s.listen(process.argv[1], () => {
        fs.writeFileSync(process.argv[2], 'ready');
        setTimeout(() => process.kill(process.pid, 'SIGKILL'), 50);
      });
    `, ipcPath, readyFile], { stdio: ['ignore', 'ignore', 'ignore'] });
    try {
      await vi.waitFor(() => expect(fs.existsSync(readyFile)).toBe(true), { timeout: 5000 });
      await new Promise<void>((resolve) => child.on('exit', () => resolve()));
      expect(fs.existsSync(ipcPath)).toBe(true); // stale file survives the crash
      const srv = await createIpcServer(ipcPath);
      expect(srv.listening).toBe(true);
      await closeIpcServer(srv, new Set());
    } finally {
      child.kill('SIGKILL');
      try { fs.unlinkSync(readyFile); } catch { /* already gone */ }
      try { fs.unlinkSync(ipcPath); } catch { /* already gone */ }
    }
  }, 10_000);

  it('createIpcServer rejects when a live peer owns the path', async () => {
    const ipcPath = findFreeIpcPath();
    const srv = await createIpcServer(ipcPath);
    try {
      await expect(createIpcServer(ipcPath)).rejects.toThrow();
    } finally {
      await closeIpcServer(srv, new Set());
    }
  });
});

// ── Master + Worker integration ──────────────────────────────────────

describe('master-worker cluster', () => {
  let port: number;
  let ipcPath: string;
  let master: MasterCoordinator;
  let worker: WorkerCoordinator;
  let masterExec: ToolExecutor;
  let workerExec: ToolExecutor;
  let lostReasons: string[];

  beforeEach(async () => {
    port = await findFreePort();
    ipcPath = findFreeIpcPath();
    lostReasons = [];

    masterExec = new ToolExecutor();
    masterExec.registerTool(makeTool('echo', (a) => `echo from master: ${a.msg ?? ''}`));
    workerExec = new ToolExecutor();
    workerExec.registerTool(makeTool('echo', (a) => `echo from worker: ${a.msg ?? ''}`));
    workerExec.registerTool(makeTool('whoami_worker', () => 'worker'));

    master = new MasterCoordinator({
      port,
      host: '127.0.0.1',
      ipcPath,
      executor: masterExec,
      workspaceId: 'master-ws',
      workspacePaths: ['/mnt/master'],
      displayName: 'Master Window',
    });
    await master.start();

    worker = new WorkerCoordinator({
      ipcPath,
      executor: workerExec,
      workspaceId: 'worker-ws',
      workspacePaths: ['/mnt/worker'],
      displayName: 'Worker Window',
    });
    worker.setOnLostMaster((reason) => lostReasons.push(reason));
    await worker.start();
  });

  afterEach(async () => {
    if (worker) await worker.stop(500).catch(() => {});
    if (master) await master.stop(1000).catch(() => {});
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(ipcPath); } catch { /* already gone */ }
    }
  });

  const url = () => `http://127.0.0.1:${port}/mcp`;

  function toolCall(name: string, args: Record<string, unknown>, extra?: Record<string, unknown>) {
    return post(url(), { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, ...extra } });
  }

  it('executes calls targeting the master workspace locally', async () => {
    const res = await toolCall('echo', { msg: 'hi' });
    expect(res.status).toBe(200);
    expect(res.body.result.content[0].text).toBe('echo from master: hi');
  });

  it('routes calls to a worker via the workspace id', async () => {
    const res = await toolCall('echo', { msg: 'hi' }, { workspace: 'worker-ws' });
    expect(res.body.result.content[0].text).toBe('echo from worker: hi');
  });

  it('routes calls to a worker via an exact workspace folder path', async () => {
    const res = await toolCall('echo', { msg: 'hi' }, { workspace: '/mnt/worker' });
    expect(res.body.result.content[0].text).toBe('echo from worker: hi');
  });

  it('routes calls to a worker via a workspace folder basename', async () => {
    const res = await toolCall('echo', { msg: 'hi' }, { workspace: 'worker' });
    expect(res.body.result.content[0].text).toBe('echo from worker: hi');
  });

  it('routes to the worker by path-prefix inference on path-like args', async () => {
    const res = await toolCall('echo', { path: '/mnt/worker/package.json', msg: 'x' });
    expect(res.body.result.content[0].text).toBe('echo from worker: x');
  });

  it('keeps calls under the master path local', async () => {
    const res = await toolCall('echo', { path: '/mnt/master/src/main.ts', msg: 'x' });
    expect(res.body.result.content[0].text).toBe('echo from master: x');
  });

  it('falls back to the master for non-path arguments', async () => {
    const res = await toolCall('echo', { msg: 'just text' });
    expect(res.body.result.content[0].text).toBe('echo from master: just text');
  });

  it('returns an InvalidParams error for an unknown workspace reference', async () => {
    const res = await toolCall('echo', { msg: 'hi' }, { workspace: 'nope' });
    expect(res.body.error.code).toBe(-32602);
    expect(res.body.error.message).toMatch(/not found/i);
  });

  it('serves tools/list locally by default and per-worker with a workspace arg', async () => {
    const local = await post(url(), { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const localNames = local.body.result.tools.map((t: any) => t.name);
    expect(localNames).toContain('list_workspaces');
    expect(localNames).not.toContain('whoami_worker');

    const workerList = await post(url(), {
      jsonrpc: '2.0', id: 3, method: 'tools/list', params: { workspace: 'worker-ws' },
    });
    const workerNames = workerList.body.result.tools.map((t: any) => t.name);
    expect(workerNames).toContain('whoami_worker');
    expect(workerNames).not.toContain('list_workspaces');
  });

  it('exposes list_workspaces with master and worker entries', async () => {
    const res = await toolCall('list_workspaces', {});
    const parsed = JSON.parse(res.body.result.content[0].text);
    const ids = parsed.map((e: any) => e.id).sort();
    expect(ids).toEqual(['master-ws', 'worker-ws']);
    const workerEntry = parsed.find((e: any) => e.id === 'worker-ws');
    expect(workerEntry.folders).toEqual(['/mnt/worker']);
    expect(workerEntry.role).toBe('worker');
  });

  it('answers PING with PONG on a raw IPC socket', async () => {
    const socket = net.createConnection(ipcPath);
    const msgs: IpcMessage[] = [];
    const decode = createDecoder((m) => msgs.push(m));
    socket.on('data', (c: Buffer) => decode(c));
    socket.on('error', () => { /* probe is best-effort; waits will fail if it errors */ });
    const welcome = new Promise<void>((resolve) => {
      socket.on('connect', () => {
        socket.write(encodeMessage({ type: MSG.REGISTER, id: 'probe', workspacePaths: [], displayName: 'Probe' }));
        resolve();
      });
    });
    await welcome;
    await vi.waitFor(() => expect(msgs.some((m) => m.type === MSG.WELCOME)).toBe(true), { timeout: 3000 });
    socket.write(encodeMessage({ type: MSG.PING }));
    await vi.waitFor(() => expect(msgs.some((m) => m.type === MSG.PONG)).toBe(true), { timeout: 3000 });
    socket.destroy();
  }, 10_000);

  it('fires the lost-master handler when the master goes away', async () => {
    await master.stop(500);
    await vi.waitFor(() => expect(lostReasons.length).toBeGreaterThan(0), { timeout: 3000 });
  });

  it('master stop unlinks the IPC socket file (POSIX)', async () => {
    expect(fs.existsSync(ipcPath)).toBe(true);
    await master.stop(500);
    if (process.platform !== 'win32') {
      expect(fs.existsSync(ipcPath)).toBe(false);
    }
  });
});

// ── End-to-end bootstrap ─────────────────────────────────────────────

describe('cluster bootstrap', () => {
  it('promotes a single window to master and serves the port', async () => {
    const port = await findFreePort();
    const ipcPath = findFreeIpcPath();
    const exec = new ToolExecutor();
    exec.registerTool(makeTool('echo', (a) => `local: ${a.msg ?? ''}`));

    const member = await bootstrapCluster({
      basePort: port,
      host: '127.0.0.1',
      ipcPath,
      executor: exec,
      workspaceId: 'ws-a',
      workspacePaths: ['/mnt/a'],
      displayName: 'Window A',
    });

    expect(member.role).toBe('master');
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'hi' } },
    });
    expect(res.body.result.content[0].text).toBe('local: hi');
    await member.stop(500);
    if (process.platform !== 'win32') {
      expect(fs.existsSync(ipcPath)).toBe(false);
    }
  });

  it('joins an existing master as a worker', async () => {
    const port = await findFreePort();
    const ipcPath = findFreeIpcPath();
    const masterExec = new ToolExecutor();
    masterExec.registerTool(makeTool('echo', (a) => `master: ${a.msg ?? ''}`));
    const master = new MasterCoordinator({
      port, host: '127.0.0.1', ipcPath, executor: masterExec,
      workspaceId: 'm1', workspacePaths: ['/mnt/m'], displayName: 'M',
    });
    await master.start();

    const workerExec = new ToolExecutor();
    workerExec.registerTool(makeTool('echo', (a) => `worker: ${a.msg ?? ''}`));
    const worker = await bootstrapCluster({
      basePort: port,
      host: '127.0.0.1',
      ipcPath,
      executor: workerExec,
      workspaceId: 'w1',
      workspacePaths: ['/mnt/w'],
      displayName: 'W',
    });

    expect(worker.role).toBe('worker');
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'echo', arguments: { msg: 'hi' }, workspace: 'w1' },
    });
    expect(res.body.result.content[0].text).toBe('worker: hi');
    await worker.stop(500);
    await master.stop(500);
  });
});