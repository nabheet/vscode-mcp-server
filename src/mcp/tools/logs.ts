/**
 * Log inspection tools — read VS Code host logs (main.log, mcpGateway.log,
 * sharedprocess.log, ...) and this extension's own JSON log, straight from the
 * MCP server. These are how we diagnose "server died during debugging" without
 * the user manually digging through ~/Library/Application Support/Code/logs.
 *
 * Safety: file access is restricted to the resolved logs root (boundary check
 * incl. realpath for symlink escape). Read-only tools.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { McpServer } from '../server';
import { defineTool } from './index';

/** Platform default VS Code logs directory (non-Insiders + Insiders). */
function platformLogsRoot(): string | undefined {
  const home = os.homedir();
  const candidates: string[] = [];
  switch (process.platform) {
    case 'darwin':
      candidates.push(path.join(home, 'Library', 'Application Support', 'Code', 'logs'));
      break;
    case 'win32':
      candidates.push(path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'logs'));
      break;
    default:
      candidates.push(path.join(home, '.config', 'Code', 'logs'));
      break;
  }
  candidates.push(candidates[0].replace(`${path.sep}Code${path.sep}`, `${path.sep}Code - Insiders${path.sep}`));
  return candidates.find((c) => fs.existsSync(c));
}

/** Walk up from logUri to the logs root: the ancestor dir that does NOT
 *  contain main.log itself but has a session subdir that does. (VS Code
 *  layout: <logsRoot>/<session>/main.log — stopping at the first dir that
 *  contains main.log lands one level too deep.) */
function getLogsRoot(context: vscode.ExtensionContext): string | undefined {
  const logUri = context.logUri;
  if (logUri && logUri.scheme === 'file') {
    let dir = path.dirname(logUri.fsPath);
    for (let i = 0; i < 16; i++) {
      const hasMain = fs.existsSync(path.join(dir, 'main.log'));
      if (!hasMain && hasSessionDirWithMainLog(dir)) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return platformLogsRoot();
}

function hasSessionDirWithMainLog(dir: string): boolean {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'main.log'))) return true;
  }
  return false;
}

/** Newest session directory name under the logs root (dirs are timestamp-prefixed). */
function newestSession(logsRoot: string): string | undefined {
  const dirs: string[] = [];
  for (const entry of fs.readdirSync(logsRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) dirs.push(entry.name);
  }
  dirs.sort().reverse();
  return dirs[0];
}

function formatBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/** Safe tail of a file: boundary-checked, big-file aware, optional grep. */
async function tailLogFile(filePath: string, maxLines: number, grep?: string): Promise<string> {
  const MAX_READ = 8 * 1024 * 1024;
  const st = await fs.promises.stat(filePath);
  let content: string;
  if (st.size > MAX_READ) {
    const fd = await fs.promises.open(filePath, 'r');
    const buf = Buffer.alloc(MAX_READ);
    await fd.read(buf, 0, MAX_READ, st.size - MAX_READ);
    await fd.close();
    content = buf.toString('utf8');
    const nl = content.indexOf('\n');
    if (nl >= 0) content = content.slice(nl + 1);
  } else {
    content = await fs.promises.readFile(filePath, 'utf8');
  }
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let filtered = lines;
  if (grep) {
    let re: RegExp | null = null;
    try { re = new RegExp(grep); } catch { /* invalid regex — no filter */ }
    if (re) filtered = lines.filter((l) => re!.test(l));
  }
  return filtered.slice(-maxLines).join('\n');
}

