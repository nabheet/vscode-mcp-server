# AGENTS.md

Guide for AI agents working in this repository.

## Project

A VS Code extension that exposes VS Code as an MCP server: debugger, terminal,
LSP, file, workspace and command tools, reachable by MCP clients such as
opencode, Claude and Cursor. One VS Code window becomes the cluster **leader**
(HTTP on `127.0.0.1:9876`) and other windows join as **workers** over the
leader's HTTP member channel, so a single endpoint reaches every window.

- Package name, publisher and version live in `package.json` and `RELEASE.md`
- Runtime: Node (extension host), TypeScript, CommonJS output (`module:
  commonjs`, `outDir: out`)
- Entry: `src/extension.ts` (activate/deactivate), MCP server in
  `src/mcp/server.ts`

`package.json` has no `"type": "module"` and no `files` array **on purpose**:
VS Code loads the extension as CommonJS, and packaging is governed by
`.vscodeignore` (which ships `out/**` and drops `src/**`, `node_modules/**`).
Do not "modernize" this to ESM or add `files` without reworking packaging.

## Architecture

```text
src/
  extension.ts            # activate(): cluster role, MCP server lifecycle
  mcp/
    server.ts             # McpServer: JSON-RPC, tools/list, tools/call, SSE
    transport.ts          # initialize negotiation, protocol version
    executor.ts           # tool execution against the vscode API
    cluster/
      bootstrap.ts        # startup decision: join, elect, promote
      election.ts         # port probing / leader health
      leader.ts           # routing: cluster target resolution + proxying
      worker.ts           # joins the leader, executes forwarded calls
      memberTransport.ts  # HTTP member channel (CALL/RESULT frames)
      protocol.ts         # frame types
      constants.ts        # ports, timings, retry budgets
    tools/                # one module per tool family, registered by index.ts
      workspace.ts        # file read/write/edit, list_files, search paths
      search.ts           # search_files (grep)
      debug.ts            # debugger tools
      navigation.ts       # go-to-definition, references, hover, rename
      lsp.ts, editors.ts, terminal.ts, commands.ts, configuration.ts, logs.ts
utils/
  path.ts                 # resolvePath, boundary and symlink handling
  openEditors.ts          # open-editor / workspace state snapshots
  timeout.ts, metrics.ts, jsonc.ts, serverLog.ts
test/                     # vitest unit suites (src/test, excludes e2e)
  e2e/                    # real-VS-Code suites (RUN_E2E gated)
```

### Cluster routing

`leader.ts` `resolveTarget` picks the window for a `tools/call`:

1. top-level `workspace` param (window id, instance id, display name, folder
   path or folder basename);
2. the same references as tool arguments (`workspaceFolder`);
3. path inference: any path-like argument routes to the window whose workspace
   is the longest prefix of that path;
4. otherwise the leader runs the call locally.

Path resolution inside a window goes through `utils/path.ts` `resolvePath`:
absolute paths are used as-is, relative paths resolve against the selected
workspace folder, symlinks are resolved segment by segment, and anything that
lands outside the workspace is rejected. New path-taking tools must use it —
that is what makes a tool cluster-routable and boundary-safe.

## Commands

```bash
npm run check     # typecheck + biome + markdownlint
npm run lint:fix  # apply biome/markdownlint fixes
npm test          # unit suites (vitest)
npm run compile   # tsc -> out/
npm run test:e2e  # E2E against a real VS Code (downloads VS Code; xvfb on CI)
```

E2E suites spawn VS Code detached and must tear the whole process group down
through `src/test/e2e/platform.ts` `stopVSCodeProcess`, which waits for the
group to drain before escalating. Never call `proc.kill()` directly in e2e.

## Conventions

- Keep tool schemas self-describing: every property needs a `description`.
- Tool results are `{ content: [{ type: "text", text }], isError }`; error
  messages must say what was wrong and what the caller can do.
- No secrets or personal data in source, tests, fixtures, logs or PR text.
- Do not claim stronger guarantees than the vscode API gives: `applyEdit` has
  no rollback, deletes can go to the OS trash.
- Work on a branch/worktree; `main` is PR-only and every push to `main`
  publishes a stable release.

## Release flow

Merging to `main` runs the release guard, publishes stable to the Marketplace
with `vsce`, tags `vX.Y.Z`, and opens a version-sync PR. The guard publishes
when anything changed since the last `v*` tag is shipping; `package-lock.json`,
`.github/**` and version-only / inert-devDependency `package.json` changes are
non-shipping. PRs also publish pre-releases on the `0.9.x` line. See
`RELEASE.md` and `.github/workflows/ci.yml`.
