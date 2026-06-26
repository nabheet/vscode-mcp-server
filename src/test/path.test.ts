import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';

// The module under test uses vscode module which is mocked in setup.ts
const { resolvePath } = await import('../utils/path');

describe('resolvePath', () => {
  beforeEach(() => {
    // Reset workspace folders each test
    (vscode.workspace as any).workspaceFolders = undefined;
  });

  it('returns absolute path as-is', () => {
    const result = resolvePath('/foo/bar/baz.ts');
    expect(result.fsPath).toBe('/foo/bar/baz.ts');
  });

  it('resolves relative path against workspace root', () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    const result = resolvePath('src/main.ts');
    expect(result.fsPath).toBe('/workspace/src/main.ts');
  });

  it('uses first workspace folder when multiple exist', () => {
    (vscode.workspace as any).workspaceFolders = [
      { uri: { fsPath: '/workspace1' } },
      { uri: { fsPath: '/workspace2' } },
    ];
    const result = resolvePath('lib/util.ts');
    expect(result.fsPath).toBe('/workspace1/lib/util.ts');
  });

  it('falls back to path.resolve when no workspace', () => {
    // Without workspace folders, uses path.resolve which prepends cwd
    const result = resolvePath('some/file.ts');
    // Should be an absolute path starting with /
    expect(result.fsPath).toBeTruthy();
    expect(result.fsPath).toMatch(/^\//);
    expect(result.fsPath).toContain('some/file.ts');
  });

  it('handles dot-relative paths', () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace' } }];
    const result = resolvePath('./relative/path.ts');
    expect(result.fsPath).toBe('/workspace/relative/path.ts');
  });

  it('rejects parent-relative paths outside workspace', () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/workspace/sub' } }];
    expect(() => resolvePath('../sibling.ts')).toThrow(/outside the workspace/i);
  });

  it('returns Uri with file scheme', () => {
    const result = resolvePath('/foo/bar.ts');
    expect(result.scheme).toBe('file');
  });
});
