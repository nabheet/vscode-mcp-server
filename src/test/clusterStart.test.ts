import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowState } from "../mcp/cluster/protocol";
import type { ToolExecutor } from "../mcp/executor";
import type { Metrics } from "../utils/metrics";

// The setting value activate() reads from getConfiguration("ipcPath"). It is
// mutable so tests can exercise the setting → env → default precedence.
const mockIpcPathSetting = vi.hoisted(() => ({ current: undefined as unknown }));

// extension.ts (and the tool modules it imports) binds the vscode module;
// provide a stub sufficient for the startCluster paths under test.
vi.mock("vscode", () => ({
  window: {
    tabGroups: {
      all: [],
      onDidChangeTabs: () => ({ dispose: vi.fn() }),
    },
    activeTextEditor: null,
    createStatusBarItem: () => ({
      name: "",
      text: "",
      tooltip: "",
      backgroundColor: undefined,
      show: vi.fn(),
    }),
    createOutputChannel: () => ({
      appendLine: vi.fn(),
      show: vi.fn(),
      dispose: vi.fn(),
    }),
    onDidChangeActiveTextEditor: () => ({ dispose: vi.fn() }),
  },
  workspace: {
    getConfiguration: (_section: string) => ({
      get: <T>(key: string, defaultValue?: T): T | undefined =>
        key === "ipcPath" ? (mockIpcPathSetting.current as T) : defaultValue,
    }),
    name: undefined,
    workspaceFolders: [],
    onDidOpenTextDocument: () => ({ dispose: vi.fn() }),
    onDidCloseTextDocument: () => ({ dispose: vi.fn() }),
    onDidChangeConfiguration: () => ({ dispose: vi.fn() }),
  },
  env: { remoteName: undefined },
  StatusBarAlignment: { Right: 1 },
  TabInputText: class {},
  TabInputTextDiff: class {},
}));

vi.mock("../mcp/cluster/bootstrap", () => ({
  bootstrapCluster: vi.fn(),
}));

// activate() registers tools through this module; stub it so the heavy tool
// modules don't need vscode stubs for this test file's scope.
vi.mock("../mcp/tools/index", () => ({
  registerAllTools: vi.fn(),
}));

import { activate, deactivate, startCluster } from "../extension";
import { bootstrapCluster, type ClusterMember } from "../mcp/cluster/bootstrap";
import { DEFAULT_IPC_PATH } from "../mcp/cluster/constants";

function makeOpts(
  log: (msg: string) => void,
  overrides: Partial<Parameters<typeof startCluster>[0]> = {},
) {
  return {
    basePort: 9876,
    host: "127.0.0.1",
    authToken: "",
    executor: {} as ToolExecutor,
    metrics: {} as Metrics,
    ipcPath: "/tmp/vscode-mcp/ipc.sock",
    workspaceId: "ws",
    workspacePaths: ["/mnt/ws"],
    displayName: "W",
    instanceId: "inst",
    instanceName: "Inst",
    state: { openEditors: [] } as WindowState,
    isRemoteContainer: false,
    log,
    ...overrides,
  };
}

function fakeMember(role: "leader" | "worker" = "leader"): ClusterMember {
  return {
    role,
    port: 9876,
    stop: vi.fn(async () => {}),
    updateState: vi.fn(),
    setOnListen: vi.fn(),
    setOnLostLeader: vi.fn(),
  } as unknown as ClusterMember;
}

