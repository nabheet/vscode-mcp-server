import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapCluster } from "../mcp/cluster/bootstrap";
import { HEALTH_SERVICE, MAX_FRAME_BYTES, MSG } from "../mcp/cluster/constants";
import { probePort } from "../mcp/cluster/election";
import { closeIpcServer, createIpcServer, isIpcAlive } from "../mcp/cluster/ipc";
import { LeaderCoordinator } from "../mcp/cluster/leader";
import {
  createDecoder,
  encodeMessage,
  FrameDecodeError,
  type IpcMessage,
} from "../mcp/cluster/protocol";
import { WorkerCoordinator } from "../mcp/cluster/worker";
import { ToolExecutor } from "../mcp/executor";
import { McpServer } from "../mcp/server";
import type { ToolDefinition } from "../utils/types";

// The retry loop in bootstrapCluster backs off between attempts (up to ~18s
// for 8 attempts). Collapse that to zero so the split-brain regression tests
// run fast; probePort stays real (spread the original module).
vi.mock("../mcp/cluster/election", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/cluster/election")>();
  return { ...actual, sleep: async () => {}, jitter: () => 0 };
});

// ── Response/row shapes used by the HTTP helpers ─────────────────────

/** Minimal successful/error JSON-RPC response shape used by tests. */
interface RpcResponseBody {
  result: {
    content: Array<{ type: string; text: string }>;
    tools: Array<{ name: string }>;
    serverInfo: { name: string; instanceId?: string; instanceName?: string };
  };
  error: { code: number; message: string };
}

/** One row of the list_workspaces output (leader or worker). */
interface WorkspaceRow {
  id: string;
  instanceId?: string;
  instanceName?: string;
  displayName: string;
  folders: string[];
  role: string;
  state: { activeFile?: string; openEditors: string[] };
}

// ── Helpers ──────────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function findFreeIpcPath(): string {
  return path.join(
    os.tmpdir(),
    `vscode-mcp-cluster-${process.pid}-${Math.random().toString(36).slice(2)}.sock`,
  );
}

function post(url: string, body: unknown): Promise<{ status: number; body: RpcResponseBody }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let parsed: RpcResponseBody;
          try {
            parsed = JSON.parse(raw) as RpcResponseBody;
          } catch {
            parsed = {
              result: { content: [], tools: [], serverInfo: { name: "" } },
              error: { code: 0, message: raw },
            };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function _get(url: string): Promise<{ status: number; body: RpcResponseBody }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          let parsed: RpcResponseBody;
          try {
            parsed = JSON.parse(raw) as RpcResponseBody;
          } catch {
            parsed = {
              result: { content: [], tools: [], serverInfo: { name: "" } },
              error: { code: 0, message: raw },
            };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      })
      .on("error", reject);
  });
}

function makeTool(
  name: string,
  handler: (args: Record<string, unknown>) => string,
): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    handler: async (args) => ({ content: [{ type: "text", text: handler(args) }], isError: false }),
  };
}

// ── Framing protocol ─────────────────────────────────────────────────

