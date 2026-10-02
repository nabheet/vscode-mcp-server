/**
 * Cluster robustness + security regression tests.
 *
 * Covers the gaps flagged in review of the cluster-auth PR:
 *  - W1: a thawed leader must not self-join its own server (self-registration guard)
 *  - N1: member-POST retry semantics (5xx retried, 4xx terminal, stop short-circuits)
 *  - N2: worker heartbeat miss counting (one PING in flight; PONG resets; failover at limit)
 *  - N3: bearer auth on the SSE session-message route
 *  - N4: stop() returns promptly with an open SSE session
 *  - N5: member-peer cap rejects with 503 and frees the slot on stream close
 *  - M1: silently-occupied port is retried within the window, then treated as foreign
 *  - squatter classification: a foreign HTTP server is skipped, not wedged on
 */
import * as http from "node:http";
import * as net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapCluster, resetElectionPatience } from "../mcp/cluster/bootstrap";
import { CLUSTER_MESSAGE_PATH, CLUSTER_STREAM_PATH, MSG } from "../mcp/cluster/constants";
import { LeaderCoordinator } from "../mcp/cluster/leader";
import { HttpMemberTransport, type MemberTransport } from "../mcp/cluster/memberTransport";
import type { IpcMessage } from "../mcp/cluster/protocol";
import { WorkerCoordinator } from "../mcp/cluster/worker";
import { ToolExecutor } from "../mcp/executor";
import { McpServer } from "../mcp/server";

// Collapse the cluster timings this suite exercises: a tiny peer cap, a fast
// heartbeat, a short retry delay, a short silent-port window, and a short
// probe timeout so the M1 window-expiry path runs in milliseconds.
vi.mock("../mcp/cluster/constants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/cluster/constants")>();
  return {
    ...actual,
    MAX_MEMBER_PEERS: 2,
    HEARTBEAT_INTERVAL_MS: 20,
    MEMBER_POST_RETRY_DELAY_MS: 20,
    SILENT_PORT_WINDOW_MS: 150,
    PROBE_TIMEOUT_MS: 100,
  };
});

// Bootstrap backs off between attempts; collapse it so window-expiry tests run fast.
vi.mock("../mcp/cluster/election", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/cluster/election")>();
  return { ...actual, sleep: async () => {}, jitter: () => 0 };
});

// ── Helpers ──────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil timed out");
    await sleep(1);
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** True if the port can currently be bound on 127.0.0.1 (bind-prove, no connect). */
function tryBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

/**
 * Find a base port whose successor is also bindable (bootstrap advances
 * base→base+1). Scans a fixed low range: probing the high ephemeral range
 * right after close() is unreliable on macOS.
 */
async function findConsecutiveFreePorts(): Promise<number> {
  for (let base = 41000; base < 46000; base += 2) {
    if ((await tryBind(base)) && (await tryBind(base + 1))) return base;
  }
  throw new Error("no two consecutive free ports found in 41000..46000");
}

interface RpcToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}
interface RpcResponse {
  result?: RpcToolResult;
  error?: { code: number; message: string };
}

