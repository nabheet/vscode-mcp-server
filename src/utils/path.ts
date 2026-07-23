import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Resolve a file path argument against a specific workspace folder or the first one.
 *
 * - If `input` is absolute, returns it directly (checks workspace boundary).
 * - If relative and a workspace is open, resolves against the workspace folder
 *   named `folderName`, or the first folder if `folderName` is omitted.
 * - Falls back to `path.resolve()` if no workspace folders are open.
 *
 * @param input - Absolute or relative file path.
 * @param folderName - Optional workspace folder name (for multi-root workspaces).
 *                     If provided, resolves relative paths against this folder.
 * @throws If `folderName` is provided but no matching folder exists.
 * @throws If the resolved path escapes all open workspace folders.
 */
export function resolvePath(input: string, folderName?: string): vscode.Uri {
  let resolved: string;

  if (path.isAbsolute(input)) {
    resolved = input;
  } else {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      if (folderName) {
        const folder = folders.find(f => f.name === folderName);
        if (!folder) {
          const names = folders.map(f => f.name).join(', ');
          throw new Error(
            `Workspace folder '${folderName}' not found. Available folders: ${names || '(none)'}`,
          );
        }
        resolved = path.join(folder.uri.fsPath, input);
      } else {
        resolved = path.join(folders[0].uri.fsPath, input);
      }
    } else {
      if (folderName) {
        throw new Error(
          `Workspace folder '${folderName}' specified but no workspace folders are open`,
        );
      }
      resolved = path.resolve(input);
    }
  }

  // Enforce workspace boundary: reject paths outside all open workspace folders
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    const normalized = path.normalize(resolved);
    const inWorkspace = folders.some(f => {
      const wsPath = path.normalize(f.uri.fsPath);
      return normalized === wsPath || normalized.startsWith(wsPath + path.sep);
    });
    if (!inWorkspace) {
      throw new Error(`Path '${input}' resolves outside the workspace. Only workspace files are accessible.`);
    }
  }

  return vscode.Uri.file(resolved);
}
