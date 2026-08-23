import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import { spawn, execSync, ChildProcess, SpawnOptions } from 'child_process';

// ── Helpers (mirror multi-root.test.ts) ─────────────────────────────────

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

function rawGet(port: number, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${pathname}`, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }));
    });
    req.on('error', reject);
  });
}

function mcpRequest(port: number, method: string, params?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = http.request(
      `http://127.0.0.1:${port}/mcp`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch (e) { reject(e); }
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
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await mcpRequest(port, 'tools/list');
      if (res?.result) return;
    } catch { /* not ready */ }
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

async function resolveCodeCli(): Promise<{ cmd: string; args: string[] }> {
  const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
  const vscodePath = await downloadAndUnzipVSCode('stable');
  if (process.platform === 'darwin') {
    // Spawn the app binary directly. The `bin/code` wrapper (returned by
    // resolveCliPathFromVSCodeExecutablePath) launches the app detached via
    // LaunchServices: under vitest the app can die before writing logs and
    // leaves orphaned processes. The binary stays attached as our child and
    // is killed cleanly in afterAll.
    const appRoot = vscodePath.endsWith('.app') ? vscodePath : vscodePath.replace(/\/Contents\/MacOS\/.+$/, '');
    const binary = path.join(appRoot, 'Contents', 'MacOS', 'Code');
    if (fs.existsSync(binary)) return { cmd: binary, args: [] };
    throw new Error(`VS Code binary not found under ${appRoot}`);
  }
  const { resolveCliPathFromVSCodeExecutablePath } = await import('@vscode/test-electron');
  const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodePath);
  if (!fs.existsSync(cliPath)) throw new Error(`VS Code CLI not found: ${cliPath}`);
  return wrapForDisplay(cliPath, []);
}

