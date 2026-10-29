import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

function isWindowsPath(value: string): boolean {
  return (
    /^[a-z]:[\\/]/i.test(value) ||
    value.startsWith("\\\\") ||
    (process.platform === "win32" && value.startsWith("//"))
  );
}

function pathApi(value: string, preferWindows = false): typeof path.posix | typeof path.win32 {
  if (isWindowsPath(value)) return path.win32;
  if (value.startsWith("/") && !preferWindows) return path.posix;
  return process.platform === "win32" ? path.win32 : path.posix;
}

function realpathWithMissingTail(
  value: string,
  api: typeof path.posix | typeof path.win32,
): string {
  const nativeApi = process.platform === "win32" ? path.win32 : path.posix;
  if (api !== nativeApi || !api.isAbsolute(value)) return value;
  const tail: string[] = [];
  const followedLinks = new Set<string>();
  let ancestor = api.normalize(value);
  while (true) {
    try {
      const realAncestor = fs.realpathSync.native(ancestor);
      return api.join(realAncestor, ...tail.reverse());
    } catch (realpathError) {
      const realpathCode = (realpathError as NodeJS.ErrnoException).code;
      if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(realpathCode ?? "")) {
        throw realpathError;
      }
      let isSymbolicLink = false;
      try {
        isSymbolicLink = fs.lstatSync(ancestor).isSymbolicLink();
      } catch (lstatError) {
        const lstatCode = (lstatError as NodeJS.ErrnoException).code;
        if (!["ENOENT", "ENOTDIR"].includes(lstatCode ?? "")) throw lstatError;
      }
      if (isSymbolicLink) {
        if (followedLinks.has(ancestor)) throw new Error(`Circular symbolic link: ${ancestor}`);
        followedLinks.add(ancestor);
        const target = fs.readlinkSync(ancestor);
        ancestor = api.normalize(
          api.isAbsolute(target) ? target : api.resolve(api.dirname(ancestor), target),
        );
        continue;
      }
      const parent = api.dirname(ancestor);
      if (parent === ancestor) return value;
      tail.push(api.basename(ancestor));
      ancestor = parent;
    }
  }
}

/**
 * Resolve symbolic links segment by segment, the way the OS does, so a `..`
 * after a link applies to the link target rather than to the link's parent.
 * Lexical normalization alone would turn `link/../file` into a different file
 * instead of honouring the traversal.
 */
function resolveSymlinks(value: string, api: typeof path.posix | typeof path.win32): string {
  const nativeApi = process.platform === "win32" ? path.win32 : path.posix;
  if (api !== nativeApi || !api.isAbsolute(value)) return value;
  const root = api.parse(value).root;
  let current = root;
  for (const segment of value.slice(root.length).split(/[\\/]+/)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      current = api.dirname(current);
      continue;
    }
    const candidate = api.join(current, segment);
    let link: string | null = null;
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) link = fs.readlinkSync(candidate);
    } catch {
      // Missing paths stay lexical; the realpath walk handles the rest.
    }
    current = link === null ? candidate : api.resolve(api.dirname(candidate), link);
  }
  return current;
}

function normalizeWithApi(value: string, api: typeof path.posix | typeof path.win32): string {
  const resolved = resolveSymlinks(value, api);
  let normalized = api.normalize(realpathWithMissingTail(resolved, api));
  if (api === path.win32) {
    const root = api.parse(normalized).root;
    if (normalized.length > root.length) normalized = normalized.replace(/[\\/]+$/, "");
    return normalized.toLowerCase();
  }
  return normalized;
}

/** Convert a native filesystem path to a stable, cross-platform display path. */
export function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

/** Normalize path spelling for equality and workspace-boundary comparisons. */
export function normalizePathForComparison(value: string): string {
  return normalizeWithApi(value, pathApi(value));
}

/** Compare filesystem paths, accounting for Windows case and short names. */
export function pathsEqual(a: string, b: string): boolean {
  return normalizePathForComparison(a) === normalizePathForComparison(b);
}

/** Return true when child equals parent or is located below it. */
export function isPathInside(child: string, parent: string): boolean {
  const posixRooted = (value: string) => value.startsWith("/") && !value.startsWith("//");
  const windows =
    isWindowsPath(child) ||
    isWindowsPath(parent) ||
    (process.platform === "win32" && !posixRooted(child) && !posixRooted(parent));
  const api = windows ? path.win32 : path.posix;
  const driveRooted = windows && api.isAbsolute(child) && !isWindowsPath(child);
  const comparisonChild = driveRooted ? api.resolve(api.parse(parent).root, child) : child;
  const normalizedChild = normalizeWithApi(comparisonChild, api);
  const normalizedParent = normalizeWithApi(parent, api);
  const relative = api.relative(normalizedParent, normalizedChild);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative))
  );
}

