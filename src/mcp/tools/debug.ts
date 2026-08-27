import * as vscode from 'vscode';
import { McpServer } from '../server';
import { defineTool } from './index';
import { resolvePath } from '../../utils/path';
import { parseJsonc } from '../../utils/jsonc';
import { withTimeout, withLaunchBudget } from '../../utils/timeout';

/** DAP calls can hang indefinitely when the adapter is blocked (e.g. a slow
 *  evaluate, mid-step). Bound every customRequest so a stuck adapter returns
 *  a clear error instead of freezing the MCP server. */
const DAP_TIMEOUT_MS = 10_000;

/** start_debugging legitimately exceeds the generic 30s tool budget: a launch
 *  resolves only after FULL session establishment, and a multiprocess compound
 *  (e.g. litellm --reload with a debugpy worker per process) attaches parent +
 *  every worker before that. Give the tool its own dispatch deadline via
 *  defineTool's timeoutMs (so dispatch won't cut it at 30s) and run the launch
 *  phase under a slightly smaller INTERNAL budget. The internal one fires
 *  first, so the handler returns a clean error result and flips isAborted() to
 *  stop issuing new launches for remaining compound members — the dispatch
 *  deadline is only the backstop. */
const START_DEBUG_TIMEOUT_MS = 120_000;
const START_DEBUG_BUDGET_MS = START_DEBUG_TIMEOUT_MS - 5_000;

/** get_debug_variables output caps — a deep object tree can serialize to
 *  megabytes and saturate the MCP round trip. */
const MAX_VARS_ROWS = 200;
const MAX_VARS_BYTES = 200 * 1024;
const EVAL_RESULT_MAX_CHARS = 100_000;

/** Serialize a variables dump with caps. Returns text + a truncation note. */
function truncateVariables(rows: unknown[]): { text: string; note: string } {
  if (rows.length === 0) return { text: '[]', note: '' };
  const limited = rows.slice(0, MAX_VARS_ROWS);
  const text = JSON.stringify(limited, null, 2);
  const notes: string[] = [];
  if (rows.length > MAX_VARS_ROWS) {
    notes.push(`${rows.length} total variables — showing first ${MAX_VARS_ROWS}`);
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_VARS_BYTES) {
    notes.push('output truncated at 200 KB');
    return { text: text.slice(0, MAX_VARS_BYTES) + '\n…', note: notes.join('; ') };
  }
  return { text, note: notes.join('; ') };
}

/** Wrap a DebugSession customRequest with a hard deadline. */
async function dapRequest<T>(session: vscode.DebugSession, command: string, args?: unknown): Promise<T> {
  return withTimeout(
    session.customRequest(command, args),
    DAP_TIMEOUT_MS,
    `Debugger request '${command}' timed out after ${DAP_TIMEOUT_MS / 1000}s (adapter unresponsive — is it paused on a slow operation?)`,
  );
}

/**
 * A named compound launch entry. Compounds bundle several launch configs and
 * appear as a single named entry in the launch dropdown.
 */
interface WorkspaceLaunchCompound {
  name: string;
  configurations: string[];
  stopAll?: boolean;
  preLaunchTask?: string;
}

interface WorkspaceLaunchSection {
  configurations?: vscode.DebugConfiguration[];
  compounds?: WorkspaceLaunchCompound[];
}

/**
 * Read the `launch` section from the workspace file (*.code-workspace). The
 * debug service does not expose workspace-file launch configs via name lookup
 * in VS Code 1.133 (getLaunch(undefined) -> undefined throws "'launch.json'
 * does not exist for passed workspace folder."), so we read the file and pass
 * the config objects directly — the object path skips name resolution.
 *
 * Workspace files are JSONC (comments + trailing commas), so a plain
 * JSON.parse fails on typical files — we use the JSONC parser.
 */
async function readWorkspaceFileLaunchSection(): Promise<WorkspaceLaunchSection | undefined> {
  // workspaceFile is a Uri on older API levels, a TextDocument on newer ones — handle both
  const wsFile = vscode.workspace.workspaceFile as unknown as { uri?: vscode.Uri } | vscode.Uri | undefined;
  const uri: vscode.Uri | undefined = wsFile && 'uri' in wsFile ? wsFile.uri : (wsFile as vscode.Uri | undefined);
  if (!uri || uri.scheme !== 'file') return undefined;
  try {
    const buf = await vscode.workspace.fs.readFile(uri);
    const json = parseJsonc<{ launch?: WorkspaceLaunchSection }>(Buffer.from(buf).toString('utf8'));
    return json.launch;
  } catch {
    return undefined;
  }
}

/**
 * Read the `launch` section from a folder's .vscode/launch.json. Returns
 * undefined when the folder has no launch.json or it cannot be parsed — the
 * folder then simply does not contribute any folder-scoped configs.
 *
 * NOTE: a folder's launch.json IS the section — it has no top-level `launch`
 * key (that wrapper only exists in *.code-workspace files). Parsing it as
 * `json.launch` (the workspace-file shape) silently yields undefined, which
 * made every folder-scoped config invisible.
 */