function wrapForDisplay(cmd: string, extraArgs: string[]): { cmd: string; args: string[] } {
  const isLinux = process.platform === 'linux';
  const hasDisplay = !!process.env.DISPLAY;
  if (isLinux && !hasDisplay) {
    try {
      execSync('which xvfb-run', { stdio: 'pipe' });
      return { cmd: 'xvfb-run', args: ['--auto-servernum', cmd, ...extraArgs] };
    } catch { /* fall through */ }
  }
  return { cmd, args: extraArgs };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('observability endpoints + log tools (E2E)', () => {
  let vsCodeProc: ChildProcess | null = null;
  let tmpDir: string | null = null;
  let port: number;

  beforeAll(async () => {
    if (!process.env.RUN_E2E) {
      ENABLED = false;
      return;
    }
    const extMain = path.join(PROJECT_ROOT, 'out', 'extension.js');
    if (!fs.existsSync(extMain)) {
      console.warn('⚠  Skipping E2E: extension not compiled (run `npm run compile` first)');
      ENABLED = false;
      return;
    }

    port = await findFreePort();
tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-'));
    const folder = path.join(tmpDir, 'ws');
    fs.mkdirSync(path.join(folder, 'src'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'src', 'index.ts'), '// obs e2e\nconst x = 1;\n');
    const vsCodeUserData = path.join(tmpDir, 'ud');
    const userSettingsDir = path.join(vsCodeUserData, 'User');
    fs.mkdirSync(userSettingsDir, { recursive: true });
    fs.writeFileSync(
      path.join(userSettingsDir, 'settings.json'),
      JSON.stringify({ 'vscode-mcp-server.port': port, 'vscode-mcp-server.authToken': '' }),
    );

    let cliCmd: string;
    let cliArgs: string[];
    try {
      const resolved = await resolveCodeCli();
      cliCmd = resolved.cmd;
      cliArgs = resolved.args;
    } catch (err) {
      console.warn('⚠  Skipping E2E:', (err as Error).message);
      ENABLED = false;
      return;
    }

    const launchArgs: string[] = [
      ...cliArgs,
      '--extensionDevelopmentPath', PROJECT_ROOT,
      '--user-data-dir', vsCodeUserData,
      '--disable-workspace-trust',
      '--new-window',
      folder,
    ];
    if (process.platform === 'linux') launchArgs.push('--no-sandbox');

    const spawnOpts: SpawnOptions = {
      env: { ...process.env, MCP_PORT: String(port), MCP_SERVER_MAX_RETRIES: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    };
    vsCodeProc = spawn(cliCmd, launchArgs, spawnOpts);
    if (vsCodeProc.stdout) vsCodeProc.stdout.on('data', (c: Buffer) => process.stdout.write(`[vscode:obs] ${c.toString()}`));
    if (vsCodeProc.stderr) vsCodeProc.stderr.on('data', (c: Buffer) => process.stdout.write(`[vscode:obs:err] ${c.toString()}`));
    vsCodeProc.on('error', (e: Error) => console.error('[diag] spawn error:', e.message));
    vsCodeProc.on('exit', (code, sig) => console.error(`[diag] VS Code exited code=${code} sig=${sig}`));

    // Hide the VS Code window on macOS (CI uses xvfb; --headless is a no-op)
    hideVSCodeWindows(vsCodeProc);

    try {
      await waitForServer(port);
    } catch (err) {
      // Diagnostics: did the extension activate? Where did it log?
      const found: string[] = [];
      const walk = (dir: string, depth: number) => {
        if (depth > 7 || found.length > 3) return;
        let entries: fs.Dirent[] = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full, depth + 1);
          else if (e.name === 'mcp.log' || e.name === 'exthost.log' || e.name === 'main.log') found.push(full);
        }
      };
      walk(vsCodeUserData, 0);
      console.error(`[diag] mcp.log search under ${vsCodeUserData}:`);
      for (const f of found) {
        console.error(`[diag]   ${f}`);
        try { console.error(fs.readFileSync(f, 'utf-8').split('\n').slice(-30).join('\n')); } catch { /* ignore */ }
      }
      if (vsCodeProc?.pid) {
        console.error(`[diag] child pid=${vsCodeProc.pid}`);
        try { process.kill(vsCodeProc.pid, 0); console.error('[diag] child ALIVE'); } catch { console.error('[diag] child DEAD'); }
        try {
          const ps = execSync(`ps -p ${vsCodeProc.pid} -o pid,ppid,stat,etime,command`).toString();
          console.error(`[diag] ps:\n${ps}`);
        } catch { /* ignore */ }
      }
      throw err;
    }
  }, 180000);

  afterAll(async () => {
    if (vsCodeProc && !vsCodeProc.killed) vsCodeProc.kill('SIGTERM');
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('list_logs exposes VS Code host logs and the extension JSON log', async () => {
    if (!ENABLED) { console.warn('skipped'); return; }
    const res = await mcpRequest(port, 'tools/call', { name: 'list_logs', arguments: {} });
    const text = res?.result?.content?.[0]?.text ?? JSON.stringify(res);
    expect(text).toContain('VS Code logs root:');
    expect(text).toContain('Sessions (newest first)');
    expect(text).toContain('Extension log files (context.logUri)');
  });

  it('extension JSON log file exists on disk with lifecycle + tool entries', async () => {
    if (!ENABLED) { console.warn('skipped'); return; }
    // After the tools/list + list_logs calls above, our mcp.log must exist and
    // contain tool records. Find it via the logs root reported by list_logs.
    const res = await mcpRequest(port, 'tools/call', { name: 'list_logs', arguments: {} });
    const text = res?.result?.content?.[0]?.text ?? '';
    const rootMatch = text.match(/VS Code logs root: (.+)/);
    expect(rootMatch, 'logs root in list_logs output').toBeTruthy();
    const logsRoot = rootMatch![1].trim();
    expect(fs.existsSync(logsRoot), `logs root exists: ${logsRoot}`).toBe(true);

    // Hunt for our mcp.log under the logs root (it lives somewhere under
    // exthost/output_logging). Assert a tool entry exists.
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 6 || found.length > 4) return;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else if (e.name === 'mcp.log') found.push(full);
      }
    };
    walk(logsRoot, 0);
    expect(found.length, 'mcp.log found under logs root').toBeGreaterThan(0);

    const content = fs.readFileSync(found[0], 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    // Every line must be valid JSON with a type field.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      expect(JSON.parse(line).type).toBeDefined();
    }
  });

  it('/metrics serves Prometheus text with memory + histogram after tool calls', async () => {
    if (!ENABLED) { console.warn('skipped'); return; }
    // tools/list already ran (waitForServer) — histogram should be non-empty.
    const { status, body } = await rawGet(port, '/metrics');
    expect(status).toBe(200);
    expect(body).toContain('vscode_mcp_uptime_seconds');
    expect(body).toContain('vscode_mcp_memory_rss_bytes');
    expect(body).toContain('vscode_mcp_event_loop_lag_ms');
    expect(body).toContain('vscode_mcp_tool_duration_seconds_count');
    // Counter is ≥1 (tools/list polling in waitForServer + list_logs call
    // before this test all dispatch through the counter).
    expect(body).toMatch(/vscode_mcp_tool_total [1-9]\d*/);
  });

  it('/diagnostics serves JSON with histograms and recent errors', async () => {
    if (!ENABLED) { console.warn('skipped'); return; }
    const { status, body } = await rawGet(port, '/diagnostics');
    expect(status).toBe(200);
    const parsed = JSON.parse(body);
    expect(parsed.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(parsed.gauges.vscode_mcp_memory_rss_bytes).toBeGreaterThan(0);
    expect(parsed.counters.vscode_mcp_tool_total).toBeGreaterThanOrEqual(1);
    expect(parsed.histograms.vscode_mcp_tool_duration_seconds.count).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(parsed.recentErrors)).toBe(true);
  });

  it('read_log tails the newest session host log', async () => {
    if (!ENABLED) { console.warn('skipped'); return; }
    const listing = await mcpRequest(port, 'tools/call', { name: 'list_logs', arguments: {} });
    const text = listing?.result?.content?.[0]?.text ?? '';
    const sessMatch = text.match(/Log files in newest session ([^\n:]+):/);
    expect(sessMatch, 'newest session listed').toBeTruthy();
    const session = sessMatch![1].trim();

    const res = await mcpRequest(port, 'tools/call', {
      name: 'read_log',
      arguments: { file: `${session}/main.log`, lines: 100 },
    });
    const out = res?.result?.content?.[0]?.text ?? JSON.stringify(res);
    // Tool must succeed (log *content* legitimately contains "[error]" lines
    // like Node deprecation warnings — assert on the result flag, not text).
    expect(res?.result?.isError).not.toBe(true);
    expect(out).not.toContain('not found');
    expect(out).toContain(`--- ${session}/main.log`);
  });

  it('read_log rejects paths that escape the logs root', async () => {
    if (!ENABLED) { console.warn('skipped'); return; }
    const res = await mcpRequest(port, 'tools/call', {
      name: 'read_log',
      arguments: { file: '/etc/hosts' },
    });
    const out = res?.result?.content?.[0]?.text ?? '';
    expect(out).toContain('Rejected');
  });
});