import * as vscode from 'vscode';
import { McpServer } from '../server';
import { defineTool } from './index';

export function registerCommandsTools(server: McpServer): void {
  server.registerTool(
    defineTool(
      'execute_command',
      'Execute any VS Code command by its ID. Returns the command result as a string.',
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'VS Code command ID (e.g. "workbench.action.files.newUntitledFile")',
          },
          args: {
            type: 'array',
            description: 'Optional arguments to pass to the command',
            items: {},
          },
        },
        required: ['command'],
      },
      async (args) => {
        const command = String(args.command);
        const cmdArgs = Array.isArray(args.args) ? args.args : [];
        console.warn('[vscode-mcp-server] execute_command: ' + command + ' args=' + JSON.stringify(cmdArgs));
        try {
          const result = await vscode.commands.executeCommand(command, ...cmdArgs);
          const MAX_RESULT_CHARS = 100_000;
          let text = result === undefined
            ? `Command '${command}' executed successfully (no return value)`
            : `Command '${command}' returned: ${JSON.stringify(result)}`;
          if (text.length > MAX_RESULT_CHARS) {
            text = text.slice(0, MAX_RESULT_CHARS) + '\n…result truncated at 100 KB…';
          }
          return { content: [{ type: 'text', text }], isError: false };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: [{ type: 'text', text: `Command '${command}' failed: ${msg}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'list_commands',
      'List all available VS Code commands. Optionally filter to internal commands.',
      {
        type: 'object',
        properties: {
          includeInternal: {
            type: 'boolean',
            description: 'Include internal commands (default: false)',
          },
        },
      },
      async (args) => {
        const internal = args.includeInternal === true;
        const commands = await vscode.commands.getCommands(internal);
        // VS Code registers thousands of commands (esp. with extensions) —
        // cap the dump so the MCP round trip stays bounded.
        const MAX_COMMANDS = 200;
        const capped = commands.length > MAX_COMMANDS;
        const list = capped ? commands.slice(0, MAX_COMMANDS) : commands;
        const text = JSON.stringify(list, null, 2);
        const note = capped
          ? `\n…${commands.length - MAX_COMMANDS} more commands omitted (showing first ${MAX_COMMANDS} of ${commands.length})`
          : '';
        return {
          content: [{ type: 'text', text: text + note }],
          isError: false,
        };
      },
    ),
  );
}