function postJson(
  url: string,
  body: unknown,
  token?: string,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(data),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(url, { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch {
          json = raw;
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function rawStatus(url: string, method: "GET" | "POST", token?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(url, { method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Open the member-channel SSE leg and resolve on response headers. */
function openMemberStream(
  port: number,
  id: string,
  token?: string,
): Promise<{ status: number; res: http.IncomingMessage }> {
  return new Promise((resolve, reject) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const req = http.get(
      `http://127.0.0.1:${port}${CLUSTER_STREAM_PATH}?id=${encodeURIComponent(id)}`,
      { headers },
      (res) => {
        res.on("data", () => {
          /* drain */
        });
        resolve({ status: res.statusCode ?? 0, res });
      },
    );
    req.on("error", reject);
  });
}

function memberPost(
  port: number,
  id: string,
  msg: IpcMessage,
): Promise<{ status: number; json: unknown }> {
  return postJson(
    `http://127.0.0.1:${port}${CLUSTER_MESSAGE_PATH}?id=${encodeURIComponent(id)}`,
    msg,
  );
}

async function listWorkspaceRows(port: number): Promise<Array<{ id: string; role: string }>> {
  const res = await postJson(`http://127.0.0.1:${port}/mcp`, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list_workspaces", arguments: {} },
  });
  const rpc = res.json as RpcResponse;
  const text = rpc.result?.content?.[0]?.text ?? "[]";
  return JSON.parse(text) as Array<{ id: string; role: string }>;
}

// ── Self-registration guard (W1) ─────────────────────────────────────

describe("self-registration guard (W1)", () => {
  const leaders: LeaderCoordinator[] = [];
  const streams: http.IncomingMessage[] = [];

  afterEach(async () => {
    for (const s of streams) s.destroy();
    streams.length = 0;
    for (const l of leaders) await l.stop(300).catch(() => {});
    leaders.length = 0;
  });

  async function startLeader(workspaceId: string, instanceId?: string): Promise<number> {
    const port = await findFreePort();
    const leader = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
      executor: new ToolExecutor(),
      workspaceId,
      instanceId,
      workspacePaths: ["/mnt/leader"],
      displayName: "Leader",
    });
    await leader.start();
    leaders.push(leader);
    return port;
  }

  it("refuses a REGISTER whose instanceId matches the leader (self-registration)", async () => {
    const port = await startLeader("leader-ws", "leader-inst");
    const { status, res } = await openMemberStream(port, "s-self");
    streams.push(res);
    expect(status).toBe(200);

    await memberPost(port, "s-self", {
      type: MSG.REGISTER,
      id: "leader-ws",
      instanceId: "leader-inst",
      workspacePaths: ["/mnt/leader"],
      displayName: "Thawed Leader",
    });

    const rows = await listWorkspaceRows(port);
    // Only the leader row; the self-registration must not create a worker.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("leader");
    expect(rows.filter((r) => r.role === "worker")).toHaveLength(0);

    // W1-C: the rejected session must be evicted, not left dangling — a
    // follow-up POST on the same session id now sees an unknown session.
    const after = await memberPost(port, "s-self", { type: MSG.PING });
    expect(after.status).toBe(404);
  });

  it("refuses a REGISTER matching the leader's workspace id when no instanceId is set", async () => {
    const port = await startLeader("leader-ws");
    const { res } = await openMemberStream(port, "s-self2");
    streams.push(res);

    await memberPost(port, "s-self2", {
      type: MSG.REGISTER,
      id: "leader-ws",
      workspacePaths: ["/mnt/leader"],
      displayName: "Thawed Leader",
    });

    const rows = await listWorkspaceRows(port);
    expect(rows.filter((r) => r.role === "worker")).toHaveLength(0);
  });

  it("accepts a legitimate worker that shares the leader's workspaceId (distinct instanceId)", async () => {
    // Multi-root / duplicated-window shape: same folder (workspaceId) but a
    // different window instance. The guard must key on instanceId, not id.
    const port = await startLeader("shared-ws", "leader-inst");
    const { res } = await openMemberStream(port, "s-multi");
    streams.push(res);

    await memberPost(port, "s-multi", {
      type: MSG.REGISTER,
      id: "shared-ws",
      instanceId: "other-inst",
      workspacePaths: ["/mnt/leader"],
      displayName: "Second Window",
    });

    const rows = await listWorkspaceRows(port);
    expect(rows.some((r) => r.id === "shared-ws" && r.role === "worker")).toBe(true);
  });

  it("still registers a genuine worker with a different id (control)", async () => {
    const port = await startLeader("leader-ws", "leader-inst");
    const { res } = await openMemberStream(port, "s-worker");
    streams.push(res);

    await memberPost(port, "s-worker", {
      type: MSG.REGISTER,
      id: "worker-ws",
      instanceId: "worker-inst",
      workspacePaths: ["/mnt/worker"],
      displayName: "Worker",
    });

    const rows = await listWorkspaceRows(port);
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.id === "worker-ws" && r.role === "worker")).toBe(true);
  });
});

// ── Member peer cap (N5) ─────────────────────────────────────────────

describe("member peer cap (N5)", () => {
  let leader: LeaderCoordinator | null = null;
  const streams: http.IncomingMessage[] = [];

  afterEach(async () => {
    for (const s of streams) s.destroy();
    streams.length = 0;
    if (leader) await leader.stop(300).catch(() => {});
    leader = null;
  });

  it("rejects a connection past the cap with 503 and frees the slot on close", async () => {
    const port = await findFreePort();
    leader = new LeaderCoordinator({
      port,
      host: "127.0.0.1",
      executor: new ToolExecutor(),
      workspaceId: "leader-ws",
      workspacePaths: ["/mnt/leader"],
      displayName: "Leader",
    });
    await leader.start();

    // MAX_MEMBER_PEERS is mocked to 2.
    const a = await openMemberStream(port, "a");
    streams.push(a.res);
    const b = await openMemberStream(port, "b");
    streams.push(b.res);

    const c = await openMemberStream(port, "c");
    expect(c.status).toBe(503);

    // Closing one stream must release its slot.
    a.res.destroy();
    await sleep(100);

    const d = await openMemberStream(port, "d");
    expect(d.status).toBe(200);
    streams.push(d.res);
  });
});

// ── SSE session-message auth (N3) + stop promptness (N4) ─────────────

describe("SSE session-message auth (N3)", () => {
  let server: McpServer | null = null;

  afterEach(async () => {
    if (server) await server.stop(300).catch(() => {});
    server = null;
  });

  it("rejects unauthenticated /metrics and /diagnostics when a token is configured", async () => {
    const port = await findFreePort();
    server = new McpServer({ port, host: "127.0.0.1", authToken: "t" });
    await server.start();

    expect(await rawStatus(`http://127.0.0.1:${port}/metrics`, "GET")).toBe(401);
    expect(await rawStatus(`http://127.0.0.1:${port}/diagnostics`, "GET")).toBe(401);
    expect(await rawStatus(`http://127.0.0.1:${port}/metrics`, "GET", "t")).toBe(200);
    expect(await rawStatus(`http://127.0.0.1:${port}/diagnostics`, "GET", "t")).toBe(200);
    // /health stays open for cluster probes.
    expect(await rawStatus(`http://127.0.0.1:${port}/health`, "GET")).toBe(200);
  });

  it("rejects an unauthenticated session-message POST with 401", async () => {
    const port = await findFreePort();
    server = new McpServer({ port, host: "127.0.0.1", authToken: "t" });
    await server.start();

    const url = `http://127.0.0.1:${port}/mcp/session/abc/message`;
    expect(await rawStatus(url, "POST")).toBe(401);
    expect(await rawStatus(url, "POST", "wrong")).toBe(401);
    // Authenticated but unknown session → 404 (auth passed, session lookup fails).
    expect(await rawStatus(url, "POST", "t")).toBe(404);
  });

  it("rejects an unauthenticated SSE GET /mcp with 401", async () => {
    const port = await findFreePort();
    server = new McpServer({ port, host: "127.0.0.1", authToken: "t" });
    await server.start();

    expect(await rawStatus(`http://127.0.0.1:${port}/mcp`, "GET")).toBe(401);
  });
});

describe("stop promptness (N4)", () => {
  it("stop() returns promptly with an open SSE session", async () => {
    const port = await findFreePort();
    const server = new McpServer({ port, host: "127.0.0.1", authToken: "t" });
    await server.start();

    // Open an authenticated SSE session and keep it open.
    const sseReq = http.get(
      `http://127.0.0.1:${port}/mcp`,
      { headers: { Authorization: "Bearer t" } },
      (res) => res.on("data", () => {}),
    );
    await sleep(50);

    const t0 = Date.now();
    await server.stop(5000);
    const elapsed = Date.now() - t0;
    sseReq.destroy();
    expect(elapsed).toBeLessThan(1500);
  });
});

// ── Heartbeat failover (N2) ──────────────────────────────────────────

class FakeTransport implements MemberTransport {
  readonly kind = "http" as const;
  onMessage: ((msg: IpcMessage) => void) | null = null;
  onClose: ((reason: string) => void) | null = null;
  readonly sent: IpcMessage[] = [];
  destroyed = false;
  /** Answer each PING with a PONG after `pongDelayMs` (0 = never). */
  pongDelayMs = 0;
  /** PINGs sent while the previous PING was still unanswered — must stay 0. */
  doubleSends = 0;
  private pingOutstanding = false;

  async connect(): Promise<void> {}

  send(msg: IpcMessage): void {
    this.sent.push(msg);
    if (msg.type !== MSG.PING) return;
    if (this.pingOutstanding) this.doubleSends++;
    if (this.pongDelayMs <= 0) return;
    this.pingOutstanding = true;
    const delay = this.pongDelayMs;
    setTimeout(() => {
      this.pingOutstanding = false;
      this.onMessage?.({ type: MSG.PONG });
    }, delay);
  }

  close(): void {
    this.destroyed = true;
  }
}

describe("worker heartbeat failover (N2)", () => {
  const workers: WorkerCoordinator[] = [];

  afterEach(async () => {
    for (const w of workers) await w.stop(200).catch(() => {});
    workers.length = 0;
  });

  async function startWorker(tp: FakeTransport): Promise<WorkerCoordinator> {
    const worker = new WorkerCoordinator({
      transport: tp,
      executor: new ToolExecutor(),
      workspaceId: "worker-ws",
      workspacePaths: ["/mnt/worker"],
      displayName: "Worker",
    });
    const started = worker.start();
    await waitUntil(() => tp.sent.some((m) => m.type === MSG.REGISTER));
    tp.onMessage?.({ type: MSG.WELCOME });
    await started;
    workers.push(worker);
    return worker;
  }

  it("fails over after consecutive unanswered PINGs", async () => {
    const tp = new FakeTransport();
    const lost: string[] = [];
    const worker = await startWorker(tp);
    worker.setOnLostLeader((reason) => lost.push(reason));

    await waitUntil(() => lost.length > 0, 2000);
    expect(lost[0]).toMatch(/no PONG/);
  });

  it("stays up when every PING is answered (one PING in flight, no double-count)", async () => {
    const tp = new FakeTransport();
    tp.pongDelayMs = 1;
    const lost: string[] = [];
    const worker = await startWorker(tp);
    worker.setOnLostLeader((reason) => lost.push(reason));

    await sleep(300); // ~15 heartbeat intervals
    expect(lost).toEqual([]);
    // Several PINGs must have been sent...
    expect(tp.sent.filter((m) => m.type === MSG.PING).length).toBeGreaterThan(2);
    // ...and never two while one was still unanswered (the N2 invariant).
    expect(tp.doubleSends).toBe(0);
  });

  it("never sends a second PING while the first is unanswered (N2 invariant)", async () => {
    const tp = new FakeTransport();
    tp.pongDelayMs = 35; // ~1.75× the interval: PINGs overlap if unguarded
    const worker = await startWorker(tp);
    await sleep(300);
    // The invariant must hold regardless of whether a failover fired.
    expect(tp.doubleSends).toBe(0);
    void worker;
  });

  it("a late PONG resets the miss counter before it reaches the limit", async () => {
    const tp = new FakeTransport();
    tp.pongDelayMs = 30; // 1.5× the interval: one miss counted, then reset
    const lost: string[] = [];
    const worker = await startWorker(tp);
    worker.setOnLostLeader((reason) => lost.push(reason));

    await sleep(300);
    expect(lost).toEqual([]);
  });
});

// ── Member POST retry semantics (N1) ─────────────────────────────────

describe("member POST retry semantics (N1)", () => {
  const servers: http.Server[] = [];

  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  it("retries a 500 and succeeds after two retries", async () => {
    let n = 0;
    const srv = http.createServer((_req, res) => {
      n += 1;
      res.writeHead(n < 3 ? 500 : 200);
      res.end("{}");
    });
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port));
    });
    servers.push(srv);

    const tp = new HttpMemberTransport({ baseUrl: `http://127.0.0.1:${port}` });
    tp.send({ type: MSG.REGISTER, id: "w" });
    await waitUntil(() => n >= 3);
    expect(n).toBe(3);
  });

  it("does not retry a terminal 4xx", async () => {
    let n = 0;
    const srv = http.createServer((_req, res) => {
      n += 1;
      res.writeHead(400);
      res.end("{}");
    });
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port));
    });
    servers.push(srv);

    const tp = new HttpMemberTransport({ baseUrl: `http://127.0.0.1:${port}` });
    tp.send({ type: MSG.REGISTER, id: "w" });
    await waitUntil(() => n >= 1);
    await sleep(100); // longer than the retry delay
    expect(n).toBe(1);
  });

  it("does not retry after close()", async () => {
    let n = 0;
    const srv = http.createServer((_req, res) => {
      n += 1;
      res.writeHead(500);
      res.end("{}");
    });
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port));
    });
    servers.push(srv);

    const tp = new HttpMemberTransport({ baseUrl: `http://127.0.0.1:${port}` });
    tp.send({ type: MSG.REGISTER, id: "w" });
    await waitUntil(() => n >= 1);
    await tp.close();
    await sleep(120); // several retry delays
    expect(n).toBe(1);
  });
});

