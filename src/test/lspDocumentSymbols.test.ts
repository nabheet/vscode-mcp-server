import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import type { McpServer } from "../mcp/server";
import type { ToolDefinition } from "../utils/types";

/** Shape of the result the LSP handlers return. */
interface ToolResult {
  content: { type: string; text: string }[];
  isError: boolean;
}

type Handler = (args: Record<string, unknown>) => Promise<unknown>;
type MockExecuteCommand = { mockResolvedValue: (v: unknown) => unknown };

/**
 * get_document_symbols resilience.
 *
 * The symbol provider result is not runtime-validated: a third-party provider
 * can return plain objects, and the declared type (DocumentSymbol |
 * SymbolInformation) does not exist at runtime. Every case below is a shape a
 * misbehaving provider can produce. Until this suite existed only tool
 * registration metadata was asserted, which is how a regression in
 * flattenSymbol reached review twice.
 */
describe("get_document_symbols resilience", () => {
  let handlers: Map<string, Handler>;

  const stubProvider = (value: unknown): unknown =>
    (vscode.commands.executeCommand as unknown as MockExecuteCommand).mockResolvedValue(value);

  const run = async (): Promise<ToolResult> => {
    const handler = handlers.get("get_document_symbols");
    if (!handler) throw new Error("missing handler get_document_symbols");
    return (await handler({})) as ToolResult;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = {
      document: { uri: { fsPath: "/tmp/symbols.ts", scheme: "file" } },
      selection: { active: { line: 0, character: 0 } },
    };
    const { registerLspTools } = await import("../mcp/tools/lsp");
    handlers = new Map();
    class MockServer {
      registerTool(def: ToolDefinition) {
        handlers.set(def.name, def.handler);
      }
    }
    registerLspTools(new MockServer() as unknown as McpServer);
  });

  afterEach(() => {
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = undefined;
  });

  it("flattens well-formed DocumentSymbol and SymbolInformation entries", async () => {
    stubProvider([
      { name: "Alpha", kind: 4, range: { start: { line: 0 } } },
      { name: "Beta", kind: 5, location: { range: { start: { line: 1 } } } },
    ]);
    const res = await run();
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain("Alpha");
    expect(res.content[0].text).toContain("Beta");
  });

  it("skips a primitive entry instead of failing the whole tool", async () => {
    stubProvider([
      { name: "Alpha", kind: 4, range: { start: { line: 0 } } },
      "junk",
      { name: "Beta", kind: 5, location: { range: { start: { line: 1 } } } },
    ]);
    const res = await run();
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain("Alpha");
    expect(res.content[0].text).toContain("Beta");
  });

  it("skips a symbol with neither location nor range", async () => {
    stubProvider([{ name: "Alpha", kind: 4 }]);
    const res = await run();
    expect(res.isError).toBe(false);
    expect(res.content[0].text).not.toContain("Alpha");
  });

  it("prints a symbol whose location is undefined but range is set", async () => {
    stubProvider([{ name: "Alpha", kind: 4, location: undefined, range: { start: { line: 2 } } }]);
    const res = await run();
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain("Alpha");
    expect(res.content[0].text).toContain("at 3");
  });

  it("skips children that are undefined", async () => {
    stubProvider([{ name: "Alpha", kind: 4, range: { start: { line: 0 } }, children: undefined }]);
    const res = await run();
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain("Alpha");
  });

  it("flattens nested children", async () => {
    stubProvider([
      {
        name: "Alpha",
        kind: 4,
        range: { start: { line: 0 } },
        children: [{ name: "Nested", kind: 5, location: { range: { start: { line: 3 } } } }],
      },
    ]);
    const res = await run();
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain("Nested");
  });

  it("iterates children given as a non-array iterable", async () => {
    stubProvider([
      {
        name: "Alpha",
        kind: 4,
        range: { start: { line: 0 } },
        children: new Set([
          { name: "FromSet", kind: 5, location: { range: { start: { line: 4 } } } },
        ]),
      },
    ]);
    const res = await run();
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain("FromSet");
  });

  it("does not throw on a truthy non-iterable children value", async () => {
    stubProvider([{ name: "Alpha", kind: 4, range: { start: { line: 0 } }, children: 5 }]);
    const res = await run();
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain("Alpha");
  });

  it("reports no symbols for an empty provider result", async () => {
    stubProvider([]);
    const res = await run();
    expect(res.isError).toBe(false);
    expect(res.content[0].text).toContain("No symbols found");
  });

  it("errors cleanly when no editor is active", async () => {
    (vscode.window as unknown as { activeTextEditor: unknown }).activeTextEditor = undefined;
    const res = await run();
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("No active text editor");
  });
});