async function readFolderLaunchSection(folder: vscode.WorkspaceFolder): Promise<WorkspaceLaunchSection | undefined> {
  try {
    const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json');
    const buf = await vscode.workspace.fs.readFile(uri);
    return parseJsonc<WorkspaceLaunchSection>(Buffer.from(buf).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** True when the section declares `name` as a config or a compound. */
function hasLaunchEntry(section: WorkspaceLaunchSection | undefined, name: string): boolean {
  if (!section) return false;
  return (
    (section.configurations ?? []).some((c) => c.name === name) ||
    (section.compounds ?? []).some((c) => c.name === name)
  );
}

export function registerDebugTools(server: McpServer): void {
  server.registerTool(
    defineTool(
      'start_debugging',
      'Start a debug session using a launch config name. Works with configs from .vscode/launch.json and the workspace file (*.code-workspace), including compound configurations.',
      {
        type: 'object',
        properties: {
          configName: { type: 'string', description: 'Launch configuration name from launch.json or the workspace file' },
          folder: { type: 'string', description: 'Workspace folder name (optional)' },
        },
        required: ['configName'],
      },
      async (args) => {
        // Folder scope: a launch config can live in ANY workspace folder's
        // .vscode/launch.json. With an explicit `folder` argument only that
        // folder is searched; without one, every open folder is searched in
        // order — a config in a non-first folder must still be found.
        const folders = vscode.workspace.workspaceFolders;
        let targetFolders: vscode.WorkspaceFolder[];
        if (args.folder) {
          const found = folders?.find((f) => f.name === args.folder);
          if (!found) {
            return { content: [{ type: 'text', text: `Workspace folder '${args.folder}' not found` }], isError: true };
          }
          targetFolders = [found];
        } else {
          targetFolders = [...(folders ?? [])];
        }

        const configName = String(args.configName);

        try {
          // Launch configs can live in a folder's .vscode/launch.json (folder
          // scope) or in the workspace file (*.code-workspace) `launch` section.
          // We read both sources FIRST and only call startDebugging for scopes
          // that actually declare the config: a doomed call makes VS Code fire
          // error toasts ("launch.json does not exist for passed workspace
          // folder", "Configuration X is missing in launch.json") even when a
          // later attempt would succeed.
          const [folderSections, wsSection] = await Promise.all([
            Promise.all(targetFolders.map((f) => readFolderLaunchSection(f))),
            readWorkspaceFileLaunchSection(),
          ]);

          let success = false;
          let detail = '';
          let timedOut = false;

          // Run the whole launch phase under a budget. startDebugging resolves
          // only after FULL session establishment, which for a heavy
          // multiprocess compound (e.g. litellm --reload with debugpy attach
          // per worker) can take well over the generic 30s tool timeout. The
          // budget rejects the caller cleanly at ~115s and flips isAborted()
          // so the loop below stops issuing NEW launches for remaining members
          // instead of silently keeping the DAP busy in the background.
          try {
            await withLaunchBudget(
              async (isAborted) => {
                // 1) Folder scope — try every target folder whose launch.json
                //    declares the config. Pass the parsed config OBJECT, not
                //    just the name: VS Code 1.133+ name-based resolution is
                //    unreliable ('launch.json does not exist for passed
                //    workspace folder' even when the file exists), and the
                //    object path also survives folder launch.json files that
                //    were (re)written after the workspace opened. (Pre-scan
                //    avoids doomed calls that fire error toasts.)
                for (let i = 0; i < targetFolders.length && !success && !isAborted(); i++) {
                  const tf = targetFolders[i];
                  const fs = folderSections[i];
                  if (!fs || !hasLaunchEntry(fs, configName)) continue;
                  const cfg = (fs.configurations ?? []).find((c) => c.name === configName);
                  try {
                    if (cfg) {
                      success = await vscode.debug.startDebugging(tf, cfg as vscode.DebugConfiguration);
                    } else {
                      // Folder-level compound: not a DebugConfiguration
                      // object, so fall back to name-based resolution.
                      success = await vscode.debug.startDebugging(tf, configName);
                    }
                  } catch (err) {
                    success = false;
                    detail = detail || ` (${err instanceof Error ? err.message : String(err)})`;
                  }
                }

                // 2) Workspace-file scope — only when the workspace file declares it.
                //    VS Code 1.133+ cannot resolve workspace-file configs by name
                //    (startDebugging(undefined, name) throws), so we read the file
                //    and pass the config objects directly — the object path skips
                //    name resolution.
                if (!success && wsSection && hasLaunchEntry(wsSection, configName) && !isAborted()) {
                  const configs = wsSection.configurations ?? [];
                  const compounds = wsSection.compounds ?? [];
                  const configByName = new Map(configs.map((c) => [c.name, c]));

                  const compound = compounds.find((c) => c.name === configName);
                  if (compound) {
                    // Compound: start every constituent config in sequence. Compounds
                    // are named launch entries, not DebugConfiguration objects, so
                    // they cannot be passed to startDebugging directly — expand here.
                    const started: string[] = [];
                    const failed: string[] = [];
                    for (const subName of compound.configurations) {
                      if (isAborted()) {
                        failed.push(`${subName} (launch timed out)`);
                        break;
                      }
                      const subConfig = configByName.get(subName);
                      if (!subConfig) {
                        failed.push(`${subName} (not found in workspace file)`);
                        continue;
                      }
                      let ok = false;
                      try {
                        ok = await vscode.debug.startDebugging(undefined, subConfig);
                      } catch {
                        ok = false;
                      }
                      const primaryFolder = targetFolders[0];
                      if (!ok && primaryFolder) {
                        try {
                          ok = await vscode.debug.startDebugging(primaryFolder, subConfig);
                        } catch {
                          ok = false;
                        }
                      }
                      if (ok) started.push(subName);
                      else failed.push(subName);
                    }
                    success = failed.length === 0 && started.length > 0;
                    detail = failed.length > 0 ? ` (failed: ${failed.join(', ')})` : '';
                  } else {
                    const wsConfig = configByName.get(configName);
                    if (wsConfig) {
                      try {
                        success = await vscode.debug.startDebugging(undefined, wsConfig);
                      } catch {
                        success = false;
                      }
                      const primaryFolderWs = targetFolders[0];
                      if (!success && primaryFolderWs) {
                        try {
                          success = await vscode.debug.startDebugging(primaryFolderWs, wsConfig);
                        } catch {
                          success = false;
                        }
                      }
                    }
                  }
                }
              },
              START_DEBUG_BUDGET_MS,
              `Debug launch '${configName}' did not complete within ${START_DEBUG_BUDGET_MS / 1000}s — stopped issuing further launches`,
            );
          } catch (err) {
            // Budget expiry (or an error escaping the launch phase): report a
            // clean error to the caller. isAborted() has already been flipped,
            // so the ghost phase will not spawn further launches.
            timedOut = err instanceof Error && /did not complete within/.test(err.message);
            if (!timedOut) {
              throw err;
            }
            detail = detail ? detail + ' (launch timed out)' : ' (launch timed out)';
          }

          if (!success) {
            const sources = targetFolders
              .map((f, i) => (folderSections[i] ? `launch.json in folder '${f.name}'` : null))
              .concat(wsSection ? ['the workspace file'] : [])
              .filter((s): s is string => !!s);
            const where = sources.length > 0 ? ` (checked ${sources.join(' and ')})` : ' (no launch sources found)';
            return {
              content: [{ type: 'text', text: `Failed to start '${configName}'${where}${detail}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: `Started debugging '${configName}'${detail}` }],
            isError: false,
          };
        } catch (err) {
          return { content: [{ type: 'text', text: `Debug start error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
      START_DEBUG_TIMEOUT_MS,
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
          const threads = await dapRequest<any>(session, 'threads');
          if (!threads?.threads?.length) return { content: [{ type: 'text', text: 'No threads available' }], isError: true };
          const stack = await dapRequest<any>(session, 'stackTrace', { threadId: threads.threads[0].id });
          if (!stack?.stackFrames?.length) return { content: [{ type: 'text', text: 'No stack frames (is debugger paused?)' }], isError: true };
          const scopes = await dapRequest<any>(session, 'scopes', { frameId: stack.stackFrames[0].id });
          const varsRef = scopes?.scopes?.[0]?.variablesReference;
          if (!varsRef) return { content: [{ type: 'text', text: 'No variables in scope' }], isError: true };
          const vars = await dapRequest<any>(session, 'variables', { variablesReference: varsRef });
          const { text, note } = truncateVariables(vars?.variables || []);
          return { content: [{ type: 'text', text: note ? text + '\n' + note : text }], isError: false };
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
          const threads = await dapRequest<any>(session, 'threads');
          if (!threads?.threads?.length) return { content: [{ type: 'text', text: 'No threads' }], isError: true };
          const stack = await dapRequest<any>(session, 'stackTrace', { threadId: threads.threads[0].id });
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
            const threads = await dapRequest<any>(session, 'threads');
            if (threads?.threads?.length) {
              const stack = await dapRequest<any>(session, 'stackTrace', { threadId: threads.threads[0].id });
              frameId = stack?.stackFrames?.[0]?.id;
            }
          } catch {
            // Not paused — fall through to global-scope eval
          }
          const result = await dapRequest<any>(session, 'evaluate', {
            expression: String(args.expression),
            context: 'repl',
            ...(frameId !== undefined ? { frameId } : {}),
          });
          let out = result?.result || String(result);
          if (out.length > EVAL_RESULT_MAX_CHARS) {
            out = out.slice(0, EVAL_RESULT_MAX_CHARS) + '\n…result truncated at 100 KB…';
          }
          return { content: [{ type: 'text', text: out }], isError: false };
        } catch (err) {
          return { content: [{ type: 'text', text: `Evaluate error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
        }
      },
    ),
  );
}
