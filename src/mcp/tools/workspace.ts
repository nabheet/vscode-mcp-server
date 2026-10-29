import * as path from "node:path";
import * as vscode from "vscode";
import { normalizePathForComparison, pathsEqual, resolvePath, toPosixPath } from "../../utils/path";
import { defineTool, type ToolRegistrar } from "./index";

/** Upper bound for a single created-file payload in `apply_workspace_edit`. */
const MAX_EDIT_CONTENT_SIZE = 1 * 1024 * 1024; // 1 MB

interface ParsedTextEdit {
  start: vscode.Position;
  end: vscode.Position;
  newText: string;
}

type PlannedEdit =
  | { kind: "textEdits"; uri: vscode.Uri; label: string; textEdits: ParsedTextEdit[] }
  | { kind: "create"; uri: vscode.Uri; label: string; content: string }
  | { kind: "delete"; uri: vscode.Uri; label: string };

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface PathStat {
  exists: boolean;
  isDirectory: boolean;
}

/** Stat a path, treating only "not found" as absence (other errors propagate as text). */
async function statPath(uri: vscode.Uri): Promise<PathStat | string> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    const directoryBit =
      typeof vscode.FileType?.Directory === "number" ? vscode.FileType.Directory : 2;
    return {
      exists: true,
      isDirectory: typeof stat?.type === "number" && (stat.type & directoryBit) !== 0,
    };
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "FileNotFound" || code === "ENOENT") return { exists: false, isDirectory: false };
    return `failed to stat path: ${errorMessage(err)}`;
  }
}

interface FileMetrics {
  lineCount: number;
  lineLengths: number[];
}

/**
 * File identity used throughout the batch: duplicate detection, the live
 * document lookup and the save step must all agree, or a differently spelled
 * path can bypass one of them.
 */
/** Comparison key for a path; an unreadable document must not fail the batch. */
function normalizeForIdentity(value: string): string {
  try {
    return normalizePathForComparison(value);
  } catch {
    return path.normalize(value).toLowerCase();
  }
}

function uriKey(uri: vscode.Uri): string {
  // Scheme stays in the key: a `git:` diff document for the same fsPath is a
  // different document and must never shadow the user's file buffer.
  const pathKey =
    process.platform === "win32" ? normalizeForIdentity(uri.fsPath) : path.normalize(uri.fsPath);
  const normalized = `${uri.scheme ?? "file"}:${pathKey.normalize("NFC")}`;
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

/** The open document for `uri`, matched by file identity (not raw URI string). */
function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uriKey(uri);
  return vscode.workspace.textDocuments?.find((doc) => uriKey(doc.uri) === key);
}

/**
 * Line metrics for the document the edit will apply to.
 *
 * An already-open document wins because that is what the edit mutates. Never
 * open one here: `openTextDocument` would turn a pending disk write into an
 * unsaved buffer.
 */
async function fileMetrics(uri: vscode.Uri): Promise<FileMetrics | string> {
  const openDoc = openDocument(uri);
  if (openDoc) {
    const lineLengths: number[] = [];
    for (let i = 0; i < openDoc.lineCount; i++) lineLengths.push(openDoc.lineAt(i).text.length);
    return { lineCount: openDoc.lineCount, lineLengths };
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const lines = Buffer.from(bytes).toString("utf-8").split("\n");
    return {
      lineCount: lines.length,
      lineLengths: lines.map((line) => (line.endsWith("\r") ? line.length - 1 : line.length)),
    };
  } catch (err) {
    return `failed to read file for validation: ${errorMessage(err)}`;
  }
}

