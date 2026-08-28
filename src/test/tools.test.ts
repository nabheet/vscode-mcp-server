import { describe, it, expect, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { ToolDefinition } from '../utils/types';

// ── Tool schema validation ──────────────────────────────────────────────

/**
 * Collect all tool definitions registered by our tool modules.
 * We import the registration functions but don't have a McpServer instance,
 * so we check the tool schemas by inspecting what each module registers.
 */
describe('tool schemas', () => {
  const validTypes = ['string', 'number', 'integer', 'boolean', 'object', 'array'];

  function validateToolSchema(def: ToolDefinition): string[] {
    const errors: string[] = [];
    const schema = def.inputSchema as Record<string, any>;

    if (!schema || schema.type !== 'object') {
      errors.push(`${def.name}: inputSchema must have type: "object"`);
      return errors;
    }

    if (schema.properties) {
      for (const [key, prop] of Object.entries(schema.properties)) {
        const p = prop as Record<string, any>;
        if (p.type && !validTypes.includes(p.type)) {
          errors.push(`${def.name}.${key}: unknown type "${p.type}"`);
        }
        if (!p.description && key !== 'folder') {
          // folder is self-explanatory, but everything else should have a description
          errors.push(`${def.name}.${key}: missing description`);
        }
      }
    }

    return errors;
  }

  it('all tool schemas use valid property types and have descriptions', async () => {
    // Import all tool modules and extract their tool definitions
    const { registerCommandsTools } = await import('../mcp/tools/commands');
    const { registerNavigationTools } = await import('../mcp/tools/navigation');
    const { registerWorkspaceTools } = await import('../mcp/tools/workspace');
    const { registerDebugTools } = await import('../mcp/tools/debug');
    const { registerTerminalTools } = await import('../mcp/tools/terminal');

    // We can't easily extract definitions without a server instance,
    // so we do a structural check by reading each module's registerTool calls
    // Instead, we create mock servers and capture what gets registered
    const allDefs: ToolDefinition[] = [];

    class MockServer {
      registerTool(def: ToolDefinition) { allDefs.push(def); }
    }

    const mockCtx = { subscriptions: [] } as any;

    registerCommandsTools(new MockServer() as any);
    registerNavigationTools(new MockServer() as any);
    registerWorkspaceTools(new MockServer() as any);
    registerDebugTools(new MockServer() as any);
    // LSP tools need document, skip in unit test
    // registerTerminalTools needs real ExtensionContext, skip

    expect(allDefs.length).toBeGreaterThan(0);

    const allErrors: string[] = [];
    for (const def of allDefs) {
      allErrors.push(...validateToolSchema(def));
    }

    if (allErrors.length > 0) {
      console.log('Schema validation errors:\n' + allErrors.join('\n'));
    }
    expect(allErrors).toEqual([]);
  });

  it('all tool schemas have required arrays as arrays of strings', async () => {
    const { registerCommandsTools } = await import('../mcp/tools/commands');
    const { registerNavigationTools } = await import('../mcp/tools/navigation');
    const { registerWorkspaceTools } = await import('../mcp/tools/workspace');
    const { registerDebugTools } = await import('../mcp/tools/debug');

    const allDefs: ToolDefinition[] = [];
    class MockServer {
      registerTool(def: ToolDefinition) { allDefs.push(def); }
    }

    registerCommandsTools(new MockServer() as any);
    registerNavigationTools(new MockServer() as any);
    registerWorkspaceTools(new MockServer() as any);
    registerDebugTools(new MockServer() as any);

    for (const def of allDefs) {
      const schema = def.inputSchema as Record<string, any>;
      if (schema.required) {
        expect(Array.isArray(schema.required)).toBe(true);
        for (const r of schema.required) {
          expect(typeof r).toBe('string');
          expect(schema.properties?.[r]).toBeDefined();
        }
      }
    }
  });

  it('only start_debugging declares a launch-specific timeoutMs override', async () => {
    const { registerDebugTools } = await import('../mcp/tools/debug');
    const allDefs: ToolDefinition[] = [];
    class MockServer {
      registerTool(def: ToolDefinition) { allDefs.push(def); }
    }
    registerDebugTools(new MockServer() as any);

    const startDef = allDefs.find((d) => d.name === 'start_debugging');
    expect(startDef).toBeDefined();
    // A debug launch resolves only after FULL session establishment (multiprocess
    // compounds attach a debugpy per worker), so it gets a budget far beyond the
    // generic 30s tool timeout instead of being cut off mid-launch.
    expect(startDef!.timeoutMs).toBe(120_000);
    for (const def of allDefs) {
      if (def.name !== 'start_debugging') {
        expect(def.timeoutMs).toBeUndefined();
      }
    }
  });

  it('tool schemas have only documented extra fields', async () => {
    const { registerCommandsTools } = await import('../mcp/tools/commands');
    const { registerNavigationTools } = await import('../mcp/tools/navigation');
    const { registerWorkspaceTools } = await import('../mcp/tools/workspace');
    const { registerDebugTools } = await import('../mcp/tools/debug');

    const allDefs: ToolDefinition[] = [];
    class MockServer {
      registerTool(def: ToolDefinition) { allDefs.push(def); }
    }

    registerCommandsTools(new MockServer() as any);
    registerNavigationTools(new MockServer() as any);
    registerWorkspaceTools(new MockServer() as any);
    registerDebugTools(new MockServer() as any);

    const allowedSchemaKeys = ['type', 'properties', 'required', 'description', 'additionalProperties'];
    for (const def of allDefs) {
      const schema = def.inputSchema as Record<string, any>;
      for (const key of Object.keys(schema)) {
        expect(allowedSchemaKeys.includes(key)).toBe(true);
      }
    }
  });

  it('all tool names are unique across all modules', async () => {
    const { registerCommandsTools } = await import('../mcp/tools/commands');
    const { registerNavigationTools } = await import('../mcp/tools/navigation');
    const { registerWorkspaceTools } = await import('../mcp/tools/workspace');
    const { registerDebugTools } = await import('../mcp/tools/debug');
    const { registerLspTools } = await import('../mcp/tools/lsp');

    const allDefs: ToolDefinition[] = [];
    class MockServer {
      registerTool(def: ToolDefinition) { allDefs.push(def); }
    }

    registerCommandsTools(new MockServer() as any);
    registerNavigationTools(new MockServer() as any);
    registerWorkspaceTools(new MockServer() as any);
    registerDebugTools(new MockServer() as any);
    // LSP tools require activeTextEditor mock — set a minimal stub
    registerLspTools(new MockServer() as any);

    const names = allDefs.map(d => d.name);
    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });

  it('all tool descriptions are non-empty', async () => {
    const { registerCommandsTools } = await import('../mcp/tools/commands');
    const { registerNavigationTools } = await import('../mcp/tools/navigation');
    const { registerWorkspaceTools } = await import('../mcp/tools/workspace');
    const { registerDebugTools } = await import('../mcp/tools/debug');
    const { registerLspTools } = await import('../mcp/tools/lsp');

    const allDefs: ToolDefinition[] = [];
    class MockServer {
      registerTool(def: ToolDefinition) { allDefs.push(def); }
    }

    registerCommandsTools(new MockServer() as any);
    registerNavigationTools(new MockServer() as any);
    registerWorkspaceTools(new MockServer() as any);
    registerDebugTools(new MockServer() as any);
    registerLspTools(new MockServer() as any);

    for (const def of allDefs) {
      expect(def.description).toBeTruthy();
    }
  });

  it('delete_file tool includes recursive parameter', async () => {
    const { registerWorkspaceTools } = await import('../mcp/tools/workspace');

    const allDefs: ToolDefinition[] = [];
    class MockServer {
      registerTool(def: ToolDefinition) { allDefs.push(def); }
    }

    registerWorkspaceTools(new MockServer() as any);
    const deleteFile = allDefs.find(d => d.name === 'delete_file');
    expect(deleteFile).toBeDefined();
    const schema = deleteFile!.inputSchema as Record<string, any>;
    expect(schema.properties?.recursive).toBeDefined();
    expect(schema.properties?.recursive.type).toBe('boolean');
  });

  it('read_file tool works (snapshot of all command tool schemas)', async () => {
    const { registerCommandsTools } = await import('../mcp/tools/commands');
    const { registerNavigationTools } = await import('../mcp/tools/navigation');
    const { registerWorkspaceTools } = await import('../mcp/tools/workspace');
    const { registerDebugTools } = await import('../mcp/tools/debug');
    const { registerSearchTools } = await import('../mcp/tools/search');

    const allDefs: ToolDefinition[] = [];
    class MockServer {
      registerTool(def: ToolDefinition) { allDefs.push(def); }
    }

    registerCommandsTools(new MockServer() as any);
    registerNavigationTools(new MockServer() as any);
    registerWorkspaceTools(new MockServer() as any);
    registerDebugTools(new MockServer() as any);
    registerSearchTools(new MockServer() as any);

    // Verify specific tool patterns
    const readFile = allDefs.find(d => d.name === 'read_file');
    expect(readFile).toBeDefined();
    expect(readFile!.inputSchema).toHaveProperty('properties');
    expect(allDefs.find(d => d.name === 'search_files')).toBeDefined();
  });
});

// ── Handler behavior ──────────────────────────────────────────────────────

describe('handler behavior', () => {
  type Handler = (args: any) => Promise<any>;
  let handlers: Map<string, Handler>;

  beforeEach(async () => {
    // Reset mocks shared across tests
    (vscode.workspace as any).workspaceFolders = undefined;
    (vscode.workspace as any).workspaceFile = undefined;
    (vscode.workspace as any).fs.readFile = vi.fn();
    (vscode as any).debug.activeDebugSession = undefined;
    (vscode as any).debug.breakpoints = [];
    (vscode.debug.startDebugging as any).mockReset();
    vi.clearAllMocks();

    // Load all tool modules and capture handlers via MockServer
    const { registerCommandsTools } = await import('../mcp/tools/commands');
    const { registerNavigationTools } = await import('../mcp/tools/navigation');
    const { registerWorkspaceTools } = await import('../mcp/tools/workspace');
    const { registerDebugTools } = await import('../mcp/tools/debug');
    const { registerSearchTools } = await import('../mcp/tools/search');

    handlers = new Map();
    class MockServer {
      registerTool(def: ToolDefinition) {
        handlers.set(def.name, def.handler);
      }
    }
    registerCommandsTools(new MockServer() as any);
    registerNavigationTools(new MockServer() as any);
    registerWorkspaceTools(new MockServer() as any);
    registerDebugTools(new MockServer() as any);
    registerSearchTools(new MockServer() as any);
  });

  /**
   * Route workspace.fs.readFile by path: `.vscode/launch.json` reads return
   * launchJson (rejected when undefined — folder has no launch.json), and
   * `*.code-workspace` reads return workspaceFile (rejected when undefined).
   */
  function mockLaunchSources(launchJson?: string, workspaceFile?: string) {
    (vscode.workspace as any).fs.readFile = vi.fn().mockImplementation((uri: any) => {
      const p = uri?.fsPath ?? '';
      if (p.endsWith('.vscode/launch.json')) {
        return launchJson !== undefined
          ? Promise.resolve(Buffer.from(launchJson))
          : Promise.reject(new Error('ENOENT'));
      }
      if (p.endsWith('.code-workspace')) {
        return workspaceFile !== undefined
          ? Promise.resolve(Buffer.from(workspaceFile))
          : Promise.reject(new Error('ENOENT'));
      }
      return Promise.reject(new Error('ENOENT'));
    });
  }

  // ── Workspace ────────────────────────────────────────────────────────

  it('get_workspace_folders returns folder list', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: { fsPath: '/workspace/frontend' } },
      { name: 'backend', uri: { fsPath: '/workspace/backend' } },
    ];
    const h = handlers.get('get_workspace_folders')!;
    const res = await h({});
    expect(res.isError).toBe(false);
    const text: string = res.content[0].text;
    expect(text).toContain('frontend');
    expect(text).toContain('backend');
  });

  it('get_workspace_folders returns empty when no folders open', async () => {
    const h = handlers.get('get_workspace_folders')!;
    const res = await h({});
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toMatch(/no workspace folders|none/i);
  });

  it('add_workspace_folder appends a folder to the workspace', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: vscode.Uri.file('/ws/frontend') },
      { name: 'backend', uri: vscode.Uri.file('/ws/backend') },
    ];
    (vscode.workspace as any).workspaceFile = { uri: { scheme: 'file', fsPath: '/ws/test.code-workspace' } };
    (vscode.workspace.updateWorkspaceFolders as any).mockReturnValue(true);

    const h = handlers.get('add_workspace_folder')!;
    const res = await h({ path: '/elsewhere/services' });

    expect(vscode.workspace.updateWorkspaceFolders).toHaveBeenCalledTimes(1);
    expect(vscode.workspace.updateWorkspaceFolders).toHaveBeenCalledWith(2, 0, {
      uri: expect.objectContaining({ fsPath: '/elsewhere/services' }),
      name: 'services',
    });
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain("Added workspace folder 'services'");
  });

  it('add_workspace_folder rejects a name collision', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: vscode.Uri.file('/ws/frontend') },
    ];
    const h = handlers.get('add_workspace_folder')!;
    const res = await h({ path: '/elsewhere/thing', name: 'frontend' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('already exists');
    expect(vscode.workspace.updateWorkspaceFolders).not.toHaveBeenCalled();
  });

  it('add_workspace_folder reports failure when the API rejects (single-folder workspace)', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: vscode.Uri.file('/ws/frontend') },
    ];
    (vscode.workspace.updateWorkspaceFolders as any).mockReturnValue(false);

    const h = handlers.get('add_workspace_folder')!;
    const res = await h({ path: '/elsewhere/thing' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/multi-root|failed/i);
  });

  it('update_workspace_folder renames and moves a folder', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: vscode.Uri.file('/ws/frontend') },
      { name: 'backend', uri: vscode.Uri.file('/ws/backend') },
    ];
    (vscode.workspace.updateWorkspaceFolders as any).mockReturnValue(true);

    const h = handlers.get('update_workspace_folder')!;
    const res = await h({ name: 'backend', path: '/elsewhere/api', newName: 'api' });

    expect(vscode.workspace.updateWorkspaceFolders).toHaveBeenCalledTimes(1);
    expect(vscode.workspace.updateWorkspaceFolders).toHaveBeenCalledWith(1, 1, {
      uri: expect.objectContaining({ fsPath: '/elsewhere/api' }),
      name: 'api',
    });
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain("Updated workspace folder 'backend' → 'api'");
  });

  it('update_workspace_folder rejects an unknown folder name', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: vscode.Uri.file('/ws/frontend') },
    ];
    const h = handlers.get('update_workspace_folder')!;
    const res = await h({ name: 'nope', path: '/x' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
    expect(vscode.workspace.updateWorkspaceFolders).not.toHaveBeenCalled();
  });

  it('update_workspace_folder requires path or newName', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: vscode.Uri.file('/ws/frontend') },
    ];
    const h = handlers.get('update_workspace_folder')!;
    const res = await h({ name: 'frontend' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/path.*newName|newName.*path/i);
  });

  it('remove_workspace_folder removes by name', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: vscode.Uri.file('/ws/frontend') },
      { name: 'backend', uri: vscode.Uri.file('/ws/backend') },
    ];
    (vscode.workspace.updateWorkspaceFolders as any).mockReturnValue(true);

    const h = handlers.get('remove_workspace_folder')!;
    const res = await h({ name: 'backend' });

    expect(vscode.workspace.updateWorkspaceFolders).toHaveBeenCalledTimes(1);
    expect(vscode.workspace.updateWorkspaceFolders).toHaveBeenCalledWith(1, 1);
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain("Removed workspace folder 'backend'");
  });

  it('remove_workspace_folder rejects an unknown folder name', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: vscode.Uri.file('/ws/frontend') },
    ];
    const h = handlers.get('remove_workspace_folder')!;
    const res = await h({ name: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
    expect(vscode.workspace.updateWorkspaceFolders).not.toHaveBeenCalled();
  });

  // ── read_files (batch) ───────────────────────────────────────────────

  it('read_files reads multiple files with === path === markers', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: vscode.Uri.file('/ws/frontend') },
    ];
    (vscode.workspace as any).fs.readFile = vi.fn().mockImplementation((uri: any) => {
      if (uri.fsPath === '/ws/frontend/a.ts') return Promise.resolve(Buffer.from('const a = 1;'));
      if (uri.fsPath === '/ws/frontend/b.ts') return Promise.resolve(Buffer.from('const b = 2;'));
      return Promise.reject(new Error('ENOENT'));
    });
    const h = handlers.get('read_files')!;
    const res = await h({ paths: ['a.ts', 'b.ts'] });
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('=== /ws/frontend/a.ts ===\nconst a = 1;');
    expect(res.content[0].text).toContain('=== /ws/frontend/b.ts ===\nconst b = 2;');
  });

  it('read_files reports per-file errors inline without aborting the batch', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: vscode.Uri.file('/ws/frontend') },
    ];
    (vscode.workspace as any).fs.readFile = vi.fn().mockImplementation((uri: any) => {
      if (uri.fsPath === '/ws/frontend/ok.ts') return Promise.resolve(Buffer.from('ok'));
      return Promise.reject(new Error('ENOENT'));
    });
    const h = handlers.get('read_files')!;
    const res = await h({ paths: ['ok.ts', 'missing.ts'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('=== /ws/frontend/ok.ts ===\nok');
    expect(res.content[0].text).toContain('=== missing.ts ===\n[error:');
    expect(res.content[0].text).toContain('ENOENT');
  });

  it('read_files resolves relative paths against the named workspaceFolder', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: vscode.Uri.file('/ws/frontend') },
      { name: 'backend', uri: vscode.Uri.file('/ws/backend') },
    ];
    (vscode.workspace as any).fs.readFile = vi.fn().mockImplementation((uri: any) => {
      if (uri.fsPath === '/ws/backend/util.ts') return Promise.resolve(Buffer.from('// shared util'));
      return Promise.reject(new Error('ENOENT'));
    });
    const h = handlers.get('read_files')!;
    const res = await h({ paths: ['util.ts'], workspaceFolder: 'backend' });
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('=== /ws/backend/util.ts ===\n// shared util');
  });

  it('read_files rejects absolute paths outside the workspace', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'frontend', uri: vscode.Uri.file('/ws/frontend') },
    ];
    const h = handlers.get('read_files')!;
    const res = await h({ paths: ['/etc/passwd'] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('outside the workspace');
    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
  });

  it('read_files errors on empty paths array', async () => {
    const h = handlers.get('read_files')!;
    const res = await h({ paths: [] });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('No paths');
  });

  // ── Navigation (no-editor handlers) ──────────────────────────────────

  it('select_lines returns error with no active editor', async () => {
    const h = handlers.get('select_lines')!;
    const res = await h({ startLine: 1, endLine: 5 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no active editor/i);
  });

  it('focus_editor succeeds', async () => {
    const h = handlers.get('focus_editor')!;
    const res = await h({});
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('Focused');
  });

  it('close_editor succeeds', async () => {
    const h = handlers.get('close_editor')!;
    const res = await h({});
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('Closed');
  });

  it('close_all_editors succeeds', async () => {
    const h = handlers.get('close_all_editors')!;
    const res = await h({});
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('Closed all editors');
  });

  // ── Commands ─────────────────────────────────────────────────────────

  it('execute_command returns success with no return value', async () => {
    const h = handlers.get('execute_command')!;
    (vscode.commands.executeCommand as any).mockResolvedValue(undefined);
    const res = await h({ command: 'workbench.action.files.newUntitledFile' });
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('executed successfully');
  });

  it('execute_command returns command result', async () => {
    const h = handlers.get('execute_command')!;
    (vscode.commands.executeCommand as any).mockResolvedValue({ value: 42 });
    const res = await h({ command: 'some.command', args: ['a', 'b'] });
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('42');
  });

  it('execute_command returns error on failure', async () => {
    const h = handlers.get('execute_command')!;
    (vscode.commands.executeCommand as any).mockRejectedValue(new Error('command failed'));
    const res = await h({ command: 'bad.command' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('command failed');
  });

  it('list_commands returns command list', async () => {
    const h = handlers.get('list_commands')!;
    const res = await h({});
    expect(res.isError).toBe(false);
    const text: string = res.content[0].text;
    expect(text).toContain('cmd1');
    expect(text).toContain('cmd2');
  });

  it('list_commands filters to internal commands', async () => {
    const h = handlers.get('list_commands')!;
    await h({ includeInternal: true });
    expect(vscode.commands.getCommands).toHaveBeenCalledWith(true);
  });

  // ── Debug ────────────────────────────────────────────────────────────

  it('stop_debugging returns error with no active session', async () => {
    const h = handlers.get('stop_debugging')!;
    const res = await h({});
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no active debug session/i);
  });

  it('list_breakpoints returns empty when none set', async () => {
    const h = handlers.get('list_breakpoints')!;
    const res = await h({});
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('No breakpoints');
  });

  it('list_breakpoints lists breakpoints when set', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: { fsPath: '/workspace' } },
    ];
    // Add a breakpoint first
    const addH = handlers.get('add_breakpoint')!;
    await addH({ path: 'src/main.ts', line: 10, workspaceFolder: 'root' });

    const h = handlers.get('list_breakpoints')!;
    const res = await h({});
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('main.ts');
    expect(res.content[0].text).toContain('10');
  });

  it('add_breakpoint returns error with nonexistent workspaceFolder', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: { fsPath: '/workspace' } },
    ];
    const h = handlers.get('add_breakpoint')!;
    const res = await h({ path: 'src/main.ts', line: 10, workspaceFolder: 'bogus' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/failed|not found/i);
  });

  it('remove_breakpoint returns error with nonexistent workspaceFolder', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: { fsPath: '/workspace' } },
    ];
    const h = handlers.get('remove_breakpoint')!;
    const res = await h({ path: 'src/main.ts', line: 10, workspaceFolder: 'bogus' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/failed|not found/i);
  });

  it('add_breakpoint allows absolute paths outside the workspace', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: { fsPath: '/workspace' } },
    ];
    const h = handlers.get('add_breakpoint')!;
    const res = await h({ path: '/Users/me/elsewhere/lib.js', line: 3 });
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('elsewhere/lib.js');
    expect((vscode.debug as any).breakpoints.length).toBe(1);
  });

  it('remove_breakpoint removes a breakpoint outside the workspace', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: { fsPath: '/workspace' } },
    ];
    const addH = handlers.get('add_breakpoint')!;
    await addH({ path: '/Users/me/elsewhere/lib.js', line: 3 });
    const h = handlers.get('remove_breakpoint')!;
    const res = await h({ path: '/Users/me/elsewhere/lib.js', line: 3 });
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('elsewhere/lib.js');
    expect((vscode.debug as any).breakpoints.length).toBe(0);
  });

  it('add_breakpoint still rejects relative paths from outside the workspace', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: { fsPath: '/workspace' } },
    ];
    const h = handlers.get('add_breakpoint')!;
    const res = await h({ path: '../escape.js', line: 3 });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/outside the workspace/i);
  });

  it('start_debugging starts a folder-scoped config from launch.json', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: vscode.Uri.file('/workspace') },
    ];
    // A folder's .vscode/launch.json IS the launch section — no top-level
    // `launch` wrapper (that only exists in *.code-workspace files).
    mockLaunchSources(
      JSON.stringify({
        version: '0.2.0',
        configurations: [{ name: 'Launch', type: 'node', request: 'launch', program: '/workspace/app.js' }],
      }),
    );
    (vscode.debug.startDebugging as any).mockResolvedValueOnce(true);

    const h = handlers.get('start_debugging')!;
    const res = await h({ configName: 'Launch' });

    expect(vscode.debug.startDebugging).toHaveBeenCalledTimes(1);
    // The parsed config OBJECT is passed (name-based resolution is unreliable
    // on VS Code 1.133+), scoped to the declaring folder.
    expect(vscode.debug.startDebugging).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'root' }),
      expect.objectContaining({ name: 'Launch', type: 'node', request: 'launch' }),
    );
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('Started debugging');
  });

  it('start_debugging launches a workspace-file config directly with no doomed attempts', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: vscode.Uri.file('/workspace') },
    ];
    (vscode.workspace as any).workspaceFile = { uri: { scheme: 'file', fsPath: '/tmp/test.code-workspace' } };
    // Folder has no launch.json; config lives in the workspace file — the old
    // ladder would still fire (folder, name) and (undefined, name) first,
    // making VS Code show error toasts before succeeding here. New behavior:
    // exactly one call, the workspace-file config object.
    mockLaunchSources(
      undefined,
      JSON.stringify({
        folders: [{ name: 'root', path: '/workspace' }],
        launch: {
          version: '0.2.0',
          configurations: [{ name: 'Launch', type: 'node', request: 'launch', program: '/workspace/app.js' }],
        },
      }),
    );
    (vscode.debug.startDebugging as any).mockResolvedValueOnce(true);

    const h = handlers.get('start_debugging')!;
    const res = await h({ configName: 'Launch' });

    expect(vscode.debug.startDebugging).toHaveBeenCalledTimes(1);
    expect(vscode.debug.startDebugging).toHaveBeenLastCalledWith(
      undefined,
      expect.objectContaining({ name: 'Launch', type: 'node', request: 'launch' }),
    );
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('Started debugging');
  });

  it('start_debugging does not fall back when a folder config exists but fails to start', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: vscode.Uri.file('/workspace') },
    ];
    // Config IS in the folder's launch.json, but starting it throws — this is
    // a genuine config failure, not a scope miss. No fallback attempt.
    mockLaunchSources(
      JSON.stringify({
        version: '0.2.0',
        configurations: [{ name: 'Launch', type: 'node', request: 'launch', program: '/workspace/app.js' }],
      }),
    );
    (vscode.debug.startDebugging as any).mockImplementation(() => {
      throw new Error("Configuration 'Launch' failed to launch");
    });

    const h = handlers.get('start_debugging')!;
    const res = await h({ configName: 'Launch' });

    expect(vscode.debug.startDebugging).toHaveBeenCalledTimes(1);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/failed to start/i);
  });

  it('start_debugging reports failure when config not found anywhere', async () => {
    const h = handlers.get('start_debugging')!;
    const res = await h({ configName: 'Launch' });

    expect(vscode.debug.startDebugging).not.toHaveBeenCalled();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/failed to start/i);
  });

  it('start_debugging returns error with unknown workspace folder', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: { fsPath: '/workspace' } },
    ];
    const h = handlers.get('start_debugging')!;
    const res = await h({ configName: 'Launch', folder: 'bogus' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/not found/i);
    expect(vscode.debug.startDebugging).not.toHaveBeenCalled();
  });

  it('start_debugging reads the workspace file config and passes it as an object', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: vscode.Uri.file('/workspace') },
    ];
    (vscode.workspace as any).workspaceFile = { uri: { scheme: 'file', fsPath: '/tmp/test.code-workspace' } };
    mockLaunchSources(
      undefined,
      JSON.stringify({
        folders: [{ name: 'root', path: '/workspace' }],
        launch: {
          version: '0.2.0',
          configurations: [
            { name: 'Ws', type: 'node', request: 'launch', program: '/workspace/app.js' },
          ],
        },
      }),
    );
    (vscode.debug.startDebugging as any).mockResolvedValueOnce(true);

    const h = handlers.get('start_debugging')!;
    const res = await h({ configName: 'Ws' });

    expect((vscode.workspace as any).fs.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: '/tmp/test.code-workspace' }),
    );
    // No folder or name-based attempts — the workspace file is known to
    // declare the config, so the object is passed directly.
    expect(vscode.debug.startDebugging).toHaveBeenCalledTimes(1);
    expect(vscode.debug.startDebugging).toHaveBeenLastCalledWith(
      undefined,
      expect.objectContaining({ name: 'Ws', type: 'node', request: 'launch' }),
    );
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('Started debugging');
  });

  it('start_debugging falls back to a folder-scoped object launch when undefined-scoped object fails', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: vscode.Uri.file('/workspace') },
    ];
    (vscode.workspace as any).workspaceFile = { uri: { scheme: 'file', fsPath: '/tmp/test.code-workspace' } };
    mockLaunchSources(
      undefined,
      JSON.stringify({
        folders: [{ name: 'root', path: '/workspace' }],
        launch: {
          version: '0.2.0',
          configurations: [{ name: 'Ws', type: 'node', request: 'launch', program: '/workspace/app.js' }],
        },
      }),
    );
    // undefined+object fails, folder+object succeeds
    (vscode.debug.startDebugging as any).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    const h = handlers.get('start_debugging')!;
    const res = await h({ configName: 'Ws' });

    expect(vscode.debug.startDebugging).toHaveBeenCalledTimes(2);
    expect(vscode.debug.startDebugging).toHaveBeenLastCalledWith(
      expect.objectContaining({ name: 'root' }),
      expect.objectContaining({ name: 'Ws', type: 'node', request: 'launch' }),
    );
    expect(res.isError).toBe(false);
  });

  it('start_debugging reads a JSONC workspace file with comments and trailing commas', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: vscode.Uri.file('/workspace') },
    ];
    (vscode.workspace as any).workspaceFile = { uri: { scheme: 'file', fsPath: '/tmp/test.code-workspace' } };
    mockLaunchSources(
      undefined,
      `{
        // Workspace files are JSONC: comments and trailing commas are legal
        "folders": [{ "name": "root", "path": "/workspace" }],
        "launch": {
          "version": "0.2.0", /* block comment */
          "configurations": [
            { "name": "Ws", "type": "node", "request": "launch", "program": "https://example.com/x" },
          ],
        },
      }`,
    );
    (vscode.debug.startDebugging as any).mockResolvedValueOnce(true);

    const h = handlers.get('start_debugging')!;
    const res = await h({ configName: 'Ws' });

    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('Started debugging');
    expect(vscode.debug.startDebugging).toHaveBeenLastCalledWith(
      undefined,
      expect.objectContaining({ name: 'Ws', type: 'node', request: 'launch', program: 'https://example.com/x' }),
    );
  });

  it('start_debugging expands a compound config from the workspace file', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: vscode.Uri.file('/workspace') },
    ];
    (vscode.workspace as any).workspaceFile = { uri: { scheme: 'file', fsPath: '/tmp/test.code-workspace' } };
    mockLaunchSources(
      undefined,
      JSON.stringify({
        folders: [{ name: 'root', path: '/workspace' }],
        launch: {
          version: '0.2.0',
          configurations: [
            { name: 'Frontend', type: 'node', request: 'launch', program: '/workspace/fe.js' },
            { name: 'Backend', type: 'node', request: 'launch', program: '/workspace/be.js' },
          ],
          compounds: [
            { name: 'Full Stack', configurations: ['Frontend', 'Backend'], stopAll: true },
          ],
        },
      }),
    );
    // Only the two compound members are started — no folder/name misses first
    (vscode.debug.startDebugging as any).mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    const h = handlers.get('start_debugging')!;
    const res = await h({ configName: 'Full Stack' });

    expect(vscode.debug.startDebugging).toHaveBeenCalledTimes(2);
    expect(vscode.debug.startDebugging).toHaveBeenNthCalledWith(
      1,
      undefined,
      expect.objectContaining({ name: 'Frontend', type: 'node', request: 'launch' }),
    );
    expect(vscode.debug.startDebugging).toHaveBeenNthCalledWith(
      2,
      undefined,
      expect.objectContaining({ name: 'Backend', type: 'node', request: 'launch' }),
    );
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('Started debugging');
  });

  it('start_debugging reports compound failure when a constituent config is missing', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: vscode.Uri.file('/workspace') },
    ];
    (vscode.workspace as any).workspaceFile = { uri: { scheme: 'file', fsPath: '/tmp/test.code-workspace' } };
    mockLaunchSources(
      undefined,
      JSON.stringify({
        folders: [{ name: 'root', path: '/workspace' }],
        launch: {
          version: '0.2.0',
          configurations: [
            { name: 'Frontend', type: 'node', request: 'launch', program: '/workspace/fe.js' },
          ],
          compounds: [
            { name: 'Full Stack', configurations: ['Frontend', 'Ghost'] },
          ],
        },
      }),
    );
    // Only 'Frontend' starts
    (vscode.debug.startDebugging as any).mockResolvedValueOnce(true);

    const h = handlers.get('start_debugging')!;
    const res = await h({ configName: 'Full Stack' });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/failed to start/i);
    expect(res.content[0].text).toContain('Ghost');
  });

  it('start_debugging expands a compound config from a folder launch.json', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'backend', uri: vscode.Uri.file('/ws/backend') },
    ];
    (vscode.workspace as any).workspaceFile = { uri: { scheme: 'file', fsPath: '/ws/test.code-workspace' } };
    mockLaunchSources(
      JSON.stringify({
        version: '0.2.0',
        configurations: [
          { name: 'Worker', type: 'node', request: 'launch', program: '/ws/backend/worker.js' },
          { name: 'API', type: 'node', request: 'launch', program: '/ws/backend/api.js' },
        ],
        compounds: [
          { name: 'Stack', configurations: ['Worker', 'API'] },
        ],
      }),
      undefined,
    );
    // Each compound member starts with the declaring folder + config object —
    // no name-based resolution (unreliable in VS Code 1.133+)
    (vscode.debug.startDebugging as any).mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    const h = handlers.get('start_debugging')!;
    const res = await h({ configName: 'Stack' });

    expect(vscode.debug.startDebugging).toHaveBeenCalledTimes(2);
    expect(vscode.debug.startDebugging).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: 'backend' }),
      expect.objectContaining({ name: 'Worker', type: 'node', request: 'launch' }),
    );
    expect(vscode.debug.startDebugging).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: 'backend' }),
      expect.objectContaining({ name: 'API', type: 'node', request: 'launch' }),
    );
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('Started debugging');
  });

  // ── Search ────────────────────────────────────────────────────────────

  function mockSearchFiles(contents: Record<string, string>, uris: { fsPath: string }[]) {
    (vscode.workspace as any).findFiles = vi.fn().mockResolvedValue(uris);
    (vscode.workspace as any).fs.readFile = vi.fn().mockImplementation((uri: any) => {
      const text = contents[uri?.fsPath ?? ''];
      return text !== undefined
        ? Promise.resolve(Buffer.from(text))
        : Promise.reject(new Error('ENOENT'));
    });
  }

  it('search_files finds matching lines with file:line:col', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: vscode.Uri.file('/ws') },
    ];
    mockSearchFiles(
      {
        '/ws/frontend/src/index.ts': '// frontend code\nconst a = 1;\n',
        '/ws/backend/src/index.ts': '// backend code\nconst b = 2;\n',
      },
      [
        { fsPath: '/ws/frontend/src/index.ts' },
        { fsPath: '/ws/backend/src/index.ts' },
      ],
    );

    const h = handlers.get('search_files')!;
    const res = await h({ query: 'const' });

    expect(res.isError).toBe(false);
    const text: string = res.content[0].text;
    expect(text).toContain('2 matches');
    expect(text).toContain('/ws/frontend/src/index.ts:2:1: const a = 1;');
    expect(text).toContain('/ws/backend/src/index.ts:2:1: const b = 2;');
    expect(vscode.workspace.findFiles).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: '**/*' }),
      '**/node_modules/**',
      2000,
    );
  });

  it('search_files returns (no matches) when nothing matches', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: vscode.Uri.file('/ws') },
    ];
    mockSearchFiles(
      { '/ws/a.ts': 'nothing here\n' },
      [{ fsPath: '/ws/a.ts' }],
    );

    const h = handlers.get('search_files')!;
    const res = await h({ query: 'zzz-nope' });

    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('(no matches)');
  });

  it('search_files searches every workspace folder by default', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'fe', uri: vscode.Uri.file('/ws/fe') },
      { name: 'be', uri: vscode.Uri.file('/ws/be') },
    ];
    mockSearchFiles(
      {
        '/ws/fe/a.ts': 'shared marker\n',
        '/ws/be/b.ts': 'shared marker\n',
      },
      [
        { fsPath: '/ws/fe/a.ts' },
        { fsPath: '/ws/be/b.ts' },
      ],
    );

    const h = handlers.get('search_files')!;
    const res = await h({ query: 'marker' });

    expect(vscode.workspace.findFiles).toHaveBeenCalledTimes(2);
    expect(vscode.workspace.findFiles).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ base: expect.objectContaining({ fsPath: '/ws/fe' }) }),
      '**/node_modules/**',
      2000,
    );
    expect(vscode.workspace.findFiles).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ base: expect.objectContaining({ fsPath: '/ws/be' }) }),
      '**/node_modules/**',
      2000,
    );
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('2 matches');
    expect(res.content[0].text).toContain('/ws/fe/a.ts:1:8: shared marker');
    expect(res.content[0].text).toContain('/ws/be/b.ts:1:8: shared marker');
  });

  it('search_files is case-insensitive by default and honors caseSensitive', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: vscode.Uri.file('/ws') },
    ];
    mockSearchFiles(
      { '/ws/a.ts': 'Hello World\n' },
      [{ fsPath: '/ws/a.ts' }],
    );

    const h = handlers.get('search_files')!;
    const loose = await h({ query: 'hello' });
    expect(loose.content[0].text).toContain('/ws/a.ts:1:1: Hello World');

    const strict = await h({ query: 'hello', caseSensitive: true });
    expect(strict.content[0].text).toContain('(no matches)');
  });

  it('search_files treats query as a regex with useRegex and reports invalid regexes', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: vscode.Uri.file('/ws') },
    ];
    mockSearchFiles(
      { '/ws/a.ts': 'const value = 42;\n' },
      [{ fsPath: '/ws/a.ts' }],
    );

    const h = handlers.get('search_files')!;
    const res = await h({ query: 'const \\w+ = \\d+', useRegex: true });
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('/ws/a.ts:1:1: const value = 42;');

    const bad = await h({ query: '([unclosed', useRegex: true });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toMatch(/invalid regular expression/i);
  });

  it('search_files caps results at maxResults', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'root', uri: vscode.Uri.file('/ws') },
    ];
    mockSearchFiles(
      { '/ws/a.ts': 'foo\nfoo\nfoo\nfoo\n' },
      [{ fsPath: '/ws/a.ts' }],
    );

    const h = handlers.get('search_files')!;
    const res = await h({ query: 'foo', maxResults: 2 });

    expect(res.isError).toBe(false);
    const text: string = res.content[0].text;
    expect(text).toContain('2 matches');
    expect(text).not.toContain('/ws/a.ts:4:');
  });

  it('search_files supports include/exclude globs and workspaceFolder scoping', async () => {
    (vscode.workspace as any).workspaceFolders = [
      { name: 'fe', uri: vscode.Uri.file('/ws/fe') },
      { name: 'be', uri: vscode.Uri.file('/ws/be') },
    ];
    mockSearchFiles(
      { '/ws/be/src/app.ts': 'const x = 1;\n' },
      [{ fsPath: '/ws/be/src/app.ts' }],
    );

    const h = handlers.get('search_files')!;
    const res = await h({ query: 'x =', include: '**/*.ts', exclude: '**/dist/**', workspaceFolder: 'be' });

    expect(vscode.workspace.findFiles).toHaveBeenCalledWith(
      expect.objectContaining({ base: expect.objectContaining({ fsPath: '/ws/be' }), pattern: '**/*.ts' }),
      '**/dist/**',
      2000,
    );
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain('/ws/be/src/app.ts:1:7: const x = 1;');
  });
});
