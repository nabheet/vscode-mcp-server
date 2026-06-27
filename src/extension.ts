import * as vscode from 'vscode';
import { McpServer, McpServerOptions } from './mcp/server';
import { registerAllTools } from './mcp/tools/index';

const OUTPUT_CHANNEL_NAME = 'VS Code MCP Server';
let server: McpServer | null = null;
let outputChannel: vscode.OutputChannel | null = null;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
  outputChannel.appendLine('[mcp] Activating vscode-mcp-server...');

  // Read config (VS Code settings with env fallbacks)
  const config = vscode.workspace.getConfiguration('vscode-mcp-server');
  const port = config.get<number>('port') || Number(process.env.MCP_PORT) || 9876;
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

  // Build server options
  const opts: McpServerOptions = {
    port,
    host,
    ...(authToken ? { authToken } : {}),
    ...(useTls ? { tlsCertPath, tlsKeyPath } : {}),
  };

  server = new McpServer(opts);
  registerAllTools(server, context);

  // Connection info callback
  server.setOnListen((url: string) => {
    let msg = 'MCP server listening on ' + url;
    if (isRemoteContainer) {
      msg += ' (remote container — use forwarded port)';
    }
    if (authToken) {
      msg += ' [auth enabled]';
    }
    outputChannel?.appendLine('[mcp] ' + msg);
    console.log('[vscode-mcp-server] ' + msg);
  });

  // Start server with port retry
  startServerWithRetry(port, host, authToken, tlsCertPath, tlsKeyPath, context).catch((err) => {
    outputChannel?.appendLine('[mcp] FATAL: ' + err.message);
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
  if (server) {
    server.stop(5000).catch(() => { /* ignore shutdown errors */ });
    server = null;
  }
  outputChannel?.appendLine('[mcp] Shutdown complete');
}

async function startServerWithRetry(
  basePort: number,
  host: string,
  authToken: string,
  tlsCertPath: string,
  tlsKeyPath: string,
  context: vscode.ExtensionContext,
): Promise<void> {
  let currentPort = basePort;
  const useTls = !!(tlsCertPath && tlsKeyPath);
  const maxRetries = Number(process.env.MCP_SERVER_MAX_RETRIES) || 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    currentPort = basePort + attempt;
    const opts: McpServerOptions = {
      port: currentPort,
      host,
      ...(authToken ? { authToken } : {}),
      ...(useTls ? { tlsCertPath, tlsKeyPath } : {}),
    };

    const srv = new McpServer(opts);
    registerAllTools(srv, context);
    server = srv;

    try {
      // Re-set the onListen since we created a new server
      srv.setOnListen((url: string) => {
        let msg = 'MCP server listening on ' + url;
        if (vscode.env.remoteName === 'dev-container' || vscode.env.remoteName === 'attached-container') {
          msg += ' (remote container — use forwarded port)';
        }
        if (authToken) msg += ' [auth enabled]';
        outputChannel?.appendLine('[mcp] ' + msg);
        console.log('[vscode-mcp-server] ' + msg);
      });

      await srv.start();
      return;
    } catch (err: any) {
      if ((err.code === 'EADDRINUSE' || (err.message && err.message.includes('already in use'))) && attempt < maxRetries - 1) {
        outputChannel?.appendLine('[mcp] Port ' + currentPort + ' in use, trying ' + (currentPort + 1) + '...');
        continue;
      }
      throw err;
    }
  }
  throw new Error('Could not find available port after ' + maxRetries + ' attempts');
}
