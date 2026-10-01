import * as http from "node:http";
import * as net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapCluster } from "../mcp/cluster/bootstrap";
import {
  CLUSTER_MESSAGE_PATH,
  CLUSTER_STREAM_PATH,
  HEALTH_SERVICE,
  MSG,
} from "../mcp/cluster/constants";
import { probeHost, probePort } from "../mcp/cluster/election";
import { LeaderCoordinator } from "../mcp/cluster/leader";
import { HttpMemberTransport } from "../mcp/cluster/memberTransport";
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

// ── HTTP member-channel helpers (issue #94) ─────────────────────────

/** Open the worker-side SSE receive leg for a session; resolves with headers. */
function openMemberStream(port: number, sessionId: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `http://127.0.0.1:${port}${CLUSTER_STREAM_PATH}?id=${encodeURIComponent(sessionId)}`,
      (res) => resolve(res),
    );
    req.on("error", reject);
  });
}

/** Resolve with the first `data:` payload of an SSE stream, then close it. */
function readSseEvent(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    res.on("data", (c: Buffer) => {
      buffer += c.toString("utf-8");
      let idx = buffer.indexOf("\n\n");
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
        if (dataLine) {
          resolve(dataLine.slice(5).trim());
          res.destroy();
          return;
        }
        // Comment-only block (e.g. ": connected") — skip and keep reading.
        idx = buffer.indexOf("\n\n");
      }
    });
    res.on("error", reject);
    res.on("end", () => reject(new Error("stream ended before an event")));
  });
}

/** Minimal HTTP request that resolves with the status code. */
function rawRequest(url: string, method: "GET" | "POST", body?: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      url,
      {
        method,
        ...(data !== undefined
          ? {
              headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(data),
              },
            }
          : {}),
      },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

// ── Port probing ─────────────────────────────────────────────────────

describe("cluster port probing", () => {
  it("probePort returns valid for a live MCP server", async () => {
    const port = await findFreePort();
    const srv = new McpServer({ port, host: "127.0.0.1" });
    await srv.start();
    try {
      const probe = await probePort(port);
      expect(probe.status).toBe("valid");
    } finally {
      await srv.stop(1000);
    }
  });

  it("probePort returns free for an unbound port", async () => {
    const port = await findFreePort();
    const probe = await probePort(port);
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
      const probe = await probePort(port);
      expect(probe.status).toBe("foreign");
    } finally {
      srv.close();
    }
  });

  it("probePort returns timeout for a silent port", async () => {
    const port = await findFreePort();
    // A TCP server that accepts but never answers HTTP → health probe times out.
    const silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(port, "127.0.0.1", resolve));
    try {
      const probe = await probePort(port);
      expect(probe.status).toBe("timeout");
    } finally {
      silent.close();
    }
  }, 10_000);

  it("probeHost returns valid for a live MCP server", async () => {
    const port = await findFreePort();
    const srv = new McpServer({ port, host: "127.0.0.1" });
    await srv.start();
    try {
      expect(await probeHost(port, "127.0.0.1")).toEqual({ status: "valid" });
    } finally {
      await srv.stop(1000);
    }
  });

  it("probeHost returns free for an unbound port", async () => {
    const port = await findFreePort();
    expect(await probeHost(port, "127.0.0.1")).toEqual({ status: "free" });
  });

  it("probeHost returns foreign for an occupied non-MCP HTTP server", async () => {
    const port = await findFreePort();
    const srv = http.createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "nothing here" }));
    });
    await new Promise<void>((resolve) => srv.listen(port, "127.0.0.1", resolve));
    try {
      expect(await probeHost(port, "127.0.0.1")).toEqual({ status: "foreign" });
    } finally {
      srv.close();
    }
  });

  it("probeHost returns timeout for a silent port", async () => {
    const port = await findFreePort();
    const silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(port, "127.0.0.1", resolve));
    try {
      expect(await probeHost(port, "127.0.0.1")).toEqual({ status: "timeout" });
    } finally {
      silent.close();
    }
  }, 10_000);
});

// ── Leader + Worker integration ──────────────────────────────────────

