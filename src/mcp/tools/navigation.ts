import * as vscode from 'vscode';
import { McpServer } from '../server';
import { defineTool } from './index';
import { resolvePath } from '../../utils/path';

/** Ensure a text editor is open for the given URI, return it */
async function openEditor(uri: vscode.Uri): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(uri);
  return await vscode.window.showTextDocument(doc);
}

export function registerNavigationTools(server: McpServer): void {
  server.registerTool(
    defineTool(
      'open_file',
      'Open a file in the editor.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to workspace root)' },
        },
        required: ['path'],
      },
      async (args) => {
        const uri = resolvePath(String(args.path));
        try {
          const editor = await openEditor(uri);
          return { content: [{ type: 'text', text: `Opened ${uri.fsPath} at line ${editor.selection.active.line + 1}` }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to open file: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'open_file_at_line',
      'Open a file and jump to a specific line.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to workspace root)' },
          line: { type: 'integer', description: 'Line number (1-indexed)' },
        },
        required: ['path', 'line'],
      },
      async (args) => {
        const uri = resolvePath(String(args.path));
        const line = Math.max(0, Number(args.line) - 1); // convert to 0-indexed
        try {
          const editor = await openEditor(uri);
          const pos = new vscode.Position(line, 0);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          return { content: [{ type: 'text', text: `Opened ${uri.fsPath} at line ${args.line}` }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'open_file_at_position',
      'Open a file and jump to a specific line and column.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to workspace root)' },
          line: { type: 'integer', description: 'Line number (1-indexed)' },
          column: { type: 'integer', description: 'Column number (1-indexed)' },
        },
        required: ['path', 'line', 'column'],
      },
      async (args) => {
        const uri = resolvePath(String(args.path));
        const line = Math.max(0, Number(args.line) - 1);
        const col = Math.max(0, Number(args.column) - 1);
        try {
          const editor = await openEditor(uri);
          const pos = new vscode.Position(line, col);
          editor.selection = new vscode.Selection(pos, pos);
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          return { content: [{ type: 'text', text: `Opened ${uri.fsPath} at line ${args.line}, column ${args.column}` }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'select_lines',
      'Select a range of lines in the active editor.',
      {
        type: 'object',
        properties: {
          startLine: { type: 'integer', description: 'Start line (1-indexed)' },
          endLine: { type: 'integer', description: 'End line (1-indexed, inclusive)' },
        },
        required: ['startLine', 'endLine'],
      },
      async (args) => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return { content: [{ type: 'text', text: 'No active editor' }], isError: true };

        const start = Math.max(0, Number(args.startLine) - 1);
        const end = Math.min(Math.max(start, Number(args.endLine) - 1), editor.document.lineCount - 1);
        editor.selection = new vscode.Selection(
          new vscode.Position(start, 0),
          new vscode.Position(end, editor.document.lineAt(end).text.length),
        );
        editor.revealRange(new vscode.Range(start, 0, end, 0), vscode.TextEditorRevealType.InCenter);
        return { content: [{ type: 'text', text: `Selected lines ${args.startLine}-${args.endLine}` }], isError: false };
      },
    ),
  );

  server.registerTool(
    defineTool(
      'reveal_in_explorer',
      'Reveal a file in the VS Code Explorer sidebar.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to workspace root)' },
        },
        required: ['path'],
      },
      async (args) => {
        const uri = resolvePath(String(args.path));
        try {
          await vscode.commands.executeCommand('revealInExplorer', uri);
          return { content: [{ type: 'text', text: `Revealed ${uri.fsPath} in explorer` }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'focus_editor',
      'Focus the active editor group.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        return { content: [{ type: 'text', text: 'Focused editor' }], isError: false };
      },
    ),
  );

  server.registerTool(
    defineTool(
      'close_editor',
      'Close the active editor tab.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        return { content: [{ type: 'text', text: 'Closed active editor' }], isError: false };
      },
    ),
  );

  server.registerTool(
    defineTool(
      'close_all_editors',
      'Close all open editor tabs.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        return { content: [{ type: 'text', text: 'Closed all editors' }], isError: false };
      },
    ),
  );
}