// ── Silent-port window + squatter classification (M1) ────────────────

describe("silent-port window (M1)", () => {
  const silentServers: net.Server[] = [];
  const httpServers: http.Server[] = [];
  const members: Array<{ stop(ms?: number): Promise<void> }> = [];

  afterEach(async () => {
    for (const m of members) await m.stop(300).catch(() => {});
    members.length = 0;
    for (const s of silentServers) s.close();
    silentServers.length = 0;
    for (const s of httpServers) s.close();
    httpServers.length = 0;
    // The patience maps are module state; a test that fails before promotion
    // would otherwise leave a stale first-seen entry for a later test.
    resetElectionPatience();
  });

  it("refuses to advance past a still-bound silent port (frozen-leader split-brain guard)", async () => {
    const base = await findConsecutiveFreePorts();
    // A live-but-silent holder: accepts TCP, never answers /health, and keeps
    // the port BOUND. This models a frozen leader. The window may expire, but
    // bootstrap must NOT advance to base+1 — doing so is the split-brain.
    const silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(base, "127.0.0.1", resolve));
    silentServers.push(silent);

    const logs: string[] = [];
    // Keep the loop bounded: with the guard, every attempt retries the same
    // port and bootstrap eventually FATALs rather than promoting on base+1.
    await expect(
      bootstrapCluster({
        basePort: base,
        host: "127.0.0.1",
        executor: new ToolExecutor(),
        workspaceId: "w1",
        workspacePaths: ["/w"],
        displayName: "W1",
        log: (m) => logs.push(m),
      }),
    ).rejects.toThrow(/Could not elect or join/);

    expect(logs.some((l) => l.includes("retrying same port"))).toBe(true);
    expect(logs.some((l) => l.includes("likely a live frozen leader"))).toBe(true);
    // Never treated as foreign while the holder is still bound.
    expect(logs.some((l) => l.includes("no longer bound"))).toBe(false);
  }, 20000);

  it("advances past a silent port once the holder is gone (no split-brain false-positive)", async () => {
    const base = await findConsecutiveFreePorts();
    // A silent squatter that RELEASES the port after the window. Bind is then
    // free, so advancing is safe and the window promotes on base+1.
    let silent: net.Server | null = new net.Server(() => {});
    await new Promise<void>((resolve) => (silent as net.Server).listen(base, "127.0.0.1", resolve));
    // Release base as soon as the first-seen window has been recorded: the
    // guard's bind test then succeeds and the loop advances.
    setTimeout(() => {
      silent?.close();
      silent = null;
    }, 60);

    const logs: string[] = [];
    const member = await bootstrapCluster({
      basePort: base,
      host: "127.0.0.1",
      executor: new ToolExecutor(),
      workspaceId: "w1",
      workspacePaths: ["/w"],
      displayName: "W1",
      log: (m) => logs.push(m),
    });
    members.push(member);

    expect(member.role).toBe("leader");
    // Either path is correct and safe: base freed before it was classified
    // silent (promote on base), or it was silent then released (advance to
    // base+1). The forbidden outcome — advancing while it is still bound — is
    // covered by the previous test.
    expect([base, base + 1]).toContain(member.port);
  }, 20000);

  it("skips a foreign HTTP squatter and promotes on the next port", async () => {
    const base = await findConsecutiveFreePorts();
    const foreign = http.createServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not us" }));
    });
    await new Promise<void>((resolve) => foreign.listen(base, "127.0.0.1", resolve));
    httpServers.push(foreign);

    const member = await bootstrapCluster({
      basePort: base,
      host: "127.0.0.1",
      executor: new ToolExecutor(),
      workspaceId: "w2",
      workspacePaths: ["/w2"],
      displayName: "W2",
    });
    members.push(member);

    expect(member.role).toBe("leader");
    expect(member.port).toBe(base + 1);
  }, 15000);
});