export function registerLogsTools(server: McpServer, context: vscode.ExtensionContext): void {
  server.registerTool(
    defineTool(
      'list_logs',
      'List available VS Code logs: sessions (newest first) and the log files in the newest session, plus this extension\'s own log files. Use read_log to tail a file.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const logsRoot = getLogsRoot(context);
        const out: string[] = [];
        if (!logsRoot) {
          out.push('VS Code logs root not found');
        } else {
          out.push('VS Code logs root: ' + logsRoot);
          const dirs: string[] = [];
          for (const entry of fs.readdirSync(logsRoot, { withFileTypes: true })) {
            if (entry.isDirectory()) dirs.push(entry.name);
          }
          dirs.sort().reverse();
          out.push(`Sessions (newest first): ${dirs.length}`);
          for (const d of dirs.slice(0, 12)) {
            const files = fs.readdirSync(path.join(logsRoot, d)).slice(0, 20);
            out.push(`  ${d}  (${files.length} files)`);
          }
          const newest = newestSession(logsRoot);
          if (newest) {
            const dir = path.join(logsRoot, newest);
            out.push(`\nLog files in newest session ${newest}:`);
            const files = fs.readdirSync(dir).sort();
            for (const f of files) {
              const st = fs.statSync(path.join(dir, f));
              out.push(`  ${f}  ${formatBytes(st.size)}  ${st.mtime.toISOString().replace('T', ' ').slice(0, 19)}`);
            }
          }
        }
        // Extension's own JSON log
        const logDir = context.logUri?.scheme === 'file' ? context.logUri.fsPath : undefined;
        if (logDir && fs.existsSync(logDir)) {
          out.push('\nExtension log files (context.logUri):');
          const files = fs.readdirSync(logDir).filter((f) => f.startsWith('mcp.log')).sort();
          if (files.length === 0) out.push('  (none yet)');
          for (const f of files) {
            const st = fs.statSync(path.join(logDir, f));
            out.push(`  ${f}  ${formatBytes(st.size)}`);
          }
        }
        return { content: [{ type: 'text', text: out.join('\n') }], isError: false };
      },
    ),
  );

  server.registerTool(
    defineTool(
      'read_log',
      'Tail a VS Code log file (e.g. main.log, mcpGateway.log, sharedprocess.log).\n' +
        'Path is relative to the VS Code logs root, e.g. "2026-08-22-14:03/main.log" — use list_logs to see the newest session name. ' +
        'Symlinks and paths escaping the logs root are rejected.',
      {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'Log file path relative to the VS Code logs root (e.g. "2026-08-22-14:03/main.log")' },
          lines: { type: 'integer', description: 'Max lines to return, tail (default 200, max 2000)' },
          grep: { type: 'string', description: 'Optional regex to filter lines' },
        },
        required: ['file'],
      },
      async (args) => {
        const logsRoot = getLogsRoot(context);
        if (!logsRoot) {
          return { content: [{ type: 'text', text: 'VS Code logs root not found on this platform' }], isError: true };
        }
        const fileArg = String(args.file);
        const candidate = path.isAbsolute(fileArg) ? fileArg : path.resolve(logsRoot, fileArg);
        const resolved = logsRoot + path.sep;

        // Boundary check — the resolved file must stay under the logs root.
        if (candidate !== logsRoot && !candidate.startsWith(resolved)) {
          return { content: [{ type: 'text', text: 'Rejected: path escapes the VS Code logs root' }], isError: true };
        }
        if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
          return { content: [{ type: 'text', text: `Log file not found: ${fileArg}` }], isError: true };
        }
        try {
          const real = await fs.promises.realpath(candidate);
          const realRoot = await fs.promises.realpath(logsRoot);
          if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
            return { content: [{ type: 'text', text: 'Rejected: symlink escapes the VS Code logs root' }], isError: true };
          }
        } catch {
          return { content: [{ type: 'text', text: `Cannot resolve log file: ${fileArg}` }], isError: true };
        }

        const maxLines = Math.min(Math.max(Number(args.lines) || 200, 1), 2000);
        const grep = args.grep ? String(args.grep) : undefined;
        try {
          const text = await tailLogFile(candidate, maxLines, grep);
          const label = grep ? ` (grep: /${grep}/)` : '';
          return {
            content: [{ type: 'text', text: `--- ${candidate.replace(logsRoot + path.sep, '')} — last ${maxLines} lines${label} ---\n${text}` }],
            isError: false,
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to read log: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );
}