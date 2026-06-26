import * as vscode from 'vscode';
import * as path from 'path';

/**
 * Resolve a file path argument against the workspace root or use as absolute.
 * If the input is absolute, returns it directly.
 * If relative and a workspace is open, resolves against the first workspace folder.
 * Falls back to `path.resolve()` if no workspace folder is available.
 */
export function resolvePath(input: string): vscode.Uri {
  if (path.isAbsolute(input)) {
    return vscode.Uri.file(input);
  }
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return vscode.Uri.file(path.join(folders[0].uri.fsPath, input));
  }
  return vscode.Uri.file(path.resolve(input));
}
