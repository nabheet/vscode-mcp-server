import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as vscode from "vscode";
import type { McpServer } from "../mcp/server";
import { registerLogsTools } from "../mcp/tools/logs";
import type { ToolDefinition } from "../utils/types";

type HandlerResult = { content: { type: string; text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<HandlerResult>;

function collectHandlers(context: vscode.ExtensionContext): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool(def: ToolDefinition) {
      handlers.set(def.name, def.handler as unknown as Handler);
    },
  };
  registerLogsTools(server as unknown as McpServer, context);
  return handlers;
}

describe("log tools", () => {
  let tmpRoot: string;
  let logsRoot: string;
  let extDir: string;
  let handlers: Map<string, Handler>;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "logs-test-"));
    // VS Code layout: <logsRoot>/<session>/main.log, with the extension's own
    // log under <session>/exthost/<id> — a directory a bare name cannot address.
    logsRoot = path.join(tmpRoot, "logs");
    const sessionDir = path.join(logsRoot, "2026-01-01-00-00-00");
    extDir = path.join(sessionDir, "exthost", "vscode-ide-mcp");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "main.log"), "main log line\n");
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(path.join(extDir, "mcp.log"), "extension line one\nextension line two\n");

    const context = {
      subscriptions: [],
      logUri: vscode.Uri.file(extDir),
    } as unknown as vscode.ExtensionContext;
    handlers = collectHandlers(context);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("list_logs advertises extension logs with a readable prefix", async () => {
    const res = await handlers.get("list_logs")?.({});
    expect(res?.isError).toBe(false);
    expect(res?.content[0].text).toContain("extension/mcp.log");
  });

  it("read_log opens the extension log by the name list_logs prints", async () => {
    const res = await handlers.get("read_log")?.({ file: "extension/mcp.log" });
    expect(res?.isError).toBe(false);
    expect(res?.content[0].text).toContain("extension line two");
    expect(res?.content[0].text).toContain("--- extension/mcp.log");
  });

  it("read_log still rejects a bare extension log name", async () => {
    const res = await handlers.get("read_log")?.({ file: "mcp.log" });
    expect(res?.isError).toBe(true);
    expect(res?.content[0].text).toContain("Log file not found");
  });

  it("read_log keeps reading VS Code host logs by session path", async () => {
    const res = await handlers.get("read_log")?.({ file: "2026-01-01-00-00-00/main.log" });
    expect(res?.isError).toBe(false);
    expect(res?.content[0].text).toContain("main log line");
  });

  it("read_log rejects traversal out of the extension log root", async () => {
    fs.writeFileSync(path.join(tmpRoot, "secret.txt"), "secret\n");
    const res = await handlers.get("read_log")?.({ file: "extension/../secret.txt" });
    expect(res?.isError).toBe(true);
    expect(res?.content[0].text).toContain("Rejected");
  });

  it("read_log rejects an absolute path outside both roots", async () => {
    fs.writeFileSync(path.join(tmpRoot, "secret.txt"), "secret\n");
    const res = await handlers.get("read_log")?.({ file: path.join(tmpRoot, "secret.txt") });
    expect(res?.isError).toBe(true);
    expect(res?.content[0].text).toContain("Rejected");
  });
});
