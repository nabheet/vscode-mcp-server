import * as vscode from 'vscode';
import { McpServer } from '../server';
import { defineTool } from './index';

/**
 * Buffer for terminal output captured via shell integration.
 * Key: terminal name, Value: accumulated output string.
 */
const terminalBuffers = new Map<string, string>();

/**
 * Set of terminal names that we created and are tracking. Kept in creation
 * order so the oldest can be evicted when the cap is hit.
 */
const managedTerminals = new Set<string>();
const managedOrder: string[] = [];

/** Max terminals we will keep open. Prevents unbounded leak of VS Code
 *  terminal processes when a client asks for a new named terminal per call. */
const MAX_TERMINALS = 15;

let outputCaptureRegistered = false;

/** Enforce the terminal cap — evict the oldest tracked terminal. */
function enforceTerminalCap(): void {
  while (managedOrder.length > MAX_TERMINALS) {
    const oldest = managedOrder.shift();
    if (!oldest) break;
    const term = vscode.window.terminals.find((t) => t.name === oldest);
    term?.dispose();
    managedTerminals.delete(oldest);
    terminalBuffers.delete(oldest);
  }
}

/**
 * Register one global listener for all terminal shell executions.
 * Filters to only terminals we manage. Idempotent — safe to call multiple times.
 */
function ensureOutputCapture(context: vscode.ExtensionContext): void {
  if (outputCaptureRegistered) return;
  outputCaptureRegistered = true;

  // Clean up terminal tracking when a terminal is closed
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((terminal) => {
      managedTerminals.delete(terminal.name);
      const idx = managedOrder.indexOf(terminal.name);
      if (idx >= 0) managedOrder.splice(idx, 1);
      terminalBuffers.delete(terminal.name);
    })
  );

  const disposable = vscode.window.onDidStartTerminalShellExecution(async (event) => {
    const termName = event.terminal.name;
    if (!managedTerminals.has(termName)) return;

    const OUTPUT_CAPTURE_TIMEOUT = 30_000; // 30s max per execution

    const capture = (async () => {
      for await (const data of event.execution.read()) {
        const existing = terminalBuffers.get(termName) || '';
        const updated = existing + data;
        // Keep last ~100 KB
        terminalBuffers.set(termName, updated.length > 100_000 ? updated.slice(-100_000) : updated);
      }
    })();

    try {
      await Promise.race([
        capture,
        new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            clearTimeout(timer);
            // Timeout reached — stop waiting on the capture promise. The
            // capture loop keeps accumulating by design (buffer is capped),
            // but we no longer block on it.
            resolve();
          }, OUTPUT_CAPTURE_TIMEOUT);
        }),
      ]);
    } catch {
      // Execution error — stop capturing but keep accumulated output
    }
  });
  context.subscriptions.push(disposable);
}

/** Get or create a terminal by name */
function getOrCreateTerminal(name: string): vscode.Terminal {
  let term = vscode.window.terminals.find((t) => t.name === name);
  if (!term) {
    term = vscode.window.createTerminal(name);
    managedTerminals.add(name);
    managedOrder.push(name);
    terminalBuffers.set(name, '');
    enforceTerminalCap();
  }
  return term;
}

export function registerTerminalTools(server: McpServer, context: vscode.ExtensionContext): void {
  ensureOutputCapture(context);

  server.registerTool(
    defineTool(
      'execute_in_terminal',
      'Execute a shell command in a VS Code integrated terminal. Uses shell integration when available for output capture.',
      {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to execute' },
          name: { type: 'string', description: 'Terminal name (optional, creates new if not exists)' },
        },
        required: ['command'],
      },
      async (args) => {
        const cmd = String(args.command);
        const termName = String(args.name || 'mcp-' + Date.now());
        const term = getOrCreateTerminal(termName);

        term.show();

        // Prefer shell integration for proper output tracking
        if (term.shellIntegration) {
          term.shellIntegration.executeCommand(cmd);
        } else {
          term.sendText(cmd, true);
        }

        return {
          content: [{ type: 'text', text: 'Executed command in terminal "' + termName + '"' }],
          isError: false,
        };
      },
    ),
  );

  server.registerTool(
    defineTool(
      'get_terminal_output',
      'Get the recent output from a terminal. Only terminals created via execute_in_terminal with shell integration are fully captured.',
      {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Terminal name' },
          maxChars: { type: 'integer', description: 'Max characters to return (default: 5000)' },
        },
        required: ['name'],
      },
      async (args) => {
        const name = String(args.name);
        const maxChars = Number(args.maxChars) || 5000;
        const buffer = terminalBuffers.get(name);

        if (!managedTerminals.has(name)) {
          return {
            content: [{ type: 'text', text: 'Terminal "' + name + '" was not created by this extension. Output capture is only available for terminals created via execute_in_terminal.' }],
            isError: false,
          };
        }

        if (!buffer || buffer.length === 0) {
          return {
            content: [{ type: 'text', text: 'No output captured yet for terminal "' + name + '". Output capture requires shell integration. Try running a command first.' }],
            isError: false,
          };
        }

        const text = buffer.length > maxChars ? '...(truncated)\n' + buffer.slice(-maxChars) : buffer;
        return { content: [{ type: 'text', text }], isError: false };
      },
    ),
  );
}
