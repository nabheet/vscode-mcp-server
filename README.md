# VS Code MCP Server

[![CI](https://github.com/nabheet/vscode-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/nabheet/vscode-mcp-server/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Let AI agents read, write, debug, and execute commands in VS Code — just like a human developer. This [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server exposes 40+ VS Code tools (debugger, terminal, LSP, file ops, commands) over SSE, compatible with opencode, Claude, Cursor, and any MCP client.

## Quick Start

1. **Install the extension** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nabheet.vscode-ide-mcp) or install a `.vsix` from the [latest release](https://github.com/nabheet/vscode-mcp-server/releases).

2. **Reload VS Code** — the extension starts automatically on startup, listening on `http://127.0.0.1:9876`.

3. **Configure your AI tool** (e.g., opencode) to connect via SSE:
   ```json
   {
     "vscode-mcp": {
       "type": "remote",
       "url": "http://127.0.0.1:9876/mcp"
     }
   }
   ```

4. **Verify** the server is running:
   ```bash
   curl -s -X POST http://127.0.0.1:9876/mcp \
     -H 'Content-Type: application/json' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

## Architecture

```
VS Code Extension (onStartupFinished)
  └─ src/extension.ts          — Lifecycle: activation, tool registration, deactivation
  └─ src/config.ts             — Settings (port, auth, TLS) from VS Code + env fallbacks
  └─ src/mcp/
       ├─ server.ts            — HTTP server: CORS, auth, TLS, SSE transport, JSON-RPC dispatch
       ├─ transport.ts         — JSON-RPC 2.0 handler + MCP protocol lifecycle (initialize, tools/list, tools/call)
       └─ tools/
            ├─ commands.ts     — Execute any VS Code command, list commands, get code actions
            ├─ navigation.ts   — Open files, line/column jump, select lines, explorer reveal, close editors
            ├─ workspace.ts    — Read/write/create/delete files, glob search, workspace folders
            ├─ debug.ts        — Start/stop debugging, breakpoints (add/remove/list), step/continue,
            │                    stack trace, variables, frame-scoped evaluate
            ├─ terminal.ts     — Execute commands in integrated terminal, capture output (30s timeout)
            └─ lsp.ts          — Diagnostics (200-line cap), hover, references, definitions, symbols,
                                 completions, code actions, call hierarchy, rename
  └─ src/utils/
       ├─ types.ts             — MCP method constants, type definitions
       └─ path.ts              — Workspace-root-aware path resolution
```

## Tools

| Tool | Module | Description |
|------|--------|-------------|
| `execute_command` | commands | Execute any VS Code command by ID |
| `list_commands` | commands | List all available VS Code commands (optionally internal) |
| `get_code_actions` | commands | Get available refactors/quick fixes at a line |
| `open_file` | navigation | Open a file in the editor |
| `open_file_at_line` | navigation | Open a file at a specific line |
| `open_file_at_position` | navigation | Open a file at a specific line and column |
| `select_lines` | navigation | Select lines in the active editor |
| `reveal_in_explorer` | navigation | Reveal file in the sidebar |
| `focus_editor` | navigation | Focus the editor group |
| `close_editor` | navigation | Close the active editor |
| `close_all_editors` | navigation | Close all editors |
| `list_files` | workspace | List files by glob pattern |
| `read_file` | workspace | Read file content |
| `write_file` | workspace | Write content to a file (creates or overwrites) |
| `create_file` | workspace | Create a new empty file |
| `delete_file` | workspace | Delete a file or directory (recursive, use trash) |
| `get_workspace_folders` | workspace | List workspace roots |
| `start_debugging` | debug | Start a debug session from a launch config |
| `stop_debugging` | debug | Stop the active debug session |
| `step_over` | debug | Step over current line |
| `step_into` | debug | Step into function |
| `step_out` | debug | Step out of function |
| `continue` | debug | Continue execution |
| `add_breakpoint` | debug | Add breakpoint (supports condition, hitCondition) |
| `remove_breakpoint` | debug | Remove a breakpoint |
| `list_breakpoints` | debug | List all breakpoints |
| `get_debug_variables` | debug | Get frame-local variables from paused session |
| `get_stack_trace` | debug | Get call stack frames |
| `evaluate_in_debug_console` | debug | **Frame-scoped** evaluate — can read locals like `pre`, `self`, `t` |
| `execute_in_terminal` | terminal | Execute command in integrated terminal (30s output capture timeout) |
| `get_terminal_output` | terminal | Get terminal output buffer |
| `find_references` | lsp | Find all references to symbol at cursor |
| `go_to_definition` | lsp | Navigate to symbol definition |
| `go_to_type_definition` | lsp | Navigate to type definition |
| `go_to_implementation` | lsp | Navigate to symbol implementation |
| `get_hover` | lsp | Get hover info at cursor |
| `get_diagnostics` | lsp | Get file diagnostics (capped at 200 lines) |
| `get_document_symbols` | lsp | Get symbols in active document |
| `get_workspace_symbols` | lsp | Search workspace symbols |
| `get_call_hierarchy` | lsp | Get incoming and outgoing call hierarchy |
| `rename_symbol` | lsp | Rename symbol across workspace |
| `get_completions` | lsp | Get completion items at cursor |

## Connecting from other AI tools

### opencode

Add to your `opencode.global.jsonc` or `opencode.json`:

```jsonc
{
  "mcpServers": {
    "vscode-mcp": {
      "type": "remote",
      "url": "http://127.0.0.1:9876/mcp"
    }
  }
}
```

### Claude Desktop / Claude Code

**Claude Code** uses the [Streamable HTTP transport](https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/) (MCP 2025-03-26). The server supports this via direct `POST /mcp` — no SSE preamble needed.

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vscode-mcp": {
      "type": "remote",
      "url": "http://127.0.0.1:9876/mcp"
    }
  }
}
```

> **Troubleshooting**: If Claude Code fails to connect, check that it's not sending an incompatible `Origin` header. The server accepts `http://127.0.0.1:<port>`, `http://localhost:<port>`, and `http://0.0.0.0:<port>`. See [Origin header troubleshooting](#origin-header-troubleshooting) below.

Or via stdio if you prefer a managed subprocess:

```json
{
  "mcpServers": {
    "vscode-mcp": {
      "command": "node",
      "args": ["path/to/vscode-mcp-server/out/cli.js"]
    }
  }
}
```

### Cursor

In Cursor Settings → Features → MCP Servers → Add new MCP server:

```
Name: vscode-mcp
Type: remote
URL: http://127.0.0.1:9876/mcp
```

### Windsurf / Continue.dev / Any MCP-compatible tool

Add a `type: "remote"` MCP server pointing to:

```
http://127.0.0.1:9876/mcp
```

The server uses **SSE transport** (the standard MCP HTTP transport). If the tool only supports stdio, you can use an SSE-to-stdio bridge like `mcp-remote` or write a thin wrapper.

### Connecting programmatically

```python
# Example: using the MCP Python SDK
from mcp import ClientSession
from mcp.client.sse import sse_client

async with sse_client("http://127.0.0.1:9876/mcp") as transport:
    async with ClientSession(transport) as session:
        result = await session.list_tools()
        for tool in result.tools:
            print(f"{tool.name}: {tool.description}")
```

```typescript
// Example: using the MCP TypeScript SDK
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(new URL("http://127.0.0.1:9876/mcp"));
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);
const tools = await client.listTools();
```

### With TLS and authentication

Enable TLS and/or auth via VS Code settings or environment variables, then update your client URL and headers accordingly.

**Server-side setup:**

| Method | Setting |
|--------|---------|
| VS Code settings | `vscode-mcp-server.tlsCertPath`, `vscode-mcp-server.tlsKeyPath`, `vscode-mcp-server.authToken` |
| Env vars | `MCP_TLS_CERT_PATH`, `MCP_TLS_KEY_PATH`, `MCP_AUTH_TOKEN` |

#### opencode

```jsonc
{
  "mcpServers": {
    "vscode-mcp": {
      "type": "remote",
      "url": "https://127.0.0.1:9876/mcp",   // https, not http
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

#### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "vscode-mcp": {
      "type": "remote",
      "url": "https://127.0.0.1:9876/mcp",
      "headers": {
        "Authorization": "Bearer <your-token>"
      }
    }
  }
}
```

#### Cursor

In Cursor Settings → Features → MCP Servers:

```
Name: vscode-mcp
Type: remote
URL: https://127.0.0.1:9876/mcp
Headers: { "Authorization": "Bearer <your-token>" }
```

#### Programmatic (Python with TLS + auth)

```python
from mcp import ClientSession
from mcp.client.sse import sse_client

async with sse_client(
    "https://127.0.0.1:9876/mcp",
    headers={"Authorization": "Bearer <your-token>"},
) as transport:
    async with ClientSession(transport) as session:
        result = await session.list_tools()
```

#### Programmatic (TypeScript with TLS + auth)

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const transport = new SSEClientTransport(
  new URL("https://127.0.0.1:9876/mcp"),
  { headers: { Authorization: "Bearer <your-token>" } }
);
const client = new Client({ name: "my-agent", version: "1.0.0" });
await client.connect(transport);
```

#### curl (for testing)

```bash
# With TLS
curl -sk https://127.0.0.1:9876/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <your-token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# With TLS + auth, direct POST
curl -sk -X POST https://127.0.0.1:9876/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <your-token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

> ⚠️ **Security note**: When auth token is set without TLS, the server logs a warning. Bearer tokens over plain HTTP can be intercepted on the local network. Use TLS for any non-loopback access.

## Troubleshooting

### Origin header troubleshooting

Some MCP clients (including recent Claude Code versions) send an `Origin` HTTP header when connecting via Streamable HTTP (`POST /mcp`). If the origin doesn't match an allowed loopback address, the server rejects the request with `403 Forbidden`.

**Allowed origins** (configurable via the server's `host` setting):

| Origin | Default? |
|--------|----------|
| `http://127.0.0.1:<port>` | ✅ Always accepted |
| `http://localhost:<port>` | ✅ Always accepted |
| `http://0.0.0.0:<port>` | ✅ Always accepted |
| `http://<configured-host>:<port>` | ✅ Only if host differs from above |
| No `Origin` header (non-browser client) | ✅ Always accepted |
| Any other origin | ❌ Rejected |

**To diagnose**: check the server logs for 403 responses when your client tries to connect:

```bash
# Verify the server is running
curl -s -X POST http://127.0.0.1:9876/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

If `curl` works but your client doesn't, the client is likely sending an `Origin` header that doesn't match. Check your client's MCP transport configuration — some allow setting custom headers.

### SSE transport deprecation

The old MCP SSE transport (`GET /mcp` → SSE stream → `endpoint` event → `POST /mcp/session/:id/message`) is **deprecated** as of the MCP 2025-03-26 specification. The new standard is **Streamable HTTP** transport (`POST /mcp` with direct JSON-RPC response).

This server supports **both** transports transparently — no configuration change needed. Just use `POST /mcp` as the endpoint and the server handles everything synchronously.

### Example: tool list (37 tools)

When connected, `tools/list` returns schemas for all tools. Key categories:

| Category | Tools |
|----------|-------|
| **Editor** | `open_file`, `open_file_at_line`, `open_file_at_position`, `select_lines`, `reveal_in_explorer`, `focus_editor`, `close_editor`, `close_all_editors` |
| **Workspace** | `read_file`, `write_file`, `create_file`, `delete_file`, `list_files`, `get_workspace_folders` |
| **Debug** | `start_debugging`, `stop_debugging`, `step_over`, `step_into`, `step_out`, `continue`, `add_breakpoint`, `remove_breakpoint`, `list_breakpoints`, `get_debug_variables`, `get_stack_trace`, `evaluate_in_debug_console` |
| **Terminal** | `execute_in_terminal`, `get_terminal_output` |
| **LSP** | `find_references`, `go_to_definition`, `go_to_type_definition`, `go_to_implementation`, `get_hover`, `get_diagnostics`, `get_document_symbols`, `get_workspace_symbols`, `get_call_hierarchy`, `rename_symbol`, `get_completions`, `get_code_actions` |
| **Commands** | `execute_command`, `list_commands` |

## MCP Protocol

### Transport

Supports three transport modes:

**1. Streamable HTTP (recommended, MCP 2025-03-26)** — `POST /mcp` with JSON-RPC body. Synchronous request/response. This is the new standard transport used by Claude Code and recent MCP SDK clients. No session setup or SSE handshake needed.

**2. SSE (legacy)** — `GET /mcp` opens an SSE stream, server sends an `endpoint` event with a session-specific POST URL. Client sends JSON-RPC messages to `POST /mcp/session/:id/message`, responses arrive via SSE `message` events. Deprecated in favor of Streamable HTTP but still supported.

**3. Direct POST (backward compat)** — `POST /mcp` with JSON-RPC body. Synchronous request/response. This is identical to Streamable HTTP at the wire level.

### Lifecycle

Full MCP protocol lifecycle implemented:

1. **Client sends `initialize`** — server responds with protocol version (`2024-11-05`), capabilities (`tools`), and server info
2. **Client sends `notifications/initialized`** — acknowledges readiness (no response expected)
3. **`tools/list`** — returns all tool definitions with JSON schemas
4. **`tools/call`** — invokes a tool by name with arguments

### Port Retry

If the default port (9876) is busy, the server tries up to 5 consecutive ports (±1 each try). If all fail, the extension logs an error and deactivates.

## Configuration

All settings under `vscode-mcp-server.*`:

| Setting | Default | Description |
|---------|---------|-------------|
| `port` | `9876` | HTTP server port (auto-retries if busy) |
| `authToken` | `""` | Bearer token (empty = no auth). ⚠️ If set without TLS, a warning is logged (cleartext risk) |
| `tlsCertPath` | `""` | TLS cert PEM path (enables HTTPS) |
| `tlsKeyPath` | `""` | TLS key PEM path (enables HTTPS) |

Settings fall back to environment variables:

| Env var | Overrides | Default |
|---------|-----------|---------|
| `MCP_PORT` | `port` | `9876` |
| `MCP_AUTH_TOKEN` | `authToken` | (none) |
| `MCP_TLS_CERT_PATH` | `tlsCertPath` | (none) |
| `MCP_TLS_KEY_PATH` | `tlsKeyPath` | (none) |
| `MCP_SERVER_MAX_RETRIES` | port retry count | `3` |

VS Code settings take priority over env vars.

### Security

- CORS restricted to loopback origin (`Access-Control-Allow-Origin: http://127.0.0.1:<port>`)
- Bearer token auth uses timing-safe comparison
- Payload limit: 1 MB
- TLS supported but not required (loopback-only by default)
- Warning logged when auth token is set without TLS

## Debug Tips

### Frame-Scoped Evaluation
`evaluate_in_debug_console` automatically resolves the top stack frame's `frameId` and passes it to the DAP `evaluate` request. This means you can read local variables directly:

```
evaluate_in_debug_console("pre")   → 69.75
evaluate_in_debug_console("self")  → Order(order_id='ORD-001', ...)
```

Without a paused debug session, it falls back to global-scope evaluation.

### Debug Workflow
1. Open target file: `open_file("src/main.py")`
2. Set breakpoints: `add_breakpoint("src/main.py", 42)`
3. Start debugging: `start_debugging("Launch Config Name")`
4. Step through: `step_over()`, `step_into()`, `step_out()`
5. Inspect: `get_stack_trace()`, `get_debug_variables()`, `evaluate_in_debug_console("my_var")`
6. Continue: `continue()`
7. Stop: `stop_debugging()`

## Development

```bash
npm install
npm run compile    # Build TypeScript → out/
npm run watch      # Watch mode
npm test           # 75 tests across 3 suites (server, transport, tools)
```

### Debug the extension itself

1. Press F5 in VS Code (uses `.vscode/launch.json` "Run Extension" config)
2. A new Extension Development Host window opens
3. The MCP server starts automatically on port 9876
4. Set breakpoints in `src/` to debug tool handlers
5. The `npm: watch` task auto-compiles on save

### Package for distribution

```bash
npx @vscode/vsce package
# Produces vscode-mcp-server-*.vsix
```

## Notes

- Workspace file operations are relative to the first workspace root folder
- Debug tools require an active debug configuration (`launch.json`) in the workspace
- Terminal tools create integrated terminals in VS Code; output capture has a 30-second timeout to prevent resource leaks
- LSP tools query the active language server; diagnostics are capped at 200 lines with `... and N more` suffix
- `sourceMap: true` is enabled — breakpoints work in the debugger when developing the extension itself
