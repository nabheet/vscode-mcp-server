# VS Code MCP Server

Exposes VS Code capabilities via an HTTP [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for AI tooling.

## Quick Start

1. **Install the extension** in VS Code:
   ```bash
   code --install-extension vscode-mcp-server-0.1.0.vsix
   ```

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

## MCP Protocol

### Transport

Supports two transport modes:

**1. SSE (recommended)** — `GET /mcp` opens an SSE stream, server sends an `endpoint` event with a session-specific POST URL. Client sends JSON-RPC messages to `POST /mcp/session/:id/message`, responses arrive via SSE `message` events.

**2. Direct POST (backward compat)** — `POST /mcp` with JSON-RPC body. Synchronous request/response.

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
npx vsce package
# Produces vscode-mcp-server-0.1.0.vsix
```

## Notes

- Workspace file operations are relative to the first workspace root folder
- Debug tools require an active debug configuration (`launch.json`) in the workspace
- Terminal tools create integrated terminals in VS Code; output capture has a 30-second timeout to prevent resource leaks
- LSP tools query the active language server; diagnostics are capped at 200 lines with `... and N more` suffix
- `sourceMap: true` is enabled — breakpoints work in the debugger when developing the extension itself
- opencode config split: project-level `opencode.json` (no MCP), global `opencode.global.jsonc` (all MCP servers including `vscode-mcp`)
