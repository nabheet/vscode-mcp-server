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
  const { downloadAndUnzipVSCode, resolveCliPathFromVSCodeExecutablePath } = await import(
    '@vscode/test-electron'
  );

  const vscodePath = await downloadAndUnzipVSCode('stable');
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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vscode-mcp-e2e-'));
    const folderA = path.join(tmpDir, 'frontend');
    const folderB = path.join(tmpDir, 'backend');
    fs.mkdirSync(path.join(folderA, 'src'), { recursive: true });
    fs.mkdirSync(path.join(folderB, 'src'), { recursive: true });
    fs.writeFileSync(path.join(folderA, 'src', 'index.ts'), '// frontend code\nconst a = 1;\n');
    fs.writeFileSync(path.join(folderB, 'src', 'index.ts'), '// backend code\nconst b = 2;\n');
    fs.writeFileSync(path.join(folderB, 'src', 'util.ts'), '// shared util in backend\n');

    const workspaceFile = path.join(tmpDir, 'test.code-workspace');
    fs.writeFileSync(
      workspaceFile,
      JSON.stringify(
        {
          folders: [
            { name: 'frontend', path: folderA },
            { name: 'backend', path: folderB },
          ],
        },
        null,
        2,
      ),
    );

    // Set port via VS Code settings (env vars don't reliably propagate
    // through VS Code's extension host process chain)
    const vsCodeUserData = path.join(tmpDir, 'vscode-user-data');
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
