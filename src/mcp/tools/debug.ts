import * as vscode from 'vscode';
import { McpServer } from '../server';
import { defineTool } from './index';
import { resolvePath } from '../../utils/path';

export function registerDebugTools(server: McpServer): void {
  server.registerTool(
    defineTool(
      'start_debugging',
      'Start a debug session using a launch config name.',
      {
        type: 'object',
        properties: {
          configName: { type: 'string', description: 'Launch configuration name from launch.json' },
          folder: { type: 'string', description: 'Workspace folder name (optional)' },
        },
        required: ['configName'],
      },
      async (args) => {
        const folders = vscode.workspace.workspaceFolders;
        const folder = args.folder
          ? folders?.find((f) => f.name === args.folder)
          : folders?.[0];

        if (!folder) {
          return { content: [{ type: 'text', text: 'No workspace folder found' }], isError: true };
        }

        try {
          const success = await vscode.debug.startDebugging(folder, String(args.configName));
          return {
            content: [{ type: 'text', text: success ? `Started debugging '${args.configName}'` : `Failed to start '${args.configName}'` }],
            isError: !success,
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Debug start error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'stop_debugging',
      'Stop the active debug session.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const session = vscode.debug.activeDebugSession;
        if (!session) {
          return { content: [{ type: 'text', text: 'No active debug session to stop' }], isError: true };
        }
        try {
          await vscode.debug.stopDebugging(session);
          return { content: [{ type: 'text', text: 'Debug session stopped' }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );

  // Step/continue commands share the same pattern
  const stepCommands = [
    { name: 'step_over', cmd: 'workbench.action.debug.stepOver', desc: 'Step over the current line in the debugger.' },
    { name: 'step_into', cmd: 'workbench.action.debug.stepInto', desc: 'Step into the function at the current line.' },
    { name: 'step_out', cmd: 'workbench.action.debug.stepOut', desc: 'Step out of the current function.' },
    { name: 'continue', cmd: 'workbench.action.debug.continue', desc: 'Continue execution in the debugger.' },
  ];

  for (const sc of stepCommands) {
    server.registerTool(
      defineTool(
        sc.name,
        sc.desc,
        { type: 'object', properties: {} },
        async () => {
          if (!vscode.debug.activeDebugSession) {
            return { content: [{ type: 'text', text: 'No active debug session' }], isError: true };
          }
          try {
            await vscode.commands.executeCommand(sc.cmd);
            return { content: [{ type: 'text', text: `${sc.name} executed` }], isError: false };
          } catch (err) {
            return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
          }
        },
      ),
    );
  }

  server.registerTool(
    defineTool(
      'add_breakpoint',
      'Add a breakpoint at a file and line.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to workspace root)' },
          line: { type: 'integer', description: 'Line number (1-indexed)' },
          condition: { type: 'string', description: 'Optional breakpoint condition expression (e.g. "x > 5")' },
          hitCondition: { type: 'string', description: 'Optional hit count condition (e.g. "5" for every 5th hit)' },
        },
        required: ['path', 'line'],
      },
      async (args) => {
        const line = Math.max(0, Number(args.line) - 1);
        const uri = resolvePath(String(args.path));
        const cond = args.condition ? String(args.condition) : undefined;
        const hitCond = args.hitCondition ? String(args.hitCondition) : undefined;
        const loc = new vscode.Location(uri, new vscode.Position(line, 0));
        const bp = new vscode.SourceBreakpoint(loc, true, cond, hitCond);
        vscode.debug.addBreakpoints([bp]);
        return { content: [{ type: 'text', text: `Breakpoint added at ${uri.fsPath}:${args.line}` }], isError: false };
      },
    ),
  );

  server.registerTool(
    defineTool(
      'remove_breakpoint',
      'Remove a breakpoint at a file and line.',
      {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (absolute or relative to workspace root)' },
          line: { type: 'integer', description: 'Line number (1-indexed)' },
        },
        required: ['path', 'line'],
      },
      async (args) => {
        const line = Math.max(0, Number(args.line) - 1);
        const uri = resolvePath(String(args.path));
        const toRemove = vscode.debug.breakpoints.filter((bp) => {
          if (bp instanceof vscode.SourceBreakpoint) {
            const loc = bp.location;
            return loc.uri.toString() === uri.toString() && loc.range.start.line === line;
          }
          return false;
        });
        if (toRemove.length === 0) {
          return { content: [{ type: 'text', text: `No breakpoint at ${uri.fsPath}:${args.line}` }], isError: true };
        }
        vscode.debug.removeBreakpoints(toRemove);
        return { content: [{ type: 'text', text: `Breakpoint removed at ${uri.fsPath}:${args.line}` }], isError: false };
      },
    ),
  );

  server.registerTool(
    defineTool(
      'list_breakpoints',
      'List all breakpoints.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const bps = vscode.debug.breakpoints;
        if (bps.length === 0) return { content: [{ type: 'text', text: 'No breakpoints' }], isError: false };
        const lines = bps.map((bp) => {
          if (bp instanceof vscode.SourceBreakpoint) {
            return `${bp.location.uri.fsPath}:${bp.location.range.start.line + 1}${bp.condition ? ` (condition: ${bp.condition})` : ''}${bp.logMessage ? ` (log: ${bp.logMessage})` : ''}`;
          }
          return `${bp.constructor.name}`;
        });
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
      },
    ),
  );

  server.registerTool(
    defineTool(
      'get_debug_variables',
      'Get variables from the active debug session (requires paused session).',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const session = vscode.debug.activeDebugSession;
        if (!session) return { content: [{ type: 'text', text: 'No active debug session' }], isError: true };
        try {
          // Get stack frames first, then variables from top frame
          const threads = await session.customRequest('threads');
          if (!threads?.threads?.length) return { content: [{ type: 'text', text: 'No threads available' }], isError: true };
          const stack = await session.customRequest('stackTrace', { threadId: threads.threads[0].id });
          if (!stack?.stackFrames?.length) return { content: [{ type: 'text', text: 'No stack frames (is debugger paused?)' }], isError: true };
          const vars = await session.customRequest('variables', { variablesReference: stack.stackFrames[0].id });
          return { content: [{ type: 'text', text: JSON.stringify(vars?.variables || [], null, 2) }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to get variables: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'get_stack_trace',
      'Get the stack trace from the active debug session.',
      {
        type: 'object',
        properties: {},
      },
      async () => {
        const session = vscode.debug.activeDebugSession;
        if (!session) return { content: [{ type: 'text', text: 'No active debug session' }], isError: true };
        try {
          const threads = await session.customRequest('threads');
          if (!threads?.threads?.length) return { content: [{ type: 'text', text: 'No threads' }], isError: true };
          const stack = await session.customRequest('stackTrace', { threadId: threads.threads[0].id });
          if (!stack?.stackFrames?.length) return { content: [{ type: 'text', text: 'No stack frames' }], isError: true };
          const lines = stack.stackFrames.map((f: any) => `${f.name}${f.source?.path ? ` at ${f.source.path}:${f.line}` : ''}`);
          return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );

  server.registerTool(
    defineTool(
      'evaluate_in_debug_console',
      'Evaluate an expression in the active debug session.',
      {
        type: 'object',
        properties: {
          expression: { type: 'string', description: 'Expression to evaluate' },
        },
        required: ['expression'],
      },
      async (args) => {
        const session = vscode.debug.activeDebugSession;
        if (!session) return { content: [{ type: 'text', text: 'No active debug session' }], isError: true };
        try {
          const result = await session.customRequest('evaluate', { expression: String(args.expression), context: 'repl' });
          return { content: [{ type: 'text', text: result?.result || String(result) }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Evaluate error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );
}