describe("cluster protocol framing", () => {
  it("round-trips a message through encode + decode in one chunk", () => {
    const seen: IpcMessage[] = [];
    const decode = createDecoder((m) => seen.push(m));
    decode(
      encodeMessage({ type: MSG.REGISTER, id: "w1", workspacePaths: ["/a"], displayName: "W1" }),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      type: MSG.REGISTER,
      id: "w1",
      workspacePaths: ["/a"],
      displayName: "W1",
    });
  });

  it("decodes a message fed byte-by-byte across many chunks", () => {
    const seen: IpcMessage[] = [];
    const decode = createDecoder((m) => seen.push(m));
    const frame = encodeMessage({
      type: MSG.CALL,
      callId: "abc",
      rawBody: '{"jsonrpc":"2.0","id":1}',
    });
    for (let i = 0; i < frame.length; i++) {
      decode(frame.subarray(i, i + 1));
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: MSG.CALL, callId: "abc" });
  });

  it("decodes multiple messages packed into one chunk", () => {
    const seen: IpcMessage[] = [];
    const decode = createDecoder((m) => seen.push(m));
    decode(
      Buffer.concat([
        encodeMessage({ type: MSG.PING }),
        encodeMessage({ type: MSG.PONG }),
        encodeMessage({ type: MSG.PING }),
      ]),
    );
    expect(seen.map((m) => m.type)).toEqual([MSG.PING, MSG.PONG, MSG.PING]);
  });

  it("decodes a split message where the length header spans two chunks", () => {
    const seen: IpcMessage[] = [];
    const decode = createDecoder((m) => seen.push(m));
    const frame = encodeMessage({
      type: MSG.RESULT,
      callId: "x",
      response: { jsonrpc: "2.0", id: 1 },
    });
    // Header = 4 bytes; split after 2 bytes so the header itself is partial.
    decode(frame.subarray(0, 2));
    decode(frame.subarray(2));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: MSG.RESULT, callId: "x" });
  });

  it("round-trips a large (1 MB) payload", () => {
    const big = "x".repeat(1024 * 1024);
    const seen: IpcMessage[] = [];
    const decode = createDecoder((m) => seen.push(m));
    const frame = encodeMessage({
      type: MSG.RESULT,
      callId: "big",
      response: { jsonrpc: "2.0", id: 1, result: { text: big } },
    });
    expect(frame.length).toBeGreaterThan(1024 * 1024);
    // Feed in 64 KB chunks like a real socket would.
    for (let i = 0; i < frame.length; i += 64 * 1024) {
      decode(frame.subarray(i, i + 64 * 1024));
    }
    expect(seen).toHaveLength(1);
    expect((seen[0].response as { result: { text: string } }).result.text).toBe(big);
  });

  it("rejects frames whose header declares a size over the cap", () => {
    const decode = createDecoder(() => {});
    const bad = Buffer.alloc(8);
    bad.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => decode(bad)).toThrow(FrameDecodeError);
  });

  it("rejects non-JSON frame bodies", () => {
    const decode = createDecoder(() => {});
    const body = Buffer.from("not json at all");
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    expect(() => decode(frame)).toThrow(/not valid JSON/);
  });

  it("rejects frame bodies that are not IPC messages", () => {
    const decode = createDecoder(() => {});
    const body = Buffer.from(JSON.stringify({ hello: "world" }));
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(body.length, 0);
    body.copy(frame, 4);
    expect(() => decode(frame)).toThrow(/missing string "type"/);
  });
});

// ── Port probing ─────────────────────────────────────────────────────

describe("cluster port probing", () => {
  it("probePort returns valid for a live MCP server", async () => {
    const port = await findFreePort();
    const srv = new McpServer({ port, host: "127.0.0.1" });
    await srv.start();
    try {
      const probe = await probePort(port, findFreeIpcPath());
      expect(probe.status).toBe("valid");
    } finally {
      await srv.stop(1000);
    }
  });

  it("probePort returns free for an unbound port", async () => {
    const port = await findFreePort();
    const probe = await probePort(port, findFreeIpcPath());
    expect(probe.status).toBe("free");
  });

  it("probePort returns foreign for an occupied non-MCP HTTP server", async () => {
    const port = await findFreePort();
    const srv = http.createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "nothing here" }));
    });
    await new Promise<void>((resolve) => srv.listen(port, "127.0.0.1", resolve));
    try {
      const probe = await probePort(port, findFreeIpcPath());
      expect(probe.status).toBe("foreign");
    } finally {
      srv.close();
    }
  });

  it("probePort returns zombie for a silent port with a live IPC pipe", async () => {
    const port = await findFreePort();
    const ipcPath = findFreeIpcPath();
    // A TCP server that accepts but never answers HTTP → health probe times out.
    const silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(port, "127.0.0.1", resolve));
    const ipc = await createIpcServer(ipcPath);
    try {
      const probe = await probePort(port, ipcPath);
      expect(probe.status).toBe("zombie");
    } finally {
      silent.close();
      await closeIpcServer(ipc, new Set());
    }
  }, 10_000);

  it("probePort returns foreign for a silent port with no IPC pipe", async () => {
    const port = await findFreePort();
    const silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(port, "127.0.0.1", resolve));
    try {
      const probe = await probePort(port, findFreeIpcPath());
      expect(probe.status).toBe("foreign");
    } finally {
      silent.close();
    }
  }, 10_000);
});

