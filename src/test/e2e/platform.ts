import { type ChildProcess, execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export async function resolveCodeCli(): Promise<{ cmd: string; args: string[] }> {
  const { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } = await import(
    "@vscode/test-electron"
  );
  const vscodePath = await downloadAndUnzipVSCode("stable");

  if (process.platform === "win32") {
    if (!fs.existsSync(vscodePath)) throw new Error(`VS Code executable not found: ${vscodePath}`);
    return { cmd: vscodePath, args: [] };
  }

  if (process.platform === "darwin") {
    const appRoot = vscodePath.endsWith(".app")
      ? vscodePath
      : vscodePath.replace(/\/Contents\/MacOS\/.+$/, "");
    const binary = path.join(appRoot, "Contents", "MacOS", "Code");
    if (fs.existsSync(binary)) return { cmd: binary, args: [] };
    throw new Error(`VS Code binary not found under ${appRoot}`);
  }

  if (process.platform === "linux") {
    if (!fs.existsSync(vscodePath)) throw new Error(`VS Code executable not found: ${vscodePath}`);
    if (!process.env.DISPLAY) {
      try {
        execSync("which xvfb-run", { stdio: "pipe" });
        return { cmd: "xvfb-run", args: ["--auto-servernum", vscodePath] };
      } catch {
        console.warn("Headless Linux detected but xvfb-run not found. Install xvfb.");
      }
    }
    return { cmd: vscodePath, args: [] };
  }

  const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodePath);
  if (!fs.existsSync(cliPath))
    throw new Error(`VS Code CLI not found at resolved path: ${cliPath}`);
  if (!process.env.DISPLAY) {
    try {
      execSync("which xvfb-run", { stdio: "pipe" });
      return { cmd: "xvfb-run", args: ["--auto-servernum", cliPath] };
    } catch {
      console.warn("Headless Linux detected but xvfb-run not found. Install xvfb.");
    }
  }
  return { cmd: cliPath, args: [] };
}

export function createCanonicalTempDir(prefix: string): string {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  return process.platform === "win32"
    ? dir.replace(/^([a-z]):/i, (_, drive: string) => `${drive.toLowerCase()}:`)
    : dir;
}

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    let timer: NodeJS.Timeout;
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    timer = setTimeout(() => {
      proc.removeListener("exit", onExit);
      resolve(false);
    }, timeoutMs);
    proc.once("exit", onExit);
  });
}

export async function stopVSCodeProcess(
  proc: ChildProcess,
  processGroup = false,
  timeoutMs = 5000,
): Promise<void> {
  if (!proc.pid) return;
  const alreadyExited = proc.exitCode !== null || proc.signalCode !== null;

  if (process.platform === "win32") {
    // Taskkill the tree even after the main process exits: detached helpers can
    // outlive it, and taskkill on an exited pid is a harmless no-op.
    const exited = alreadyExited ? null : waitForExit(proc, timeoutMs);
    try {
      execFileSync("taskkill.exe", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // The process tree may already have exited.
    }
    await exited;
    return;
  }

  // Signal only the main process: VS Code shuts its own helpers down in order,
  // so signalling the whole group directly produces crash reports for services
  // that are still draining.
  if (!alreadyExited) {
    const exited = waitForExit(proc, timeoutMs);
    try {
      proc.kill("SIGTERM");
    } catch {
      // The process may have exited between the status check and the signal.
    }
    if (!(await exited) && proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        // The process may have exited.
      }
      await waitForExit(proc, 1000);
    }
  }

  // Group leaders can leave reparented helpers behind; reap them silently.
  if (processGroup) {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      // The process group has exited.
    }
  }
}

export function freezeWindow(proc: ChildProcess, freeze: boolean): void {
  if (!proc.pid) throw new Error("VS Code process has no PID");
  if (process.platform !== "win32") {
    process.kill(-proc.pid, freeze ? "SIGSTOP" : "SIGCONT");
    return;
  }

  const operation = freeze
    ? `
$completed = @()
try {
  foreach ($id in $ids) {
    $handle = $handles[[int]$id]
    if ($null -eq $handle) { continue }
    $status = [ProcessControl]::NtSuspendProcess($handle)
    if ($status -eq -1073741558) { continue }
    if ($status -ne 0) { throw "NtSuspendProcess failed for $($id): $($status)" }
    $completed += [int]$id
  }
} catch {
  [array]::Reverse($completed)
  foreach ($resumeId in $completed) {
    $resumeHandle = $handles[[int]$resumeId]
    if ($null -ne $resumeHandle) { [void][ProcessControl]::NtResumeProcess($resumeHandle) }
  }
  throw
}`
    : `
[array]::Reverse($ids)
$errors = @()
foreach ($id in $ids) {
  $handle = $handles[[int]$id]
  if ($null -eq $handle) { continue }
  $status = [ProcessControl]::NtResumeProcess($handle)
  if ($status -ne 0 -and $status -ne -1073741558) { $errors += "NtResumeProcess failed for $($id): $($status)" }
}
if ($errors.Count -gt 0) { throw ($errors -join '; ') }`;
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ProcessControl {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
  [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
}
'@
$all = @(Get-CimInstance Win32_Process)
function Get-Descendants([int]$parent) {
  foreach ($child in ($all | Where-Object ParentProcessId -eq $parent)) {
    [int]$child.ProcessId
    Get-Descendants ([int]$child.ProcessId)
  }
}
$ids = @(${proc.pid}) + @(Get-Descendants ${proc.pid})
$handles = @{}
foreach ($id in $ids) {
  $handle = [ProcessControl]::OpenProcess(0x0800, $false, [int]$id)
  if ($handle -eq [IntPtr]::Zero) {
    if ([int]$id -eq ${proc.pid}) { throw "Cannot open VS Code process ${proc.pid}" }
    continue
  }
  $handles[[int]$id] = $handle
}
try {
${operation}
} finally {
  foreach ($handle in $handles.Values) {
    [void][ProcessControl]::CloseHandle($handle)
  }
}
`;
  // Encoded command: the script carries quotes, braces and `$`, which do not
  // survive a command line intact.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
    stdio: "pipe",
    timeout: 30000,
  });
}
