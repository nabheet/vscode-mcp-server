import { describe, it, expect } from 'vitest';
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
});
