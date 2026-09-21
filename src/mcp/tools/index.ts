import * as vscode from 'vscode';
import { ToolDefinition } from '../../utils/types';

import { registerCommandsTools } from './commands';
import { registerNavigationTools } from './navigation';
import { registerWorkspaceTools } from './workspace';
import { registerLspTools } from './lsp';
import { registerDebugTools } from './debug';
import { registerTerminalTools } from './terminal';
import { registerLogsTools } from './logs';
import { registerSearchTools } from './search';

/**
 * Minimal surface the tool registration functions need. Satisfied by both
 * McpServer (master HTTP layer) and ToolExecutor (worker IPC execution), so
 * every cluster member registers the exact same tool set.
 */
export interface ToolRegistrar {
  registerTool(def: ToolDefinition): void;
}

export function registerAllTools(server: ToolRegistrar, context: vscode.ExtensionContext): void {
  registerCommandsTools(server);
  registerNavigationTools(server);
  registerWorkspaceTools(server);
  registerLspTools(server);
  registerDebugTools(server);
  registerTerminalTools(server, context);
  registerLogsTools(server, context);
  registerSearchTools(server);
}

export function defineTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: ToolDefinition['handler'],
  timeoutMs?: number,
): ToolDefinition {
  return { name, description, inputSchema, handler, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}
