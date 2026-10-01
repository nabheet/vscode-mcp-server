import { type ChildProcess, execSync, type SpawnOptions, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// ── Helpers ──────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();

let ENABLED = true;

// C1 requires a token for non-loopback binds (auto-detected Docker bridges
// on Linux CI runners), so the spawned windows authenticate; every MCP call
// carries the shared token.
const E2E_AUTH_TOKEN = "t";

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

/**
 * True when the MCP endpoint is unreachable OR accepts connections but
 * never answers (a SIGSTOPped leader). A plain mcpRequest would hang
 * forever on the frozen server, so this probe enforces its own socket
 * timeout and treats a timeout as "down".
 */
function probePortDown(port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const req = http.request(
      `http://127.0.0.1:${port}/mcp`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      },
      () => {
        // Any HTTP response means the server is alive.
        req.destroy();
        resolve(false);
      },
    );
    req.on("error", () => resolve(true)); // refused / reset → down
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(true); // accepted but silent → frozen leader → down
    });
    req.write(body);
    req.end();
  });
}

interface McpContentPart {
  type: string;
  text: string;
}

interface McpToolResult {
  isError?: boolean;
  content: McpContentPart[];
  [key: string]: unknown;
}

interface McpResponse {
  jsonrpc: "2.0";
  id: number;
  result: McpToolResult;
  error?: { code: number; message: string };
}

function mcpRequest(
  port: number,
  method: string,
  params?: Record<string, unknown>,
): Promise<McpResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params,
    });
    const req = http.request(
      `http://127.0.0.1:${port}/mcp`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
          Authorization: `Bearer ${E2E_AUTH_TOKEN}`,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function waitForServer(port: number, timeoutMs = 120000): Promise<void> {
  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await mcpRequest(port, "tools/list");
      if (res?.result) return;
    } catch {
      // Server not ready yet
    }
    const elapsed = Date.now() - start;
    if (elapsed - lastLog >= 10000) {
      lastLog = elapsed;
      console.log(`⌛ Waiting for MCP server... ${(elapsed / 1000).toFixed(0)}s`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`MCP server did not start within ${timeoutMs}ms`);
}

// VS Code ignores Chromium's --headless flag, so local macOS runs pop a
// window. CI runs under xvfb (headless) and is unaffected. Hiding requires
// Accessibility permission — failures are swallowed.
function hideVSCodeWindows(_procs: ChildProcess[], delayMs = 1500) {
  if (process.platform !== "darwin") return;
  setTimeout(() => {
    try {
      execSync(
        'osascript -e \'tell application "System Events" to set visible of (first process whose name is "Code") to false\'',
        { stdio: "ignore" },
      );
    } catch {
      /* no Accessibility permission — window stays visible */
    }
  }, delayMs);
}

/**
 * Resolve the VS Code CLI binary via `@vscode/test-electron` (downloads
 * VS Code to a cache, works on all platforms, no local install required).
 *
 * On headless Linux, xvfb-run is auto-detected and wrapped around the command.
 */
async function resolveCodeCli(): Promise<{
  cmd: string;
  args: string[];
}> {
  const { downloadAndUnzipVSCode } = await import("@vscode/test-electron");

  const vscodePath = await downloadAndUnzipVSCode("stable");
  if (process.platform === "darwin") {
    // Spawn the app binary directly. The `bin/code` wrapper (returned by
    // resolveCliPathFromVSCodeExecutablePath) launches the app detached via
    // LaunchServices: under vitest the app can die before writing logs and
    // leaves orphaned processes. The binary stays attached as our child.
    const appRoot = vscodePath.endsWith(".app")
      ? vscodePath
      : vscodePath.replace(/\/Contents\/MacOS\/.+$/, "");
    const binary = path.join(appRoot, "Contents", "MacOS", "Code");
    if (fs.existsSync(binary)) return { cmd: binary, args: [] };
    throw new Error(`VS Code binary not found under ${appRoot}`);
  }
  if (process.platform === "linux") {
    // downloadAndUnzipVSCode returns the root Electron binary itself
    // (<dir>/code). Spawn it directly — NOT the `bin/code` Node CLI wrapper
    // that resolveCliPathFromVSCodeExecutablePath returns: that wrapper
    // spawns the real binary and exits, so the PID we hold would be a dead
    // script whose process group vanishes and whose child (the real app)
    // gets reparented away from it, breaking the self-heal test's group
    // freeze. The binary stays attached as our child.
    return wrapForDisplay(vscodePath, []);
  }
  const { resolveCliPathFromVSCodeExecutablePath } = await import("@vscode/test-electron");
  const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodePath);

  if (!fs.existsSync(cliPath)) {
    throw new Error(`VS Code CLI not found at resolved path: ${cliPath}`);
  }

  return wrapForDisplay(cliPath, []);
}

