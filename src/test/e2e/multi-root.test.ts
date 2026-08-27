import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { spawn, execSync, ChildProcess, SpawnOptions } from 'child_process';

// ── Helpers ──────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();

let ENABLED = true;

function findFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as any).port;
      srv.close(() => resolve(port));
    });
  });
}

function mcpRequest(port: number, method: string, params?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    });
    const req = http.request(
      `http://127.0.0.1:${port}/mcp`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function waitForServer(port: number, timeoutMs = 120000): Promise<void> {
  const start = Date.now();
  let lastLog = 0;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await mcpRequest(port, 'tools/list');
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
function hideVSCodeWindows(proc: ChildProcess, delayMs = 1500) {
  if (process.platform !== 'darwin') return;
  setTimeout(() => {
    try {
      execSync(
        'osascript -e \'tell application "System Events" to set visible of (first process whose name is "Code") to false\'',
        { stdio: 'ignore' },
      );
    } catch { /* no Accessibility permission — window stays visible */ }
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
  const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');

  const vscodePath = await downloadAndUnzipVSCode('stable');
  if (process.platform === 'darwin') {
    // Spawn the app binary directly. The `bin/code` wrapper (returned by
    // resolveCliPathFromVSCodeExecutablePath) launches the app detached via
    // LaunchServices: under vitest the app can die before writing logs and
    // leaves orphaned processes. The binary stays attached as our child.
    const appRoot = vscodePath.endsWith('.app')
      ? vscodePath
      : vscodePath.replace(/\/Contents\/MacOS\/.+$/, '');
    const binary = path.join(appRoot, 'Contents', 'MacOS', 'Code');
    if (fs.existsSync(binary)) return { cmd: binary, args: [] };
    throw new Error(`VS Code binary not found under ${appRoot}`);
  }
  const { resolveCliPathFromVSCodeExecutablePath } = await import(
    '@vscode/test-electron'
  );
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
  const isLinux = process.platform === 'linux';
  const hasDisplay = !!process.env.DISPLAY;

  if (isLinux && !hasDisplay) {
    try {
      execSync('which xvfb-run', { stdio: 'pipe' });
      return { cmd: 'xvfb-run', args: ['--auto-servernum', cmd, ...extraArgs] };
    } catch {
      console.warn(
        'Headless Linux detected but xvfb-run not found. Install xvfb: apt-get install xvfb',
      );
    }
  }

  return { cmd, args: extraArgs };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('multi-root workspace (E2E)', () => {
  let vsCodeProc: ChildProcess | null = null;
  let tmpDir: string | null = null;
  let port: number;

  beforeAll(async () => {
    if (!process.env.RUN_E2E) {
      ENABLED = false;
      return;
    }

    // Verify extension is compiled
    const extMain = path.join(PROJECT_ROOT, 'out', 'extension.js');
    if (!fs.existsSync(extMain)) {
      console.warn('⚠  Skipping E2E tests: extension not compiled (run `npm run compile` first)');
      ENABLED = false;
      return;
    }

    port = await findFreePort();

    // Create temp workspace with two named folders
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mre-'));
    const folderA = path.join(tmpDir, 'frontend');
    const folderB = path.join(tmpDir, 'backend');
    fs.mkdirSync(path.join(folderA, 'src'), { recursive: true });
    fs.mkdirSync(path.join(folderB, 'src'), { recursive: true });
    fs.writeFileSync(path.join(folderA, 'src', 'index.ts'), '// frontend code\nconst a = 1;\n');
    fs.writeFileSync(path.join(folderB, 'src', 'index.ts'), '// backend code\nconst b = 2;\n');
    fs.writeFileSync(path.join(folderB, 'src', 'util.ts'), '// shared util in backend\n');

    const workspaceFile = path.join(tmpDir, 'test.code-workspace');
    // Deliberately JSONC (comments + trailing commas), not JSON.stringify'd —
    // real .code-workspace files are JSONC and start_debugging must parse them.
    fs.writeFileSync(
      workspaceFile,
      `{
        // Workspace files are JSONC: comments and trailing commas are legal
        "folders": [
          { "name": "frontend", "path": ${JSON.stringify(folderA)} },
          { "name": "backend", "path": ${JSON.stringify(folderB)} },
        ],
        /* Launch configs at workspace-file level (not in a folder's
           .vscode/launch.json) — requires start_debugging to resolve with
           folder === undefined. Also includes a compound that bundles the
           two configs into one named launch entry. */
        "launch": {
          "version": "0.2.0",
          "configurations": [
            { "name": "WorkspaceFile Debug", "type": "node", "request": "launch", "program": ${JSON.stringify(path.join(folderB, 'app.js'))} },
            { "name": "WorkspaceFile Debug 2", "type": "node", "request": "launch", "program": ${JSON.stringify(path.join(folderB, 'app2.js'))} },
            /* Slow Launch: preLaunchTask sleeps 33s, so FULL session
               establishment legitimately exceeds the generic 30s tool
               timeout (DEFAULT_TOOL_TIMEOUT_MS). start_debugging declares
               its own 120s budget — this must succeed, not get cut off
               mid-launch with a ghost handler still launching. */
            { "name": "Slow Launch", "type": "node", "request": "launch", "program": ${JSON.stringify(path.join(folderB, 'app.js'))}, "preLaunchTask": "Sleep 33s" },
            /* Slow Compound members: EACH config establishes in ~10s — no
               single member is slow. But a compound awaits every member
               sequentially inside ONE start_debugging call, so cumulative
               establishment (~40s+) exceeds the generic 30s tool timeout.
               This mirrors a real ai-gateway-style "Run All": individual
               launches look fast, the compound total is what matters. */
            { "name": "Slow Compound 1", "type": "node", "request": "launch", "program": ${JSON.stringify(path.join(folderB, 'app.js'))}, "preLaunchTask": "Sleep 10s" },
            { "name": "Slow Compound 2", "type": "node", "request": "launch", "program": ${JSON.stringify(path.join(folderB, 'app2.js'))}, "preLaunchTask": "Sleep 10s" },
            { "name": "Slow Compound 3", "type": "node", "request": "launch", "program": ${JSON.stringify(path.join(folderB, 'app.js'))}, "preLaunchTask": "Sleep 10s" },
            { "name": "Slow Compound 4", "type": "node", "request": "launch", "program": ${JSON.stringify(path.join(folderB, 'app2.js'))}, "preLaunchTask": "Sleep 10s" },
          ],
          "compounds": [
            { "name": "WorkspaceFile Compound", "configurations": ["WorkspaceFile Debug", "WorkspaceFile Debug 2"], "stopAll": true },
            { "name": "Slow Compound", "configurations": ["Slow Compound 1", "Slow Compound 2", "Slow Compound 3", "Slow Compound 4"], "stopAll": true },
          ],
        },
        /* Tasks for the Slow Launch / Slow Compound preLaunchTasks. Shell
           tasks, non-background (isBackground defaults to false) — VS Code
           waits for each to finish before its debug adapter starts, delaying
           session establishment. */
        "tasks": {
          "version": "2.0.0",
          "tasks": [
            {
              "label": "Sleep 33s",
              "type": "shell",
              "command": "sleep 33",
              "presentation": { "reveal": "silent", "panel": "shared" },
            },
            {
              "label": "Sleep 10s",
              "type": "shell",
              "command": "sleep 10",
              "presentation": { "reveal": "silent", "panel": "shared" },
            },
          ],
        },
      }`,
    );

    // Debug targets for the workspace-file launch configs (plain JS so the
    // built-in Node debug adapter can run them). Long lifetime (60s) so
    // sessions stay alive for the whole test — slow-launch tests take ~50s
    // and need every member stoppable when they finish.
    fs.writeFileSync(
      path.join(folderB, 'app.js'),
      '// e2e debug target\nsetTimeout(() => {}, 60000);\n',
    );
    fs.writeFileSync(
      path.join(folderB, 'app2.js'),
      '// e2e debug target 2\nsetTimeout(() => {}, 60000);\n',
    );

    // Folder-level launch.json in the SECOND folder (backend). The default
    // folder scope is the first folder (frontend) — a config declared only
    // here must still be found when start_debugging is called WITHOUT a
    // `folder` argument, proving every open folder's .vscode/launch.json is
    // searched (not just the first folder's, and not just the workspace file).
    fs.mkdirSync(path.join(folderB, '.vscode'), { recursive: true });
    fs.writeFileSync(
      path.join(folderB, '.vscode', 'launch.json'),
      `{
        "version": "0.2.0",
        "configurations": [
          { "name": "Folder Debug", "type": "node", "request": "launch", "program": ${JSON.stringify(path.join(folderB, 'app.js'))} },
          { "name": "Folder Debug 2", "type": "node", "request": "launch", "program": ${JSON.stringify(path.join(folderB, 'app2.js'))} },
        ],
        "compounds": [
          { "name": "Folder Stack", "configurations": ["Folder Debug", "Folder Debug 2"] },
        ],
      }`,
    );

    // Set port via VS Code settings (env vars don't reliably propagate
    // through VS Code's extension host process chain). Note: short names
    // (`ud`, `mre-`) — VS Code's IPC socket under the user-data dir must stay
    // under macOS's ~103-char Unix socket path limit (os.tmpdir() is already
    // long: /var/folders/...).
    const vsCodeUserData = path.join(tmpDir, 'ud');
    const userSettingsDir = path.join(vsCodeUserData, 'User');
    fs.mkdirSync(userSettingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(userSettingsDir, 'settings.json'),
      JSON.stringify({
        'vscode-mcp-server.port': port,
        'vscode-mcp-server.authToken': '',
      }),
    );

    // Resolve VS Code CLI (download if needed, wrap with xvfb on headless Linux)
    let cliCmd: string;
    let cliArgs: string[];
    try {
      const resolved = await resolveCodeCli();
      cliCmd = resolved.cmd;
      cliArgs = resolved.args;
    } catch (err) {
      console.warn('⚠  Skipping E2E tests:', (err as Error).message);
      ENABLED = false;
      return;
    }

    const launchArgs: string[] = [
      ...cliArgs,
      '--extensionDevelopmentPath',
      PROJECT_ROOT,
      '--user-data-dir',
      vsCodeUserData,
      '--disable-workspace-trust',
      '--new-window',
      workspaceFile,
    ];

    // @vscode/test-electron normally adds --no-sandbox on Linux; when we
    // use the CLI path directly we must add it ourselves.
    if (process.platform === 'linux') {
      launchArgs.push('--no-sandbox');
    }

    const logPath = path.join(tmpDir, 'vscode.log');
    const spawnOpts: SpawnOptions = {
      env: {
        ...process.env,
        MCP_PORT: String(port),
        MCP_SERVER_MAX_RETRIES: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    vsCodeProc = spawn(cliCmd, launchArgs, spawnOpts);

    // VS Code ignores Chromium's --headless flag, so local macOS runs pop a
    // window. Hide it via AppleScript — CI runs under xvfb and is unaffected.
    // Requires Accessibility permission; failures are ignored (tests must
    // never fail just because a window stayed visible).
    hideVSCodeWindows(vsCodeProc);

    // Log VS Code output for debugging failures
    const logStream = fs.createWriteStream(logPath);
    if (vsCodeProc.stdout) {
      vsCodeProc.stdout.pipe(logStream);
      // Also forward to console so CI logs capture startup errors
      vsCodeProc.stdout.on('data', (chunk: Buffer) => {
        process.stdout.write(`[vscode:stdout] ${chunk.toString()}`);
      });
    }
    if (vsCodeProc.stderr) {
      vsCodeProc.stderr.pipe(logStream);
      vsCodeProc.stderr.on('data', (chunk: Buffer) => {
        process.stderr.write(`[vscode:stderr] ${chunk.toString()}`);
      });
    }

    // Wait for MCP server to be ready (up to 120s — CI runners are slow)
    await waitForServer(port, 120000);
  }, 180000);

  afterAll(async () => {
    if (vsCodeProc && !vsCodeProc.killed) {
      vsCodeProc.kill('SIGTERM');
      // Wait for graceful exit, then force kill
      const exited = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (vsCodeProc && !vsCodeProc.killed) vsCodeProc.kill('SIGKILL');
          resolve();
        }, 5000);
        vsCodeProc!.on('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await exited;
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
      if (lastErr) console.warn('⚠  Failed to clean up temp dir:', lastErr);
    }
  }, 15000);

  // ── Workspace folder listing ─────────────────────────────────────────

  it('get_workspace_folders returns both folders with correct names', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'get_workspace_folders',
      arguments: {},
    });
    expect(res.result.isError).toBe(false);
    const text: string = res.result.content[0].text;
    expect(text).toContain('frontend:');
    expect(text).toContain('backend:');
  });

  // ── Workspace folder mutation (add / update / remove) ────────────────
  // These run against the live multi-root window opened from test.code-workspace,
  // so vscode.workspace.updateWorkspaceFolders applies immediately.

  async function pollFolders(want: string[], notWant: string[] = []): Promise<string> {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const res = await mcpRequest(port, 'tools/call', {
        name: 'get_workspace_folders',
        arguments: {},
      });
      const text: string = res.result.content[0].text;
      if (want.every((w) => text.includes(w)) && notWant.every((n) => !text.includes(n))) return text;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Folder state not reached: want=${want.join(',')} notWant=${notWant.join(',')}`);
  }

  it('add_workspace_folder appends a folder (relative path resolves against the workspace file)', async () => {
    if (!ENABLED) return;
    fs.mkdirSync(path.join(tmpDir!, 'data'), { recursive: true });
    const res = await mcpRequest(port, 'tools/call', {
      name: 'add_workspace_folder',
      arguments: { path: 'data' },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain("Added workspace folder 'data'");
    const list = await pollFolders(['data:']);
    expect(list).toContain('frontend:');
    expect(list).toContain('backend:');
  });

  it('update_workspace_folder renames an existing folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'update_workspace_folder',
      arguments: { name: 'data', newName: 'data2' },
    });
    expect(res.result.isError, `tool text: ${res.result.content[0].text}`).toBe(false);
    expect(res.result.content[0].text).toContain("Updated workspace folder 'data' → 'data2'");
    await pollFolders(['data2:'], ['data:']);
  });

  it('remove_workspace_folder removes the added folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'remove_workspace_folder',
      arguments: { name: 'data2' },
    });
    expect(res.result.isError, `tool text: ${res.result.content[0].text}`).toBe(false);
    expect(res.result.content[0].text).toContain("Removed workspace folder 'data2'");
    await pollFolders(['frontend:', 'backend:'], ['data']);
  });

  // ── read_file with workspaceFolder ───────────────────────────────────

  it('read_file with workspaceFolder resolves to the correct folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'read_file',
      arguments: { path: 'src/index.ts', workspaceFolder: 'backend' },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain('// backend code');
  });

  it('read_file without workspaceFolder uses the first folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'read_file',
      arguments: { path: 'src/index.ts' },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain('// frontend code');
  });

  it('read_file resolves to frontend when explicitly specified', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'read_file',
      arguments: { path: 'src/index.ts', workspaceFolder: 'frontend' },
    });
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text).toContain('// frontend code');
  });

  it('read_file with nonexistent workspaceFolder returns error', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'read_file',
      arguments: { path: 'src/index.ts', workspaceFolder: 'nonexistent' },
    });
    expect(res.result.isError).toBe(true);
    expect((res.result.content[0].text as string).toLowerCase()).toMatch(/not found|does not exist/);
  });

  // ── write_file with workspaceFolder ──────────────────────────────────

  it('write_file with workspaceFolder writes to the correct folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'write_file',
      arguments: {
        path: 'src/newfile.ts',
        content: '// written from E2E test\n',
        workspaceFolder: 'backend',
      },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string).toLowerCase()).toContain('written');

    // Verify by reading it back
    const readRes = await mcpRequest(port, 'tools/call', {
      name: 'read_file',
      arguments: { path: 'src/newfile.ts', workspaceFolder: 'backend' },
    });
    expect(readRes.result.content[0].text).toBe('// written from E2E test\n');
  });

  it('write_file without workspaceFolder writes to first folder', async () => {
    if (!ENABLED) return;
    const fname = 'src/frontend-only.ts';
    const res = await mcpRequest(port, 'tools/call', {
      name: 'write_file',
      arguments: { path: fname, content: '// frontend only\n' },
    });
    expect(res.result.isError).toBe(false);

    // Verify it's in frontend (first folder)
    const readFrontend = await mcpRequest(port, 'tools/call', {
      name: 'read_file',
      arguments: { path: fname, workspaceFolder: 'frontend' },
    });
    expect(readFrontend.result.isError).toBe(false);
    expect(readFrontend.result.content[0].text).toBe('// frontend only\n');

    // Verify NOT in backend
    const readBackend = await mcpRequest(port, 'tools/call', {
      name: 'read_file',
      arguments: { path: fname, workspaceFolder: 'backend' },
    });
    expect(readBackend.result.isError).toBe(true);
  });

  it('write_file with nonexistent workspaceFolder returns error', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'write_file',
      arguments: { path: 'src/any.ts', content: 'x', workspaceFolder: 'bogus' },
    });
    expect(res.result.isError).toBe(true);
    expect((res.result.content[0].text as string).toLowerCase()).toMatch(/not found/);
  });

  // ── list_files with workspaceFolder ──────────────────────────────────

  it('list_files with workspaceFolder scopes to that folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'list_files',
      arguments: { pattern: 'src/*', workspaceFolder: 'backend' },
    });
    expect(res.result.isError).toBe(false);
    const listing: string = res.result.content[0].text;
    expect(listing).toContain('index.ts');
    expect(listing).toContain('util.ts');
    // the file written in the write_file test should also show up
    expect(listing).toContain('newfile.ts');
  });

  it('list_files without workspaceFolder lists first folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'list_files',
      arguments: { pattern: 'src/*' },
    });
    expect(res.result.isError).toBe(false);
    const listing: string = res.result.content[0].text;
    expect(listing).toContain('index.ts');
    // frontend only has index.ts, not util.ts
    expect(listing).not.toContain('util.ts');
    expect(listing).not.toContain('newfile.ts');
  });

  // ── create_file with workspaceFolder ─────────────────────────────────

  it('create_file with workspaceFolder creates in the correct folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'create_file',
      arguments: { path: 'src/created-by-folder.ts', workspaceFolder: 'backend' },
    });
    expect(res.result.isError).toBe(false);

    // Verify by reading it back
    const readRes = await mcpRequest(port, 'tools/call', {
      name: 'read_file',
      arguments: { path: 'src/created-by-folder.ts', workspaceFolder: 'backend' },
    });
    expect(readRes.result.isError).toBe(false);
  });

  it('create_file without workspaceFolder creates in first folder', async () => {
    if (!ENABLED) return;
    const fname = 'src/created-by-default.ts';
    const res = await mcpRequest(port, 'tools/call', {
      name: 'create_file',
      arguments: { path: fname },
    });
    expect(res.result.isError).toBe(false);

    // Verify it exists in frontend (first folder)
    const readFrontend = await mcpRequest(port, 'tools/call', {
      name: 'read_file',
      arguments: { path: fname, workspaceFolder: 'frontend' },
    });
    expect(readFrontend.result.isError).toBe(false);

    // Verify it does NOT exist in backend
    const readBackend = await mcpRequest(port, 'tools/call', {
      name: 'read_file',
      arguments: { path: fname, workspaceFolder: 'backend' },
    });
    expect(readBackend.result.isError).toBe(true);
  });

  it('create_file with nonexistent workspaceFolder returns error', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'create_file',
      arguments: { path: 'src/created.ts', workspaceFolder: 'bogus' },
    });
    expect(res.result.isError).toBe(true);
  });

  // ── delete_file with workspaceFolder ─────────────────────────────────

  it('delete_file with workspaceFolder deletes from correct folder', async () => {
    if (!ENABLED) return;
    const fname = 'src/todelete-by-folder.ts';
    // Create a file to delete
    await mcpRequest(port, 'tools/call', {
      name: 'create_file',
      arguments: { path: fname, workspaceFolder: 'backend' },
    });

    const res = await mcpRequest(port, 'tools/call', {
      name: 'delete_file',
      arguments: { path: fname, workspaceFolder: 'backend' },
    });
    expect(res.result.isError).toBe(false);

    // Verify it's gone
    const readRes = await mcpRequest(port, 'tools/call', {
      name: 'read_file',
      arguments: { path: fname, workspaceFolder: 'backend' },
    });
    expect(readRes.result.isError).toBe(true);
  });

  it('delete_file with nonexistent workspaceFolder returns error', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'delete_file',
      arguments: { path: 'src/any.ts', workspaceFolder: 'bogus' },
    });
    expect(res.result.isError).toBe(true);
  });

  it('delete_file without workspaceFolder deletes from first folder', async () => {
    if (!ENABLED) return;
    const fname = 'src/todelete-from-frontend.ts';
    // Create a file in frontend (first folder)
    await mcpRequest(port, 'tools/call', {
      name: 'create_file',
      arguments: { path: fname },
    });

    const res = await mcpRequest(port, 'tools/call', {
      name: 'delete_file',
      arguments: { path: fname },
    });
    expect(res.result.isError).toBe(false);

    // Verify it's gone from frontend
    const readRes = await mcpRequest(port, 'tools/call', {
      name: 'read_file',
      arguments: { path: fname, workspaceFolder: 'frontend' },
    });
    expect(readRes.result.isError).toBe(true);
  });

  // ── open_file with workspaceFolder ───────────────────────────────────

  it('open_file with workspaceFolder opens from correct folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'open_file',
      arguments: { path: 'src/index.ts', workspaceFolder: 'backend' },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('Opened');
    expect((res.result.content[0].text as string)).toContain('index.ts');
  });

  it('open_file without workspaceFolder uses first folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'open_file',
      arguments: { path: 'src/index.ts' },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('Opened');
    expect((res.result.content[0].text as string)).toContain('index.ts');
  });

  it('open_file with nonexistent workspaceFolder returns error', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'open_file',
      arguments: { path: 'src/index.ts', workspaceFolder: 'bogus' },
    });
    expect(res.result.isError).toBe(true);
  });

  // ── open_file_at_line with workspaceFolder ───────────────────────────

  it('open_file_at_line with workspaceFolder opens at correct line', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'open_file_at_line',
      arguments: { path: 'src/index.ts', line: 1, workspaceFolder: 'backend' },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('line 1');
  });

  it('open_file_at_line without workspaceFolder opens from first folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'open_file_at_line',
      arguments: { path: 'src/index.ts', line: 2 },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('line 2');
  });

  it('open_file_at_line with nonexistent workspaceFolder returns error', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'open_file_at_line',
      arguments: { path: 'src/index.ts', line: 1, workspaceFolder: 'bogus' },
    });
    expect(res.result.isError).toBe(true);
  });

  // ── reveal_in_explorer with workspaceFolder ──────────────────────────

  it('reveal_in_explorer with workspaceFolder succeeds', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'reveal_in_explorer',
      arguments: { path: 'src/index.ts', workspaceFolder: 'backend' },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('Revealed');
  });

  it('reveal_in_explorer with nonexistent workspaceFolder returns error', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'reveal_in_explorer',
      arguments: { path: 'src/index.ts', workspaceFolder: 'bogus' },
    });
    expect(res.result.isError).toBe(true);
  });

  it('reveal_in_explorer without workspaceFolder reveals from first folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'reveal_in_explorer',
      arguments: { path: 'src/index.ts' },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('Revealed');
  });

  // ── open_file_at_position with workspaceFolder ───────────────────────

  it('open_file_at_position with workspaceFolder opens at correct position', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'open_file_at_position',
      arguments: { path: 'src/index.ts', line: 1, column: 1, workspaceFolder: 'backend' },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('line 1, column 1');
  });

  it('open_file_at_position without workspaceFolder uses first folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'open_file_at_position',
      arguments: { path: 'src/index.ts', line: 1, column: 1 },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('Opened');
  });

  it('open_file_at_position with nonexistent workspaceFolder returns error', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'open_file_at_position',
      arguments: { path: 'src/index.ts', line: 1, column: 1, workspaceFolder: 'bogus' },
    });
    expect(res.result.isError).toBe(true);
  });

  // ── add_breakpoint / remove_breakpoint with workspaceFolder ──────────

  it('add_breakpoint with workspaceFolder sets breakpoint in correct folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'add_breakpoint',
      arguments: { path: 'src/index.ts', line: 1, workspaceFolder: 'backend' },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('Breakpoint added');

    // Verify it was actually set
    const listRes = await mcpRequest(port, 'tools/call', {
      name: 'list_breakpoints',
      arguments: {},
    });
    expect(listRes.result.isError).toBe(false);
    expect((listRes.result.content[0].text as string)).toContain('src/index.ts');
  });

  it('add_breakpoint without workspaceFolder sets breakpoint in first folder', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'add_breakpoint',
      arguments: { path: 'src/index.ts', line: 2 },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('Breakpoint added');
  });

  it('add_breakpoint with nonexistent workspaceFolder returns error', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'add_breakpoint',
      arguments: { path: 'src/index.ts', line: 1, workspaceFolder: 'bogus' },
    });
    expect(res.result.isError).toBe(true);
  });

  it('remove_breakpoint with workspaceFolder removes breakpoint', async () => {
    if (!ENABLED) return;
    // Add a breakpoint first
    await mcpRequest(port, 'tools/call', {
      name: 'add_breakpoint',
      arguments: { path: 'src/index.ts', line: 3, workspaceFolder: 'backend' },
    });

    const res = await mcpRequest(port, 'tools/call', {
      name: 'remove_breakpoint',
      arguments: { path: 'src/index.ts', line: 3, workspaceFolder: 'backend' },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('Breakpoint removed');
  });

  it('remove_breakpoint without workspaceFolder removes from first folder', async () => {
    if (!ENABLED) return;
    // Add a breakpoint in frontend (first folder)
    await mcpRequest(port, 'tools/call', {
      name: 'add_breakpoint',
      arguments: { path: 'src/index.ts', line: 1 },
    });

    const res = await mcpRequest(port, 'tools/call', {
      name: 'remove_breakpoint',
      arguments: { path: 'src/index.ts', line: 1 },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('Breakpoint removed');
  });

  it('remove_breakpoint with nonexistent workspaceFolder returns error', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'remove_breakpoint',
      arguments: { path: 'src/index.ts', line: 1, workspaceFolder: 'bogus' },
    });
    expect(res.result.isError).toBe(true);
  });

  // ── start_debugging with workspace-file launch config ───────────────

  it('start_debugging launches a config defined in the workspace file', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'start_debugging',
      arguments: { configName: 'WorkspaceFile Debug' },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('Started debugging');

    // Prove a real debug session is active (not just a resolved promise):
    // stop_debugging errors with "No active debug session to stop" when nothing
    // actually started.
    const stop = await mcpRequest(port, 'tools/call', {
      name: 'stop_debugging',
      arguments: {},
    });
    expect(stop.result.isError).toBe(false);
    expect((stop.result.content[0].text as string)).toContain('stopped');
  });

  it('start_debugging launches a compound defined in the workspace file', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'start_debugging',
      arguments: { configName: 'WorkspaceFile Compound' },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('Started debugging');

    // The compound bundles two configs, so both sessions should be live.
    // stop_debugging only stops the active session — stopping twice succeeds
    // only if both actually started (the second stop has a session to stop).
    const stop1 = await mcpRequest(port, 'tools/call', {
      name: 'stop_debugging',
      arguments: {},
    });
    expect(stop1.result.isError).toBe(false);
    const stop2 = await mcpRequest(port, 'tools/call', {
      name: 'stop_debugging',
      arguments: {},
    });
    expect(stop2.result.isError).toBe(false);
  });

  it('start_debugging finds a config in a NON-first folder launch.json without a folder argument', async () => {
    if (!ENABLED) return;

    // 'Folder Debug' lives only in backend/.vscode/launch.json; the default
    // folder scope is the FIRST folder (frontend). It must still resolve —
    // folder-level launch configs in any open folder are searchable.
    const res = await mcpRequest(port, 'tools/call', {
      name: 'start_debugging',
      arguments: { configName: 'Folder Debug' },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('Started debugging');

    const stop = await mcpRequest(port, 'tools/call', {
      name: 'stop_debugging',
      arguments: {},
    });
    expect(stop.result.isError).toBe(false);
    expect((stop.result.content[0].text as string)).toContain('stopped');
  });

  it('start_debugging with an explicit folder argument narrows the search to that folder', async () => {
    if (!ENABLED) return;

    // 'Folder Debug' is declared in backend, NOT frontend. With
    // folder: 'frontend', start_debugging must NOT find it — the folder
    // argument is a hard scope, not a hint.
    const res = await mcpRequest(port, 'tools/call', {
      name: 'start_debugging',
      arguments: { configName: 'Folder Debug', folder: 'frontend' },
    });
    expect(res.result.isError).toBe(true);
    expect((res.result.content[0].text as string)).toContain("Failed to start 'Folder Debug'");

    // And with folder: 'backend' it must resolve.
    const ok = await mcpRequest(port, 'tools/call', {
      name: 'start_debugging',
      arguments: { configName: 'Folder Debug', folder: 'backend' },
    });
    expect(ok.result.isError).toBe(false);
    expect((ok.result.content[0].text as string)).toContain('Started debugging');

    const stop = await mcpRequest(port, 'tools/call', {
      name: 'stop_debugging',
      arguments: {},
    });
    expect(stop.result.isError).toBe(false);
  });

  it('start_debugging expands a compound declared in a folder launch.json', async () => {
    if (!ENABLED) return;

    // 'Folder Stack' is a compound in backend/.vscode/launch.json (not the
    // workspace file). Compounds are named entries, not DebugConfiguration
    // objects, and name-based resolution is unreliable in VS Code 1.133+ —
    // the tool must expand the compound and pass each member config object.
    const res = await mcpRequest(port, 'tools/call', {
      name: 'start_debugging',
      arguments: { configName: 'Folder Stack', folder: 'backend' },
    });
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('Started debugging');

    const stop = await mcpRequest(port, 'tools/call', {
      name: 'stop_debugging',
      arguments: {},
    });
    expect(stop.result.isError).toBe(false);
    expect((stop.result.content[0].text as string)).toContain('stopped');
  });

  it('start_debugging survives a launch slower than the generic 30s tool timeout (per-tool budget)', async () => {
    if (!ENABLED) return;

    // Slow Launch's preLaunchTask sleeps 33s, so full session establishment
    // takes > 30s. The generic DEFAULT_TOOL_TIMEOUT_MS would cut this off
    // mid-launch (and the abandoned handler would keep launching in the
    // background); the per-tool 120s budget must let it complete normally.
    const started = Date.now();
    const res = await mcpRequest(port, 'tools/call', {
      name: 'start_debugging',
      arguments: { configName: 'Slow Launch' },
    });
    const elapsedMs = Date.now() - started;

    // Prove the launch genuinely outlasted the old 30s default (sleep floor
    // makes this deterministic) — otherwise this test passes vacuously.
    expect(elapsedMs).toBeGreaterThan(30_000);
    expect(res.result.isError).toBe(false);
    expect(res.result.content[0].text as string).toContain('Started debugging');

    // Stop the slow session so later tests start clean.
    const stop = await mcpRequest(port, 'tools/call', {
      name: 'stop_debugging',
      arguments: {},
    });
    expect(stop.result.isError).toBe(false);
    expect((stop.result.content[0].text as string)).toContain('stopped');
  }, 120000);

  it('start_debugging completes a compound whose cumulative establishment exceeds the generic 30s tool timeout', async () => {
    if (!ENABLED) return;

    // 4 configs × ~10s preLaunchTask sleep ≈ 40s+ of cumulative session
    // establishment. No single member is slow — but the compound awaits each
    // member sequentially inside ONE tool call, so the total blows past the
    // generic 30s DEFAULT_TOOL_TIMEOUT_MS (the ai-gateway "Run All" shape:
    // individual launches look fast, the compound total is what matters).
    // The per-tool 120s budget must let it finish with every member live.
    const started = Date.now();
    const res = await mcpRequest(port, 'tools/call', {
      name: 'start_debugging',
      arguments: { configName: 'Slow Compound' },
    });
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeGreaterThan(30_000);
    expect(res.result.isError).toBe(false);
    expect((res.result.content[0].text as string)).toContain('Started debugging');

    // All four members should be live: stopping succeeds once per session.
    for (let i = 0; i < 4; i++) {
      const stop = await mcpRequest(port, 'tools/call', {
        name: 'stop_debugging',
        arguments: {},
      });
      expect(stop.result.isError).toBe(false);
      expect((stop.result.content[0].text as string)).toContain('stopped');
    }
  }, 120000);

  // ── Error cases ──────────────────────────────────────────────────────

  it('list_files with nonexistent workspaceFolder returns error', async () => {
    if (!ENABLED) return;
    const res = await mcpRequest(port, 'tools/call', {
      name: 'list_files',
      arguments: { pattern: 'src/*', workspaceFolder: 'bogus' },
    });
    expect(res.result.isError).toBe(true);
    expect((res.result.content[0].text as string).toLowerCase()).toMatch(/not found/);
  });
});
