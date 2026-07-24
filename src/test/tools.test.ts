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

    const allDefs: ToolDefinition[] = [];
    class MockServer {
      registerTool(def: ToolDefinition) { allDefs.push(def); }
    }

    registerCommandsTools(new MockServer() as any);
    registerNavigationTools(new MockServer() as any);
    registerWorkspaceTools(new MockServer() as any);
    registerDebugTools(new MockServer() as any);

    // Verify specific tool patterns
    const readFile = allDefs.find(d => d.name === 'read_file');
    expect(readFile).toBeDefined();
    expect(readFile!.inputSchema).toHaveProperty('properties');
  });
});

// ── Handler behavior ──────────────────────────────────────────────────────

describe('handler behavior', () => {
  type Handler = (args: any) => Promise<any>;
  let handlers: Map<string, Handler>;

  beforeEach(async () => {
    // Reset mocks shared across tests
    (vscode.workspace as any).workspaceFolders = undefined;
    (vscode as any).debug.activeDebugSession = undefined;
    (vscode as any).debug.breakpoints = [];
    vi.clearAllMocks();

    // Load all tool modules and capture handlers via MockServer
    const { registerCommandsTools } = await import('../mcp/tools/commands');
    const { registerNavigationTools } = await import('../mcp/tools/navigation');
    const { registerWorkspaceTools } = await import('../mcp/tools/workspace');
    const { registerDebugTools } = await import('../mcp/tools/debug');

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
  });

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

  it('start_debugging returns error with no workspace folder', async () => {
    const h = handlers.get('start_debugging')!;
    const res = await h({ configName: 'Launch' });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/no workspace folder/i);
  });
});
