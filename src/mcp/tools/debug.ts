import * as vscode from 'vscode';
import { McpServer } from '../server';
import { defineTool } from './index';
import { resolvePath } from '../../utils/path';

/**
 * Read a launch configuration by name from the workspace file (*.code-workspace)
 * `launch` section. The debug service does not expose workspace-file launch configs
 * via name lookup in VS Code 1.133 (getLaunch(undefined) -> undefined throws
 * "'launch.json' does not exist for passed workspace folder."), so we read the file
 * and pass the config object directly — the object path skips name resolution.
 */
async function readWorkspaceFileLaunchConfig(configName: string): Promise<vscode.DebugConfiguration | undefined> {
  // workspaceFile is a Uri on older API levels, a TextDocument on newer ones — handle both
  const wsFile = vscode.workspace.workspaceFile as unknown as { uri?: vscode.Uri } | vscode.Uri | undefined;
  const uri: vscode.Uri | undefined = wsFile && 'uri' in wsFile ? wsFile.uri : (wsFile as vscode.Uri | undefined);
  if (!uri || uri.scheme !== 'file') return undefined;
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    const json = JSON.parse(Buffer.from(buf).toString('utf8')) as {
      launch?: { configurations?: vscode.DebugConfiguration[] };
    };
    return json.launch?.configurations?.find((c) => c.name === configName);
  } catch {
    return undefined;
  }
}

export function registerDebugTools(server: McpServer): void {
  server.registerTool(
    defineTool(
      'start_debugging',
      'Start a debug session using a launch config name. Works with configs from .vscode/launch.json and the workspace file (*.code-workspace).',
      {
        type: 'object',
        properties: {
          configName: { type: 'string', description: 'Launch configuration name from launch.json or the workspace file' },
          folder: { type: 'string', description: 'Workspace folder name (optional)' },
        },
        required: ['configName'],
      },
      async (args) => {
        const folders = vscode.workspace.workspaceFolders;
        const folder = args.folder
          ? folders?.find((f) => f.name === args.folder)
          : folders?.[0];

        if (args.folder && !folder) {
          return { content: [{ type: 'text', text: `Workspace folder '${args.folder}' not found` }], isError: true };
        }

        try {
          // Launch configs can live in a folder's .vscode/launch.json (requires the
          // folder scope) or in the workspace file (*.code-workspace) `launch` section.
          // Resolution attempts, in order:
          //  1) folder + name      -> folder's .vscode/launch.json
          //  2) undefined + name   -> workspace-level name lookup (works on some versions)
          //  3) undefined + object -> workspace-file config passed directly (bypasses the
          //                           broken name resolution; works in VS Code 1.133)
          //  4) folder + object    -> same config, scoped to a folder as a safety net
          let success = false;
          if (folder) {
            try {
              success = await vscode.debug.startDebugging(folder, String(args.configName));
            } catch {
              // Config not in this folder's launch.json — try the next attempt
            }
          }
          if (!success) {
            try {
              success = await vscode.debug.startDebugging(undefined, String(args.configName));
            } catch {
              // Workspace-level name lookup failed — fall through to the file read
            }
          }
          if (!success) {
            const wsConfig = await readWorkspaceFileLaunchConfig(String(args.configName));
            if (wsConfig) {
              try {
                success = await vscode.debug.startDebugging(undefined, wsConfig);
              } catch {
                // try folder-scoped below
              }
              if (!success && folder) {
                success = await vscode.debug.startDebugging(folder, wsConfig);
              }
            }
          }
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
          workspaceFolder: { type: 'string', description: 'Optional workspace folder name (for multi-root workspaces). Resolves relative paths against this folder.' },
        },
        required: ['path', 'line'],
      },
      async (args) => {
        const line = Math.max(0, Number(args.line) - 1);
        try {
          const uri = resolvePath(String(args.path), args.workspaceFolder ? String(args.workspaceFolder) : undefined);
          const cond = args.condition ? String(args.condition) : undefined;
          const hitCond = args.hitCondition ? String(args.hitCondition) : undefined;
          const loc = new vscode.Location(uri, new vscode.Position(line, 0));
          const bp = new vscode.SourceBreakpoint(loc, true, cond, hitCond);
          vscode.debug.addBreakpoints([bp]);
          return { content: [{ type: 'text', text: `Breakpoint added at ${uri.fsPath}:${args.line}` }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to add breakpoint: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
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
          workspaceFolder: { type: 'string', description: 'Optional workspace folder name (for multi-root workspaces). Resolves relative paths against this folder.' },
        },
        required: ['path', 'line'],
      },
      async (args) => {
        const line = Math.max(0, Number(args.line) - 1);
        try {
          const uri = resolvePath(String(args.path), args.workspaceFolder ? String(args.workspaceFolder) : undefined);
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
        } catch (err) {
          return { content: [{ type: 'text', text: `Failed to remove breakpoint: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
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
          const scopes = await session.customRequest('scopes', { frameId: stack.stackFrames[0].id });
          const varsRef = scopes?.scopes?.[0]?.variablesReference;
          if (!varsRef) return { content: [{ type: 'text', text: 'No variables in scope' }], isError: true };
          const vars = await session.customRequest('variables', { variablesReference: varsRef });
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
          // Resolve top stack frame for frame-scoped evaluation (locals)
          let frameId: number | undefined;
          try {
            const threads = await session.customRequest('threads');
            if (threads?.threads?.length) {
              const stack = await session.customRequest('stackTrace', { threadId: threads.threads[0].id });
              frameId = stack?.stackFrames?.[0]?.id;
            }
          } catch {
            // Not paused — fall through to global-scope eval
          }
          const result = await session.customRequest('evaluate', {
            expression: String(args.expression),
            context: 'repl',
            ...(frameId !== undefined ? { frameId } : {}),
          });
          return { content: [{ type: 'text', text: result?.result || String(result) }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Evaluate error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );
}