/** Parse + validate the `textEdits` payload; returns an error message on failure. */
function parseTextEdits(raw: unknown): ParsedTextEdit[] | string {
  if (!Array.isArray(raw) || raw.length === 0) {
    return "`textEdits` must be a non-empty array";
  }
  const parsed: ParsedTextEdit[] = [];
  for (const [i, item] of raw.entries()) {
    const te = item as { range?: unknown; newText?: unknown } | null;
    if (!te || typeof te !== "object") return `textEdits[${i}] must be an object`;
    if (typeof te.newText !== "string") return `textEdits[${i}].newText must be a string`;
    const range = te.range as
      | {
          start?: { line?: unknown; character?: unknown };
          end?: { line?: unknown; character?: unknown };
        }
      | undefined;
    const start = range?.start;
    const end = range?.end;
    if (!start || !end) return `textEdits[${i}].range requires both \`start\` and \`end\``;
    for (const [name, pos] of [
      ["start", start],
      ["end", end],
    ] as const) {
      const { line, character } = pos;
      if (
        typeof line !== "number" ||
        typeof character !== "number" ||
        !Number.isInteger(line) ||
        !Number.isInteger(character) ||
        line < 0 ||
        character < 0
      ) {
        return `textEdits[${i}].range.${name} requires non-negative integer \`line\` and \`character\``;
      }
    }
    const startPos = new vscode.Position(start.line as number, start.character as number);
    const endPos = new vscode.Position(end.line as number, end.character as number);
    if (
      (end.line as number) < (start.line as number) ||
      ((end.line as number) === (start.line as number) &&
        (end.character as number) < (start.character as number))
    ) {
      return `textEdits[${i}].range.end must not precede range.start`;
    }
    parsed.push({ start: startPos, end: endPos, newText: te.newText });
  }
  // VS Code rejects overlapping edits in one file; catch it here so the error
  // names the offending entries instead of failing the whole apply opaquely.
  const ordered = parsed
    .map((te, index) => ({ te, index }))
    .sort((a, b) =>
      a.te.start.line === b.te.start.line
        ? a.te.start.character - b.te.start.character
        : a.te.start.line - b.te.start.line,
    );
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1].te;
    const next = ordered[i].te;
    const nextStartsBeforePrevEnds =
      next.start.line < prev.end.line ||
      (next.start.line === prev.end.line && next.start.character < prev.end.character);
    if (nextStartsBeforePrevEnds) {
      return `textEdits[${ordered[i - 1].index}] and textEdits[${ordered[i].index}] overlap`;
    }
  }
  return parsed;
}

/** Reject ranges that point past the end of the file or line, before any edit applies. */
async function checkRangesAgainstFile(
  uri: vscode.Uri,
  edits: ParsedTextEdit[],
): Promise<string | undefined> {
  const metrics = await fileMetrics(uri);
  if (typeof metrics === "string") return metrics;
  for (const [i, te] of edits.entries()) {
    if (te.start.line >= metrics.lineCount || te.end.line >= metrics.lineCount) {
      return `textEdits[${i}].range is outside the file (${metrics.lineCount} line(s))`;
    }
    if (te.start.character > metrics.lineLengths[te.start.line]) {
      return `textEdits[${i}].range.start.character ${te.start.character} exceeds line ${te.start.line} length (${metrics.lineLengths[te.start.line]})`;
    }
    if (te.end.character > metrics.lineLengths[te.end.line]) {
      return `textEdits[${i}].range.end.character ${te.end.character} exceeds line ${te.end.line} length (${metrics.lineLengths[te.end.line]})`;
    }
  }
  return undefined;
}

/** Where `read_file`/`read_files` take their bytes from. */
type ReadSource = "disk" | "editor" | "auto";

const UNTITLED_URI_RE = /^untitled:/i;

function openDocumentFor(uri: vscode.Uri): vscode.TextDocument | undefined {
  const documents = vscode.workspace.textDocuments ?? [];
  return documents.find(
    (doc) =>
      doc.uri.scheme === uri.scheme &&
      (doc.uri.toString() === uri.toString() || doc.uri.path === uri.path),
  );
}

function sourceArg(value: unknown): ReadSource {
  const raw = typeof value === "string" ? value.toLowerCase() : "auto";
  if (raw === "disk" || raw === "editor" || raw === "auto") return raw;
  throw new Error(`Unknown source '${String(value)}'. Use "disk", "editor" or "auto".`);
}

/**
 * Read one path the way `read_file` promises: `disk` reads the file,
 * `editor` reads the open document (unsaved buffer included), `auto` prefers
 * the open document and falls back to disk. `untitled:` URIs only exist in an
 * editor, so `disk` is an error for them.
 */
async function readPathText(
  input: string,
  folderName: string | undefined,
  source: ReadSource,
): Promise<{ text: string; label: string; fromEditor: boolean; dirty: boolean }> {
  if (UNTITLED_URI_RE.test(input)) {
    if (source === "disk") {
      throw new Error('Untitled buffers exist only in the editor; use source "editor" or "auto"');
    }
    const uri = vscode.Uri.parse(input);
    const doc = openDocumentFor(uri);
    if (!doc) throw new Error(`No open editor for ${input}`);
    return { text: doc.getText(), label: input, fromEditor: true, dirty: doc.isDirty === true };
  }

  const uri = resolvePath(input, folderName);
  if (source !== "disk") {
    const doc = openDocumentFor(uri);
    if (doc) {
      return {
        text: doc.getText(),
        label: toPosixPath(uri.fsPath),
        fromEditor: true,
        dirty: doc.isDirty === true,
      };
    }
    if (source === "editor") {
      throw new Error(`No open editor for ${toPosixPath(uri.fsPath)}`);
    }
  }
  const bytes = await vscode.workspace.fs.readFile(uri);
  return {
    text: Buffer.from(bytes).toString("utf-8"),
    label: toPosixPath(uri.fsPath),
    fromEditor: false,
    dirty: false,
  };
}