/**
 * On headless Linux, wrap the command with xvfb-run.
 */
function wrapForDisplay(cmd: string, extraArgs: string[]): { cmd: string; args: string[] } {
  const isLinux = process.platform === "linux";
  const hasDisplay = !!process.env.DISPLAY;

  if (isLinux && !hasDisplay) {
    try {
      execSync("which xvfb-run", { stdio: "pipe" });
      return { cmd: "xvfb-run", args: ["--auto-servernum", cmd, ...extraArgs] };
    } catch {
      console.warn(
        "Headless Linux detected but xvfb-run not found. Install xvfb: apt-get install xvfb",
      );
    }
  }

  return { cmd, args: extraArgs };
}

// ── Tests ────────────────────────────────────────────────────────────────

/**
 * Two-window cluster E2E: proves wire-level instance identity end to end.
 *
 * Spawns TWO VS Code windows (distinct user-data dirs, distinct single-root
 * workspaces) sharing ONE cluster port. Election decides which becomes
 * leader; the other joins over the HTTP member channel. The test then:
 *  1. lists the cluster (2 rows, distinct instanceIds, one leader + one worker)
 *  2. targets each window BY instanceId and proves the calls land in the
 *     right window (folder listing + file content)
 *  3. lists tools per window (worker must not expose leader-only tools)
 */