// ── IPC helpers ──────────────────────────────────────────────────────

describe("cluster IPC helpers", () => {
  it("isIpcAlive is false when nothing listens on the path", async () => {
    expect(await isIpcAlive(findFreeIpcPath(), 300)).toBe(false);
  });

  it("createIpcServer recovers from a stale socket file left by a crash", async () => {
    const ipcPath = findFreeIpcPath();
    // Simulate a hard crash: a child binds the socket then SIGKILLs itself.
    // Node's normal close() auto-unlinks, so only a real crash leaves a
    // stale socket file behind — this is the exact scenario the recovery
    // path guards against.
    const readyFile = `${ipcPath}.ready`;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      const net = require('net');
      const fs = require('fs');
      const s = net.createServer(() => {});
      s.listen(process.argv[1], () => {
        fs.writeFileSync(process.argv[2], 'ready');
        setTimeout(() => process.kill(process.pid, 'SIGKILL'), 50);
      });
    `,
        ipcPath,
        readyFile,
      ],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    try {
      await vi.waitFor(() => expect(fs.existsSync(readyFile)).toBe(true), { timeout: 5000 });
      await new Promise<void>((resolve) => child.on("exit", () => resolve()));
      expect(fs.existsSync(ipcPath)).toBe(true); // stale file survives the crash
      const srv = await createIpcServer(ipcPath);
      expect(srv.listening).toBe(true);
      await closeIpcServer(srv, new Set());
    } finally {
      child.kill("SIGKILL");
      try {
        fs.unlinkSync(readyFile);
      } catch {
        /* already gone */
      }
      try {
        fs.unlinkSync(ipcPath);
      } catch {
        /* already gone */
      }
    }
  }, 10_000);

  it("createIpcServer rejects when a live peer owns the path", async () => {
    const ipcPath = findFreeIpcPath();
    const srv = await createIpcServer(ipcPath);
    try {
      await expect(createIpcServer(ipcPath)).rejects.toThrow();
    } finally {
      await closeIpcServer(srv, new Set());
    }
  });
});

// ── Leader + Worker integration ──────────────────────────────────────

describe("leader-worker cluster", () => {
  let port: number;
  let ipcPath: string;
  let leader: LeaderCoordinator;
  let worker: WorkerCoordinator;
  let leaderExec: ToolExecutor;
  let workerExec: ToolExecutor;
  let lostReasons: string[];

  beforeEach(async () => {
    port = await findFreePort();
    ipcPath = findFreeIpcPath();
    lostReasons = [];

    leaderExec = new ToolExecutor();
    leaderExec.registerTool(makeTool("echo", (a) => `echo from leader: ${a.msg ?? ""}`));
    workerExec = new ToolExecutor();
    workerExec.registerTool(makeTool("echo", (a) => `echo from worker: ${a.msg ?? ""}`));
    workerExec.registerTool(makeTool("whoami_worker", () => "worker"));

    leader = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
      ipcPath,
      executor: leaderExec,
      workspaceId: "leader-ws",
      workspacePaths: ["/mnt/leader"],
      displayName: "Leader Window",
    });
    await leader.start();

    worker = new WorkerCoordinator({
      ipcPath,
      executor: workerExec,
      workspaceId: "worker-ws",
      workspacePaths: ["/mnt/worker"],
      displayName: "Worker Window",
    });
    worker.setOnLostLeader((reason) => lostReasons.push(reason));
    await worker.start();
  });

  afterEach(async () => {
    if (worker) await worker.stop(500).catch(() => {});
    if (leader) await leader.stop(1000).catch(() => {});
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(ipcPath);
      } catch {
        /* already gone */
      }
    }
  });

  const url = () => `http://127.0.0.1:${port}/mcp`;

  function toolCall(name: string, args: Record<string, unknown>, extra?: Record<string, unknown>) {
    return post(url(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, ...extra },
    });
  }

  it("executes calls targeting the leader workspace locally", async () => {
    const res = await toolCall("echo", { msg: "hi" });
    expect(res.status).toBe(200);
    expect(res.body.result.content[0].text).toBe("echo from leader: hi");
  });

  it("routes calls to a worker via the workspace id", async () => {
    const res = await toolCall("echo", { msg: "hi" }, { workspace: "worker-ws" });
    expect(res.body.result.content[0].text).toBe("echo from worker: hi");
  });

  it("routes calls to a worker via an exact workspace folder path", async () => {
    const res = await toolCall("echo", { msg: "hi" }, { workspace: "/mnt/worker" });
    expect(res.body.result.content[0].text).toBe("echo from worker: hi");
  });

  it("routes calls to a worker via a workspace folder basename", async () => {
    const res = await toolCall("echo", { msg: "hi" }, { workspace: "worker" });
    expect(res.body.result.content[0].text).toBe("echo from worker: hi");
  });

  it("routes to the worker by path-prefix inference on path-like args", async () => {
    const res = await toolCall("echo", { path: "/mnt/worker/package.json", msg: "x" });
    expect(res.body.result.content[0].text).toBe("echo from worker: x");
  });

  it("keeps calls under the leader path local", async () => {
    const res = await toolCall("echo", { path: "/mnt/leader/src/main.ts", msg: "x" });
    expect(res.body.result.content[0].text).toBe("echo from leader: x");
  });

  it("falls back to the leader for non-path arguments", async () => {
    const res = await toolCall("echo", { msg: "just text" });
    expect(res.body.result.content[0].text).toBe("echo from leader: just text");
  });

  it("returns an InvalidParams error for an unknown workspace reference", async () => {
    const res = await toolCall("echo", { msg: "hi" }, { workspace: "nope" });
    expect(res.body.error.code).toBe(-32602);
    expect(res.body.error.message).toMatch(/not found/i);
  });

  it("serves tools/list locally by default and per-worker with a workspace arg", async () => {
    const local = await post(url(), { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const localNames = local.body.result.tools.map((t) => t.name);
    expect(localNames).toContain("list_workspaces");
    expect(localNames).not.toContain("whoami_worker");

    const workerList = await post(url(), {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/list",
      params: { workspace: "worker-ws" },
    });
    const workerNames = workerList.body.result.tools.map((t) => t.name);
    expect(workerNames).toContain("whoami_worker");
    expect(workerNames).not.toContain("list_workspaces");
  });

  it("exposes list_workspaces with leader and worker entries", async () => {
    const res = await toolCall("list_workspaces", {});
    const parsed = JSON.parse(res.body.result.content[0].text) as WorkspaceRow[];
    const ids = parsed.map((e) => e.id).sort();
    expect(ids).toEqual(["leader-ws", "worker-ws"]);
    const workerEntry = parsed.find((e) => e.id === "worker-ws");
    expect(workerEntry.folders).toEqual(["/mnt/worker"]);
    expect(workerEntry.role).toBe("worker");
  });

  it("answers PING with PONG on a raw IPC socket", async () => {
    const socket = net.createConnection(ipcPath);
    const msgs: IpcMessage[] = [];
    const decode = createDecoder((m) => msgs.push(m));
    socket.on("data", (c: Buffer) => decode(c));
    socket.on("error", () => {
      /* probe is best-effort; waits will fail if it errors */
    });
    const welcome = new Promise<void>((resolve) => {
      socket.on("connect", () => {
        socket.write(
          encodeMessage({
            type: MSG.REGISTER,
            id: "probe",
            workspacePaths: [],
            displayName: "Probe",
          }),
        );
        resolve();
      });
    });
    await welcome;
    await vi.waitFor(() => expect(msgs.some((m) => m.type === MSG.WELCOME)).toBe(true), {
      timeout: 3000,
    });
    socket.write(encodeMessage({ type: MSG.PING }));
    await vi.waitFor(() => expect(msgs.some((m) => m.type === MSG.PONG)).toBe(true), {
      timeout: 3000,
    });
    socket.destroy();
  }, 10_000);

  it("fires the lost-leader handler when the leader goes away", async () => {
    await leader.stop(500);
    await vi.waitFor(() => expect(lostReasons.length).toBeGreaterThan(0), { timeout: 3000 });
  });

  it("leader stop unlinks the IPC socket file (POSIX)", async () => {
    expect(fs.existsSync(ipcPath)).toBe(true);
    await leader.stop(500);
    if (process.platform !== "win32") {
      expect(fs.existsSync(ipcPath)).toBe(false);
    }
  });
});

// ── Window state descriptor (issue #76) ─────────────────────────────

describe("window state descriptor", () => {
  let port: number;
  let ipcPath: string;
  let leader: LeaderCoordinator;
  let worker: WorkerCoordinator;
  let leaderExec: ToolExecutor;
  let workerExec: ToolExecutor;

  beforeEach(async () => {
    port = await findFreePort();
    ipcPath = findFreeIpcPath();

    leaderExec = new ToolExecutor();
    leaderExec.registerTool(makeTool("echo", (a) => `echo from leader: ${a.msg ?? ""}`));
    workerExec = new ToolExecutor();
    workerExec.registerTool(makeTool("echo", (a) => `echo from worker: ${a.msg ?? ""}`));

    leader = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
      ipcPath,
      executor: leaderExec,
      workspaceId: "leader-ws",
      workspacePaths: ["/mnt/leader"],
      displayName: "Leader Window",
      state: { activeFile: "/mnt/leader/init.ts", openEditors: ["/mnt/leader/init.ts"] },
    });
    await leader.start();

    worker = new WorkerCoordinator({
      ipcPath,
      executor: workerExec,
      workspaceId: "worker-ws",
      workspacePaths: ["/mnt/worker"],
      displayName: "Worker Window",
      state: { openEditors: ["/mnt/worker/a.ts"] },
    });
    await worker.start();
  });

  afterEach(async () => {
    if (worker) await worker.stop(500).catch(() => {});
    if (leader) await leader.stop(1000).catch(() => {});
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(ipcPath);
      } catch {
        /* already gone */
      }
    }
  });

  const url = () => `http://127.0.0.1:${port}/mcp`;

  function toolCall(name: string, args: Record<string, unknown>, extra?: Record<string, unknown>) {
    return post(url(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, ...extra },
    });
  }

  async function listRows(): Promise<WorkspaceRow[]> {
    const res = await toolCall("list_workspaces", {});
    return JSON.parse(res.body.result.content[0].text) as WorkspaceRow[];
  }

  it("carries initial state in REGISTER and list_workspaces rows", async () => {
    const rows = await listRows();
    const leaderRow = rows.find((e) => e.id === "leader-ws");
    const workerRow = rows.find((e) => e.id === "worker-ws");
    expect(leaderRow.state).toEqual({
      activeFile: "/mnt/leader/init.ts",
      openEditors: ["/mnt/leader/init.ts"],
    });
    expect(workerRow.state).toEqual({ openEditors: ["/mnt/worker/a.ts"] });
  });

  it("defaults state to empty openEditors when not provided", async () => {
    const socket = net.createConnection(ipcPath);
    const msgs: IpcMessage[] = [];
    const decode = createDecoder((m) => msgs.push(m));
    socket.on("data", (c: Buffer) => decode(c));
    socket.on("error", () => {});
    await new Promise<void>((resolve) => {
      socket.on("connect", () => {
        socket.write(
          encodeMessage({
            type: MSG.REGISTER,
            id: "bare-ws",
            workspacePaths: [],
            displayName: "Bare",
          }),
        );
        resolve();
      });
    });
    await vi.waitFor(() => expect(msgs.some((m) => m.type === MSG.WELCOME)).toBe(true), {
      timeout: 3000,
    });
    const rows = await listRows();
    const bare = rows.find((e) => e.id === "bare-ws");
    expect(bare.state).toEqual({ openEditors: [] });
    socket.destroy();
  }, 10_000);

  it("propagates worker state updates via MSG.UPDATE", async () => {
    worker.updateState({ activeFile: "/mnt/worker/b.ts", openEditors: ["/mnt/worker/b.ts"] });
    await vi.waitFor(
      () => {
        return listRows().then((rows) => {
          const workerRow = rows.find((e) => e.id === "worker-ws");
          expect(workerRow.state).toEqual({
            activeFile: "/mnt/worker/b.ts",
            openEditors: ["/mnt/worker/b.ts"],
          });
        });
      },
      { timeout: 3000 },
    );
  }, 10_000);

  it("ignores state updates from an unregistered socket", async () => {
    const socket = net.createConnection(ipcPath);
    socket.on("error", () => {});
    await new Promise<void>((resolve) => {
      socket.on("connect", () => resolve());
    });
    // No REGISTER: MSG.UPDATE must be dropped, not crash the leader.
    socket.write(encodeMessage({ type: MSG.UPDATE, state: { openEditors: ["/x/y.ts"] } }));
    await new Promise((r) => setTimeout(r, 300));
    const rows = await listRows();
    expect(rows.find((e) => e.id === "worker-ws").state).toEqual({
      openEditors: ["/mnt/worker/a.ts"],
    });
    socket.destroy();
  }, 10_000);

  it("lets the leader publish its own window state", async () => {
    leader.updateState({ activeFile: "/mnt/leader/next.ts", openEditors: ["/mnt/leader/next.ts"] });
    const rows = await listRows();
    expect(rows.find((e) => e.id === "leader-ws").state).toEqual({
      activeFile: "/mnt/leader/next.ts",
      openEditors: ["/mnt/leader/next.ts"],
    });
  });

  it("sanitizes malformed worker state on the wire", async () => {
    const socket = net.createConnection(ipcPath);
    const msgs: IpcMessage[] = [];
    const decode = createDecoder((m) => msgs.push(m));
    socket.on("data", (c: Buffer) => decode(c));
    socket.on("error", () => {});
    await new Promise<void>((resolve) => {
      socket.on("connect", () => {
        socket.write(
          encodeMessage({
            type: MSG.REGISTER,
            id: "dirty-ws",
            workspacePaths: [],
            displayName: "Dirty",
            state: { activeFile: 42, openEditors: ["/ok.ts", 7] },
          }),
        );
        resolve();
      });
    });
    await vi.waitFor(() => expect(msgs.some((m) => m.type === MSG.WELCOME)).toBe(true), {
      timeout: 3000,
    });
    const rows = await listRows();
    const dirty = rows.find((e) => e.id === "dirty-ws");
    expect(dirty.state).toEqual({ openEditors: ["/ok.ts"] });
    socket.destroy();
  }, 10_000);
});

