# VS Code MCP Server

Exposes VS Code capabilities via an HTTP [MCP (Model Context Protocol)](https://modelcontextprotocol.io) server for AI tooling.

## Architecture

```
VS Code Extension
  └─ src/extension.ts          — Lifecycle: activation, tool registration, deactivation
  └─ src/config.ts             — Settings (port, auth, TLS) from VS Code + env fallbacks
  └─ src/mcp/
       ├─ server.ts            — HTTP server: CORS, auth, payload limits, JSON-RPC dispatch
       ├─ transport.ts         — JSON-RPC 2.0 handler + schema validation (pure, testable)
       └─ tools/
            ├─ commands.ts     — VS Code actions, commands, tasks, code actions
            ├─ navigation.ts   — File open, line jump, search, settings, explorer reveal
            ├─ workspace.ts    — Read/edit/create/delete files, search, workspace folders
            ├─ debug.ts        — Start/stop debugging, breakpoints, state
            ├─ terminal.ts     — Create, send to, read terminal output
            └─ lsp.ts          — Diagnostics and symbols via LSP
  └─ src/utils/
       ├─ types.ts             — ToolDefinition, McpServerOptions, ConfigOptions
       └─ path.ts              — Path resolution (workspace-root-aware)
```

## Tools

| Tool | Module | Description |
|------|--------|-------------|
| `run_command` | commands | Execute any VS Code command |
| `run_code_action` | commands | Apply code actions at cursor |
| `run_task` | commands | Run VS Code tasks |
| `get_context_actions` | commands | List available context actions |
| `open_file` | navigation | Open a file in the editor |
| `go_to_line` | navigation | Navigate to line/column |
| `search_files` | navigation | Find files by glob pattern |
| `reveal_in_explorer` | navigation | Reveal file in sidebar |
| `open_settings` | navigation | Open settings editor |
| `get_workspace_folders` | workspace | List workspace roots |
| `read_file` | workspace | Read file content |
| `edit_file` | workspace | Apply text edits to a file |
| `create_file` | workspace | Create a new file |
| `delete_file` | workspace | Delete a file |
| `search_text` | workspace | Full-text search across files |
| `start_debugging` | debug | Start a debug session |
| `stop_debugging` | debug | Stop active debug session |
| `set_breakpoints` | debug | Set/clear breakpoints |
| `get_debug_state` | debug | Get current debug state |
| `create_terminal` | terminal | Create a terminal |
| `send_to_terminal` | terminal | Send text to terminal |
| `get_terminal_content` | terminal | Read terminal output |
| `get_diagnostics` | lsp | Get file diagnostics |
| `get_symbols` | lsp | Get document symbols |

## Configuration

All settings under `vscode-mcp-server.*`:

| Setting | Default | Description |
|---------|---------|-------------|
| `port` | `9876` | HTTP server port |
| `authToken` | `""` | Bearer token (empty = no auth) |
| `tlsCertPath` | `""` | TLS cert PEM path (enables HTTPS) |
| `tlsKeyPath` | `""` | TLS key PEM path (enables HTTPS) |

Settings fall back to environment variables `MCP_PORT`, `MCP_AUTH_TOKEN`, `MCP_TLS_CERT_PATH`, `MCP_TLS_KEY_PATH`.

## Development

```bash
npm install
npm run compile    # Build
npm run watch      # Watch mode
npm test           # Run 51 tests across 4 suites
```

## Protocol

Implements a subset of JSON-RPC 2.0 over HTTP `POST /mcp`:

- `tools/list` — list all registered tools with schemas
- `tools/call` — call a tool by name with arguments

CORS enabled (`Access-Control-Allow-Origin: *`). Supports bearer token auth.

## Notes

- Workspace file operations are relative to the first workspace root folder
- Debug tools require an active debug configuration in the workspace
- Terminal tools create integrated terminals in VS Code
- LSP tools query the active language server for diagnostics and symbols