/** Flush pending promise microtasks before advancing fake timers. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("startCluster FATAL retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(bootstrapCluster).mockReset();
  });

  afterEach(() => {
    // Stop/null any member the test created and drop pending retry timers.
    deactivate();
    vi.useRealTimers();
  });

  it("schedules a retry with the base delay after a FATAL startup", async () => {
    const log = vi.fn();
    vi.mocked(bootstrapCluster)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(fakeMember());
    const p = startCluster(makeOpts(log));
    await settle();

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("FATAL cluster startup: boom — retrying in 2000ms (attempt 1)"),
    );

    // The scheduled retry re-runs startCluster, which succeeds this time.
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(vi.mocked(bootstrapCluster)).toHaveBeenCalledTimes(2);
    // Only one retry was logged — the retried election succeeded.
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("attempt 2"));
    await p;
  });

  it("doubles the backoff on repeated FATALs and caps it", async () => {
    const log = vi.fn();
    vi.mocked(bootstrapCluster).mockRejectedValue(new Error("boom"));
    const p = startCluster(makeOpts(log));
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("retrying in 2000ms (attempt 1)"));

    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("retrying in 4000ms (attempt 2)"));

    await vi.advanceTimersByTimeAsync(4000);
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("retrying in 8000ms (attempt 3)"));

    await vi.advanceTimersByTimeAsync(8000);
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("retrying in 16000ms (attempt 4)"));

    await vi.advanceTimersByTimeAsync(16000);
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("retrying in 30000ms (attempt 5)"));
    await p;
  });

  it("resets the retry counter after a successful election", async () => {
    const log = vi.fn();
    let lostLeader: ((reason: string) => void) | undefined;
    vi.mocked(bootstrapCluster)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        role: "worker",
        port: 9876,
        stop: vi.fn(async () => {}),
        updateState: vi.fn(),
        setOnListen: vi.fn(),
        setOnLostLeader: (cb: (reason: string) => void) => {
          lostLeader = cb;
        },
      } as unknown as ClusterMember)
      .mockRejectedValueOnce(new Error("boom2"))
      .mockResolvedValue(fakeMember());
    const p = startCluster(makeOpts(log));
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("attempt 1"));

    // The retry succeeds as a worker: the backoff counter resets.
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(lostLeader).toBeDefined();
    expect(vi.mocked(bootstrapCluster)).toHaveBeenCalledTimes(2);

    // Lost leader triggers a re-election that FATALs again. Because the
    // counter was reset, the backoff restarts from the base delay.
    lostLeader?.("simulated");
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("retrying in 2000ms (attempt 1)"));
    await p;
  });

  it("does not fire a stale scheduled retry after a later successful election", async () => {
    const log = vi.fn();
    vi.mocked(bootstrapCluster)
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(fakeMember());
    const p = startCluster(makeOpts(log));
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("retrying in 2000ms"));

    // A successful election happens before the retry timer fires.
    await startCluster(makeOpts(vi.fn()));
    expect(vi.mocked(bootstrapCluster)).toHaveBeenCalledTimes(2);

    // Advancing past the original retry deadline must not re-elect.
    await vi.advanceTimersByTimeAsync(5000);
    await settle();
    expect(vi.mocked(bootstrapCluster)).toHaveBeenCalledTimes(2);
    await p;
  });

  it("cancels a pending retry on deactivate", async () => {
    const log = vi.fn();
    vi.mocked(bootstrapCluster).mockRejectedValue(new Error("boom"));
    const p = startCluster(makeOpts(log));
    await settle();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("attempt 1"));

    deactivate(); // invalidates the generation and clears the timer
    await vi.advanceTimersByTimeAsync(10000);
    await settle();
    expect(vi.mocked(bootstrapCluster)).toHaveBeenCalledTimes(1);
    await p;
  });

  it("threads the configured ipcPath into bootstrapCluster", async () => {
    const log = vi.fn();
    vi.mocked(bootstrapCluster).mockResolvedValue(fakeMember());
    const p = startCluster(makeOpts(log, { ipcPath: "/opt/vscode-mcp/ipc.sock" }));
    await settle();
    expect(vi.mocked(bootstrapCluster)).toHaveBeenCalledWith(
      expect.objectContaining({ ipcPath: "/opt/vscode-mcp/ipc.sock" }),
    );
    await p;
  });

  it("omits ipcPath from bootstrapCluster when not configured", async () => {
    const log = vi.fn();
    vi.mocked(bootstrapCluster).mockResolvedValue(fakeMember());
    const p = startCluster(makeOpts(log, { ipcPath: undefined }));
    await settle();
    const callArgs = vi.mocked(bootstrapCluster).mock.calls[0][0];
    expect(callArgs).not.toHaveProperty("ipcPath");
    await p;
  });
});

// ── activate() IPC path wiring ────────────────────────────────────────

describe("activate IPC path wiring", () => {
  const context = () =>
    ({ subscriptions: [], logUri: undefined }) as Parameters<typeof activate>[0];

  beforeEach(() => {
    vi.mocked(bootstrapCluster).mockReset();
    vi.mocked(bootstrapCluster).mockResolvedValue(fakeMember());
    mockIpcPathSetting.current = undefined;
    delete process.env.VSCODE_MCP_IPC_PATH;
  });

  afterEach(() => {
    deactivate();
    delete process.env.VSCODE_MCP_IPC_PATH;
  });

  async function waitForBootstrapCall() {
    await vi.waitFor(() => expect(vi.mocked(bootstrapCluster)).toHaveBeenCalled());
    return vi.mocked(bootstrapCluster).mock.calls[0][0];
  }

  it("threads the resolved ipcPath from the vscode-mcp-server.ipcPath setting into the cluster", async () => {
    mockIpcPathSetting.current = "/opt/vscode-mcp/ipc.sock";
    activate(context());
    const callArgs = await waitForBootstrapCall();
    expect(callArgs).toMatchObject({ ipcPath: "/opt/vscode-mcp/ipc.sock" });
  });

  it("falls back to the VSCODE_MCP_IPC_PATH env var when the setting is empty", async () => {
    mockIpcPathSetting.current = "";
    process.env.VSCODE_MCP_IPC_PATH = "/tmp/env-ipc/ipc.sock";
    activate(context());
    const callArgs = await waitForBootstrapCall();
    expect(callArgs).toMatchObject({ ipcPath: "/tmp/env-ipc/ipc.sock" });
  });

  it("falls back to the default IPC path when neither setting nor env is set", async () => {
    activate(context());
    const callArgs = await waitForBootstrapCall();
    expect(callArgs).toMatchObject({ ipcPath: DEFAULT_IPC_PATH });
  });

  it("ignores a non-string setting value (hand-edited settings.json)", async () => {
    mockIpcPathSetting.current = 123;
    process.env.VSCODE_MCP_IPC_PATH = "/tmp/env-ipc/ipc.sock";
    activate(context());
    const callArgs = await waitForBootstrapCall();
    expect(callArgs).toMatchObject({ ipcPath: "/tmp/env-ipc/ipc.sock" });
  });
});
