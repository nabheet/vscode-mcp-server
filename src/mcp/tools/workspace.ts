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
          workspaceFolder: { type: 'string', description: 'Optional workspace folder name (for multi-root workspaces). Resolves relative paths against this folder.' },
        },
      },
      async (args) => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          return { content: [{ type: 'text', text: 'No workspace folder open' }], isError: true };
        }

        // Resolve target folder
        let rootUri: vscode.Uri;
        if (args.workspaceFolder) {
          const folder = folders.find(f => f.name === args.workspaceFolder);
          if (!folder) {
            const names = folders.map(f => f.name).join(', ');
            return { content: [{ type: 'text', text: `Workspace folder '${args.workspaceFolder}' not found. Available folders: ${names}` }], isError: true };
          }
          rootUri = folder.uri;
        } else {
          rootUri = folders[0].uri;
        }

        // Apply sub-path if given
        if (args.path) {
          rootUri = vscode.Uri.file(path.join(rootUri.fsPath, String(args.path)));
        }

        const pattern = String(args.pattern || '**/*');
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
          workspaceFolder: { type: 'string', description: 'Optional workspace folder name (for multi-root workspaces). Resolves relative paths against this folder.' },
        },
        required: ['path'],
      },
      async (args) => {
        const uri = resolvePath(String(args.path), args.workspaceFolder ? String(args.workspaceFolder) : undefined);
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
          workspaceFolder: { type: 'string', description: 'Optional workspace folder name (for multi-root workspaces). Resolves relative paths against this folder.' },
        },
        required: ['path', 'content'],
      },
      async (args) => {
        const uri = resolvePath(String(args.path), args.workspaceFolder ? String(args.workspaceFolder) : undefined);
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
          workspaceFolder: { type: 'string', description: 'Optional workspace folder name (for multi-root workspaces). Resolves relative paths against this folder.' },
        },
        required: ['path'],
      },
      async (args) => {
        const uri = resolvePath(String(args.path), args.workspaceFolder ? String(args.workspaceFolder) : undefined);
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
      'Delete a file or directory.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to workspace root)' },
          useTrash: { type: 'boolean', description: 'Move to trash instead of permanent delete (default: true)' },
          recursive: { type: 'boolean', description: 'Recursively delete directories (default: false)' },
          workspaceFolder: { type: 'string', description: 'Optional workspace folder name (for multi-root workspaces). Resolves relative paths against this folder.' },
        },
        required: ['path'],
      },
      async (args) => {
        const uri = resolvePath(String(args.path), args.workspaceFolder ? String(args.workspaceFolder) : undefined);
        const useTrash = args.useTrash !== false;
        const recursive = args.recursive === true;
        try {
          await vscode.workspace.fs.delete(uri, { recursive, useTrash });
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

  server.registerTool(
    defineTool(
      'add_workspace_folder',
      'Add a folder to the workspace (multi-root only). Path is absolute or relative to the workspace file; name defaults to the folder basename.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Folder path (absolute or relative to the workspace file)' },
          name: { type: 'string', description: 'Optional folder name (default: basename of the path)' },
        },
        required: ['path'],
      },
      async (args) => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          return { content: [{ type: 'text', text: 'No workspace open — open a workspace before adding folders' }], isError: true };
        }
        const resolved = resolveFolderPath(String(args.path));
        const uri = vscode.Uri.file(resolved);
        const name = args.name ? String(args.name) : path.basename(resolved);
        if (folders.some((f) => f.name === name)) {
          return { content: [{ type: 'text', text: `Workspace folder '${name}' already exists` }], isError: true };
        }
        if (folders.some((f) => f.uri.fsPath === resolved)) {
          return { content: [{ type: 'text', text: `Path already open: ${resolved}` }], isError: true };
        }
        const ok = await callWhenWorkspaceFoldersConfirmed(() => vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name }));
        if (!ok) {
          return {
            content: [{ type: 'text', text: 'Failed to add workspace folder — adding folders requires a multi-root workspace opened from a .code-workspace file (open the folder with a workspace file first)' }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: `Added workspace folder '${name}' (${resolved}).\n\nCurrent folders:\n${formatWorkspaceFolders()}` }], isError: false };
      },
    ),
  );

  server.registerTool(
    defineTool(
      'update_workspace_folder',
      'Update a workspace folder (rename and/or change its path). Multi-root only. At least one of path/newName is required.',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the workspace folder to update' },
          path: { type: 'string', description: 'New folder path (absolute or relative to the workspace file)' },
          newName: { type: 'string', description: 'New folder name' },
        },
        required: ['name'],
      },
      async (args) => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          return { content: [{ type: 'text', text: 'No workspace folders open' }], isError: true };
        }
        const idx = folders.findIndex((f) => f.name === String(args.name));
        if (idx === -1) {
          return {
            content: [{ type: 'text', text: `Workspace folder '${args.name}' not found. Available folders: ${folders.map((f) => f.name).join(', ')}` }],
            isError: true,
          };
        }
        if (!args.path && !args.newName) {
          return { content: [{ type: 'text', text: 'Provide at least one of `path` or `newName` to update' }], isError: true };
        }
        const current = folders[idx];
        const resolved = args.path ? resolveFolderPath(String(args.path)) : current.uri.fsPath;
        const newName = args.newName ? String(args.newName) : current.name;
        const others = folders.filter((_, i) => i !== idx);
        if (others.some((f) => f.name === newName)) {
          return { content: [{ type: 'text', text: `Workspace folder '${newName}' already exists` }], isError: true };
        }
        if (others.some((f) => f.uri.fsPath === resolved)) {
          return { content: [{ type: 'text', text: `Path already open: ${resolved}` }], isError: true };
        }
        const ok = await replaceWorkspaceFolder(idx, { uri: vscode.Uri.file(resolved), name: newName });
        if (!ok) {
          return {
            content: [{ type: 'text', text: 'Failed to update workspace folder — updating folders requires a multi-root workspace opened from a .code-workspace file' }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: `Updated workspace folder '${args.name}' → '${newName}' (${resolved}).\n\nCurrent folders:\n${formatWorkspaceFolders()}` }], isError: false };
      },
    ),
  );

  server.registerTool(
    defineTool(
      'remove_workspace_folder',
      'Remove a folder from the workspace (multi-root only).',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the workspace folder to remove' },
        },
        required: ['name'],
      },
      async (args) => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          return { content: [{ type: 'text', text: 'No workspace folders open' }], isError: true };
        }
        const idx = folders.findIndex((f) => f.name === String(args.name));
        if (idx === -1) {
          return {
            content: [{ type: 'text', text: `Workspace folder '${args.name}' not found. Available folders: ${folders.map((f) => f.name).join(', ')}` }],
            isError: true,
          };
        }
        const removed = folders[idx];
        const ok = await callWhenWorkspaceFoldersConfirmed(() => vscode.workspace.updateWorkspaceFolders(idx, 1));
        if (!ok) {
          return {
            content: [{ type: 'text', text: 'Failed to remove workspace folder — removing folders requires a multi-root workspace opened from a .code-workspace file' }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: `Removed workspace folder '${removed.name}' (${removed.uri.fsPath}).\n\nCurrent folders:\n${formatWorkspaceFolders()}` }], isError: false };
      },
    ),
  );
}

