import type * as vscode from "vscode";
import type { ToolDefinition } from "../../utils/types";
import type { McpServer } from "../server";

import { registerCommandsTools } from "./commands";
import { registerDebugTools } from "./debug";
import { registerLogsTools } from "./logs";
import { registerLspTools } from "./lsp";
import { registerNavigationTools } from "./navigation";
import { registerSearchTools } from "./search";
import { registerTerminalTools } from "./terminal";
import { registerWorkspaceTools } from "./workspace";

export function registerAllTools(server: McpServer, context: vscode.ExtensionContext): void {
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
  handler: ToolDefinition["handler"],
  timeoutMs?: number,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema,
    handler,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}
