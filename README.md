# VS Code MCP Server

[![CI](https://github.com/nabheet/vscode-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/nabheet/vscode-mcp-server/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Let AI agents read, write, debug, and execute commands in VS Code — just like a
human developer. This [MCP (Model Context Protocol)](https://modelcontextprotocol.io)
server exposes 50 VS Code tools (debugger, terminal, LSP, file ops, commands)
over SSE, compatible with opencode, Claude, Cursor, and any MCP client.

```bash
code --install-extension nabheet.vscode-ide-mcp
```

## Debugger MCP

Drive the VS Code debugger from your AI agent: start and stop sessions, set
and remove breakpoints, step through code, inspect stack frames and local
variables, and evaluate expressions in the paused frame —
`start_debugging`, `step_over`, `add_breakpoint`, `get_stack_trace`,
`evaluate_in_debug_console`, and more.

## VS Code terminal and LSP tools

Run commands in the integrated terminal (`execute_in_terminal`,
`get_terminal_output`) and query language servers — definitions, references,
hover, rename, diagnostics, completions, symbols, and code actions
(`go_to_definition`, `find_references`, `get_diagnostics`, `rename_symbol`).

## Quick Start

1. **Install the extension** from the
   [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nabheet.vscode-ide-mcp)
   or install a `.vsix` from the [latest release](https://github.com/nabheet/vscode-mcp-server/releases).

2. **Reload VS Code** — the extension starts automatically on startup. The first window becomes the
   **leader** and listens on `http://127.0.0.1:9876`; additional windows on the same machine join as
   **workers** over the leader's HTTP member channel and share the same port (the MCP client targets
   a window via a `workspace` argument).
   Windows in a dev container and windows on the host join the same cluster over the same HTTP member
   channel instead — see [Cross-host clusters](#cross-host-clusters).

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

```text
VS Code Extension (onStartupFinished)
  └─ src/extension.ts          — Lifecycle: activation, cluster election, re-election,
                                  tool registration, window-state publishing, deactivation
  └─ src/mcp/
       ├─ executor.ts          — Shared tool executor: registration, dispatch, concurrency cap, timeouts
       ├─ server.ts            — HTTP server: CORS, auth, TLS, SSE transport, JSON-RPC dispatch
       ├─ transport.ts         — JSON-RPC 2.0 handler + MCP protocol lifecycle
       ├─ cluster/
       │    ├─ election.ts     — Port probing (/health) → valid | free | foreign | timeout
       │    ├─ constants.ts    — Port/heartbeat/timeout constants + MSG protocol types
       │    ├─ leader.ts       — LeaderCoordinator: owns the HTTP port, routes tools/call
       │    │                    to workers, serves list_workspaces
       │    ├─ worker.ts       — WorkerCoordinator: joins leader via HTTP member channel,
       │    │                    heartbeat failover + re-election
       │    ├─ bootstrap.ts    — Bounded retry loop: promote (leader) or join (worker), with backoff
       │    └─ memberTransport.ts — HTTP member channel (SSE stream + POST) for all workers
       └─ tools/
            ├─ commands.ts     — Execute/catalog VS Code commands, get code actions
            ├─ navigation.ts   — Open files, jump to line/col, select, reveal, close editors
            ├─ workspace.ts    — Read/write/delete files, glob search, folder CRUD
            ├─ debug.ts        — Debug lifecycle, breakpoints, stepping, stack/vars/evaluate
            ├─ terminal.ts     — Run commands in integrated terminal, capture output (30s)
            ├─ search.ts       — Full-text content search across workspace folders (grep)
            └─ lsp.ts          — Diagnostics (200-line cap), hover, references, definitions,
                                  symbols, completions, code actions, call hierarchy, rename
  └─ src/utils/
       ├─ types.ts             — MCP method constants, type definitions
       └─ path.ts              — Workspace-root-aware path resolution
```

## Tools

| Tool | Module | Description |
| ------ | -------- | ------------- |
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
| `read_files` | workspace | Read multiple files in one call (batch, per-file errors inline) |
| `write_file` | workspace | Write content to a file (creates or overwrites) |
| `create_file` | workspace | Create a new empty file |
| `delete_file` | workspace | Delete a file or directory (recursive, use trash) |
| `get_workspace_folders` | workspace | List workspace roots |
| `list_workspaces` | cluster | List windows (leader + workers): id, name, folders, role, state |
| `add_workspace_folder` | workspace | Add a folder to the workspace (multi-root) |
| `update_workspace_folder` | workspace | Rename/change a workspace folder's path (multi-root) |
| `remove_workspace_folder` | workspace | Remove a folder from the workspace (multi-root) |
| `search_files` | search | Grep file contents across the workspace (regex, case-insensitive) |
| `list_logs` | logs | List VS Code log sessions and files |
| `read_log` | logs | Tail a VS Code log file (with optional grep filter) |
| `start_debugging` | debug | Start a debug session from a folder/workspace launch config |
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
| `evaluate_in_debug_console` | debug | **Frame-scoped** evaluate — reads paused-session locals |
| `execute_in_terminal` | terminal | Execute command in integrated terminal (30s output timeout) |
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

## Cluster mode

Every VS Code window runs one cluster member. Exactly one window (the
**leader**) owns the HTTP port; every other window (a **worker**) connects to
it over the **HTTP member channel** — the same mechanism on one machine and
across hosts (see below). Clients connect to the single leader port and target
a specific window via the `workspace` argument on `tools/call` / `tools/list`,
or via a `workspaceFolder` tool argument (see below).

### Cross-host clusters

A VS Code **dev container** window and a window on the **host machine** join
the same cluster automatically over the same HTTP member channel:

- The leader publishes two extra routes on its HTTP port (only when cluster
  membership is enabled):
  - `GET /cluster/stream?id=<sessionId>` — server-sent events carrying
    leader → worker messages (one JSON `IpcMessage` per `event: message`).
  - `POST /cluster/message?id=<sessionId>` — worker → leader messages; the
    leader responds `202 {"accepted": true}`.
- The worker keeps the SSE stream open and sends heartbeats (`PING`) every
  `HEARTBEAT_INTERVAL_MS` (5 s). Two missed `PONG`s mark the leader as lost
  and trigger re-election.
- Registration is bounded by `REGISTER_TIMEOUT_MS` (5 s); a worker that cannot
  reach a candidate leader within that window moves on.

**Host ↔ container discovery:**

- A **Docker dev container** window probes the host leader through an ordered
  candidate chain, taking the first host that answers (or the first that is
free, in which case the container window promotes and the host window later
   joins it via the loopback `valid` probe + HTTP join):
  1. `vscode-mcp-server.leaderHost` / `MCP_LEADER_HOST` — explicit override
     (always wins when set);
  2. `host.docker.internal` — Docker Desktop / OrbStack resolve this to the
     host loopback;
  3. the container's **default gateway** — Linux native Docker routes the
     container's default traffic to the host's bridge interface, so no
     `extra_hosts` or `devcontainer.json` networking config is needed.
- The reverse direction (host window joining a container leader) works out of
  the box: a container leader binds `127.0.0.1` inside the container, and VS
  Code's port forwarding reaches it. `forwardPorts` tunnels to `localhost`
  inside the container, and the leader additionally calls
  `vscode.env.asExternalUri` for the port it actually bound — election may
  advance past `port` when the base port is taken, and the tunnel follows it —
  so VS Code establishes the host→container tunnel automatically. The host side
  of that tunnel binds `127.0.0.1` unless you set `remote.localPortHost` to
  `allInterfaces`.
- Port forwarding is the supported path. If you bypass it (devcontainer
  `appPort` / compose `ports:`), Docker publishes the port on `0.0.0.0` and a
  loopback bind inside the container is unreachable — set
  `vscode-mcp-server.bindHost` to `0.0.0.0` **and** an `authToken` (C1 requires
  the token for any non-loopback bind).
- `bindHost` takes an IP address or a hostname. A **specific** address (rather
  than `0.0.0.0`) is bound *alongside* `127.0.0.1`, so windows in the same
  namespace still find the leader by probing loopback instead of promoting a
  second one. A value that is neither an IP address nor a hostname is refused
  at startup — a permanent configuration error, never retried.
- On **Linux** hosts, a host leader binds `127.0.0.1` **plus** its detected
  Docker bridge address(es) (`docker0`, `br-*`, `cni-podman0`, …), so
  containers reach it at `<bridge-ip>:<port>`. Because those bridge addresses
  are non-loopback, the leader refuses to start unless an auth token is set
  (`vscode-mcp-server.authToken` or `MCP_AUTH_TOKEN`) — see Security.
- `host.docker.internal` is only a valid default inside a Docker dev
  container. Other remote environments (attached container, SSH, WSL, …) do
  **not** probe for a host leader unless you set
  `vscode-mcp-server.leaderHost` (or `MCP_LEADER_HOST`) explicitly.
- If your container networking still can't reach the host (WSL2 without
  Docker Desktop, rootless Podman with a custom bridge name, …), point the
  container window at the right address with the
  `vscode-mcp-server.leaderHost` setting or the `MCP_LEADER_HOST` env var, or
  add `"extra_hosts": ["host.docker.internal:host-gateway"]` to
  `devcontainer.json`.

### list_workspaces

`list_workspaces` returns one row per window. Each row carries stable identity
plus live editor state:

```json
[
  {
    "id": "/path/to/folder:12345",
    "instanceId": "9f7b…uuid…",
    "instanceName": "My Project",
    "displayName": "My Project",
    "folders": ["/path/to/folder"],
    "role": "leader",
    "state": {
      "activeFile": "/path/to/folder/src/main.ts",
      "openEditors": ["/path/to/folder/src/main.ts", "/path/to/folder/src/util.ts"]
    }
  }
]
```

- `role` — `"leader"` (owns the port) or `"worker"` (joined over HTTP).
- `state.activeFile` — absolute path of the active editor, when one is open
  (omitted otherwise).
- `state.openEditors` — absolute paths of all open editor tabs; always present.

State is refreshed automatically as editors open, close, or change focus
(debounced, pushed over the member channel for workers), so two windows on the
same folder are distinguishable by which files they have open.

### Targeting a window

Pass `workspace` on `tools/call` / `tools/list` to route to a specific window.
Accepted values:

- a row `id` from `list_workspaces`
- an `instanceId` (stable per-window UUID)
- a folder path contained in that window's `folders`
- a folder **basename** from that window's `folders` (e.g. `"my-project"` for
  `/path/to/my-project`) — the shortest matching prefix wins, with the leader
  keeping ties
- a window's `displayName` / `instanceName`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "open_file",
    "arguments": { "path": "src/main.ts" },
    "workspace": "/path/to/folder"
  }
}
```

Most MCP clients (opencode, Claude Code, …) don't support non-standard top-level
`params` fields, so the leader also resolves routing references from **tool
arguments**. On every `tools/call` it checks `arguments.workspace` and
`arguments.workspaceFolder` using the same accepted values as above (id,
instanceId, display name, folder path, or folder basename):

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "search_files",
    "arguments": {
      "query": "TODO",
      "workspaceFolder": "my-project"
    }
  }
}
```

