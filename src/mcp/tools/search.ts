import * as vscode from 'vscode';
import { McpServer } from '../server';
import { defineTool } from './index';

const MAX_FILE_BYTES = 512 * 1024; // skip files larger than 512 KB
const MAX_SCAN_FILES = 2000; // cap on files handed to findFiles

export function registerSearchTools(server: McpServer): void {
  server.registerTool(
    defineTool(
      'search_files',
      'Search file contents across the workspace (grep). Returns each match with file path, line number, column, and the matching line text. Supports optional regex, case sensitivity, include/exclude globs, and context lines.',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text or regular expression to search for' },
          include: { type: 'string', description: 'Glob filter for files to search (default: "**/*")' },
          exclude: { type: 'string', description: 'Glob of files to skip (default: "**/node_modules/**")' },
          caseSensitive: { type: 'boolean', description: 'Case-sensitive match (default: false)' },
          useRegex: { type: 'boolean', description: 'Treat query as a regular expression (default: false)' },
          maxResults: { type: 'integer', description: 'Maximum matches to return (default: 100, max 1000)' },
          contextLines: { type: 'integer', description: 'Lines of context before and after each match (default: 0, max 10)' },
          workspaceFolder: { type: 'string', description: 'Optional workspace folder name (for multi-root workspaces). Searches this folder only.' },
        },
        required: ['query'],
      },
      async (args) => {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
          return { content: [{ type: 'text', text: 'No workspace folder open' }], isError: true };
        }

        // Resolve search roots. With no workspaceFolder, search the WHOLE
        // workspace (every folder) — grep semantics. With one, scope to it.
        let roots: vscode.Uri[];
        if (args.workspaceFolder) {
          const folder = folders.find((f) => f.name === args.workspaceFolder);
          if (!folder) {
            const names = folders.map((f) => f.name).join(', ');
            return { content: [{ type: 'text', text: `Workspace folder '${args.workspaceFolder}' not found. Available folders: ${names}` }], isError: true };
          }
          roots = [folder.uri];
        } else {
          roots = folders.map((f) => f.uri);
        }

        const query = String(args.query);
        const flags = args.caseSensitive ? '' : 'i';
        let re: RegExp;
        try {
          re = args.useRegex
            ? new RegExp(query, flags)
            : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
        } catch (err) {
          return { content: [{ type: 'text', text: `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }

        const include = args.include ? String(args.include) : '**/*';
        const exclude = args.exclude ? String(args.exclude) : '**/node_modules/**';
        const maxResults = Math.max(1, Math.min(1000, Number(args.maxResults) || 100));
        const contextLines = Math.max(0, Math.min(10, Number(args.contextLines) || 0));

        let files: vscode.Uri[] = [];
        try {
          const seen = new Set<string>();
          for (const root of roots) {
            const found = await vscode.workspace.findFiles(new vscode.RelativePattern(root, include), exclude, MAX_SCAN_FILES);
            for (const f of found) {
              if (seen.has(f.fsPath)) continue; // folder roots may overlap
              seen.add(f.fsPath);
              files.push(f);
            }
          }
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to scan files: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }

        const results: string[] = [];
        const matchedFiles = new Set<string>();
        let matchCount = 0;
        for (const uri of files) {
          if (matchCount >= maxResults) break;
          let text: string;
          try {
            const bytes = await vscode.workspace.fs.readFile(uri);
            if (bytes.length > MAX_FILE_BYTES) continue;
            text = Buffer.from(bytes).toString('utf-8');
          } catch {
            continue; // unreadable — skip
          }
          const lines = text.split(/\r?\n/);
          for (let i = 0; i < lines.length && matchCount < maxResults; i++) {
            const m = re.exec(lines[i]);
            if (!m) continue;
            matchedFiles.add(uri.fsPath);
            if (contextLines > 0) {
              const from = Math.max(0, i - contextLines);
              const to = Math.min(lines.length - 1, i + contextLines);
              for (let c = from; c <= to; c++) {
                results.push(`${c === i ? '>' : ' '} ${uri.fsPath}:${c + 1}: ${lines[c]}`);
              }
              results.push('--');
            } else {
              results.push(`${uri.fsPath}:${i + 1}:${m.index + 1}: ${lines[i]}`);
            }
            matchCount++;
          }
        }

        if (matchCount === 0) {
          return { content: [{ type: 'text', text: '(no matches)' }], isError: false };
        }
        const summary = `${matchCount} match${matchCount === 1 ? '' : 'es'} in ${matchedFiles.size} file(s)`;
        return { content: [{ type: 'text', text: `${summary}\n\n${results.join('\n')}` }], isError: false };
      },
    ),
  );
}