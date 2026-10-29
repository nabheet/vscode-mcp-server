import { type ChildProcess, spawn } from "node:child_process";
import { stopVSCodeProcess } from "./e2e/platform";

const describePosix = process.platform === "win32" ? describe.skip : describe;

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (groupAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function spawnDetached(script: string): ChildProcess {
  return spawn("sh", ["-c", script], { detached: true, stdio: "ignore" });
}

async function waitForPid(proc: ChildProcess): Promise<number> {
  if (proc.pid) return proc.pid;
  await new Promise((resolve) => proc.once("spawn", resolve));
  if (!proc.pid) throw new Error("process did not spawn");
  return proc.pid;
}

describePosix("stopVSCodeProcess", () => {
  it("returns promptly when the process already exited and its group is gone", async () => {
    const proc = spawnDetached("exit 0");
    const pid = await waitForPid(proc);
    await new Promise((resolve) => proc.once("exit", resolve));

    const started = Date.now();
    await stopVSCodeProcess(proc, true, 5000, 5000);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2000);
    expect(groupAlive(pid)).toBe(false);
  });

  it("waits for a draining group instead of signalling it immediately", async () => {
    // The shell reaps its own child on SIGTERM, like VS Code's helper shutdown.
    const proc = spawnDetached(
      'sleep 60 & child=$!; trap "kill $child; wait $child; exit 0" TERM; wait',
    );
    const pid = await waitForPid(proc);

    const started = Date.now();
    await stopVSCodeProcess(proc, true, 5000, 5000);
    const elapsed = Date.now() - started;

    await waitUntilDead(pid, 1000);
    expect(groupAlive(pid)).toBe(false);
    // Drained on its own: no need to burn the full grace window.
    expect(elapsed).toBeLessThan(4000);
  });

  it("terminates a helper that outlives its parent without SIGKILL", async () => {
    // The parent shell exits on SIGTERM; the background sleep stays in the
    // process group and only dies from the follow-up SIGTERM to the group.
    const proc = spawnDetached("sleep 60 & wait");
    const pid = await waitForPid(proc);

    const started = Date.now();
    await stopVSCodeProcess(proc, true, 5000, 1000);
    const elapsed = Date.now() - started;

    await waitUntilDead(pid, 2000);
    expect(groupAlive(pid)).toBe(false);
    expect(elapsed).toBeLessThan(8000);
  });

  it("force-kills a parent that ignores SIGTERM, then reaps the group", async () => {
    const proc = spawnDetached('trap "" TERM; sleep 60 & wait');
    const pid = await waitForPid(proc);

    await stopVSCodeProcess(proc, true, 300, 1000);
    await waitUntilDead(pid, 2000);

    expect(groupAlive(pid)).toBe(false);
  });
});
