import * as vscode from 'vscode';
import { ToolDefinition } from '../../utils/types';
import { McpServer } from '../server';

import { registerCommandsTools } from './commands';
import { registerNavigationTools } from './navigation';
import { registerWorkspaceTools } from './workspace';
import { registerLspTools } from './lsp';
import { registerDebugTools } from './debug';
import { registerTerminalTools } from './terminal';

export function registerAllTools(server: McpServer, context: vscode.ExtensionContext): void {
  registerCommandsTools(server);
  registerNavigationTools(server);
  registerWorkspaceTools(server);
  registerLspTools(server);
  registerDebugTools(server);
  registerTerminalTools(server, context);
}

export function defineTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: ToolDefinition['handler'],
): ToolDefinition {
  return { name, description, inputSchema, handler };
}