/**
 * Resolve a file path argument against a specific workspace folder or the first one.
 *
 * - If `input` is absolute, returns it directly (checks workspace boundary).
 * - If relative and a workspace is open, resolves against the workspace folder
 *   named `folderName`, or the first folder if `folderName` is omitted.
 * - Falls back to `path.resolve()` if no workspace folders are open.
 *
 * @param input - Absolute or relative file path.
 * @param folderName - Optional workspace folder reference (for multi-root
 *                     workspaces): the folder name or its full path. If
 *                     provided, resolves relative paths against this folder.
 * @param allowOutsideWorkspace - When true, absolute paths outside all open
 *                     workspace folders are accepted. Used by tools whose
 *                     target is not a workspace file (e.g. breakpoints).
 * @throws If `folderName` is provided but no matching folder exists.
 * @throws If the resolved path escapes all open workspace folders (unless
 *         `allowOutsideWorkspace` is true).
 */
export function resolvePath(
  input: string,
  folderName?: string,
  allowOutsideWorkspace = false,
): vscode.Uri {
  let resolved: string;
  const folders = vscode.workspace.workspaceFolders;
  const posixMockWorkspace =
    process.platform === "win32" &&
    folders?.length &&
    folders.every(
      (folder) => folder.uri.fsPath.startsWith("/") && !isWindowsPath(folder.uri.fsPath),
    );
  const windowsWorkspace =
    process.platform === "win32" && folders?.some((folder) => isWindowsPath(folder.uri.fsPath));
  if (windowsWorkspace && /^[/\\](?![/\\])/.test(input) && !isWindowsPath(input)) {
    throw new Error("Root-relative Windows paths are ambiguous; use a drive-qualified path");
  }
  const api = pathApi(input, process.platform === "win32" && !posixMockWorkspace);
  if (process.platform === "win32" && /^[a-z]:(?![\\/])/i.test(input)) {
    throw new Error("Drive-relative paths are not supported");
  }
  const inputWasAbsolute = api.isAbsolute(input);

  if (inputWasAbsolute) {
    resolved = input;
  } else {
    if (folders && folders.length > 0) {
      if (folderName) {
        const folder = folders.find(
          (f) => f.name === folderName || pathsEqual(f.uri.fsPath, folderName),
        );
        if (!folder) {
          const names = folders.map((f) => `${f.name} (${f.uri.fsPath})`).join(", ");
          throw new Error(
            `Workspace folder '${folderName}' not found. Available folders: ${names || "(none)"}`,
          );
        }
        resolved = pathApi(folder.uri.fsPath).join(folder.uri.fsPath, input);
      } else {
        resolved = pathApi(folders[0].uri.fsPath).join(folders[0].uri.fsPath, input);
      }
    } else {
      if (folderName) {
        throw new Error(
          `Workspace folder '${folderName}' specified but no workspace folders are open`,
        );
      }
      resolved = api.resolve(input);
    }
  }

  // Resolve links and `..` the way the OS does before the boundary check: a
  // lexical `link/../file` passes a prefix check while the OS follows `link`
  // out of the workspace, and normalizing it lexically would silently retarget
  // the call at a different file.
  const resolvedApi = pathApi(resolved, process.platform === "win32" && !posixMockWorkspace);
  resolved = resolvedApi.normalize(resolveSymlinks(resolved, resolvedApi));

  // Enforce workspace boundary: reject paths outside all open workspace folders.
  // When `allowOutsideWorkspace` is set, only ABSOLUTE inputs may leave the
  // workspace — relative inputs still resolve against (and must stay inside) it.
  if (folders && folders.length > 0 && (!allowOutsideWorkspace || !inputWasAbsolute)) {
    const inWorkspace = folders.some((f) => {
      return isPathInside(resolved, f.uri.fsPath);
    });
    if (!inWorkspace) {
      throw new Error(
        `Path '${input}' resolves outside the workspace. Only workspace files are accessible.`,
      );
    }
  }

  return vscode.Uri.file(resolved);
}