describe("cluster leader-worker (E2E)", () => {
  const procs: ChildProcess[] = [];
  let tmpDir: string | null = null;
  let port: number;

  beforeAll(async () => {
    if (!process.env.RUN_E2E) {
      ENABLED = false;
      return;
    }

    // Verify extension is compiled
    const extMain = path.join(PROJECT_ROOT, "out", "extension.js");
    if (!fs.existsSync(extMain)) {
      console.warn("⚠  Skipping E2E tests: extension not compiled (run `npm run compile` first)");
      ENABLED = false;
      return;
    }

    port = await findFreePort();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cl-"));

    // Two single-root workspaces with distinct, greppable content
    const folderA = path.join(tmpDir, "alpha");
    const folderB = path.join(tmpDir, "beta");
    fs.mkdirSync(path.join(folderA, "src"), { recursive: true });
    fs.mkdirSync(path.join(folderB, "src"), { recursive: true });
    fs.writeFileSync(path.join(folderA, "src", "index.ts"), "// alpha code\nconst a = 1;\n");
    fs.writeFileSync(path.join(folderB, "src", "index.ts"), "// beta code\nconst b = 2;\n");

    // Resolve VS Code CLI (download if needed, wrap with xvfb on headless Linux)
    let cliCmd: string;
    let cliArgs: string[];
    try {
      const resolved = await resolveCodeCli();
      cliCmd = resolved.cmd;
      cliArgs = resolved.args;
    } catch (err) {
      console.warn("⚠  Skipping E2E tests:", (err as Error).message);
      ENABLED = false;
      return;
    }

    // Two distinct user-data dirs = two distinct windows. BOTH windows share
    // the SAME cluster port — the cluster elects exactly one leader; the
    // other joins as worker. Settings carry the port (env vars don't
    // reliably propagate through VS Code's extension host chain).
    const spawns: Array<[string, string]> = [
      [folderA, "a"],
      [folderB, "b"],
    ];
    for (const [folder, tag] of spawns) {
      const vsCodeUserData = path.join(tmpDir, `ud${tag}`);
      const userSettingsDir = path.join(vsCodeUserData, "User");
      fs.mkdirSync(userSettingsDir, { recursive: true });
      fs.writeFileSync(
        path.join(userSettingsDir, "settings.json"),
        JSON.stringify({
          "vscode-mcp-server.port": port,
          "vscode-mcp-server.authToken": E2E_AUTH_TOKEN,
        }),
      );

      const launchArgs: string[] = [
        ...cliArgs,
        "--extensionDevelopmentPath",
        PROJECT_ROOT,
        "--user-data-dir",
        vsCodeUserData,
        "--disable-workspace-trust",
        "--new-window",
        folder,
      ];
      if (process.platform === "linux") {
        launchArgs.push("--no-sandbox");
      }

      const spawnOpts: SpawnOptions = {
        env: {
          ...process.env,
          MCP_PORT: String(port),
          MCP_SERVER_MAX_RETRIES: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
        // Each window becomes a process-group leader (its PID is its PGID)
        // so the self-heal test can SIGSTOP/SIGCONT the entire window —
        // main, renderer, and extension host — via kill(-pid). Without
        // this, the children share vitest's process group and a group-wide
        // stop would freeze the test runner itself.
        detached: true,
      };

      const proc = spawn(cliCmd, launchArgs, spawnOpts);
      procs.push(proc);

      // Log VS Code output for debugging failures
      const logPath = path.join(tmpDir, `vscode-${tag}.log`);
      const logStream = fs.createWriteStream(logPath);
      if (proc.stdout) proc.stdout.pipe(logStream);
      if (proc.stderr) proc.stderr.pipe(logStream);
    }

    // VS Code ignores Chromium's --headless flag, so local macOS runs pop
    // windows. Hide them via AppleScript — CI runs under xvfb and is
    // unaffected. Requires Accessibility permission; failures are ignored.
    hideVSCodeWindows(procs);

    // Wait for the elected leader to come up (up to 180s — two windows on
    // slow CI runners). The worker joins shortly after.
    await waitForServer(port, 180000);
  }, 240000);

  afterAll(async () => {
    for (const proc of procs) {
      if (!proc.killed) {
        proc.kill("SIGTERM");
        // Wait for graceful exit, then force kill
        const exited = new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
            resolve();
          }, 5000);
          proc.on("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        await exited;
      }
    }
    if (tmpDir) {
      // Retry cleanup with backoff — VS Code may still hold file locks briefly
      let lastErr: unknown;
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
          lastErr = undefined;
          break;
        } catch (e) {
          lastErr = e;
          if (i < 4) await new Promise((r) => setTimeout(r, 500));
        }
      }
      if (lastErr) console.warn("⚠  Failed to clean up temp dir:", lastErr);
    }
  }, 20000);

  /** Poll list_workspaces until both windows have registered. */
  async function waitForTwoWindows(deadlineMs = 90000): Promise<Array<Record<string, unknown>>> {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const res = await mcpRequest(port, "tools/call", {
        name: "list_workspaces",
        arguments: {},
      });
      if (res.result && !res.result.isError) {
        try {
          const rows = JSON.parse(res.result.content[0].text) as Array<Record<string, unknown>>;
          if (Array.isArray(rows) && rows.length >= 2) return rows;
        } catch {
          /* not JSON yet */
        }
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Cluster did not reach 2 windows within ${deadlineMs}ms`);
  }

  /**
   * Assert the MCP endpoint is NOT serving — used right after freezing the
   * leader to prove the cluster is genuinely broken before self-heal.
   * Only a leader serves the HTTP port, so any success here means the
   * freeze did not land.
   */
  async function expectServerDown(port: number, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await probePortDown(port)) return; // refused, reset, or silent
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`MCP server still responding ${timeoutMs}ms after leader freeze`);
  }

  // ── Discovery ─────────────────────────────────────────────────────────

  it("list_workspaces returns both windows with distinct instanceIds", async () => {
    if (!ENABLED) return;
    const rows = await waitForTwoWindows();
    expect(rows).toHaveLength(2);

    const ids = rows.map((r) => r.instanceId);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBeTruthy();

    const roles = rows.map((r) => r.role).sort();
    expect(roles).toEqual(["leader", "worker"]);

    const folders = rows.flatMap((r) => (r.folders as string[]) ?? []);
    expect(folders.some((f) => f.endsWith("alpha"))).toBe(true);
    expect(folders.some((f) => f.endsWith("beta"))).toBe(true);

    // Every window must expose a state descriptor (issue #76): openEditors
    // is always an array; activeFile is a string when an editor is active.
    for (const row of rows) {
      const state = row.state as { activeFile?: unknown; openEditors?: unknown } | undefined;
      expect(state).toBeDefined();
      expect(Array.isArray(state?.openEditors)).toBe(true);
      if (state?.activeFile !== undefined) {
        expect(typeof state.activeFile).toBe("string");
      }
    }
  });

  // ── Targeting by instanceId ──────────────────────────────────────────

  it("routes tools/call by instanceId: each window answers with its own folder + file content", async () => {
    if (!ENABLED) return;
    const rows = await waitForTwoWindows();
    const alphaIdx = rows.findIndex((r) =>
      (r.folders as string[]).some((f) => f.endsWith("alpha")),
    );
    const betaIdx = rows.findIndex((r) => (r.folders as string[]).some((f) => f.endsWith("beta")));
    expect(alphaIdx).toBeGreaterThanOrEqual(0);
    expect(betaIdx).toBeGreaterThanOrEqual(0);
    expect(alphaIdx).not.toBe(betaIdx);
    const alphaId = rows[alphaIdx].instanceId as string;
    const betaId = rows[betaIdx].instanceId as string;

    // get_workspace_folders targeted at each window reports that window only
    const aFolders = await mcpRequest(port, "tools/call", {
      name: "get_workspace_folders",
      arguments: {},
      workspace: alphaId,
    });
    expect(aFolders.result.isError, `alpha folders: ${aFolders.result.content[0].text}`).toBe(
      false,
    );
    expect(aFolders.result.content[0].text).toContain("alpha:");

    const bFolders = await mcpRequest(port, "tools/call", {
      name: "get_workspace_folders",
      arguments: {},
      workspace: betaId,
    });
    expect(bFolders.result.isError, `beta folders: ${bFolders.result.content[0].text}`).toBe(false);
    expect(bFolders.result.content[0].text).toContain("beta:");

    // read_file targeted at each window returns THAT window's file content
    const aRead = await mcpRequest(port, "tools/call", {
      name: "read_file",
      arguments: { path: "src/index.ts" },
      workspace: alphaId,
    });
    expect(aRead.result.isError, `alpha read: ${aRead.result.content[0].text}`).toBe(false);
    expect(aRead.result.content[0].text).toContain("// alpha code");

    const bRead = await mcpRequest(port, "tools/call", {
      name: "read_file",
      arguments: { path: "src/index.ts" },
      workspace: betaId,
    });
    expect(bRead.result.isError, `beta read: ${bRead.result.content[0].text}`).toBe(false);
    expect(bRead.result.content[0].text).toContain("// beta code");
  });

  // ── Per-window tool list ─────────────────────────────────────────────

  it("routes tools/list by instanceId: worker list excludes leader-only list_workspaces", async () => {
    if (!ENABLED) return;

    // Snapshot key: the (role, instanceId) pairs that define the cluster
    // composition. Re-elections change the leader's instanceId (a restarted
    // host gets a new random UUID), so a stable key across the whole check
    // proves no re-election happened between the poll and the tools/list
    // call — only then is a worker returning list_workspaces a real bug.
    const snapshotKey = (rows: Array<Record<string, unknown>>): string =>
      JSON.stringify(
        rows
          .map((r) => [r.role, r.instanceId] as const)
          .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
      );

    const deadline = Date.now() + 30000;
    for (;;) {
      if (Date.now() > deadline) {
        throw new Error(
          "Cluster never presented a stable worker tools/list within 30s (repeated re-elections)",
        );
      }
      const rows = await waitForTwoWindows();
      const workerIdx = rows.findIndex((r) => r.role === "worker");
      expect(workerIdx).toBeGreaterThanOrEqual(0);
      const workerId = rows[workerIdx].instanceId as string;
      const beforeKey = snapshotKey(rows);

      const res = (await mcpRequest(port, "tools/list", {
        workspace: workerId,
      })) as unknown as { result: { tools: Array<{ name: string }> } };

      expect(res.result.tools).toBeDefined();
      const names = res.result.tools.map((t) => t.name);
      expect(names).toContain("read_file");
      expect(names).toContain("get_workspace_folders");
      if (!names.includes("list_workspaces")) return;

      // list_workspaces present — either a real bug or the cluster
      // re-elected mid-check (the sampled worker was promoted, answered as
      // leader, then was demoted before we re-read). Re-read the cluster
      // and compare the full composition: if the leader identity or the
      // worker set changed at all, treat it as churn and retry.
      const afterRows = await waitForTwoWindows();
      const stillSame = snapshotKey(afterRows) === beforeKey;
      const stillWorker = afterRows.some((r) => r.instanceId === workerId && r.role === "worker");
      if (!stillSame || !stillWorker) {
        // Cluster churned mid-check — re-poll and retry.
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      // Identical, stable cluster composition with the sampled window
      // still a worker, yet tools/list returned list_workspaces — real bug.
      expect(
        names,
        `cluster snapshot unchanged (${beforeKey}) but worker returned list_workspaces`,
      ).not.toContain("list_workspaces");
      return;
    }
  });

  // ── FATAL self-heal ──────────────────────────────────────────────────

  it("cluster self-heals to leader after leader freeze + FATAL (no reload)", async () => {
    if (!ENABLED) return;

    // Identify the elected leader so we can freeze its extension host.
    const rows = await waitForTwoWindows();
    const leaderIdx = rows.findIndex((r) => r.role === "leader");
    expect(leaderIdx).toBeGreaterThanOrEqual(0);
    const leaderFolders = (rows[leaderIdx].folders as string[]) ?? [];
    const leaderFolder = leaderFolders.find((f) => f.endsWith("alpha") || f.endsWith("beta"));
    expect(leaderFolder, "leader row should carry the alpha or beta folder").toBeTruthy();
    const leaderProc = procs[leaderFolder?.endsWith("alpha") ? 0 : 1];
    expect(leaderProc.pid, "leader process should be trackable").toBeTruthy();

    // Freeze (SIGSTOP — NOT kill) the leader window's ENTIRE process group
    // (main + renderer + extension host). The frozen processes keep the TCP
    // port bound but never answer, so the survivor's /health probe times
    // out: "occupied but silent" → it must NOT promote and must NOT advance
    // to a higher port — it retries the SAME port and FATALs ("Could not
    // elect or join a leader after N attempts") before extension.ts's retry
    // loop re-runs startCluster. Pre-fix, the window stayed dead until a
    // manual reload. A kill would be useless here: the port would free up
    // and the survivor would simply promote — and VS Code would
    // auto-restart the killed extension host, racing it.
    //
    // The whole group is frozen (not just the extension host) because the
    // extension host is an Electron "NodeService" utility process whose PID
    // is not reliably discoverable on every platform (lsof is not guaranteed
    // on Linux runners). Freezing the group also keeps VS Code's main
    // process watchdog from restarting the frozen extension host. Each
    // window is spawned with `detached: true`, so kill(-pid) targets the
    // whole group.
    process.kill(-leaderProc.pid, "SIGSTOP");

    try {
      // Frozen leader accepts TCP but never answers: MCP must be down.
      await expectServerDown(port);

      // Hold the freeze long enough for the first bootstrap to exhaust its
      // attempts. Re-election starts ~10-15s in (2 missed PONGs at 5s
      // heartbeat ticks); each attempt costs a 2s probe timeout plus up to
      // 5.5s backoff, so 8 attempts ≈ 41s and FATAL#1 lands around 55-60s.
      // Un-freezing at 70s guarantees at least one FATAL and an
      // already-scheduled retry — that FATAL is the regression signal.
      //
      // The freeze must hold for the whole window: if VS Code ever
      // auto-restarts the frozen extension host, the port comes back and
      // the cluster heals by promotion instead of by the FATAL retry we are
      // testing — fail loudly rather than silently pass on the wrong path.
      const holdUntil = Date.now() + 70000;
      while (Date.now() < holdUntil) {
        await new Promise((r) => setTimeout(r, 5000));
        if (!(await probePortDown(port))) {
          throw new Error(
            "MCP server became reachable during the freeze; SIGSTOP did not isolate the leader window",
          );
        }
      }
    } finally {
      // Thaw the leader so its port (and cluster membership) come back.
      // The group may already be gone if VS Code exited — that is caught
      // by the hold assertion above, not silently ignored here.
      try {
        process.kill(-leaderProc.pid, "SIGCONT");
      } catch {
        // Already exited; nothing to resume.
      }
    }

    // Self-heal must happen WITHOUT any reload: the retry re-runs
    // startCluster and the survivor re-joins the original leader. Which
    // window is leader is intentionally NOT asserted — the leader never
    // died, only froze, so it keeps its role; the regression signal is
    // that the cluster returns to TWO windows (pre-fix, the FATALed window
    // stayed dead and only the leader's own row ever appears).
    await waitForServer(port, 90000);
    const healedRows = await waitForTwoWindows(90000);
    const healedLeader = healedRows.find((r) => r.role === "leader");
    expect(healedLeader, "cluster should have a leader after self-heal").toBeTruthy();
    expect(healedRows.map((r) => r.role).sort()).toEqual(["leader", "worker"]);
  }, 240000);
});
