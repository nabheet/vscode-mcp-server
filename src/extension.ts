import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { bootstrapCluster, type ClusterMember } from "./mcp/cluster/bootstrap";
import type { WindowState } from "./mcp/cluster/protocol";
import { ToolExecutor } from "./mcp/executor";
import { registerAllTools } from "./mcp/tools/index";
import { Metrics } from "./utils/metrics";
import { ServerLog } from "./utils/serverLog";

const OUTPUT_CHANNEL_NAME = "VS Code MCP Server";
const DEFAULT_PORT = 9876;

let outputChannel: vscode.OutputChannel | null = null;
let member: ClusterMember | null = null;
let statusBar: vscode.StatusBarItem | null = null;
let electing = false;
/** Debounce timer for window-state pushes to the cluster. */
let statePushTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Auto-retry after a FATAL cluster startup so transient IPC races (e.g. a
 * socket file momentarily unlinked during a reload) self-heal instead of
 * leaving the window with no cluster role until a manual reload.
 */
let startupRetryAttempt = 0;
let startupRetryTimer: ReturnType<typeof setTimeout> | undefined;
/** Bumped by every startCluster call; retries check it so a stale scheduled
 * retry never fires after a newer election superseded it. */
let startupGeneration = 0;
const STARTUP_RETRY_BASE_MS = 2000;
const STARTUP_RETRY_MAX_MS = 30000;

/**
 * Snapshot this window's editor state (active file + open editors) for
 * list_workspaces, so clients can tell windows apart even when they share
 * a folder and display name.
 */
function currentWindowState(): WindowState {
  const openEditors: string[] = [];
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      let uri: vscode.Uri | undefined;
      if (tab.input instanceof vscode.TabInputText) {
        uri = tab.input.uri;
      } else if (tab.input instanceof vscode.TabInputTextDiff) {
        uri = tab.input.modified;
      }
      if (uri?.scheme === "file") {
        const p = uri.fsPath;
        if (!openEditors.includes(p)) openEditors.push(p);
      }
    }
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  const activeFile = active?.scheme === "file" ? active.fsPath : undefined;
  return activeFile ? { activeFile, openEditors } : { openEditors };
}

/** Debounce rapid editor/tab churn into a single cluster state update. */
function scheduleStatePush(): void {
  if (statePushTimer) clearTimeout(statePushTimer);
  statePushTimer = setTimeout(() => {
    statePushTimer = undefined;
    member?.updateState(currentWindowState());
  }, 300);
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  outputChannel.appendLine("[mcp] Activating vscode-mcp-server (cluster mode)...");

  // Observability: shared metrics registry + rotating JSON-lines file log.
  const metrics = new Metrics();
  const logDir = context.logUri?.scheme === "file" ? context.logUri.fsPath : undefined;
  const fileLog = logDir ? new ServerLog(logDir) : undefined;
  if (fileLog) {
    outputChannel.appendLine(`[mcp] JSON log: ${logDir}`);
    fileLog.log({
      type: "lifecycle",
      event: "activate",
      version: vscode.version,
      remote: vscode.env.remoteName ?? "local",
    });
  }

  // Read config (VS Code settings with env fallbacks)
  const config = vscode.workspace.getConfiguration("vscode-mcp-server");
  const port = config.get<number>("port") || Number(process.env.MCP_PORT) || DEFAULT_PORT;
  const authToken = config.get<string>("authToken") || process.env.MCP_AUTH_TOKEN || "";
  const tlsCertPath = config.get<string>("tlsCertPath") || process.env.MCP_TLS_CERT_PATH || "";
  const tlsKeyPath = config.get<string>("tlsKeyPath") || process.env.MCP_TLS_KEY_PATH || "";

  // Detect remote container
  const isRemoteContainer =
    vscode.env.remoteName === "dev-container" ||
    vscode.env.remoteName === "attached-container" ||
    false;
  const host = isRemoteContainer ? "0.0.0.0" : "127.0.0.1";

  // Validate TLS config
  const useTls = !!(tlsCertPath && tlsKeyPath);
  if ((tlsCertPath && !tlsKeyPath) || (!tlsCertPath && tlsKeyPath)) {
    outputChannel.appendLine(
      "[mcp] WARNING: Both tlsCertPath and tlsKeyPath must be set for HTTPS. Falling back to HTTP.",
    );
  }

  if (isRemoteContainer) {
    outputChannel.appendLine("[mcp] Remote container detected — binding to 0.0.0.0");
    outputChannel.appendLine(`[mcp] Ensure devcontainer.json includes: "forwardPorts": [${port}]`);
  }
  if (authToken) {
    outputChannel.appendLine(
      "[mcp] Auth token configured — clients must send Authorization: Bearer <token>",
    );
  }
  if (useTls) {
    outputChannel.appendLine(`[mcp] TLS enabled — using cert: ${tlsCertPath}`);
  }

  // This window's cluster identity. The id must be unique per window (even
  // for two windows on the same folder) — the pid disambiguates.
  const workspaceFolders = vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath) ?? [];
  const workspaceId =
    workspaceFolders.length > 0 ? `${workspaceFolders[0]}:${process.pid}` : `empty:${process.pid}`;
  const displayName =
    vscode.workspace.name ?? (workspaceFolders.length > 0 ? workspaceFolders[0] : "No Folder");

  // Wire-level instance identity: a stable per-window UUID + human-readable
  // name surfaced in initialize serverInfo and list_workspaces so MCP clients
  // can tell which VS Code window they are talking to.
  const instanceId = randomUUID();
  const instanceName = vscode.workspace.name ?? "Untitled";

  // Shared execution engine: one instance per process, reused by the Leader's
  // HTTP server, the Leader's router, and Worker forwarded calls, so every
  // cluster member runs the identical tool set with identical limits.
  const executor = new ToolExecutor({ metrics, logger: fileLog, instanceId, instanceName });
  registerAllTools(executor, context);

  // Elect a role (leader = own the port; worker = join the existing leader).
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
    instanceId,
    instanceName,
    state: currentWindowState(),
    isRemoteContainer,
    log: (msg: string) => outputChannel?.appendLine(`[mcp] ${msg}`),
  });

  // Keep list_workspaces state fresh: push active file / open editors on
  // editor and tab changes (debounced so bursty events coalesce).
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => scheduleStatePush()),
    vscode.window.tabGroups.onDidChangeTabs(() => scheduleStatePush()),
    vscode.workspace.onDidOpenTextDocument(() => scheduleStatePush()),
    vscode.workspace.onDidCloseTextDocument(() => scheduleStatePush()),
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("vscode-mcp-server")) {
        outputChannel?.appendLine("[mcp] Config changed — restart VS Code to apply changes");
      }
    }),
  );

  outputChannel.appendLine("[mcp] Activation complete");
}

