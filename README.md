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
| `execute_command` | commands | Execute any VS Code command by ID |
| `list_commands` | commands | List all available VS Code commands |
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
| `write_file` | workspace | Write content to a file |
| `create_file` | workspace | Create a new empty file |
| `delete_file` | workspace | Delete a file |
| `get_workspace_folders` | workspace | List workspace roots |
| `start_debugging` | debug | Start a debug session |
| `stop_debugging` | debug | Stop active debug session |
| `step_over` | debug | Step over in debugger |
| `step_into` | debug | Step into function |
| `step_out` | debug | Step out of function |
| `continue` | debug | Continue execution |
| `add_breakpoint` | debug | Add a breakpoint |
| `remove_breakpoint` | debug | Remove a breakpoint |
| `list_breakpoints` | debug | List all breakpoints |
| `get_debug_variables` | debug | Get variables from active session |
| `get_stack_trace` | debug | Get stack trace from active session |
| `evaluate_in_debug_console` | debug | Evaluate expression in debug console |
| `execute_in_terminal` | terminal | Execute command in integrated terminal |
| `get_terminal_output` | terminal | Get terminal output buffer |
| `find_references` | lsp | Find references to symbol at cursor |
| `go_to_definition` | lsp | Navigate to symbol definition |
| `go_to_type_definition` | lsp | Navigate to type definition |
| `go_to_implementation` | lsp | Navigate to symbol implementation |
| `get_hover` | lsp | Get hover info at cursor |
| `get_diagnostics` | lsp | Get file diagnostics |
| `get_document_symbols` | lsp | Get symbols in active document |
| `get_workspace_symbols` | lsp | Search workspace symbols |
| `get_code_actions` | lsp | Get available code actions |
| `get_call_hierarchy` | lsp | Get call hierarchy |
| `rename_symbol` | lsp | Rename symbol across workspace |
| `get_completions` | lsp | Get completion items |

## Configuration

All settings under `vscode-mcp-server.*`:

| Setting | Default | Description |
|---------|---------|-------------|
| `port` | `9876` | HTTP server port |
| `authToken` | `""` | Bearer token (empty = no auth) |
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

CORS restricted to loopback origin (`Access-Control-Allow-Origin: http://127.0.0.1:<port>`). Supports bearer token auth (timing-safe comparison).

## Notes

- Workspace file operations are relative to the first workspace root folder
- Debug tools require an active debug configuration in the workspace
- Terminal tools create integrated terminals in VS Code
- LSP tools query the active language server for diagnostics and symbols
