import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WindowState } from "../mcp/cluster/protocol";
import type { ToolExecutor } from "../mcp/executor";
import type { Metrics } from "../utils/metrics";

// extension.ts (and the tool modules it imports) binds the vscode module;
// provide a stub sufficient for the startCluster paths under test.
vi.mock("vscode", () => ({
  window: {
    tabGroups: { all: [] },
    activeTextEditor: null,
    createStatusBarItem: () => ({
      name: "",
      text: "",
      tooltip: "",
      backgroundColor: undefined,
      show: vi.fn(),
    }),
  },
  StatusBarAlignment: { Right: 1 },
  TabInputText: class {},
  TabInputTextDiff: class {},
}));

vi.mock("../mcp/cluster/bootstrap", () => ({
  bootstrapCluster: vi.fn(),
}));

import { deactivate, startCluster } from "../extension";
import { bootstrapCluster, type ClusterMember } from "../mcp/cluster/bootstrap";

function makeOpts(log: (msg: string) => void) {
  return {
    basePort: 9876,
    host: "127.0.0.1",
    authToken: "",
    executor: {} as ToolExecutor,
    metrics: {} as Metrics,
    workspaceId: "ws",
    workspacePaths: ["/mnt/ws"],
    displayName: "W",
    instanceId: "inst",
    instanceName: "Inst",
    state: { openEditors: [] } as WindowState,
    isRemoteContainer: false,
    log,
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
});
