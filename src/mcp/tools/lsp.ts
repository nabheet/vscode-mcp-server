import * as vscode from "vscode";
import { withTimeout } from "../../utils/timeout";
import { defineTool, type ToolRegistrar } from "./index";

/** LSP provider calls go to the language server — slow or hung servers never
 *  answer. Same protection as DAP: bound every call so the MCP server never
 *  waits on a dead language server. */
const LSP_TIMEOUT_MS = 10_000;

/** Run an `vscode.execute*Provider` command with a hard deadline. */
function lspCommand<T>(command: string, ...args: unknown[]): Promise<T> {
  return withTimeout(
    vscode.commands.executeCommand<T>(command, ...args),
    LSP_TIMEOUT_MS,
    `Language server request '${command}' timed out after ${LSP_TIMEOUT_MS / 1000}s (language server unresponsive)`,
  );
}

/** Active text editor, or undefined when none is focused. */
function activeEditor(): vscode.TextEditor | undefined {
  return vscode.window.activeTextEditor;
}

/**
 * Accept either a `file:///abs/path` URI or a raw filesystem path. A bare
 * drive letter (`C:/x`) is a path, not a scheme, so a scheme needs 2+ chars.
 */
function parseUriArg(value: string): vscode.Uri {
  return /^[a-z][a-z0-9+.-]+:/i.test(value) ? vscode.Uri.parse(value) : vscode.Uri.file(value);
}

/** Tool result for "no active text editor". */
function noEditorError(): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: "No active text editor" }], isError: true };
}

/** Get cursor position from active editor */
function getCursor(editor: vscode.TextEditor): vscode.Position {
  return editor.selection.active;
}

/** Normalise a definition result — supports both Location and LocationLink */
interface NormalisedLocation {
  uri: vscode.Uri;
  range: vscode.Range;
}
function normaliseLocation(loc: unknown): NormalisedLocation {
  const candidate = loc as {
    uri?: vscode.Uri;
    range?: vscode.Range;
    targetUri?: vscode.Uri;
    targetRange?: vscode.Range;
  };
  if (candidate.uri && candidate.range?.start) {
    return { uri: candidate.uri, range: candidate.range }; // vscode.Location
  }
  if (candidate.targetUri && candidate.targetRange) {
    return { uri: candidate.targetUri, range: candidate.targetRange }; // LocationLink
  }
  throw new Error(
    `Unexpected location format from language server: ${JSON.stringify(loc).slice(0, 200)}`,
  );
}

/** Arrays and other iterables — main iterated any truthy `children` value. */
function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function"
  );
}

