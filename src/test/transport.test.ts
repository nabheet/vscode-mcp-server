import { describe, it, expect, vi } from 'vitest';
import { handleRequest } from '../mcp/transport';
import { ToolDefinition } from '../utils/types';

// ── Helpers ──────────────────────────────────────────────────────────────

function makeTool(name: string, schema: Record<string, unknown>, handler?: (args: any) => any): [string, ToolDefinition] {
  return [name, {
    name,
    description: `Tool ${name}`,
    inputSchema: schema,
    handler: handler ?? vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
  }];
}

function setupTools(tools: [string, ToolDefinition][]): Map<string, ToolDefinition> {
  return new Map(tools);
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('handleRequest', () => {
  const tools = setupTools([
    makeTool('hello', {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    }),
    makeTool('add', {
      type: 'object',
      properties: { a: { type: 'integer' }, b: { type: 'integer' } },
      required: ['a', 'b'],
    }),
    makeTool('noop', { type: 'object', properties: {} }),
  ]);

  // ── Parse Errors ────────────────────────────────────────────────────

  it('returns ParseError for invalid JSON', async () => {
    const res = await handleRequest('not json', tools);
    expect(res.jsonrpc).toBe('2.0');
    expect(res.error?.code).toBe(-32700);
    expect(res.error?.message).toMatch(/parse error/i);
  });

  it('returns InvalidRequest for non-object body', async () => {
    const res = await handleRequest('"string"', tools);
    expect(res.error?.code).toBe(-32600);
  });

  it('returns InvalidRequest for missing jsonrpc version', async () => {
    const res = await handleRequest('{"method":"x"}', tools);
    expect(res.error?.code).toBe(-32600);
    expect(res.error?.message).toMatch(/jsonrpc.*2\.0/i);
  });

  it('returns InvalidRequest for wrong jsonrpc version', async () => {
    const res = await handleRequest('{"jsonrpc":"1.0","method":"x"}', tools);
    expect(res.error?.code).toBe(-32600);
  });

  it('returns InvalidRequest for non-string method', async () => {
    const res = await handleRequest('{"jsonrpc":"2.0","method":123}', tools);
    expect(res.error?.code).toBe(-32600);
  });

  // ── Method Not Found ────────────────────────────────────────────────

  it('returns MethodNotFound for unknown method', async () => {
    const res = await handleRequest('{"jsonrpc":"2.0","id":1,"method":"bogus"}', tools);
    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toMatch(/not found.*bogus/i);
  });

  // ── tools/list ──────────────────────────────────────────────────────

  it('lists all registered tools', async () => {
    const res = await handleRequest('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', tools);
    expect(res.id).toBe(1);
    const result = res.result as any;
    expect(result.tools).toHaveLength(3);
    const names = result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual(['add', 'hello', 'noop']);
  });

  it('tools/list items have name, description, inputSchema', async () => {
    const res = await handleRequest('{"jsonrpc":"2.0","id":2,"method":"tools/list"}', tools);
    const item = (res.result as any).tools[0];
    expect(item).toHaveProperty('name');
    expect(item).toHaveProperty('description');
    expect(item).toHaveProperty('inputSchema');
  });

  it('tools/list works without id', async () => {
    const res = await handleRequest('{"jsonrpc":"2.0","method":"tools/list"}', tools);
    expect(res.id).toBeNull();
    expect(res.result).toBeDefined();
  });

  // ── tools/call — params validation ─────────────────────────────────

  it('requires object params', async () => {
    const res = await handleRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":"bogus"}', tools);
    expect((res.result as any).isError).toBe(true);
    expect((res.result as any).content[0].text).toMatch(/invalid params/i);
  });

  it('requires name in params', async () => {
    const res = await handleRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{}}', tools);
    expect((res.result as any).isError).toBe(true);
    expect((res.result as any).content[0].text).toMatch(/"name".*non-empty/i);
  });

  it('requires non-empty name', async () => {
    const res = await handleRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":""}}', tools);
    expect((res.result as any).isError).toBe(true);
  });

  it('returns error for unknown tool name', async () => {
    const res = await handleRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nope"}}', tools);
    expect((res.result as any).isError).toBe(true);
    expect((res.result as any).content[0].text).toMatch(/tool not found.*nope/i);
  });

  // ── tools/call — schema validation ──────────────────────────────────

  it('passes when required args are present', async () => {
    const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'Hi there' }] });
    const localTools = setupTools([makeTool('hello', { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, handler)]);
    const res = await handleRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hello","arguments":{"name":"World"}}}', localTools);
    expect(handler).toHaveBeenCalledWith({ name: 'World' });
    expect((res.result as any).content[0].text).toBe('Hi there');
  });

  it('rejects missing required args', async () => {
    const res = await handleRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hello","arguments":{}}}', tools);
    expect((res.result as any).isError).toBe(true);
    expect((res.result as any).content[0].text).toMatch(/missing required.*name/i);
  });

  it('rejects wrong type for string arg', async () => {
    const res = await handleRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"hello","arguments":{"name":42}}}', tools);
    expect((res.result as any).isError).toBe(true);
    expect((res.result as any).content[0].text).toMatch(/expected type.*string.*number/i);
  });

  it('accepts integer values for integer type', async () => {
    const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'sum' }] });
    const localTools = setupTools([makeTool('add', { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] }, handler)]);
    const res = await handleRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add","arguments":{"a":3,"b":4}}}', localTools);
    expect(handler).toHaveBeenCalledWith({ a: 3, b: 4 });
    expect((res.result as any).isError).toBeFalsy();
  });

  it('rejects float for integer type', async () => {
    const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'sum' }] });
    const localTools = setupTools([makeTool('add', { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] }, handler)]);
    const res = await handleRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"add","arguments":{"a":3.5}}}', localTools);
    expect((res.result as any).isError).toBe(true);
    expect((res.result as any).content[0].text).toMatch(/expected type.*integer.*number/i);
  });

  it('accepts number type args', async () => {
    const handler = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const localTools = setupTools([makeTool('calc', { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] }, handler)]);
    const res = await handleRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"calc","arguments":{"x":3.14}}}', localTools);
    expect(handler).toHaveBeenCalledWith({ x: 3.14 });
    expect((res.result as any).isError).toBeFalsy();
  });

  // ── tools/call — handler errors ─────────────────────────────────────

  it('wraps handler errors in result', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('something broke'));
    const localTools = setupTools([makeTool('fail', { type: 'object', properties: {} }, handler)]);
    const res = await handleRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fail"}}', localTools);
    expect((res.result as any).isError).toBe(true);
    expect((res.result as any).content[0].text).toMatch(/tool error.*something broke/i);
  });

  it('handles non-Error thrown values', async () => {
    const handler = vi.fn().mockRejectedValue('raw string error');
    const localTools = setupTools([makeTool('fail2', { type: 'object', properties: {} }, handler)]);
    const res = await handleRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"fail2"}}', localTools);
    expect((res.result as any).isError).toBe(true);
    expect((res.result as any).content[0].text).toMatch(/raw string error/i);
  });

  // ── JSON-RPC response shape ─────────────────────────────────────────

  it('response has jsonrpc, id, and either result or error', async () => {
    const res = await handleRequest('{"jsonrpc":"2.0","id":99,"method":"tools/list"}', tools);
    expect(res.jsonrpc).toBe('2.0');
    expect(res.id).toBe(99);
    expect(res.result).toBeDefined();
    expect(res.error).toBeUndefined();
  });

  it('error response has code, message and no result', async () => {
    const res = await handleRequest('not json', tools);
    expect(res.error).toBeDefined();
    expect(res.error?.code).toBeDefined();
    expect(res.error?.message).toBeDefined();
    expect(res.result).toBeUndefined();
  });

  it('preserves string id', async () => {
    const res = await handleRequest('{"jsonrpc":"2.0","id":"req-001","method":"tools/list"}', tools);
    expect(res.id).toBe('req-001');
  });

  it('preserves null id', async () => {
    const res = await handleRequest('{"jsonrpc":"2.0","id":null,"method":"tools/list"}', tools);
    expect(res.id).toBeNull();
  });
});