describe("leader constructor auth (C1)", () => {
  const base = () => ({
    port: 0,
    executor: new ToolExecutor(),
    workspaceId: "w",
    workspacePaths: ["/tmp"],
    displayName: "W",
  });

  it("throws when the bind host is non-loopback and no authToken is set", () => {
    expect(() => new LeaderCoordinator({ ...base(), host: "0.0.0.0" })).toThrow(
      /non-loopback bind/,
    );
  });

  it("throws when hosts contain a non-loopback address and no authToken is set", () => {
    expect(
      () => new LeaderCoordinator({ ...base(), host: "127.0.0.1", hosts: ["192.168.1.10"] }),
    ).toThrow(/non-loopback bind/);
  });

  it("allows a non-loopback bind when an authToken is set", () => {
    const leader = new LeaderCoordinator({ ...base(), host: "0.0.0.0", authToken: "t" });
    expect(leader).toBeInstanceOf(LeaderCoordinator);
  });

  it("allows loopback-only binds without an authToken", () => {
    const leader = new LeaderCoordinator({ ...base(), host: "127.0.0.1" });
    expect(leader).toBeInstanceOf(LeaderCoordinator);
  });
});

describe("leader-worker cluster", () => {
  let port: number;
  let leader: LeaderCoordinator;
  let worker: WorkerCoordinator;
  let leaderExec: ToolExecutor;
  let workerExec: ToolExecutor;
  let lostReasons: string[];

  beforeEach(async () => {
    port = await findFreePort();
    lostReasons = [];

    leaderExec = new ToolExecutor();
    leaderExec.registerTool(makeTool("echo", (a) => `echo from leader: ${a.msg ?? ""}`));
    workerExec = new ToolExecutor();
    workerExec.registerTool(makeTool("echo", (a) => `echo from worker: ${a.msg ?? ""}`));
    workerExec.registerTool(makeTool("whoami_worker", () => "worker"));

    leader = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
      executor: leaderExec,
      workspaceId: "leader-ws",
      workspacePaths: ["/mnt/leader"],
      displayName: "Leader Window",
    });
    await leader.start();

    worker = new WorkerCoordinator({
      transport: new HttpMemberTransport({ baseUrl: `http://127.0.0.1:${port}` }),
      executor: workerExec,
      workspaceId: "worker-ws",
      workspacePaths: ["/mnt/worker"],
      displayName: "Worker Window",
      instanceId: "worker-inst",
    });
    worker.setOnLostLeader((reason) => lostReasons.push(reason));
    await worker.start();
  });

  afterEach(async () => {
    if (worker) await worker.stop(500).catch(() => {});
    if (leader) await leader.stop(1000).catch(() => {});
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

  it("routes to the worker by basename-prefix inference on path-like args", async () => {
    const res = await toolCall("echo", { path: "worker/src/main.ts", msg: "x" });
    expect(res.body.result.content[0].text).toBe("echo from worker: x");
  });

  it("routes calls to a worker via a workspaceFolder argument (basename)", async () => {
    const res = await toolCall("echo", { workspaceFolder: "worker", msg: "hi" });
    expect(res.body.result.content[0].text).toBe("echo from worker: hi");
  });

  it("routes calls to a worker via a workspaceFolder argument (full path)", async () => {
    const res = await toolCall("echo", { workspaceFolder: "/mnt/worker", msg: "hi" });
    expect(res.body.result.content[0].text).toBe("echo from worker: hi");
  });

  it("routes calls to a worker via a workspaceFolder argument (display name)", async () => {
    const res = await toolCall("echo", { workspaceFolder: "Worker Window", msg: "hi" });
    expect(res.body.result.content[0].text).toBe("echo from worker: hi");
  });

  it("routes calls to a worker via a workspaceFolder argument (instance id)", async () => {
    const res = await toolCall("echo", { workspaceFolder: "worker-inst", msg: "hi" });
    expect(res.body.result.content[0].text).toBe("echo from worker: hi");
  });

  it("keeps workspaceFolder targeting the leader's own folder local", async () => {
    const res = await toolCall("echo", { workspaceFolder: "leader", msg: "hi" });
    expect(res.body.result.content[0].text).toBe("echo from leader: hi");
  });

  it("falls through to the leader for an unknown workspaceFolder argument", async () => {
    const res = await toolCall("echo", { workspaceFolder: "nope", msg: "hi" });
    expect(res.body.result.content[0].text).toBe("echo from leader: hi");
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

  it("fires the lost-leader handler when the leader goes away", async () => {
    await leader.stop(500);
    await vi.waitFor(() => expect(lostReasons.length).toBeGreaterThan(0), { timeout: 3000 });
  });
});

// ── HTTP member channel cluster (issue #94) ─────────────────────────
// A worker joined over the SSE/POST member channel behaves like a native
// member: REGISTER/WELCOME, CALL/RESULT, PING/PONG, UPDATE, failover.

describe("HTTP member channel cluster", () => {
  let port: number;
  let leader: LeaderCoordinator;
  let worker: WorkerCoordinator;
  let leaderExec: ToolExecutor;
  let workerExec: ToolExecutor;
  let lostReasons: string[];
  let logs: string[];

  beforeEach(async () => {
    port = await findFreePort();
    lostReasons = [];
    logs = [];

    leaderExec = new ToolExecutor();
    leaderExec.registerTool(makeTool("echo", (a) => `echo from leader: ${a.msg ?? ""}`));
    workerExec = new ToolExecutor();
    workerExec.registerTool(makeTool("echo", (a) => `echo from worker: ${a.msg ?? ""}`));
    workerExec.registerTool(makeTool("whoami_worker", () => "worker"));

    leader = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
      executor: leaderExec,
      workspaceId: "leader-ws",
      workspacePaths: ["/mnt/leader"],
      displayName: "Leader Window",
      log: (m) => logs.push(m),
    });
    await leader.start();

    worker = new WorkerCoordinator({
      transport: new HttpMemberTransport({
        baseUrl: `http://127.0.0.1:${port}`,
        log: (m) => logs.push(m),
      }),
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

  it("registers the worker over the HTTP member channel", async () => {
    const res = await toolCall("list_workspaces", {});
    const parsed = JSON.parse(res.body.result.content[0].text) as WorkspaceRow[];
    const ids = parsed.map((e) => e.id).sort();
    expect(ids).toEqual(["leader-ws", "worker-ws"]);
    const workerEntry = parsed.find((e) => e.id === "worker-ws");
    expect(workerEntry?.displayName).toBe("Worker Window");
  });

  it("routes a call to the HTTP worker and ships the result back", async () => {
    const res = await toolCall("echo", { msg: "hi" }, { workspace: "worker-ws" });
    expect(res.status).toBe(200);
    expect(res.body.result.content[0].text).toBe("echo from worker: hi");
  });

  it("keeps leader-local calls local when a worker is over HTTP", async () => {
    const res = await toolCall("echo", { msg: "hi" }, { workspace: "leader-ws" });
    expect(res.body.result.content[0].text).toBe("echo from leader: hi");
  });

  it("propagates window-state updates over the member channel", async () => {
    worker.updateState({
      activeFile: "/mnt/worker/src/main.ts",
      openEditors: ["/mnt/worker/src/main.ts"],
    });
    await vi.waitFor(
      async () => {
        const res = await toolCall("list_workspaces", {});
        const parsed = JSON.parse(res.body.result.content[0].text) as WorkspaceRow[];
        const workerEntry = parsed.find((e) => e.id === "worker-ws");
        expect(workerEntry?.state.activeFile).toBe("/mnt/worker/src/main.ts");
      },
      { timeout: 3000 },
    );
  });

  it("answers PING with PONG on the raw member channel", async () => {
    const sessionId = "sess-raw-ping";
    const stream = await openMemberStream(port, sessionId);
    try {
      const pongPromise = readSseEvent(stream);
      const status = await rawRequest(
        `http://127.0.0.1:${port}${CLUSTER_MESSAGE_PATH}?id=${sessionId}`,
        "POST",
        { type: MSG.PING },
      );
      expect(status).toBe(202);
      const data = await pongPromise;
      expect(JSON.parse(data)).toMatchObject({ type: MSG.PONG });
    } finally {
      stream.destroy();
    }
  }, 10_000);

  it("fires the lost-leader handler when the leader stops (SSE closes)", async () => {
    await leader.stop(500);
    await vi.waitFor(() => expect(lostReasons.length).toBeGreaterThan(0), { timeout: 3000 });
  });
});

// ── Member channel HTTP guards (issue #94) ──────────────────────────
// The two /cluster routes mount only when the Leader opts in via
// memberChannel, and are guarded like the rest of the server: origin
// checks, bearer auth, session id, body cap.

describe("member channel HTTP guards", () => {
  it("returns 404 for the member channel when the server has no memberChannel", async () => {
    const port = await findFreePort();
    const srv = new McpServer({ port, host: "127.0.0.1" });
    await srv.start();
    try {
      expect(await rawRequest(`http://127.0.0.1:${port}${CLUSTER_STREAM_PATH}?id=x`, "GET")).toBe(
        404,
      );
      expect(
        await rawRequest(`http://127.0.0.1:${port}${CLUSTER_MESSAGE_PATH}?id=x`, "POST", {
          type: MSG.PING,
        }),
      ).toBe(404);
    } finally {
      await srv.stop(1000);
    }
  });

  it("rejects member requests without a session id", async () => {
    const port = await findFreePort();
    const leader = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
      executor: new ToolExecutor(),
      workspaceId: "l",
      workspacePaths: ["/mnt/l"],
      displayName: "L",
    });
    await leader.start();
    try {
      expect(await rawRequest(`http://127.0.0.1:${port}${CLUSTER_STREAM_PATH}`, "GET")).toBe(400);
      expect(
        await rawRequest(`http://127.0.0.1:${port}${CLUSTER_MESSAGE_PATH}`, "POST", {
          type: MSG.PING,
        }),
      ).toBe(400);
    } finally {
      await leader.stop(500);
    }
  });

  it("returns 404 for a POST to an unknown member session", async () => {
    const port = await findFreePort();
    const leader = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
      executor: new ToolExecutor(),
      workspaceId: "l",
      workspacePaths: ["/mnt/l"],
      displayName: "L",
    });
    await leader.start();
    try {
      expect(
        await rawRequest(
          `http://127.0.0.1:${port}${CLUSTER_MESSAGE_PATH}?id=never-registered`,
          "POST",
          { type: MSG.PING },
        ),
      ).toBe(404);
    } finally {
      await leader.stop(500);
    }
  });

  it("rejects an oversized member POST body with 413", async () => {
    const port = await findFreePort();
    const leader = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
      executor: new ToolExecutor(),
      workspaceId: "l",
      workspacePaths: ["/mnt/l"],
      displayName: "L",
    });
    await leader.start();
    try {
      const big = { type: MSG.PING, pad: "x".repeat(11 * 1024 * 1024) };
      expect(
        await rawRequest(
          `http://127.0.0.1:${port}${CLUSTER_MESSAGE_PATH}?id=whatever`,
          "POST",
          big,
        ),
      ).toBe(413);
    } finally {
      await leader.stop(500);
    }
  }, 15_000);

  it("rejects member requests from a browser origin (DNS-rebinding guard)", async () => {
    const port = await findFreePort();
    const leader = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
      executor: new ToolExecutor(),
      workspaceId: "l",
      workspacePaths: ["/mnt/l"],
      displayName: "L",
    });
    await leader.start();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.get(
          {
            host: "127.0.0.1",
            port,
            path: `${CLUSTER_STREAM_PATH}?id=x`,
            headers: { Origin: "http://evil.example" },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
      });
      expect(status).toBe(403);
    } finally {
      await leader.stop(500);
    }
  });
});

