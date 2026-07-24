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

  // ── Multi-root workspace tests ──────────────────────────────────────

  it('resolves relative path against named workspace folder', () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: { fsPath: '/workspace/frontend' } },
      { name: 'backend', uri: { fsPath: '/workspace/backend' } },
    ];
    const result = resolvePath('src/main.ts', 'backend');
    expect(result.fsPath).toBe('/workspace/backend/src/main.ts');
  });

  it('resolves relative path against non-first workspace folder', () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'a', uri: { fsPath: '/workspace/a' } },
      { name: 'b', uri: { fsPath: '/workspace/b' } },
    ];
    const result = resolvePath('lib/util.ts', 'b');
    expect(result.fsPath).toBe('/workspace/b/lib/util.ts');
  });

  it('throws when named workspace folder does not exist', () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: { fsPath: '/workspace/frontend' } },
    ];
    expect(() => resolvePath('src/main.ts', 'nonexistent')).toThrow(/not found/i);
  });

  it('throws when folder name given but no workspace folders open', () => {
    (vscode.workspace as any).workspaceFolders = undefined;
    expect(() => resolvePath('src/main.ts', 'frontend')).toThrow(/no workspace folders are open/i);
  });

  it('uses first folder when folderName omitted in multi-root workspace', () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: { fsPath: '/workspace/frontend' } },
      { name: 'backend', uri: { fsPath: '/workspace/backend' } },
    ];
    const result = resolvePath('src/main.ts');
    expect(result.fsPath).toBe('/workspace/frontend/src/main.ts');
  });

  it('still enforces workspace boundary with named folder', () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: { fsPath: '/workspace/frontend' } },
      { name: 'backend', uri: { fsPath: '/workspace/backend' } },
    ];
    expect(() => resolvePath('../outside.ts', 'frontend')).toThrow(/outside the workspace/i);
  });

  it('accepts absolute path with named folder (folder is ignored but boundary checked)', () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: { fsPath: '/workspace/frontend' } },
    ];
    const result = resolvePath('/workspace/frontend/src/main.ts', 'frontend');
    expect(result.fsPath).toBe('/workspace/frontend/src/main.ts');
  });

  it('rejects absolute path outside workspace even with named folder', () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: { fsPath: '/workspace/frontend' } },
    ];
    expect(() => resolvePath('/etc/passwd', 'frontend')).toThrow(/outside the workspace/i);
  });

  // ── Folder name edge cases ───────────────────────────────────────────

  it('handles empty string folderName (falls back to first folder)', () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: { fsPath: '/workspace/frontend' } },
      { name: 'backend', uri: { fsPath: '/workspace/backend' } },
    ];
    const result = resolvePath('src/main.ts', '');
    expect(result.fsPath).toBe('/workspace/frontend/src/main.ts');
  });

  it('rejects folderName with prefix match (requires exact match)', () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: { fsPath: '/workspace/frontend' } },
      { name: 'backend', uri: { fsPath: '/workspace/backend' } },
    ];
    expect(() => resolvePath('src/main.ts', 'back')).toThrow(/not found/i);
  });

  it('rejects folderName with extra whitespace', () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: { fsPath: '/workspace/frontend' } },
    ];
    expect(() => resolvePath('src/main.ts', ' frontend')).toThrow(/not found/i);
  });
});