export function deactivate(): void {
  outputChannel?.appendLine("[mcp] Shutting down...");
  // Invalidate any scheduled startup retry — the host is going away.
  startupGeneration += 1;
  startupRetryAttempt = 0;
  if (startupRetryTimer) {
    clearTimeout(startupRetryTimer);
    startupRetryTimer = undefined;
  }
  if (member) {
    const m = member;
    member = null;
    m.stop(3000).catch(() => {
      /* ignore shutdown errors */
    });
  }
  outputChannel?.appendLine("[mcp] Shutdown complete");
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
  instanceId: string;
  instanceName: string;
  state: WindowState;
  isRemoteContainer: boolean;
  log: (msg: string) => void;
}

/** Elect a role and wire re-election. Re-runs whenever the Leader is lost. */
export async function startCluster(opts: ClusterStartOptions): Promise<void> {
  if (electing) return;
  // A fresh election (retry, re-election, or manual reload) supersedes any
  // pending scheduled retry from a previous FATAL.
  if (startupRetryTimer) {
    clearTimeout(startupRetryTimer);
    startupRetryTimer = undefined;
  }
  const generation = ++startupGeneration;
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
      instanceId: opts.instanceId,
      instanceName: opts.instanceName,
      state: opts.state,
      log: opts.log,
    });

    // Stop the previous member (a worker that lost its leader; idempotent).
    if (member && member !== newMember) {
      const old = member;
      member = null;
      await old.stop(500).catch(() => {});
    }
    member = newMember;
    // A successful election resets the backoff so the next transient FATAL
    // starts from the base delay again.
    startupRetryAttempt = 0;
    // State captured at activation may be stale after election; push the
    // freshest snapshot once the member is wired. Debounced pushes handle
    // the rest.
    newMember.updateState(currentWindowState());

    if (newMember.role === "worker") {
      newMember.setOnLostLeader((reason: string) => {
        opts.log(`Lost leader (${reason}) — re-electing...`);
        void startCluster(opts);
      });
    } else {
      newMember.setOnListen((url: string) => {
        let msg = `MCP server listening on ${url}`;
        if (opts.isRemoteContainer) msg += " (remote container — use forwarded port)";
        if (opts.authToken) msg += " [auth enabled]";
        opts.log(msg);
        console.log(`[vscode-mcp-server] ${msg}`);
      });
    }
    updateStatusBar(newMember);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Transient FATALs (e.g. the IPC socket file momentarily unlinked during a
    // simultaneous reload) self-heal: retry with exponential backoff so the
    // window still gets a cluster role without a manual reload.
    const delay = Math.min(STARTUP_RETRY_BASE_MS * 2 ** startupRetryAttempt, STARTUP_RETRY_MAX_MS);
    startupRetryAttempt += 1;
    opts.log(
      `FATAL cluster startup: ${msg} — retrying in ${delay}ms (attempt ${startupRetryAttempt})`,
    );
    startupRetryTimer = setTimeout(() => {
      startupRetryTimer = undefined;
      // Stale retry: a newer election (or deactivate) superseded this one.
      if (generation !== startupGeneration) return;
      void startCluster(opts);
    }, delay);
  } finally {
    electing = false;
  }
}

function updateStatusBar(m: ClusterMember): void {
  if (!statusBar) {
    statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBar.name = "MCP Server";
    statusBar.show();
  }
  if (m.role === "leader") {
    statusBar.text = `$(server) MCP :${m.port}`;
    statusBar.tooltip = `MCP cluster leader — serving ${m.port}`;
    statusBar.backgroundColor = undefined;
  } else {
    statusBar.text = "$(plug) MCP worker";
    statusBar.tooltip = "MCP cluster worker (leader in another window)";
    statusBar.backgroundColor = undefined;
  }
}