// ── Window state descriptor (issue #76) ─────────────────────────────

describe("window state descriptor", () => {
  let port: number;
  let leader: LeaderCoordinator;
  let worker: WorkerCoordinator;
  let leaderExec: ToolExecutor;
  let workerExec: ToolExecutor;

  beforeEach(async () => {
    port = await findFreePort();

    leaderExec = new ToolExecutor();
    leaderExec.registerTool(makeTool("echo", (a) => `echo from leader: ${a.msg ?? ""}`));
    workerExec = new ToolExecutor();
    workerExec.registerTool(makeTool("echo", (a) => `echo from worker: ${a.msg ?? ""}`));

    leader = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
      executor: leaderExec,
      workspaceId: "leader-ws",
      workspacePaths: ["/mnt/leader"],
      displayName: "Leader Window",
      state: { activeFile: "/mnt/leader/init.ts", openEditors: ["/mnt/leader/init.ts"] },
    });
    await leader.start();

    worker = new WorkerCoordinator({
      transport: new HttpMemberTransport({ baseUrl: `http://127.0.0.1:${port}` }),
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
    const sessionId = "bare-sess";
    const stream = await openMemberStream(port, sessionId);
    try {
      const welcomePromise = readSseEvent(stream);
      const status = await rawRequest(
        `http://127.0.0.1:${port}${CLUSTER_MESSAGE_PATH}?id=${sessionId}`,
        "POST",
        { type: MSG.REGISTER, id: "bare-ws", workspacePaths: [], displayName: "Bare" },
      );
      expect(status).toBe(202);
      const data = await welcomePromise;
      expect(JSON.parse(data)).toMatchObject({ type: MSG.WELCOME });
      const rows = await listRows();
      const bare = rows.find((e) => e.id === "bare-ws");
      expect(bare.state).toEqual({ openEditors: [] });
    } finally {
      stream.destroy();
    }
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

  it("ignores state updates from an unregistered session", async () => {
    // No REGISTER for this session: the leader has no peer for it, the POST
    // 404s, and the worker's stored state is untouched.
    const status = await rawRequest(
      `http://127.0.0.1:${port}${CLUSTER_MESSAGE_PATH}?id=ghost`,
      "POST",
      { type: MSG.UPDATE, state: { openEditors: ["/x/y.ts"] } },
    );
    expect(status).toBe(404);
    const rows = await listRows();
    expect(rows.find((e) => e.id === "worker-ws").state).toEqual({
      openEditors: ["/mnt/worker/a.ts"],
    });
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
    const sessionId = "dirty-sess";
    const stream = await openMemberStream(port, sessionId);
    try {
      const welcomePromise = readSseEvent(stream);
      const status = await rawRequest(
        `http://127.0.0.1:${port}${CLUSTER_MESSAGE_PATH}?id=${sessionId}`,
        "POST",
        {
          type: MSG.REGISTER,
          id: "dirty-ws",
          workspacePaths: [],
          displayName: "Dirty",
          state: { activeFile: 42, openEditors: ["/ok.ts", 7] },
        },
      );
      expect(status).toBe(202);
      await welcomePromise;
      const rows = await listRows();
      const dirty = rows.find((e) => e.id === "dirty-ws");
      expect(dirty.state).toEqual({ openEditors: ["/ok.ts"] });
    } finally {
      stream.destroy();
    }
  }, 10_000);
});

// ── End-to-end bootstrap ─────────────────────────────────────────────

describe("cluster bootstrap", () => {
  it("promotes a single window to leader and serves the port", async () => {
    const port = await findFreePort();
    const exec = new ToolExecutor();
    exec.registerTool(makeTool("echo", (a) => `local: ${a.msg ?? ""}`));

    const member = await bootstrapCluster({
      basePort: port,
      host: "127.0.0.1",
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
  });

  it("joins an existing leader as a worker", async () => {
    const port = await findFreePort();
    const leaderExec = new ToolExecutor();
    leaderExec.registerTool(makeTool("echo", (a) => `leader: ${a.msg ?? ""}`));
    const leader = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
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

  it("joins a leader in another namespace via crossBoundaryHosts", async () => {
    // The leader lives on a second loopback address ("the host"). The
    // bootstrap window probes 127.0.0.1 (free), then the cross-boundary host,
    // and joins over the HTTP member channel instead of promoting — the
    // container→host.docker.internal scenario.
    const port = await findFreePort();
    // IPv6 loopback as the "other namespace" address: always bindable without
    // root, unlike 127.x aliases on macOS. Bracket it in URLs per RFC 3986.
    const hostIp = "::1";
    const origin = `http://[${hostIp}]:${port}`;
    const leaderExec = new ToolExecutor();
    leaderExec.registerTool(makeTool("echo", (a) => `host leader: ${a.msg ?? ""}`));
    const leader = new LeaderCoordinator({
      port,
      host: hostIp,
      executor: leaderExec,
      workspaceId: "host-leader",
      workspacePaths: ["/mnt/host"],
      displayName: "Host Leader",
    });
    await leader.start();

    const workerExec = new ToolExecutor();
    workerExec.registerTool(makeTool("echo", (a) => `container worker: ${a.msg ?? ""}`));
    const worker = await bootstrapCluster({
      basePort: port,
      host: "127.0.0.1",
      crossBoundaryHosts: [hostIp],
      executor: workerExec,
      workspaceId: "container-w",
      workspacePaths: ["/mnt/container"],
      displayName: "Container W",
    });

    expect(worker.role).toBe("worker");
    const res = await post(`${origin}/mcp`, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "echo", arguments: { msg: "hi" }, workspace: "container-w" },
    });
    expect(res.body.result.content[0].text).toBe("container worker: hi");
    await worker.stop(500);
    await leader.stop(500);
  });

  it("promotes locally after cross-boundary hosts time out (container with no host leader)", async () => {
    // Container-alone repro: local port free, but every cross-boundary probe
    // times out — Docker Desktop's VM gateway silently drops SYNs to
    // unforwarded ports, so the "host" looks occupied but silent forever.
    // The bootstrap must wait a bounded patience window (frozen-leader
    // safety) and then promote locally instead of retrying the same port
    // until MAX_ELECTION_ATTEMPTS and dying without a leader.
    const port = await findFreePort();
    const logs: string[] = [];
    const silentConns = new Set<net.Socket>();

    // Silent TCP listener on the "host" namespace (::1): accepts but never
    // answers /health → probeHost reports timeout, like the VM gateway.
    // Connections are tracked so the listener can be torn down: accepted-but-
    // unread sockets keep close() waiting forever otherwise.
    const silentHost = net.createServer((sock) => {
      silentConns.add(sock);
      sock.on("close", () => silentConns.delete(sock));
    });
    await new Promise<void>((resolve) => silentHost.listen(port, "::1", resolve));

    const exec = new ToolExecutor();
    exec.registerTool(makeTool("echo", (a) => `local: ${a.msg ?? ""}`));

    try {
      const member = await bootstrapCluster({
        basePort: port,
        host: "127.0.0.1",
        crossBoundaryHosts: ["::1"],
        executor: exec,
        workspaceId: "ws-alone",
        workspacePaths: ["/mnt/alone"],
        displayName: "Window Alone",
        log: (m) => logs.push(m),
      });

      expect(member.role).toBe("leader");
      await member.stop(500);
      // It waited the bounded patience window (did not promote on the first
      // timeout — a frozen host leader must get its chance)...
      expect(logs.filter((l) => l.includes("retrying same port")).length).toBeGreaterThan(0);
      // ...then fell through to local promotion.
      expect(logs.some((l) => l.includes("promoting locally"))).toBe(true);
    } finally {
      for (const sock of silentConns) sock.destroy();
      await new Promise<void>((resolve) => silentHost.close(() => resolve()));
    }
  }, 30_000);

  it("does not promote to the next port when a valid leader rejects the join", async () => {
    const port = await findFreePort();
    const logs: string[] = [];

    // Fake "valid" leader: answers /health with our service signature but
    // serves no member channel, so the HTTP join handshake always fails.
    // Split-brain repro: the old code advanced to the next port and
    // promoted, fragmenting the cluster into two leaders.
    const httpServer = http.createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ service: HEALTH_SERVICE }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "no member channel" }));
    });
    await new Promise<void>((resolve) => httpServer.listen(port, "127.0.0.1", resolve));

    try {
      await expect(
        bootstrapCluster({
          basePort: port,
          host: "127.0.0.1",
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
      expect(logs.some((l) => l.includes(`HTTP join on 127.0.0.1:${port} failed`))).toBe(true);

      // And the next port was never bound for promotion.
      const nextPortFree = await new Promise<boolean>((resolve) => {
        const srv = http.createServer();
        srv.once("error", () => resolve(false));
        srv.listen(port + 1, "127.0.0.1", () => srv.close(() => resolve(true)));
      });
      expect(nextPortFree).toBe(true);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }, 10_000);
});

// ── Wire-level instance identity ────────────────────────────────────

describe("wire-level instance identity", () => {
  const LEADER_INSTANCE = "11111111-1111-1111-1111-111111111111";
  const WORKER_INSTANCE = "22222222-2222-2222-2222-222222222222";
  let port: number;
  let leader: LeaderCoordinator;
  let worker: WorkerCoordinator;
  let leaderExec: ToolExecutor;
  let workerExec: ToolExecutor;
  let lostReasons: string[];

  beforeEach(async () => {
    port = await findFreePort();
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
      executor: leaderExec,
      workspaceId: "leader-ws",
      workspacePaths: ["/mnt/leader"],
      displayName: "Leader Window",
      instanceId: LEADER_INSTANCE,
      instanceName: "Leader Instance",
    });
    await leader.start();

    worker = new WorkerCoordinator({
      transport: new HttpMemberTransport({ baseUrl: `http://127.0.0.1:${port}` }),
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