// ── End-to-end bootstrap ─────────────────────────────────────────────

describe("cluster bootstrap", () => {
  it("promotes a single window to leader and serves the port", async () => {
    const port = await findFreePort();
    const ipcPath = findFreeIpcPath();
    const exec = new ToolExecutor();
    exec.registerTool(makeTool("echo", (a) => `local: ${a.msg ?? ""}`));

    const member = await bootstrapCluster({
      basePort: port,
      host: "127.0.0.1",
      ipcPath,
      executor: exec,
      workspaceId: "ws-a",
      workspacePaths: ["/mnt/a"],
      displayName: "Window A",
    });

    expect(member.role).toBe("leader");
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { msg: "hi" } },
    });
    expect(res.body.result.content[0].text).toBe("local: hi");
    await member.stop(500);
    if (process.platform !== "win32") {
      expect(fs.existsSync(ipcPath)).toBe(false);
    }
  });

  it("joins an existing leader as a worker", async () => {
    const port = await findFreePort();
    const ipcPath = findFreeIpcPath();
    const leaderExec = new ToolExecutor();
    leaderExec.registerTool(makeTool("echo", (a) => `leader: ${a.msg ?? ""}`));
    const leader = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
      ipcPath,
      executor: leaderExec,
      workspaceId: "m1",
      workspacePaths: ["/mnt/m"],
      displayName: "M",
    });
    await leader.start();

    const workerExec = new ToolExecutor();
    workerExec.registerTool(makeTool("echo", (a) => `worker: ${a.msg ?? ""}`));
    const worker = await bootstrapCluster({
      basePort: port,
      host: "127.0.0.1",
      ipcPath,
      executor: workerExec,
      workspaceId: "w1",
      workspacePaths: ["/mnt/w"],
      displayName: "W",
    });

    expect(worker.role).toBe("worker");
    const res = await post(`http://127.0.0.1:${port}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { msg: "hi" }, workspace: "w1" },
    });
    expect(res.body.result.content[0].text).toBe("worker: hi");
    await worker.stop(500);
    await leader.stop(500);
  });

  it("does not promote to the next port when a valid leader rejects the join", async () => {
    const port = await findFreePort();
    const ipcPath = findFreeIpcPath();
    const logs: string[] = [];

    // Fake "valid" leader: answers /health with our service signature, but
    // its IPC pipe destroys every connection, so the join handshake always
    // fails. Split-brain repro: the old code advanced to the next port and
    // promoted, fragmenting the cluster into two leaders.
    const httpServer = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ service: HEALTH_SERVICE }));
    });
    await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
    const ipcServer = net.createServer((socket) => {
      setImmediate(() => socket.destroy()); // REGISTER dies immediately
    });
    await new Promise<void>((resolve) => ipcServer.listen(ipcPath, resolve));

    try {
      await expect(
        bootstrapCluster({
          basePort: port,
          host: "127.0.0.1",
          ipcPath,
          executor: new ToolExecutor(),
          workspaceId: "ws-join-fail",
          workspacePaths: ["/mnt/join-fail"],
          displayName: "Join Fail",
          log: (m) => logs.push(m),
        }),
      ).rejects.toThrow(/Could not elect or join/);

      // Every attempt must target the live leader's port — never a
      // promotion on a higher port.
      expect(logs.filter((l) => l.includes("Promoted to leader"))).toHaveLength(0);
      expect(logs.some((l) => l.includes(`Join on port ${port} failed`))).toBe(true);

      // And the next port was never bound for promotion.
      const nextPortFree = await new Promise<boolean>((resolve) => {
        const srv = http.createServer();
        srv.once("error", () => resolve(false));
        srv.listen(port + 1, "127.0.0.1", () => srv.close(() => resolve(true)));
      });
      expect(nextPortFree).toBe(true);
    } finally {
      await new Promise<void>((resolve) => ipcServer.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      try {
        fs.unlinkSync(ipcPath);
      } catch {
        /* already gone */
      }
    }
  }, 10_000);

  it("a second leader cannot steal a live leader's IPC socket", async () => {
    const port = await findFreePort();
    const ipcPath = findFreeIpcPath();
    const exec1 = new ToolExecutor();
    exec1.registerTool(makeTool("echo", (a) => `m1: ${a.msg ?? ""}`));
    const leader1 = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
      ipcPath,
      executor: exec1,
      workspaceId: "m1",
      workspacePaths: ["/mnt/m1"],
      displayName: "M1",
    });
    await leader1.start();

    const exec2 = new ToolExecutor();
    exec2.registerTool(makeTool("echo", (a) => `m2: ${a.msg ?? ""}`));
    const leader2 = new LeaderCoordinator({
      port: port + 1,
      host: "127.0.0.1",
      ipcPath, // same path — a promoting window must NOT steal it
      executor: exec2,
      workspaceId: "m2",
      workspacePaths: ["/mnt/m2"],
      displayName: "M2",
    });

    let worker: WorkerCoordinator | null = null;
    try {
      await expect(leader2.start()).rejects.toThrow();

      // The live leader's pipe must still serve workers normally.
      worker = new WorkerCoordinator({
        ipcPath,
        executor: exec1,
        workspaceId: "w1",
        workspacePaths: ["/mnt/w"],
        displayName: "W",
      });
      await worker.start();
      expect(fs.existsSync(ipcPath)).toBe(true);
    } finally {
      if (worker) await worker.stop(300).catch(() => {});
      await leader2.stop(300).catch(() => {});
      await leader1.stop(500).catch(() => {});
      try {
        fs.unlinkSync(ipcPath);
      } catch {
        /* already gone */
      }
    }
  });
});

// ── Wire-level instance identity ────────────────────────────────────

describe("wire-level instance identity", () => {
  const LEADER_INSTANCE = "11111111-1111-1111-1111-111111111111";
  const WORKER_INSTANCE = "22222222-2222-2222-2222-222222222222";
  let port: number;
  let ipcPath: string;
  let leader: LeaderCoordinator;
  let worker: WorkerCoordinator;
  let leaderExec: ToolExecutor;
  let workerExec: ToolExecutor;
  let lostReasons: string[];

  beforeEach(async () => {
    port = await findFreePort();
    ipcPath = findFreeIpcPath();
    lostReasons = [];

    // Mirrors extension.ts: the shared executor carries the window identity,
    // so initialize serverInfo reports it through the Leader's HTTP server.
    leaderExec = new ToolExecutor({ instanceId: LEADER_INSTANCE, instanceName: "Leader Instance" });
    leaderExec.registerTool(makeTool("echo", (a) => `echo from leader: ${a.msg ?? ""}`));
    workerExec = new ToolExecutor();
    workerExec.registerTool(makeTool("echo", (a) => `echo from worker: ${a.msg ?? ""}`));

    leader = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
      ipcPath,
      executor: leaderExec,
      workspaceId: "leader-ws",
      workspacePaths: ["/mnt/leader"],
      displayName: "Leader Window",
      instanceId: LEADER_INSTANCE,
      instanceName: "Leader Instance",
    });
    await leader.start();

    worker = new WorkerCoordinator({
      ipcPath,
      executor: workerExec,
      workspaceId: "worker-ws",
      workspacePaths: ["/mnt/worker"],
      displayName: "Worker Window",
      instanceId: WORKER_INSTANCE,
      instanceName: "Worker Instance",
    });
    worker.setOnLostLeader((reason) => lostReasons.push(reason));
    await worker.start();
  });

  afterEach(async () => {
    if (worker) await worker.stop(500).catch(() => {});
    if (leader) await leader.stop(1000).catch(() => {});
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(ipcPath);
      } catch {
        /* already gone */
      }
    }
  });

  const url = () => `http://127.0.0.1:${port}/mcp`;

  function toolCall(name: string, args: Record<string, unknown>, extra?: Record<string, unknown>) {
    return post(url(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args, ...extra },
    });
  }

  it("reports instanceId/instanceName in initialize serverInfo", async () => {
    const res = await post(url(), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    });
    expect(res.body.result.serverInfo.name).toBeTruthy();
    expect(res.body.result.serverInfo.instanceId).toBe(LEADER_INSTANCE);
    expect(res.body.result.serverInfo.instanceName).toBe("Leader Instance");
  });

  it("surfaces instanceId/instanceName in list_workspaces rows", async () => {
    const res = await toolCall("list_workspaces", {});
    const parsed = JSON.parse(res.body.result.content[0].text) as WorkspaceRow[];
    const leaderRow = parsed.find((e) => e.id === "leader-ws");
    const workerRow = parsed.find((e) => e.id === "worker-ws");
    expect(leaderRow.instanceId).toBe(LEADER_INSTANCE);
    expect(leaderRow.instanceName).toBe("Leader Instance");
    expect(workerRow.instanceId).toBe(WORKER_INSTANCE);
    expect(workerRow.instanceName).toBe("Worker Instance");
  });

  it("routes tools/call by instanceId", async () => {
    const toWorker = await toolCall("echo", { msg: "hi" }, { workspace: WORKER_INSTANCE });
    expect(toWorker.body.result.content[0].text).toBe("echo from worker: hi");

    const toLeader = await toolCall("echo", { msg: "hi" }, { workspace: LEADER_INSTANCE });
    expect(toLeader.body.result.content[0].text).toBe("echo from leader: hi");
  });

  it("routes tools/list by instanceId", async () => {
    const res = await post(url(), {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: { workspace: WORKER_INSTANCE },
    });
    const names = res.body.result.tools.map((t) => t.name);
    expect(names).toContain("echo");
    // Worker list must NOT include leader-only list_workspaces.
    expect(names).not.toContain("list_workspaces");
  });
});
