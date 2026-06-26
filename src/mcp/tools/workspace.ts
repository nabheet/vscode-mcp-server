import * as vscode from 'vscode';
import * as path from 'path';
import { McpServer } from '../server';
import { defineTool } from './index';
import { resolvePath } from '../../utils/path';

export function registerWorkspaceTools(server: McpServer): void {
  server.registerTool(
    defineTool(
      'list_files',
      'List files and directories in a workspace path using glob pattern.',
      {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob pattern (default: "**/*")' },
          path: { type: 'string', description: 'Root directory relative to workspace (default: workspace root)' },
        },
      },
      async (args) => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          return { content: [{ type: 'text', text: 'No workspace folder open' }], isError: true };
        }

        const pattern = String(args.pattern || '**/*');
        const rootUri = args.path
          ? vscode.Uri.file(path.join(folders[0].uri.fsPath, String(args.path)))
          : folders[0].uri;

        try {
          const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(rootUri, pattern),
            '**/node_modules/**',
            1000,
          );
          const lines = files.map((f) => f.fsPath).sort();
          return { content: [{ type: 'text', text: lines.join('\n') || '(no files found)' }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'read_file',
      'Read the contents of a file.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to workspace root)' },
        },
        required: ['path'],
      },
      async (args) => {
        const uri = resolvePath(String(args.path));
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const text = Buffer.from(bytes).toString('utf-8');
          return { content: [{ type: 'text', text }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to read file: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'write_file',
      'Write content to a file (creates or overwrites).',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to workspace root)' },
          content: { type: 'string', description: 'File content' },
        },
        required: ['path', 'content'],
      },
      async (args) => {
        const uri = resolvePath(String(args.path));
        const content = String(args.content);
        const MAX_WRITE_SIZE = 1 * 1024 * 1024; // 1 MB
        if (content.length > MAX_WRITE_SIZE) {
          return { content: [{ type: 'text', text: `Content too large: ${content.length} bytes (max ${MAX_WRITE_SIZE})` }], isError: true };
        }
        try {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
          return { content: [{ type: 'text', text: `Written ${uri.fsPath}` }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to write: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'create_file',
      'Create a new empty file.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to workspace root)' },
        },
        required: ['path'],
      },
      async (args) => {
        const uri = resolvePath(String(args.path));
        try {
          // Check if file already exists
          try {
            await vscode.workspace.fs.stat(uri);
            return { content: [{ type: 'text', text: `File already exists: ${uri.fsPath}` }], isError: true };
          } catch { /* stat fails → file doesn't exist, proceed */ }
          // Ensure parent directory exists
          const parent = vscode.Uri.file(path.dirname(uri.fsPath));
          try {
            await vscode.workspace.fs.createDirectory(parent);
          } catch { /* may already exist */ }
          await vscode.workspace.fs.writeFile(uri, new Uint8Array());
          return { content: [{ type: 'text', text: `Created ${uri.fsPath}` }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to create: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'delete_file',
      'Delete a file.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to workspace root)' },
          useTrash: { type: 'boolean', description: 'Move to trash instead of permanent delete (default: true)' },
        },
        required: ['path'],
      },
      async (args) => {
        const uri = resolvePath(String(args.path));
        const useTrash = args.useTrash !== false;
        try {
          await vscode.workspace.fs.delete(uri, { recursive: false, useTrash });
          return { content: [{ type: 'text', text: `Deleted ${uri.fsPath}${useTrash ? ' (moved to trash)' : ''}` }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to delete: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'get_workspace_folders',
      'Get the list of open workspace folders.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          return { content: [{ type: 'text', text: 'No workspace folders open' }], isError: false };
        }
        const lines = folders.map((f) => `${f.name}: ${f.uri.fsPath}`);
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
      },
    ),
  );
}
