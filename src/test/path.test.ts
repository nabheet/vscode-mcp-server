import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { isPathInside, pathsEqual, toPosixPath } from "../utils/path";

/** Mutable view of the vscode.workspace API that tests patch with mocks. */
type MockWorkspace = {
  workspaceFolders?: { uri: { fsPath: string } }[];
};

// The module under test uses vscode module which is mocked in setup.ts
const { resolvePath } = await import("../utils/path");

describe("resolvePath", () => {
  beforeEach(() => {
    // Reset workspace folders each test
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = undefined;
  });

  it("returns absolute path as-is", () => {
    const result = resolvePath("/foo/bar/baz.ts");
    // With no workspace the host platform decides the separator.
    expect(toPosixPath(result.fsPath)).toBe("/foo/bar/baz.ts");
  });

  it("resolves relative path against workspace root", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { uri: { fsPath: "/workspace" } },
    ];
    const result = resolvePath("src/main.ts");
    expect(result.fsPath).toBe("/workspace/src/main.ts");
  });

  it("uses first workspace folder when multiple exist", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { uri: { fsPath: "/workspace1" } },
      { uri: { fsPath: "/workspace2" } },
    ];
    const result = resolvePath("lib/util.ts");
    expect(result.fsPath).toBe("/workspace1/lib/util.ts");
  });

  it("falls back to path.resolve when no workspace", () => {
    // Without workspace folders, uses path.resolve which prepends cwd
    const result = resolvePath("some/file.ts");
    // Must remain absolute on both POSIX and Windows.
    expect(result.fsPath).toBeTruthy();
    expect(path.isAbsolute(result.fsPath)).toBe(true);
    expect(toPosixPath(result.fsPath)).toContain("some/file.ts");
  });

  it("handles dot-relative paths", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { uri: { fsPath: "/workspace" } },
    ];
    const result = resolvePath("./relative/path.ts");
    expect(result.fsPath).toBe("/workspace/relative/path.ts");
  });

  it("rejects parent-relative paths outside workspace", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { uri: { fsPath: "/workspace/sub" } },
    ];
    expect(() => resolvePath("../sibling.ts")).toThrow(/outside the workspace/i);
  });

  it("returns Uri with file scheme", () => {
    const result = resolvePath("/foo/bar.ts");
    expect(result.scheme).toBe("file");
  });

  // ── Multi-root workspace tests ──────────────────────────────────────

  it("resolves relative path against named workspace folder", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { name: "frontend", uri: { fsPath: "/workspace/frontend" } },
      { name: "backend", uri: { fsPath: "/workspace/backend" } },
    ];
    const result = resolvePath("src/main.ts", "backend");
    expect(result.fsPath).toBe("/workspace/backend/src/main.ts");
  });

  it("resolves relative path against non-first workspace folder", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { name: "a", uri: { fsPath: "/workspace/a" } },
      { name: "b", uri: { fsPath: "/workspace/b" } },
    ];
    const result = resolvePath("lib/util.ts", "b");
    expect(result.fsPath).toBe("/workspace/b/lib/util.ts");
  });

  it("resolves relative path against a folder given as a full path", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { name: "a", uri: { fsPath: "/workspace/a" } },
      { name: "b", uri: { fsPath: "/workspace/b" } },
    ];
    const result = resolvePath("lib/util.ts", "/workspace/b");
    expect(result.fsPath).toBe("/workspace/b/lib/util.ts");
  });

  it("throws when folder path does not match any open folder", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { name: "frontend", uri: { fsPath: "/workspace/frontend" } },
    ];
    expect(() => resolvePath("src/main.ts", "/other/path")).toThrow(/not found/i);
  });

  it("throws when named workspace folder does not exist", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { name: "frontend", uri: { fsPath: "/workspace/frontend" } },
    ];
    expect(() => resolvePath("src/main.ts", "nonexistent")).toThrow(/not found/i);
  });

  it("throws when folder name given but no workspace folders open", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = undefined;
    expect(() => resolvePath("src/main.ts", "frontend")).toThrow(/no workspace folders are open/i);
  });

  it("uses first folder when folderName omitted in multi-root workspace", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { name: "frontend", uri: { fsPath: "/workspace/frontend" } },
      { name: "backend", uri: { fsPath: "/workspace/backend" } },
    ];
    const result = resolvePath("src/main.ts");
    expect(result.fsPath).toBe("/workspace/frontend/src/main.ts");
  });

  it("still enforces workspace boundary with named folder", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { name: "frontend", uri: { fsPath: "/workspace/frontend" } },
      { name: "backend", uri: { fsPath: "/workspace/backend" } },
    ];
    expect(() => resolvePath("../outside.ts", "frontend")).toThrow(/outside the workspace/i);
  });

  it("accepts absolute path with named folder (folder is ignored but boundary checked)", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { name: "frontend", uri: { fsPath: "/workspace/frontend" } },
    ];
    const result = resolvePath("/workspace/frontend/src/main.ts", "frontend");
    expect(result.fsPath).toBe("/workspace/frontend/src/main.ts");
  });

  it("rejects absolute path outside workspace even with named folder", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { name: "frontend", uri: { fsPath: "/workspace/frontend" } },
    ];
    expect(() => resolvePath("/etc/passwd", "frontend")).toThrow(/outside the workspace/i);
  });

  // ── Folder name edge cases ───────────────────────────────────────────

  it("handles empty string folderName (falls back to first folder)", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { name: "frontend", uri: { fsPath: "/workspace/frontend" } },
      { name: "backend", uri: { fsPath: "/workspace/backend" } },
    ];
    const result = resolvePath("src/main.ts", "");
    expect(result.fsPath).toBe("/workspace/frontend/src/main.ts");
  });

  it("rejects folderName with prefix match (requires exact match)", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { name: "frontend", uri: { fsPath: "/workspace/frontend" } },
      { name: "backend", uri: { fsPath: "/workspace/backend" } },
    ];
    expect(() => resolvePath("src/main.ts", "back")).toThrow(/not found/i);
  });

  it("rejects folderName with extra whitespace", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { name: "frontend", uri: { fsPath: "/workspace/frontend" } },
    ];
    expect(() => resolvePath("src/main.ts", " frontend")).toThrow(/not found/i);
  });

  it("compares Windows paths without case or slash sensitivity", () => {
    expect(pathsEqual("C:\\Work\\Runner\\Project", "c:/work/runner/project/")).toBe(true);
  });

  it("does not apply Windows case folding to POSIX double-slash paths", () => {
    if (process.platform === "win32") return;
    expect(pathsEqual("//server/Folder", "//server/folder")).toBe(false);
  });

  it("enforces Windows workspace boundaries by path segment", () => {
    expect(isPathInside("c:\\work\\project\\src\\main.ts", "C:\\Work\\Project")).toBe(true);
    expect(isPathInside("C:\\Work\\ProjectSibling\\file.ts", "C:\\Work\\Project")).toBe(false);
  });

  it("checks Windows root-relative paths against the workspace drive", () => {
    expect(isPathInside("/work/project/src/main.ts", "C:\\Work\\Project")).toBe(true);
    expect(isPathInside("/work/project-sibling/file.ts", "C:\\Work\\Project")).toBe(false);
  });

  it("rejects a workspace path that follows a symlink outside the root", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "path-boundary-"));
    const workspace = path.join(tempDir, "workspace");
    const outside = path.join(tempDir, "outside");
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    const link = path.join(workspace, "linked");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    try {
      expect(isPathInside(path.join(link, "file.txt"), workspace)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("collapses traversal so a symlink cannot redirect the returned path", () => {
    if (process.platform === "win32") return;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "path-traversal-"));
    const workspace = path.join(tempDir, "workspace");
    const outside = path.join(tempDir, "outside");
    fs.mkdirSync(workspace);
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(workspace, "link"), "dir");
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { uri: { fsPath: workspace } },
    ];
    try {
      // The raw string keeps `..` after the symlink; path.join would drop it.
      const result = resolvePath(`${workspace}/link/../outside/secret.txt`);
      expect(result.fsPath).not.toContain("..");
      expect(result.fsPath.startsWith(`${workspace}${path.sep}`)).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a path through a dangling symlink outside the workspace", () => {
    if (process.platform === "win32") return;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "path-dangling-"));
    const workspace = path.join(tempDir, "workspace");
    const outside = path.join(tempDir, "outside", "missing");
    fs.mkdirSync(workspace);
    fs.symlinkSync(outside, path.join(workspace, "linked"), "dir");
    try {
      expect(isPathInside(path.join(workspace, "linked", "new-file.txt"), workspace)).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("matches a Windows workspace folder path case-insensitively", () => {
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { name: "backend", uri: { fsPath: "C:\\Work\\Backend" } },
    ];
    const result = resolvePath("src\\main.ts", "c:\\work\\backend");
    expect(result.fsPath).toBe("C:\\Work\\Backend\\src\\main.ts");
  });

  it("rejects root-relative and drive-relative Windows inputs", () => {
    if (process.platform !== "win32") return;
    (vscode.workspace as unknown as MockWorkspace).workspaceFolders = [
      { name: "workspace", uri: { fsPath: "C:\\Work\\Project" } },
    ];
    expect(() => resolvePath("/Work/Project/src/main.ts")).toThrow(/drive-qualified/i);
    expect(() => resolvePath("C:\\outside\\file.ts")).toThrow(/outside the workspace/i);
    expect(() => resolvePath("C:relative\\file.ts")).toThrow(/Drive-relative/i);
  });
});