async function replaceWorkspaceFolder(
  idx: number,
  replacement: { uri: vscode.Uri; name: string },
): Promise<boolean> {
  // VS Code 1.133+ detects same-URI renames (its folder delta compares by
  // index + URI + name), so a single replace call succeeds once the workspace
  // is confirmed. Older hosts compare by URI only and reject same-URI renames
  // — fall back to remove → wait for the change to land → add.
  if (await callWhenWorkspaceFoldersConfirmed(() => vscode.workspace.updateWorkspaceFolders(idx, 1, replacement))) {
    return true;
  }
  if (!(await callWhenWorkspaceFoldersConfirmed(() => vscode.workspace.updateWorkspaceFolders(idx, 1)))) {
    return false;
  }
  await waitForWorkspaceFoldersChange(2000);
  return callWhenWorkspaceFoldersConfirmed(() => vscode.workspace.updateWorkspaceFolders(idx, 0, replacement));
}

/**
 * VS Code's extension host refuses a workspace-folder mutation while a previous
 * one is still unconfirmed (`updateWorkspaceFolders` returns false when the
 * `_unconfirmedWorkspace` guard is set — it is only cleared once the main
 * window acknowledges via `$acceptWorkspaceData`, which fires
 * `onDidChangeWorkspaceFolders`). Retry until the pending change lands.
 */
async function callWhenWorkspaceFoldersConfirmed(
  call: () => boolean,
  attempts = 15,
  waitMs = 200,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (call()) return true;
    await waitForWorkspaceFoldersChange(waitMs);
  }
  return call();
}

function waitForWorkspaceFoldersChange(timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let d: { dispose(): void } | undefined;
    let settled = false;
    d = vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (settled) return;
      settled = true;
      d?.dispose();
      resolve();
    });
    setTimeout(() => {
      if (settled) return;
      settled = true;
      d?.dispose();
      resolve();
    }, timeoutMs);
  });
}

function resolveFolderPath(input: string): string {
  if (path.isAbsolute(input)) return input;
  const wsFile = vscode.workspace.workspaceFile;
  const base =
    wsFile && wsFile.scheme === 'file'
      ? path.dirname(wsFile.fsPath)
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!base) {
    throw new Error('Cannot resolve a relative folder path without a workspace file or workspace folder');
  }
  return path.resolve(base, input);
}

function formatWorkspaceFolders(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return '(no workspace folders)';
  return folders.map((f) => `${f.name}: ${f.uri.fsPath}`).join('\n');
}
