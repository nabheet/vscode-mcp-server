import * as vscode from 'vscode';
import { McpServer } from '../server';
import { defineTool } from './index';

/** Get active text editor or return a CallToolResult error */
function requireEditor(): { editor: vscode.TextEditor; err: null } | { editor: null; err: ReturnType<typeof defineTool>['handler'] extends (...args: any[]) => infer R ? Awaited<R> : never } {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    const err = { content: [{ type: 'text' as const, text: 'No active text editor' }], isError: true };
    return { editor: null, err: err as any };
  }
  return { editor, err: null } as any;
}

/** Get cursor position from active editor */
function getCursor(editor: vscode.TextEditor): vscode.Position {
  return editor.selection.active;
}

export function registerLspTools(server: McpServer): void {
  server.registerTool(
    defineTool(
      'find_references',
      'Find all references to the symbol at the cursor position.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const { editor, err } = requireEditor();
        if (err) return err;
        try {
          const refs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', editor!.document.uri, getCursor(editor!));
          if (!refs || refs.length === 0) return { content: [{ type: 'text', text: 'No references found' }], isError: false };
          const lines = refs.map((r) => `${r.uri.fsPath}:${r.range.start.line + 1}:${r.range.start.character + 1}`);
          return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'go_to_definition',
      'Navigate to the definition of the symbol at cursor.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const { editor, err } = requireEditor();
        if (err) return err;
        try {
          const defs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', editor!.document.uri, getCursor(editor!));
          if (!defs || defs.length === 0) return { content: [{ type: 'text', text: 'No definition found' }], isError: false };
          const loc = defs[0];
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(loc.uri), { selection: loc.range });
          return { content: [{ type: 'text', text: `Navigated to ${loc.uri.fsPath}:${loc.range.start.line + 1}` }], isError: false };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'go_to_type_definition',
      'Navigate to the type definition of the symbol at cursor.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const { editor, err } = requireEditor();
        if (err) return err;
        try {
          const defs = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeTypeDefinitionProvider', editor!.document.uri, getCursor(editor!));
          if (!defs || defs.length === 0) return { content: [{ type: 'text', text: 'No type definition found' }], isError: false };
          const loc = defs[0];
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(loc.uri), { selection: loc.range });
          return { content: [{ type: 'text', text: `Navigated to ${loc.uri.fsPath}:${loc.range.start.line + 1}` }], isError: false };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'go_to_implementation',
      'Navigate to the implementation of the symbol at cursor.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const { editor, err } = requireEditor();
        if (err) return err;
        try {
          const impls = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeImplementationProvider', editor!.document.uri, getCursor(editor!));
          if (!impls || impls.length === 0) return { content: [{ type: 'text', text: 'No implementation found' }], isError: false };
          const loc = impls[0];
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(loc.uri), { selection: loc.range });
          return { content: [{ type: 'text', text: `Navigated to ${loc.uri.fsPath}:${loc.range.start.line + 1}` }], isError: false };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'get_hover',
      'Get hover information for the symbol at cursor.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const { editor, err } = requireEditor();
        if (err) return err;
        try {
          const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', editor!.document.uri, getCursor(editor!));
          if (!hovers || hovers.length === 0) return { content: [{ type: 'text', text: 'No hover info' }], isError: false };
          const texts = hovers.flatMap((h) => h.contents.map((c) => (c instanceof vscode.MarkdownString ? c.value : String(c))));
          return { content: [{ type: 'text', text: texts.join('\n---\n') }], isError: false };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'get_diagnostics',
      'Get diagnostics for the active file (or all files if no editor active).',
      {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'Optional file URI to get diagnostics for' },
        },
      },
      async (args) => {
        let targetUri: vscode.Uri | undefined;
        if (args.uri) {
          targetUri = vscode.Uri.file(String(args.uri));
        } else if (vscode.window.activeTextEditor) {
          targetUri = vscode.window.activeTextEditor.document.uri;
        }

        const diagnostics = targetUri
          ? vscode.languages.getDiagnostics(targetUri)
          : vscode.languages.getDiagnostics();

        if (!diagnostics || (Array.isArray(diagnostics) && diagnostics.length === 0)) {
          return { content: [{ type: 'text', text: 'No diagnostics' }], isError: false };
        }

        const lines: string[] = [];
        const entries = Array.isArray(diagnostics) ? diagnostics : [diagnostics];
        for (const diag of entries) {
          if ('uri' in diag && 'diagnostics' in diag) {
            for (const d of (diag as any).diagnostics) {
              lines.push(`${(diag as any).uri.fsPath}:${d.range.start.line + 1}:${d.range.start.character + 1} [${d.severity}] ${d.message}`);
            }
          } else {
            const d = diag as vscode.Diagnostic;
            lines.push(`${targetUri?.fsPath || '?'}:${d.range.start.line + 1}:${d.range.start.character + 1} [${d.severity}] ${d.message}`);
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') || 'No diagnostics' }], isError: false };
      },
    ),
  );

  server.registerTool(
    defineTool(
      'get_document_symbols',
      'Get symbols defined in the active document.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const { editor, err } = requireEditor();
        if (err) return err;
        try {
          const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', editor!.document.uri);
          if (!symbols || (Array.isArray(symbols) && symbols.length === 0)) return { content: [{ type: 'text', text: 'No symbols found' }], isError: false };
          const lines: string[] = [];
          function flattenSymbol(s: any): void {
            if (s.location) {
              lines.push(`${s.name} (${vscode.SymbolKind[s.kind]}) at ${s.location.range.start.line + 1}`);
            } else if (s.range) {
              // DocumentSymbol uses .range instead of .location
              lines.push(`${s.name} (${vscode.SymbolKind[s.kind]}) at ${s.range.start.line + 1}`);
            }
            if (s.children) {
              for (const child of s.children) flattenSymbol(child);
            }
          }
          for (const s of symbols as any[]) flattenSymbol(s);
          return { content: [{ type: 'text', text: lines.join('\n') || 'No symbols found' }], isError: false };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'get_workspace_symbols',
      'Search for symbols in the workspace by query.',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query (min 3 chars recommended)' },
        },
        required: ['query'],
      },
      async (args) => {
        try {
          const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', String(args.query));
          if (!symbols || symbols.length === 0) return { content: [{ type: 'text', text: 'No matching symbols' }], isError: false };
          const lines = symbols.map((s) => `${s.name} (${vscode.SymbolKind[s.kind]}) — ${s.location.uri.fsPath}:${s.location.range.start.line + 1}`);
          return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'get_code_actions',
      'Get available code actions (refactor, quick fix) at a given range.',
      {
        type: 'object',
        properties: {
          line: { type: 'integer', description: 'Line number (1-indexed)' },
        },
        required: ['line'],
      },
      async (args) => {
        const { editor, err } = requireEditor();
        if (err) return err;
        const line = Math.max(0, Number(args.line) - 1);
        const lineRange = editor!.document.lineAt(line).range;
        try {
          const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', editor!.document.uri, lineRange);
          if (!actions || actions.length === 0) return { content: [{ type: 'text', text: 'No code actions available' }], isError: false };
          const lines = actions.map((a) => `${a.title}${a.kind ? ` (${a.kind.value})` : ''}`);
          return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'get_call_hierarchy',
      'Get the call hierarchy for the symbol at cursor (incoming and outgoing calls).',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const { editor, err } = requireEditor();
        if (err) return err;
        try {
          const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>('vscode.executePrepareCallHierarchy', editor!.document.uri, getCursor(editor!));
          if (!items || items.length === 0) return { content: [{ type: 'text', text: 'No call hierarchy available' }], isError: false };

          const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.executeCallHierarchyIncomingCalls', items[0]);
          const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>('vscode.executeCallHierarchyOutgoingCalls', items[0]);

          const lines: string[] = [];
          lines.push(`Symbol: ${items[0].name}`);
          if (incoming) {
            lines.push('--- Incoming calls ---');
            incoming.forEach((c) => lines.push(`  ${c.from.name} → ${c.from.uri.fsPath}:${c.from.range.start.line + 1}`));
          }
          if (outgoing) {
            lines.push('--- Outgoing calls ---');
            outgoing.forEach((c) => lines.push(`  ${items[0].name} → ${c.to.name} at ${c.to.uri.fsPath}:${c.to.range.start.line + 1}`));
          }
          return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'rename_symbol',
      'Rename the symbol at the cursor position across the workspace.',
      {
        type: 'object',
        properties: {
          newName: { type: 'string', description: 'New name for the symbol' },
        },
        required: ['newName'],
      },
      async (args) => {
        const { editor, err } = requireEditor();
        if (err) return err;
        try {
          const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', editor!.document.uri, getCursor(editor!), String(args.newName));
          if (!edit) return { content: [{ type: 'text', text: 'Rename provider returned no changes' }], isError: false };
          const applied = await vscode.workspace.applyEdit(edit);
          return { content: [{ type: 'text', text: applied ? `Renamed to '${args.newName}'` : 'Rename failed to apply' }], isError: !applied };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'get_completions',
      'Get completion items at the cursor position.',
      {
        type: 'object',
        properties: {
          line: { type: 'integer', description: 'Line number (1-indexed, defaults to cursor line)' },
          column: { type: 'integer', description: 'Column number (1-indexed, defaults to cursor column)' },
          maxResults: { type: 'integer', description: 'Maximum completions to return (default: 50)' },
        },
      },
      async (args) => {
        const { editor, err } = requireEditor();
        if (err) return err;
        const line = args.line !== undefined ? Math.max(0, Number(args.line) - 1) : getCursor(editor!).line;
        const col = args.column !== undefined ? Math.max(0, Number(args.column) - 1) : getCursor(editor!).character;
        const maxResults = Number(args.maxResults) || 50;
        const pos = new vscode.Position(line, col);
        try {
          const list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', editor!.document.uri, pos);
          if (!list || !list.items || list.items.length === 0) return { content: [{ type: 'text', text: 'No completions available' }], isError: false };
          const items = list.items
            .sort((a, b) => (a.sortText || a.label.toString()).localeCompare(b.sortText || b.label.toString()))
            .slice(0, maxResults);
          const lines = items.map((item) => {
            const label = typeof item.label === 'string' ? item.label : item.label.label;
            return `${label}${item.detail ? ` — ${item.detail}` : ''}${item.insertText && typeof item.insertText === 'string' && item.insertText !== label ? ` → '${item.insertText}'` : ''}`;
          });
          return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
        } catch (e) {
          return { content: [{ type: 'text', text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      },
    ),
  );
}