export function registerLspTools(server: ToolRegistrar): void {
  server.registerTool(
    defineTool(
      "find_references",
      "Find all references to the symbol at the cursor position.",
      {
        type: "object",
        properties: {},
      },
      async () => {
        const editor = activeEditor();
        if (!editor) return noEditorError();
        try {
          const refs = await lspCommand<vscode.Location[]>(
            "vscode.executeReferenceProvider",
            editor.document.uri,
            getCursor(editor),
          );
          if (!refs || refs.length === 0)
            return { content: [{ type: "text", text: "No references found" }], isError: false };
          const lines = refs.map(
            (r) => `${r.uri.fsPath}:${r.range.start.line + 1}:${r.range.start.character + 1}`,
          );
          return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
        } catch (e) {
          return {
            content: [
              { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "go_to_definition",
      "Navigate to the definition of the symbol at cursor.",
      {
        type: "object",
        properties: {},
      },
      async () => {
        const editor = activeEditor();
        if (!editor) return noEditorError();
        try {
          const defs = await lspCommand(
            "vscode.executeDefinitionProvider",
            editor.document.uri,
            getCursor(editor),
          );
          if (!defs || !Array.isArray(defs) || defs.length === 0)
            return { content: [{ type: "text", text: "No definition found" }], isError: false };
          const loc = normaliseLocation(defs[0]);
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(loc.uri), {
            selection: loc.range,
          });
          return {
            content: [
              { type: "text", text: `Navigated to ${loc.uri.fsPath}:${loc.range.start.line + 1}` },
            ],
            isError: false,
          };
        } catch (e) {
          return {
            content: [
              { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "go_to_type_definition",
      "Navigate to the type definition of the symbol at cursor.",
      {
        type: "object",
        properties: {},
      },
      async () => {
        const editor = activeEditor();
        if (!editor) return noEditorError();
        try {
          const defs = await lspCommand(
            "vscode.executeTypeDefinitionProvider",
            editor.document.uri,
            getCursor(editor),
          );
          if (!defs || !Array.isArray(defs) || defs.length === 0)
            return {
              content: [{ type: "text", text: "No type definition found" }],
              isError: false,
            };
          const loc = normaliseLocation(defs[0]);
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(loc.uri), {
            selection: loc.range,
          });
          return {
            content: [
              { type: "text", text: `Navigated to ${loc.uri.fsPath}:${loc.range.start.line + 1}` },
            ],
            isError: false,
          };
        } catch (e) {
          return {
            content: [
              { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "go_to_implementation",
      "Navigate to the implementation of the symbol at cursor.",
      {
        type: "object",
        properties: {},
      },
      async () => {
        const editor = activeEditor();
        if (!editor) return noEditorError();
        try {
          const impls = await lspCommand(
            "vscode.executeImplementationProvider",
            editor.document.uri,
            getCursor(editor),
          );
          if (!impls || !Array.isArray(impls) || impls.length === 0)
            return { content: [{ type: "text", text: "No implementation found" }], isError: false };
          const loc = normaliseLocation(impls[0]);
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(loc.uri), {
            selection: loc.range,
          });
          return {
            content: [
              { type: "text", text: `Navigated to ${loc.uri.fsPath}:${loc.range.start.line + 1}` },
            ],
            isError: false,
          };
        } catch (e) {
          return {
            content: [
              { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "get_hover",
      "Get hover information for the symbol at cursor.",
      {
        type: "object",
        properties: {},
      },
      async () => {
        const editor = activeEditor();
        if (!editor) return noEditorError();
        try {
          const hovers = await lspCommand<vscode.Hover[]>(
            "vscode.executeHoverProvider",
            editor.document.uri,
            getCursor(editor),
          );
          if (!hovers || hovers.length === 0)
            return { content: [{ type: "text", text: "No hover info" }], isError: false };
          const texts = hovers.flatMap((h) =>
            h.contents.map((c) => (c instanceof vscode.MarkdownString ? c.value : String(c))),
          );
          return { content: [{ type: "text", text: texts.join("\n---\n") }], isError: false };
        } catch (e) {
          return {
            content: [
              { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "get_diagnostics",
      "Get diagnostics for the active file, for a specific file, or for every file when nothing is open. Returns `path:line:col [severity] message` lines, capped at 200 with a count of the remainder.",
      {
        type: "object",
        properties: {
          uri: {
            type: "string",
            description:
              "Optional file to get diagnostics for, as a `file:///abs/path` URI or a raw absolute path",
          },
        },
      },
      async (args) => {
        // Both getDiagnostics overloads are normalised to [uri, diagnostics]
        // pairs. The no-arg form already returns that shape — positional
        // arrays, which have no `uri`/`diagnostics` properties — while the
        // targeted form returns a bare Diagnostic[].
        let entries: Array<{ uri?: vscode.Uri; diagnostics: readonly vscode.Diagnostic[] }>;
        let targetUri: vscode.Uri | undefined;
        if (args.uri) {
          targetUri = parseUriArg(String(args.uri));
          entries = [{ uri: targetUri, diagnostics: vscode.languages.getDiagnostics(targetUri) }];
        } else if (vscode.window.activeTextEditor) {
          targetUri = vscode.window.activeTextEditor.document.uri;
          entries = [{ uri: targetUri, diagnostics: vscode.languages.getDiagnostics(targetUri) }];
        } else {
          entries = vscode.languages
            .getDiagnostics()
            .map(([uri, diagnostics]) => ({ uri, diagnostics }));
        }

        const MAX_DIAG_LINES = 200;
        const lines: string[] = [];
        let total = 0;
        for (const entry of entries) {
          const diagnostics = Array.isArray(entry.diagnostics) ? entry.diagnostics : [];
          total += diagnostics.length;
          if (lines.length >= MAX_DIAG_LINES) continue;
          const file = entry.uri?.fsPath ?? targetUri?.fsPath ?? "?";
          for (const d of diagnostics) {
            if (lines.length >= MAX_DIAG_LINES) break;
            const line = `${file}:${d.range.start.line + 1}:${d.range.start.character + 1} [${d.severity}] ${d.message}`;
            lines.push(line);
          }
        }

        if (total === 0) {
          return { content: [{ type: "text", text: "No diagnostics" }], isError: false };
        }
        const tail = total > MAX_DIAG_LINES ? `\n... and ${total - MAX_DIAG_LINES} more` : "";
        return { content: [{ type: "text", text: lines.join("\n") + tail }], isError: false };
      },
    ),
  );

  server.registerTool(
    defineTool(
      "get_document_symbols",
      "Get symbols defined in the active document.",
      {
        type: "object",
        properties: {},
      },
      async () => {
        const editor = activeEditor();
        if (!editor) return noEditorError();
        try {
          const symbols = await lspCommand<vscode.DocumentSymbol[] | vscode.SymbolInformation[]>(
            "vscode.executeDocumentSymbolProvider",
            editor.document.uri,
          );
          if (!symbols || symbols.length === 0)
            return { content: [{ type: "text", text: "No symbols found" }], isError: false };
          const lines: string[] = [];
          function flattenSymbol(s: vscode.DocumentSymbol | vscode.SymbolInformation): void {
            // A provider can return a primitive where a symbol is expected;
            // main's truthiness chain skipped those, and `in` would throw.
            if (typeof s !== "object" || s === null) return;
            const located = "location" in s ? s.location : undefined;
            const own = "range" in s ? s.range : undefined;
            const range = located?.range ?? own;
            if (range) {
              lines.push(`${s.name} (${vscode.SymbolKind[s.kind]}) at ${range.start.line + 1}`);
            }
            const children: unknown = "children" in s ? s.children : undefined;
            if (isIterable(children)) {
              for (const child of children) {
                flattenSymbol(child as vscode.DocumentSymbol | vscode.SymbolInformation);
              }
            }
          }
          for (const s of symbols) flattenSymbol(s);
          return {
            content: [{ type: "text", text: lines.join("\n") || "No symbols found" }],
            isError: false,
          };
        } catch (e) {
          return {
            content: [
              { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "get_workspace_symbols",
      "Search for symbols in the workspace by query.",
      {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query (min 3 chars recommended)" },
        },
        required: ["query"],
      },
      async (args) => {
        try {
          const symbols = await lspCommand<vscode.SymbolInformation[]>(
            "vscode.executeWorkspaceSymbolProvider",
            String(args.query),
          );
          if (!symbols || symbols.length === 0)
            return { content: [{ type: "text", text: "No matching symbols" }], isError: false };
          const lines = symbols.map(
            (s) =>
              `${s.name} (${vscode.SymbolKind[s.kind]}) — ${s.location.uri.fsPath}:${s.location.range.start.line + 1}`,
          );
          return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
        } catch (e) {
          return {
            content: [
              { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "get_code_actions",
      "Get available code actions (refactor, quick fix) at a given range.",
      {
        type: "object",
        properties: {
          line: { type: "integer", description: "Line number (1-indexed)" },
        },
        required: ["line"],
      },
      async (args) => {
        const editor = activeEditor();
        if (!editor) return noEditorError();
        const line = Math.max(0, Number(args.line) - 1);
        const lineRange = editor.document.lineAt(line).range;
        try {
          const actions = await lspCommand<vscode.CodeAction[]>(
            "vscode.executeCodeActionProvider",
            editor.document.uri,
            lineRange,
          );
          if (!actions || actions.length === 0)
            return {
              content: [{ type: "text", text: "No code actions available" }],
              isError: false,
            };
          const lines = actions.map((a) => `${a.title}${a.kind ? ` (${a.kind.value})` : ""}`);
          return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
        } catch (e) {
          return {
            content: [
              { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "get_call_hierarchy",
      "Get the call hierarchy for the symbol at cursor (incoming and outgoing calls).",
      {
        type: "object",
        properties: {},
      },
      async () => {
        const editor = activeEditor();
        if (!editor) return noEditorError();
        try {
          const items = await lspCommand<vscode.CallHierarchyItem[]>(
            "vscode.executePrepareCallHierarchy",
            editor.document.uri,
            getCursor(editor),
          );
          if (!items || items.length === 0)
            return {
              content: [{ type: "text", text: "No call hierarchy available" }],
              isError: false,
            };

          const incoming = await lspCommand<vscode.CallHierarchyIncomingCall[]>(
            "vscode.executeCallHierarchyIncomingCalls",
            items[0],
          );
          const outgoing = await lspCommand<vscode.CallHierarchyOutgoingCall[]>(
            "vscode.executeCallHierarchyOutgoingCalls",
            items[0],
          );

          const lines: string[] = [];
          lines.push(`Symbol: ${items[0].name}`);
          if (incoming) {
            lines.push("--- Incoming calls ---");
            incoming.forEach((c) => {
              lines.push(`  ${c.from.name} → ${c.from.uri.fsPath}:${c.from.range.start.line + 1}`);
            });
          }
          if (outgoing) {
            lines.push("--- Outgoing calls ---");
            outgoing.forEach((c) => {
              lines.push(
                `  ${items[0].name} → ${c.to.name} at ${c.to.uri.fsPath}:${c.to.range.start.line + 1}`,
              );
            });
          }
          return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
        } catch (e) {
          return {
            content: [
              { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "rename_symbol",
      "Rename the symbol at the cursor position across the workspace.",
      {
        type: "object",
        properties: {
          newName: { type: "string", description: "New name for the symbol" },
        },
        required: ["newName"],
      },
      async (args) => {
        const editor = activeEditor();
        if (!editor) return noEditorError();
        try {
          const edit = await lspCommand<vscode.WorkspaceEdit>(
            "vscode.executeDocumentRenameProvider",
            editor.document.uri,
            getCursor(editor),
            String(args.newName),
          );
          if (!edit)
            return {
              content: [{ type: "text", text: "Rename provider returned no changes" }],
              isError: false,
            };
          const applied = await vscode.workspace.applyEdit(edit);
          return {
            content: [
              {
                type: "text",
                text: applied ? `Renamed to '${args.newName}'` : "Rename failed to apply",
              },
            ],
            isError: !applied,
          };
        } catch (e) {
          return {
            content: [
              { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            ],
            isError: true,
          };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      "get_completions",
      "Get completion items at the cursor position.",
      {
        type: "object",
        properties: {
          line: {
            type: "integer",
            description: "Line number (1-indexed, defaults to cursor line)",
          },
          column: {
            type: "integer",
            description: "Column number (1-indexed, defaults to cursor column)",
          },
          maxResults: {
            type: "integer",
            description: "Maximum completions to return (default: 50)",
          },
        },
      },
      async (args) => {
        const editor = activeEditor();
        if (!editor) return noEditorError();
        const line =
          args.line !== undefined ? Math.max(0, Number(args.line) - 1) : getCursor(editor).line;
        const col =
          args.column !== undefined
            ? Math.max(0, Number(args.column) - 1)
            : getCursor(editor).character;
        const maxResults = Number(args.maxResults) || 50;
        const pos = new vscode.Position(line, col);
        try {
          const list = await lspCommand<vscode.CompletionList>(
            "vscode.executeCompletionItemProvider",
            editor.document.uri,
            pos,
          );
          if (!list?.items || list.items.length === 0)
            return {
              content: [{ type: "text", text: "No completions available" }],
              isError: false,
            };
          const items = list.items
            .sort((a, b) =>
              (a.sortText || a.label.toString()).localeCompare(b.sortText || b.label.toString()),
            )
            .slice(0, maxResults);
          const lines = items.map((item) => {
            const label = typeof item.label === "string" ? item.label : item.label.label;
            return `${label}${item.detail ? ` — ${item.detail}` : ""}${item.insertText && typeof item.insertText === "string" && item.insertText !== label ? ` → '${item.insertText}'` : ""}`;
          });
          return { content: [{ type: "text", text: lines.join("\n") }], isError: false };
        } catch (e) {
          return {
            content: [
              { type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` },
            ],
            isError: true,
          };
        }
      },
    ),
  );
}
