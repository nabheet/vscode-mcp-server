import * as vscode from 'vscode';
import { ToolExecutor } from './mcp/executor';
import { registerAllTools } from './mcp/tools/index';
import { bootstrapCluster, ClusterMember } from './mcp/cluster/bootstrap';
import { Metrics } from './utils/metrics';
import { ServerLog } from './utils/serverLog';

const OUTPUT_CHANNEL_NAME = 'VS Code MCP Server';
const DEFAULT_PORT = 6010;

let outputChannel: vscode.OutputChannel | null = null;
let member: ClusterMember | null = null;
let statusBar: vscode.StatusBarItem | null = null;
let electing = false;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  outputChannel.appendLine('[mcp] Activating vscode-mcp-server (cluster mode)...');

  // Observability: shared metrics registry + rotating JSON-lines file log.
  const metrics = new Metrics();
  const logDir = context.logUri?.scheme === 'file' ? context.logUri.fsPath : undefined;
  const fileLog = logDir ? new ServerLog(logDir) : undefined;
  if (fileLog) {
    outputChannel.appendLine('[mcp] JSON log: ' + logDir);
    fileLog.log({ type: 'lifecycle', event: 'activate', version: vscode.version, remote: vscode.env.remoteName ?? 'local' });
  }

  // Read config (VS Code settings with env fallbacks)
  const config = vscode.workspace.getConfiguration('vscode-mcp-server');
  const port = config.get<number>('port') || Number(process.env.MCP_PORT) || DEFAULT_PORT;
  const authToken = config.get<string>('authToken') || process.env.MCP_AUTH_TOKEN || '';
  const tlsCertPath = config.get<string>('tlsCertPath') || process.env.MCP_TLS_CERT_PATH || '';
  const tlsKeyPath = config.get<string>('tlsKeyPath') || process.env.MCP_TLS_KEY_PATH || '';

  // Detect remote container
  const isRemoteContainer = vscode.env.remoteName === 'dev-container'
    || vscode.env.remoteName === 'attached-container'
    || false;
  const host = isRemoteContainer ? '0.0.0.0' : '127.0.0.1';

  // Validate TLS config
  const useTls = !!(tlsCertPath && tlsKeyPath);
  if ((tlsCertPath && !tlsKeyPath) || (!tlsCertPath && tlsKeyPath)) {
    outputChannel.appendLine('[mcp] WARNING: Both tlsCertPath and tlsKeyPath must be set for HTTPS. Falling back to HTTP.');
  }

  if (isRemoteContainer) {
    outputChannel.appendLine('[mcp] Remote container detected — binding to 0.0.0.0');
    outputChannel.appendLine('[mcp] Ensure devcontainer.json includes: "forwardPorts": [' + port + ']');
  }
  if (authToken) {
    outputChannel.appendLine('[mcp] Auth token configured — clients must send Authorization: Bearer <token>');
  }
  if (useTls) {
    outputChannel.appendLine('[mcp] TLS enabled — using cert: ' + tlsCertPath);
  }

  // This window's cluster identity. The id must be unique per window (even
  // for two windows on the same folder) — the pid disambiguates.
  const workspaceFolders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const workspaceId = workspaceFolders.length > 0
    ? `${workspaceFolders[0]}:${process.pid}`
    : `empty:${process.pid}`;
  const displayName = vscode.workspace.name ?? (workspaceFolders.length > 0 ? workspaceFolders[0] : 'No Folder');

  // Shared execution engine: one instance per process, reused by the Master's
  // HTTP server, the Master's router, and Worker forwarded calls, so every
  // cluster member runs the identical tool set with identical limits.
  const executor = new ToolExecutor({ metrics, logger: fileLog });
  registerAllTools(executor, context);

  // Elect a role (master = own the port; worker = join the existing master).
  void startCluster({
    basePort: port,
    host,
    authToken,
    tlsCertPath: useTls ? tlsCertPath : undefined,
    tlsKeyPath: useTls ? tlsKeyPath : undefined,
    executor,
    metrics,
    logger: fileLog,
    workspaceId,
    workspacePaths: workspaceFolders,
    displayName,
    isRemoteContainer,
    log: (msg: string) => outputChannel?.appendLine('[mcp] ' + msg),
  });

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('vscode-mcp-server')) {
        outputChannel?.appendLine('[mcp] Config changed — restart VS Code to apply changes');
      }
    }),
  );

  outputChannel.appendLine('[mcp] Activation complete');
}

export function deactivate(): void {
  outputChannel?.appendLine('[mcp] Shutting down...');
  if (member) {
    const m = member;
    member = null;
    m.stop(3000).catch(() => { /* ignore shutdown errors */ });
  }
  outputChannel?.appendLine('[mcp] Shutdown complete');
}

interface ClusterStartOptions {
  basePort: number;
  host: string;
  authToken: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  executor: ToolExecutor;
  metrics: Metrics;
  logger?: ServerLog;
  workspaceId: string;
  workspacePaths: string[];
  displayName: string;
  isRemoteContainer: boolean;
  log: (msg: string) => void;
}

/** Elect a role and wire re-election. Re-runs whenever the Master is lost. */
async function startCluster(opts: ClusterStartOptions): Promise<void> {
  if (electing) return;
  electing = true;
  try {
    const newMember = await bootstrapCluster({
      basePort: opts.basePort,
      host: opts.host,
      ...(opts.authToken ? { authToken: opts.authToken } : {}),
      ...(opts.tlsCertPath ? { tlsCertPath: opts.tlsCertPath, tlsKeyPath: opts.tlsKeyPath! } : {}),
      executor: opts.executor,
      metrics: opts.metrics,
      logger: opts.logger,
      workspaceId: opts.workspaceId,
      workspacePaths: opts.workspacePaths,
      displayName: opts.displayName,
      log: opts.log,
    });

    // Stop the previous member (a worker that lost its master; idempotent).
    if (member && member !== newMember) {
      const old = member;
      member = null;
      await old.stop(500).catch(() => {});
    }
    member = newMember;

    if (newMember.role === 'worker') {
      newMember.setOnLostMaster((reason: string) => {
        opts.log(`Lost master (${reason}) — re-electing...`);
        void startCluster(opts);
      });
    } else {
      newMember.setOnListen((url: string) => {
        let msg = 'MCP server listening on ' + url;
        if (opts.isRemoteContainer) msg += ' (remote container — use forwarded port)';
        if (opts.authToken) msg += ' [auth enabled]';
        opts.log(msg);
        console.log('[vscode-mcp-server] ' + msg);
      });
    }
    updateStatusBar(newMember);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.log('FATAL cluster startup: ' + msg);
  } finally {
    electing = false;
  }
}

function updateStatusBar(m: ClusterMember): void {
  if (!statusBar) {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.name = 'MCP Server';
    statusBar.show();
  }
  if (m.role === 'master') {
    statusBar.text = `$(server) MCP :${m.port}`;
    statusBar.tooltip = 'MCP cluster master — serving ' + m.port;
    statusBar.backgroundColor = undefined;
  } else {
    statusBar.text = '$(plug) MCP worker';
    statusBar.tooltip = 'MCP cluster worker (master in another window)';
    statusBar.backgroundColor = undefined;
  }
}