Routing order per call:

1. Top-level `params.workspace` — explicit window id/path/displayName.
2. Tool argument `workspace` / `workspaceFolder` — same resolution, useful when
   the client can't send top-level params. Tools that already interpret
   `workspaceFolder` as a multi-root folder name work unchanged: the leader
   resolves it first, then the target window's tool resolves it against that
   window's own folders (by name **or** full path).
3. Path inference — any string argument that looks like an absolute path or a
   workspace-relative path is matched against each window's `folders` by
   prefix/basename.

An unresolved `workspaceFolder` reference falls through to path inference and
finally the leader — the tool itself then reports "folder not found" against the
leader's folders, so local multi-root behavior is preserved.

Without `workspace`, calls target the leader window.

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

**Claude Code** uses the [Streamable HTTP transport](
https://spec.modelcontextprotocol.io/specification/2025-03-26/basic/transports/)
(MCP 2025-03-26). The server supports this via direct `POST /mcp` — no SSE
preamble needed.

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

> **Troubleshooting**: If Claude Code fails to connect, check that it's not
> sending an incompatible `Origin` header. The server accepts
> `http://127.0.0.1:<port>`, `http://localhost:<port>`, and
> `http://0.0.0.0:<port>`. See
> [Origin header troubleshooting](#origin-header-troubleshooting) below.

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

```text
Name: vscode-mcp
Type: remote
URL: http://127.0.0.1:9876/mcp
```

### Windsurf / Continue.dev / Any MCP-compatible tool

Add a `type: "remote"` MCP server pointing to:

```text
http://127.0.0.1:9876/mcp
```

The server uses **SSE transport** (the standard MCP HTTP transport). If the tool
only supports stdio, you can use an SSE-to-stdio bridge like `mcp-remote` or
write a thin wrapper.

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

Enable TLS and/or auth via VS Code settings or environment variables, then
update your client URL and headers accordingly.

**Server-side setup:**

- **VS Code settings** — `vscode-mcp-server.tlsCertPath`,
  `vscode-mcp-server.tlsKeyPath`, `vscode-mcp-server.authToken`
- **Env vars** — `MCP_TLS_CERT_PATH`, `MCP_TLS_KEY_PATH`, `MCP_AUTH_TOKEN`

#### opencode (TLS)

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

#### Claude Desktop / Claude Code (TLS)

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

#### Cursor (TLS)

In Cursor Settings → Features → MCP Servers:

```text
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

> ⚠️ **Security note**: Bearer tokens over plain HTTP can be intercepted on the
> local network. Use TLS for any non-loopback access. A non-loopback bind
> refuses to start without an auth token (see Security).

## Troubleshooting

### Origin header troubleshooting

Some MCP clients (including recent Claude Code versions) send an `Origin` HTTP
header when connecting via Streamable HTTP (`POST /mcp`). If the origin doesn't
match an allowed loopback address, the server rejects the request with
`403 Forbidden`.

**Allowed origins** (configurable via the server's `host` setting):

| Origin | Default? |
| -------- | ---------- |
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

If `curl` works but your client doesn't, the client is likely sending an
`Origin` header that doesn't match. Check your client's MCP transport
configuration — some allow setting custom headers.

### SSE transport deprecation

The old MCP SSE transport (`GET /mcp` → SSE stream → `endpoint` event →
`POST /mcp/session/:id/message`) is **deprecated** as of the MCP 2025-03-26
specification. The new standard is **Streamable HTTP** transport (`POST /mcp`
with direct JSON-RPC response).

This server supports **both** transports transparently — no configuration
change needed. Just use `POST /mcp` as the endpoint and the server handles
everything synchronously.

### Example: tool list (50 tools)

When connected, `tools/list` returns schemas for all tools. Key categories:

- **Editor** — `open_file`, `open_file_at_line`, `open_file_at_position`,
  `select_lines`, `reveal_in_explorer`, `focus_editor`, `close_editor`,
  `close_all_editors`
- **Workspace** — `read_file`, `read_files`, `write_file`, `create_file`,
  `delete_file`, `list_files`, `get_workspace_folders`,
  `add_workspace_folder`, `update_workspace_folder`, `remove_workspace_folder`
- **Search** — `search_files`
- **Debug** — `start_debugging`, `stop_debugging`, `step_over`, `step_into`,
  `step_out`, `continue`, `add_breakpoint`, `remove_breakpoint`,
  `list_breakpoints`, `get_debug_variables`, `get_stack_trace`,
  `evaluate_in_debug_console`
- **Terminal** — `execute_in_terminal`, `get_terminal_output`
- **Logs** — `list_logs`, `read_log`
- **LSP** — `find_references`, `go_to_definition`, `go_to_type_definition`,
  `go_to_implementation`, `get_hover`, `get_diagnostics`,
  `get_document_symbols`, `get_workspace_symbols`, `get_call_hierarchy`,
  `rename_symbol`, `get_completions`, `get_code_actions`
- **Commands** — `execute_command`, `list_commands`

## MCP Protocol

### Transport

Supports three transport modes:

**1. Streamable HTTP (recommended, MCP 2025-03-26)** — `POST /mcp` with
   JSON-RPC body. Synchronous request/response. This is the new standard
   transport used by Claude Code and recent MCP SDK clients. No session setup
   or SSE handshake needed.

**2. SSE (legacy)** — `GET /mcp` opens an SSE stream, server sends an
   `endpoint` event with a session-specific POST URL. Client sends JSON-RPC
   messages to `POST /mcp/session/:id/message`, responses arrive via SSE
   `message` events. Deprecated in favor of Streamable HTTP but still supported.

**3. Direct POST (backward compat)** — `POST /mcp` with JSON-RPC body.
   Synchronous request/response. This is identical to Streamable HTTP at the
   wire level.

### Lifecycle

Full MCP protocol lifecycle implemented:

1. **Client sends `initialize`** — server responds with protocol version
   (`2024-11-05`), capabilities (`tools`), and server info
2. **Client sends `notifications/initialized`** — acknowledges readiness (no response expected)
3. **`tools/list`** — returns all tool definitions with JSON schemas
4. **`tools/call`** — invokes a tool by name with arguments

### Port Retry

If the default port (9876) is busy, the leader scans up to 5 consecutive ports
(9876..9880, controlled by `MCP_SERVER_MAX_RETRIES`). If a port is occupied by
a non-MCP process, the next port is tried. The election loop retries the whole
scan up to 8 times with exponential backoff; workers re-join the elected leader
over HTTP rather than taking their own port.

## Configuration

All settings under `vscode-mcp-server.*`:

| Setting | Default | Description |
| --------- | --------- | ------------- |
| `port` | `9876` | HTTP server port (auto-retries if busy) |
| `authToken` | `""` | Bearer token (empty = no auth). Required for non-loopback binds |
| `tlsCertPath` | `""` | TLS cert PEM path (enables HTTPS) |
| `tlsKeyPath` | `""` | TLS key PEM path (enables HTTPS) |
| `leaderHost` | `""` | Container→host probe override; default `host.docker.internal` + gateway |
| `bindHost` | `""` (loopback) | Bind address (IP/hostname). Non-loopback needs `authToken` (C1) |

Settings fall back to environment variables:

| Env var | Overrides | Default |
| --------- | ----------- | --------- |
| `MCP_PORT` | `port` | `9876` |
| `MCP_AUTH_TOKEN` | `authToken` | (none) |
| `MCP_TLS_CERT_PATH` | `tlsCertPath` | (none) |
| `MCP_TLS_KEY_PATH` | `tlsKeyPath` | (none) |
| `MCP_LEADER_HOST` | `leaderHost` | (none — `host.docker.internal`, then gateway) |
| `MCP_BIND_HOST` | `bindHost` | (none — `127.0.0.1`) |
| `MCP_SERVER_MAX_RETRIES` | ports scanned per election (default 5, 9876–9880) | `5` |

VS Code settings take priority over env vars.

### Security

- CORS restricted to loopback origin (`Access-Control-Allow-Origin: http://127.0.0.1:<port>`)
- Bearer token auth uses timing-safe comparison
- Payload limit: 1 MB
- TLS supported but not required (loopback-only by default)
- Dev-container windows bind loopback too (`127.0.0.1`); VS Code's port
  forwarding tunnels the host to it, so no token is needed in a container
- Non-loopback binds (e.g. Linux Docker bridge addresses) refuse to start
  without an auth token
- When `authToken` is set, `/metrics` and `/diagnostics` also require the
  bearer token (they expose process internals once the bind is reachable
  beyond loopback). `/health` stays unauthenticated so cluster probes work.
  A metrics scraper pointing at a token-protected server must be configured
  with `authorization`/`bearer_token`.
- **Cluster member channel (cross-host):** when `authToken` is set, member
  channel requests carry the same `Authorization: Bearer <token>` and are
  rejected otherwise. The cluster refuses to start when any bind address is
  non-loopback and no `authToken` is configured (`vscode-mcp-server.authToken`
  or `MCP_AUTH_TOKEN`), because the member channel proxies tool calls to every
  worker. There is **no separate cluster handshake** in v1 — a loopback-only
  bind without a token lets anyone on the host register as a member. Only
  enable cross-host clusters on a trusted network (a fake leader could drive a
  real worker, and a spoofed worker could observe leader messages). A
  per-cluster shared secret + HMAC nonce handshake is planned for a later
  version.

## Debug Tips

### Frame-Scoped Evaluation

`evaluate_in_debug_console` automatically resolves the top stack frame's
`frameId` and passes it to the DAP `evaluate` request. This means you can read
local variables directly:

```text
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

### Launch Config Locations

`start_debugging` finds a config by name in two places, preferring folder-level configs:

1. A folder's `.vscode/launch.json` — pass `folder` to target a specific
   workspace folder (defaults to the first)
2. The workspace file (`*.code-workspace`) `launch` section — available in
   multi-root workspaces opened via a `.code-workspace` file

For workspace-file configs, the extension reads the config from the workspace
file and starts it directly, which also works around a VS Code quirk where
name-based lookup with an undefined folder fails.

## Development

```bash
npm install
npm run compile    # Build TypeScript → out/
npm run watch      # Watch mode
npm test           # Unit tests (server, transport, tools, cluster, …)
npm run test:e2e   # End-to-end: launches real VS Code windows and verifies cluster routing
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

## Releases

Publishing is fully automated from GitHub Actions — no local login needed.

**Stable** — merging to `main` auto-publishes the next patch to the
[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nabheet.vscode-ide-mcp)
when the merge changes what ships: `vsce publish patch` bumps `package.json`,
publishes, tags `vX.Y.Z`, creates a GitHub release (VSIX attached), then syncs
the bumped version back to `main` via an auto-PR (`chore: bump version to
vX.Y.Z`; a job-level guard matching the sync-back commit message prevents it
from re-triggering publishing). A merge that touches only non-shipping paths
(`package-lock.json`, `.github/**`, or `package.json` with only `version`/inert
devDependency changes) is skipped, so a dependabot devDependency bump does not
cut a release. Manual `workflow_dispatch` always publishes.

**Pre-release** — every push to an open PR publishes a unique pre-release
(`0.9.<workflow-run>`) to the Marketplace pre-release channel. This dedicated
line is always above the stable `0.3.x` line, so it never collides with
stable releases; the published version is commented on the PR.

See `RELEASE.md` for details.

## Notes

- Workspace file operations target the first workspace root by default. In
  multi-root workspaces, pass `workspaceFolder` to any file tool (`read_file`,
  `read_files`, `write_file`, `create_file`, `delete_file`, `list_files`,
  `open_file`, `open_file_at_line`, `open_file_at_position`,
  `reveal_in_explorer`, `add_breakpoint`, `remove_breakpoint`) to operate on a
  specific folder
- Debug tools require an active debug configuration — either in a folder's
  `.vscode/launch.json` or in the workspace file (`*.code-workspace`).
  `start_debugging` checks both, preferring folder-level configs
- Terminal tools create integrated terminals in VS Code; output capture has a
  30-second timeout to prevent resource leaks
- LSP tools query the active language server; diagnostics are capped at 200
  lines with `... and N more` suffix
- `sourceMap: true` is enabled — breakpoints work in the debugger when developing the extension itself