const EDITOR_SOURCE_NOTICE = "--- read from the open editor (unsaved changes) ---\n";

export function registerWorkspaceTools(server: ToolRegistrar): void {
  server.registerTool(
    defineTool(
      "list_files",
      "List files and directories in a workspace path using glob pattern.",
      {
        type: "object",
        properties: {
          pattern: { type: "string", description: 'Glob pattern (default: "**/*")' },
          path: {
            type: "string",
            description:
              "Root directory (absolute, or relative to the workspace folder). Default: workspace folder root.",
          },
          workspaceFolder: {
            type: "string",
            description:
              "Optional workspace folder name (for multi-root workspaces). Resolves relative paths against this folder.",
          },
        },
      },
      async (args) => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          return { content: [{ type: "text", text: "No workspace folder open" }], isError: true };
        }

        // Resolve the root the same way read/write tools do: absolute paths are
        // taken as-is (and may target the window that owns them, via cluster
        // routing), relative paths resolve against the selected folder.
        let rootUri: vscode.Uri;
        try {
          rootUri = resolvePath(
            args.path ? String(args.path) : ".",
            args.workspaceFolder ? String(args.workspaceFolder) : undefined,
          );
        } catch (err) {
          return {
            content: [{ type: "text", text: errorMessage(err) }],
            isError: true,
          };
        }

        const pattern = String(args.pattern || "**/*");
        try {
          const files = await vscode.workspace.findFiles(
            new vscode.RelativePattern(rootUri, pattern),
            "**/node_modules/**",
            1000,
          );
          const lines = files.map((f) => f.fsPath).sort();
          return {
            content: [{ type: "text", text: lines.join("\n") || "(no files found)" }],
            isError: false,
          };
        } catch (err) {
          return {
            content: [
              { type: "text", text: `Failed: ${err instanceof Error ? err.message : String(err)}` },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "read_file",
      'Read the contents of a file, or of an open editor buffer that is not saved yet. `source: "disk"` reads the file, `"editor"` reads the open document (including unsaved changes), `"auto"` (default) prefers the open document and falls back to disk. An `untitled:` URI from get_open_editors is readable with `"editor"` or `"auto"`. When unsaved editor content is returned, a one-line notice precedes it.',
      {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "File path (absolute or relative to workspace root), or an untitled: URI from get_open_editors",
          },
          workspaceFolder: {
            type: "string",
            description:
              "Optional workspace folder name (for multi-root workspaces). Resolves relative paths against this folder.",
          },
          source: {
            type: "string",
            enum: ["disk", "editor", "auto"],
            description:
              'Where to read from: "disk" (file on disk), "editor" (open document, unsaved changes included), "auto" (default: editor when the document is open, else disk).',
          },
        },
        required: ["path"],
      },
      async (args) => {
        let source: ReadSource;
        try {
          source = sourceArg(args.source);
        } catch (err) {
          return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
        }
        try {
          const result = await readPathText(
            String(args.path),
            args.workspaceFolder ? String(args.workspaceFolder) : undefined,
            source,
          );
          const notice = result.fromEditor && result.dirty ? EDITOR_SOURCE_NOTICE : "";
          return { content: [{ type: "text", text: `${notice}${result.text}` }], isError: false };
        } catch (err) {
          return {
            content: [{ type: "text", text: `Failed to read file: ${errorMessage(err)}` }],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "read_files",
      'Read the contents of multiple files in one call, including `untitled:` buffers. Each result is prefixed with a "=== <path> ===" marker. Missing/unreadable files are reported inline without aborting the batch. When unsaved editor content is returned, a one-line notice precedes it.',
      {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: {
              type: "string",
              description:
                "File path (absolute or relative to workspace root), or an untitled: URI from get_open_editors",
            },
            description:
              "File paths to read (absolute or relative to workspace root), or untitled: URIs",
          },
          workspaceFolder: {
            type: "string",
            description:
              "Optional workspace folder name (for multi-root workspaces). Resolves relative paths against this folder.",
          },
          source: {
            type: "string",
            enum: ["disk", "editor", "auto"],
            description:
              'Where to read from: "disk" (file on disk), "editor" (open document, unsaved changes included), "auto" (default: editor when the document is open, else disk).',
          },
        },
        required: ["paths"],
      },
      async (args) => {
        const paths: string[] = Array.isArray(args.paths) ? args.paths.map(String) : [];
        if (paths.length === 0) {
          return { content: [{ type: "text", text: "No paths provided" }], isError: true };
        }
        let source: ReadSource;
        try {
          source = sourceArg(args.source);
        } catch (err) {
          return { content: [{ type: "text", text: errorMessage(err) }], isError: true };
        }
        const folderName = args.workspaceFolder ? String(args.workspaceFolder) : undefined;
        const parts: string[] = [];
        let failures = 0;
        for (const p of paths) {
          try {
            const result = await readPathText(p, folderName, source);
            const notice = result.fromEditor && result.dirty ? EDITOR_SOURCE_NOTICE : "";
            parts.push(`=== ${result.label} ===\n${notice}${result.text}`);
          } catch (err) {
            failures++;
            parts.push(`=== ${p} ===\n[error: ${errorMessage(err)}]`);
          }
        }
        return { content: [{ type: "text", text: parts.join("\n\n") }], isError: failures > 0 };
      },
    ),
  );

  server.registerTool(
    defineTool(
      "apply_workspace_edit",
      "Apply multiple edits across files in one VS Code WorkspaceEdit call. Each entry is either a list of text edits at ranges, a file creation (with optional content), or a file deletion, and each path may appear once per batch. All entries are validated first; if any entry is invalid nothing is applied and per-file errors are reported inline. On success the whole batch is applied as a single undo step, and edited buffers are saved to disk unless the file already had unsaved changes.",
      {
        type: "object",
        properties: {
          edits: {
            type: "array",
            description:
              "Batch of file edits applied atomically. Each entry must set exactly one of `textEdits`, `create: true`, or `delete: true`.",
            items: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "File path (absolute or relative to workspace root)",
                },
                workspaceFolder: {
                  type: "string",
                  description:
                    "Optional workspace folder name (for multi-root workspaces). Resolves a relative path against this folder.",
                },
                textEdits: {
                  type: "array",
                  description:
                    "Text edits applied to an existing file. Ranges are 0-based (line, character) and applied in one group.",
                  items: {
                    type: "object",
                    properties: {
                      range: {
                        type: "object",
                        properties: {
                          start: {
                            type: "object",
                            properties: {
                              line: { type: "number", description: "0-based line number" },
                              character: { type: "number", description: "0-based column" },
                            },
                            required: ["line", "character"],
                          },
                          end: {
                            type: "object",
                            properties: {
                              line: { type: "number", description: "0-based line number" },
                              character: { type: "number", description: "0-based column" },
                            },
                            required: ["line", "character"],
                          },
                        },
                        required: ["start", "end"],
                      },
                      newText: {
                        type: "string",
                        description: "Replacement text (empty string deletes)",
                      },
                    },
                    required: ["range", "newText"],
                  },
                },
                create: {
                  type: "boolean",
                  description: "Create the file (fails atomically if it already exists)",
                },
                content: {
                  type: "string",
                  description:
                    "Initial content for a created file (ignored unless `create` is true)",
                },
                delete: {
                  type: "boolean",
                  description: "Delete the file (fails atomically if missing)",
                },
              },
              required: ["path"],
            },
          },
        },
        required: ["edits"],
      },
      async (args) => {
        const raw = Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : [];
        if (raw.length === 0) {
          return { content: [{ type: "text", text: "No edits provided" }], isError: true };
        }

        const problems: string[] = [];
        const planned: PlannedEdit[] = [];
        const seenUris = new Set<string>();

        for (const entry of raw) {
          const label =
            typeof entry?.path === "string" && entry.path ? entry.path : "(missing path)";
          const fail = (message: string) => {
            problems.push(`=== ${label} ===\n[error: ${message}]`);
          };

          if (typeof entry?.path !== "string" || entry.path.length === 0) {
            fail("edit entry requires a non-empty string `path`");
            continue;
          }

          let uri: vscode.Uri;
          try {
            uri = resolvePath(
              entry.path,
              entry.workspaceFolder ? String(entry.workspaceFolder) : undefined,
            );
          } catch (err) {
            fail(errorMessage(err));
            continue;
          }

          // One entry per file: VS Code rejects batches that delete and then
          // edit the same URI, and duplicate creates would concatenate content.
          const key = uriKey(uri);
          if (seenUris.has(key)) {
            fail("duplicate entry for the same file (edit each path once per batch)");
            continue;
          }
          seenUris.add(key);

          const hasTextEdits = entry.textEdits !== undefined;
          const hasCreate = entry.create === true;
          const hasDelete = entry.delete === true;
          const modes = [hasTextEdits, hasCreate, hasDelete].filter(Boolean).length;
          if (modes === 0) {
            fail("edit entry requires one of `textEdits`, `create: true`, or `delete: true`");
            continue;
          }
          if (modes > 1) {
            fail("edit entry sets more than one of `textEdits`, `create`, `delete`");
            continue;
          }

          if (hasDelete) {
            const stat = await statPath(uri);
            if (typeof stat === "string") {
              fail(stat);
              continue;
            }
            if (!stat.exists) {
              fail("file does not exist");
              continue;
            }
            if (stat.isDirectory) {
              fail("path is a directory (only files can be deleted here)");
              continue;
            }
            const openDelete = openDocument(uri);
            if (openDelete?.isDirty === true) {
              fail("file has unsaved changes in an open editor; save or close it before deleting");
              continue;
            }
            planned.push({ kind: "delete", uri, label });
            continue;
          }

          if (hasCreate) {
            const stat = await statPath(uri);
            if (typeof stat === "string") {
              fail(stat);
              continue;
            }
            if (stat.exists) {
              fail("file already exists");
              continue;
            }
            const content = typeof entry.content === "string" ? entry.content : "";
            const bytes = Buffer.byteLength(content, "utf-8");
            if (bytes > MAX_EDIT_CONTENT_SIZE) {
              fail(`content too large: ${bytes} bytes (max ${MAX_EDIT_CONTENT_SIZE})`);
              continue;
            }
            planned.push({ kind: "create", uri, label, content });
            continue;
          }

          const parsed = parseTextEdits(entry.textEdits);
          if (typeof parsed === "string") {
            fail(parsed);
            continue;
          }
          const stat = await statPath(uri);
          if (typeof stat === "string") {
            fail(stat);
            continue;
          }
          if (!stat.exists) {
            fail("file does not exist");
            continue;
          }
          if (stat.isDirectory) {
            fail("path is a directory (only files can be edited here)");
            continue;
          }
          const lineErr = await checkRangesAgainstFile(uri, parsed);
          if (lineErr) {
            fail(lineErr);
            continue;
          }
          planned.push({ kind: "textEdits", uri, label, textEdits: parsed });
        }

        // Atomicity: never apply a partial batch. Any per-file problem aborts
        // the whole call; read_files-style inline errors explain each failure.
        if (problems.length > 0) {
          return {
            content: [{ type: "text", text: problems.join("\n\n") }],
            isError: true,
          };
        }

        const edit = new vscode.WorkspaceEdit();
        for (const p of planned) {
          if (p.kind === "delete") {
            edit.deleteFile(p.uri, { ignoreIfNotExists: false, recursive: false });
          } else if (p.kind === "create") {
            edit.createFile(p.uri, { ignoreIfExists: false, overwrite: false });
            if (p.content) edit.insert(p.uri, new vscode.Position(0, 0), p.content);
          } else {
            for (const te of p.textEdits ?? []) {
              edit.replace(p.uri, new vscode.Range(te.start, te.end), te.newText);
            }
          }
        }

        // VS Code applies text edits to editor buffers; only files that were
        // already open get persisted by the editor's own save rules. Record
        // which documents were dirty beforehand so we save what we changed —
        // and only that.
        const dirtyBefore = new Map<string, boolean>();
        for (const doc of vscode.workspace.textDocuments ?? []) {
          dirtyBefore.set(uriKey(doc.uri), doc.isDirty === true);
        }

        let applied: boolean;
        try {
          applied = await vscode.workspace.applyEdit(edit);
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to apply workspace edit: ${errorMessage(err)}. Check the paths in this batch before retrying — a rejected batch is not guaranteed to be a clean rollback.`,
              },
            ],
            isError: true,
          };
        }
        if (!applied) {
          // VS Code resolves `false` without saying which entry it rejected, so
          // re-read the state it validated against and name each path.
          const observed: string[] = [];
          for (const p of planned) {
            const stat = await statPath(p.uri);
            const state =
              typeof stat === "string"
                ? `unreadable (${stat})`
                : stat.exists
                  ? stat.isDirectory
                    ? "exists (directory)"
                    : "exists"
                  : "does not exist";
            const open = openDocument(p.uri);
            const buffer = open ? `, open${open.isDirty === true ? " and dirty" : ""}` : "";
            observed.push(`${p.kind} ${p.uri.fsPath}: ${state}${buffer}`);
          }
          return {
            content: [
              {
                type: "text",
                text: `Failed to apply workspace edit: VS Code rejected the batch. State now:\n${observed.join("\n")}\nCheck the paths in this batch before retrying — a rejected batch is not guaranteed to be a clean rollback.`,
              },
            ],
            isError: true,
          };
        }

        const saveProblems: string[] = [];
        const leftDirty: string[] = [];
        for (const p of planned) {
          if (p.kind === "delete") continue;
          const key = uriKey(p.uri);
          const doc = openDocument(p.uri);
          if (!doc || doc.isDirty !== true || typeof doc.save !== "function") continue;
          if (dirtyBefore.get(key) === true) {
            leftDirty.push(p.uri.fsPath);
            continue;
          }
          try {
            // VS Code resolves `false` when a save fails; it does not reject.
            const saved = await doc.save();
            if (saved === false) saveProblems.push(`${p.uri.fsPath}: the editor could not save it`);
          } catch (err) {
            saveProblems.push(`${p.uri.fsPath}: ${errorMessage(err)}`);
          }
        }
        if (saveProblems.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `Edit applied in the editor but could not be saved to disk for ${saveProblems.length} file(s):\n${saveProblems.join("\n")}`,
              },
            ],
            isError: true,
          };
        }

        const summary = planned.map((p) => {
          if (p.kind === "delete") return `=== ${toPosixPath(p.uri.fsPath)} ===\nDeleted`;
          if (p.kind === "create") {
            const bytes = Buffer.byteLength(p.content ?? "", "utf-8");
            return `=== ${toPosixPath(p.uri.fsPath)} ===\nCreated (${bytes} bytes)`;
          }
          return `=== ${toPosixPath(p.uri.fsPath)} ===\nApplied ${p.textEdits?.length ?? 0} text edit(s)`;
        });
        const notes = leftDirty.length
          ? `\n\nLeft unsaved (document already had unsaved changes):\n${leftDirty.join("\n")}`
          : "";
        return {
          content: [
            {
              type: "text",
              text: `Applied ${planned.length} file edit(s) in a single workspace edit\n\n${summary.join("\n\n")}${notes}`,
            },
          ],
          isError: false,
        };
      },
    ),
  );

  server.registerTool(
    defineTool(
      "get_file_info",
      'Get metadata (size, modified time, type) for one or more paths in one call. Each result is prefixed with a "=== <path> ===" marker. A path that does not exist is reported inline with exists:false and null size/modified, not as an error; other per-path failures are reported inline without aborting the batch.',
      {
        type: "object",
        properties: {
          paths: {
            type: "array",
            items: {
              type: "string",
              description: "File path (absolute or relative to workspace root)",
            },
            description: "File paths to stat (absolute or relative to workspace root)",
          },
          workspaceFolder: {
            type: "string",
            description:
              "Optional workspace folder name (for multi-root workspaces). Resolves relative paths against this folder.",
          },
        },
        required: ["paths"],
      },
      async (args) => {
        const paths: string[] = Array.isArray(args.paths) ? args.paths.map(String) : [];
        if (paths.length === 0) {
          return { content: [{ type: "text", text: "No paths provided" }], isError: true };
        }
        const folderName = args.workspaceFolder ? String(args.workspaceFolder) : undefined;
        const parts: string[] = [];
        let failures = 0;
        for (const p of paths) {
          let uri: vscode.Uri;
          try {
            uri = resolvePath(p, folderName);
          } catch (err) {
            failures++;
            parts.push(
              `=== ${p} ===\n[error: ${err instanceof Error ? err.message : String(err)}]`,
            );
            continue;
          }
          try {
            const stat = await vscode.workspace.fs.stat(uri);
            parts.push(
              `=== ${toPosixPath(uri.fsPath)} ===\n${JSON.stringify({
                exists: true,
                isDirectory: (stat.type & vscode.FileType.Directory) !== 0,
                size: stat.size,
                modified: new Date(stat.mtime).toISOString(),
              })}`,
            );
          } catch (err) {
            // A missing path is a normal answer, not a batch failure. A path
            // under a file (FileNotADirectory) is missing too.
            const code = (err as { code?: string }).code;
            if (
              code === "FileNotFound" ||
              code === "EntryNotFound" ||
              code === "FileNotADirectory"
            ) {
              parts.push(
                `=== ${toPosixPath(uri.fsPath)} ===\n${JSON.stringify({
                  exists: false,
                  isDirectory: false,
                  size: null,
                  modified: null,
                })}`,
              );
            } else {
              failures++;
              parts.push(
                `=== ${toPosixPath(uri.fsPath)} ===\n[error: ${err instanceof Error ? err.message : String(err)}]`,
              );
            }
          }
        }
        return { content: [{ type: "text", text: parts.join("\n\n") }], isError: failures > 0 };
      },
    ),
  );

  server.registerTool(
    defineTool(
      "write_file",
      "Write content to a file (creates or overwrites).",
      {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path (absolute or relative to workspace root)",
          },
          content: { type: "string", description: "File content" },
          workspaceFolder: {
            type: "string",
            description:
              "Optional workspace folder name (for multi-root workspaces). Resolves relative paths against this folder.",
          },
        },
        required: ["path", "content"],
      },
      async (args) => {
        const uri = resolvePath(
          String(args.path),
          args.workspaceFolder ? String(args.workspaceFolder) : undefined,
        );
        const content = String(args.content);
        const MAX_WRITE_SIZE = 1 * 1024 * 1024; // 1 MB
        if (content.length > MAX_WRITE_SIZE) {
          return {
            content: [
              {
                type: "text",
                text: `Content too large: ${content.length} bytes (max ${MAX_WRITE_SIZE})`,
              },
            ],
            isError: true,
          };
        }
        try {
          await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf-8"));
          return { content: [{ type: "text", text: `Written ${uri.fsPath}` }], isError: false };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to write: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "create_file",
      "Create a new empty file.",
      {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path (absolute or relative to workspace root)",
          },
          workspaceFolder: {
            type: "string",
            description:
              "Optional workspace folder name (for multi-root workspaces). Resolves relative paths against this folder.",
          },
        },
        required: ["path"],
      },
      async (args) => {
        const uri = resolvePath(
          String(args.path),
          args.workspaceFolder ? String(args.workspaceFolder) : undefined,
        );
        try {
          // Check if file already exists
          try {
            await vscode.workspace.fs.stat(uri);
            return {
              content: [{ type: "text", text: `File already exists: ${uri.fsPath}` }],
              isError: true,
            };
          } catch {
            /* stat fails → file doesn't exist, proceed */
          }
          // Ensure parent directory exists
          const parent = vscode.Uri.file(path.dirname(uri.fsPath));
          try {
            await vscode.workspace.fs.createDirectory(parent);
          } catch {
            /* may already exist */
          }
          await vscode.workspace.fs.writeFile(uri, new Uint8Array());
          return { content: [{ type: "text", text: `Created ${uri.fsPath}` }], isError: false };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to create: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "delete_file",
      "Delete a file or directory.",
      {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path (absolute or relative to workspace root)",
          },
          useTrash: {
            type: "boolean",
            description: "Move to trash instead of permanent delete (default: true)",
          },
          recursive: {
            type: "boolean",
            description: "Recursively delete directories (default: false)",
          },
          workspaceFolder: {
            type: "string",
            description:
              "Optional workspace folder name (for multi-root workspaces). Resolves relative paths against this folder.",
          },
        },
        required: ["path"],
      },
      async (args) => {
        const uri = resolvePath(
          String(args.path),
          args.workspaceFolder ? String(args.workspaceFolder) : undefined,
        );
        const useTrash = args.useTrash !== false;
        const recursive = args.recursive === true;
        try {
          await vscode.workspace.fs.delete(uri, { recursive, useTrash });
          return {
            content: [
              { type: "text", text: `Deleted ${uri.fsPath}${useTrash ? " (moved to trash)" : ""}` },
            ],
            isError: false,
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to delete: ${err instanceof Error ? err.message : String(err)}`,
              },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "get_workspace_folders",
      "Get the list of open workspace folders.",
      {
        type: "object",
        properties: {},
      },
      async () => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          return { content: [{ type: "text", text: "No workspace folders open" }], isError: false };
        }
        const lines = folders.map((f) => `${f.name}: ${f.uri.fsPath}`);
        return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
      },
    ),
  );

  server.registerTool(
    defineTool(
      "add_workspace_folder",
      "Add a folder to the workspace (multi-root only). Path is absolute or relative to the workspace file; name defaults to the folder basename.",
      {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Folder path (absolute or relative to the workspace file)",
          },
          name: {
            type: "string",
            description: "Optional folder name (default: basename of the path)",
          },
        },
        required: ["path"],
      },
      async (args) => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          return {
            content: [
              { type: "text", text: "No workspace open — open a workspace before adding folders" },
            ],
            isError: true,
          };
        }
        const resolved = resolveFolderPath(String(args.path));
        const uri = vscode.Uri.file(resolved);
        const name = args.name ? String(args.name) : path.basename(resolved);
        if (folders.some((f) => f.name === name)) {
          return {
            content: [{ type: "text", text: `Workspace folder '${name}' already exists` }],
            isError: true,
          };
        }
        if (folders.some((f) => pathsEqual(f.uri.fsPath, resolved))) {
          return {
            content: [{ type: "text", text: `Path already open: ${resolved}` }],
            isError: true,
          };
        }
        const ok = await callWhenWorkspaceFoldersConfirmed(() =>
          vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri, name }),
        );
        if (!ok) {
          return {
            content: [
              {
                type: "text",
                text: "Failed to add workspace folder — adding folders requires a multi-root workspace opened from a .code-workspace file (open the folder with a workspace file first)",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Added workspace folder '${name}' (${resolved}).\n\nCurrent folders:\n${formatWorkspaceFolders()}`,
            },
          ],
          isError: false,
        };
      },
    ),
  );

  server.registerTool(
    defineTool(
      "update_workspace_folder",
      "Update a workspace folder (rename and/or change its path). Multi-root only. At least one of path/newName is required.",
      {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the workspace folder to update" },
          path: {
            type: "string",
            description: "New folder path (absolute or relative to the workspace file)",
          },
          newName: { type: "string", description: "New folder name" },
        },
        required: ["name"],
      },
      async (args) => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          return { content: [{ type: "text", text: "No workspace folders open" }], isError: true };
        }
        const idx = folders.findIndex(
          (f) => f.name === String(args.name) || pathsEqual(f.uri.fsPath, String(args.name)),
        );
        if (idx === -1) {
          return {
            content: [
              {
                type: "text",
                text: `Workspace folder '${args.name}' not found. Available folders: ${folders.map((f) => `${f.name} (${f.uri.fsPath})`).join(", ")}`,
              },
            ],
            isError: true,
          };
        }
        if (!args.path && !args.newName) {
          return {
            content: [
              { type: "text", text: "Provide at least one of `path` or `newName` to update" },
            ],
            isError: true,
          };
        }
        const current = folders[idx];
        const resolved = args.path ? resolveFolderPath(String(args.path)) : current.uri.fsPath;
        const newName = args.newName ? String(args.newName) : current.name;
        const others = folders.filter((_, i) => i !== idx);
        if (others.some((f) => f.name === newName)) {
          return {
            content: [{ type: "text", text: `Workspace folder '${newName}' already exists` }],
            isError: true,
          };
        }
        if (others.some((f) => pathsEqual(f.uri.fsPath, resolved))) {
          return {
            content: [{ type: "text", text: `Path already open: ${resolved}` }],
            isError: true,
          };
        }
        const ok = await replaceWorkspaceFolder(idx, {
          uri: vscode.Uri.file(resolved),
          name: newName,
        });
        if (!ok) {
          return {
            content: [
              {
                type: "text",
                text: "Failed to update workspace folder — updating folders requires a multi-root workspace opened from a .code-workspace file",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Updated workspace folder '${args.name}' → '${newName}' (${resolved}).\n\nCurrent folders:\n${formatWorkspaceFolders()}`,
            },
          ],
          isError: false,
        };
      },
    ),
  );

  server.registerTool(
    defineTool(
      "remove_workspace_folder",
      "Remove a folder from the workspace (multi-root only).",
      {
        type: "object",
        properties: {
          name: { type: "string", description: "Name of the workspace folder to remove" },
        },
        required: ["name"],
      },
      async (args) => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          return { content: [{ type: "text", text: "No workspace folders open" }], isError: true };
        }
        const idx = folders.findIndex(
          (f) => f.name === String(args.name) || pathsEqual(f.uri.fsPath, String(args.name)),
        );
        if (idx === -1) {
          return {
            content: [
              {
                type: "text",
                text: `Workspace folder '${args.name}' not found. Available folders: ${folders.map((f) => `${f.name} (${f.uri.fsPath})`).join(", ")}`,
              },
            ],
            isError: true,
          };
        }
        const removed = folders[idx];
        const ok = await callWhenWorkspaceFoldersConfirmed(() =>
          vscode.workspace.updateWorkspaceFolders(idx, 1),
        );
        if (!ok) {
          return {
            content: [
              {
                type: "text",
                text: "Failed to remove workspace folder — removing folders requires a multi-root workspace opened from a .code-workspace file",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `Removed workspace folder '${removed.name}' (${removed.uri.fsPath}).\n\nCurrent folders:\n${formatWorkspaceFolders()}`,
            },
          ],
          isError: false,
        };
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
  if (
    await callWhenWorkspaceFoldersConfirmed(() =>
      vscode.workspace.updateWorkspaceFolders(idx, 1, replacement),
    )
  ) {
    return true;
  }
  if (
    !(await callWhenWorkspaceFoldersConfirmed(() =>
      vscode.workspace.updateWorkspaceFolders(idx, 1),
    ))
  ) {
    return false;
  }
  await waitForWorkspaceFoldersChange(2000);
  return callWhenWorkspaceFoldersConfirmed(() =>
    vscode.workspace.updateWorkspaceFolders(idx, 0, replacement),
  );
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
    wsFile && wsFile.scheme === "file"
      ? path.dirname(wsFile.fsPath)
      : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!base) {
    throw new Error(
      "Cannot resolve a relative folder path without a workspace file or workspace folder",
    );
  }
  return path.resolve(base, input);
}

function formatWorkspaceFolders(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return "(no workspace folders)";
  return folders.map((f) => `${f.name}: ${f.uri.fsPath}`).join("\n");
}
