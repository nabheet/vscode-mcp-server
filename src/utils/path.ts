import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Resolve a file path argument against the workspace root or use as absolute.
 * If the input is absolute, returns it directly.
 * If relative and a workspace is open, resolves against the first workspace folder.
 * Falls back to `path.resolve()` if no workspace folder is available.
 *
 * Throws if the resolved path is outside all workspace folders when a workspace is open.
 */
export function resolvePath(input: string): vscode.Uri {
  let resolved: string;

  if (path.isAbsolute(input)) {
    resolved = input;
  } else {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length > 0) {
      resolved = path.join(folders[0].uri.fsPath, input);
    } else {
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
