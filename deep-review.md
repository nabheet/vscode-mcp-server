# Deep Review: vscode-mcp-server

## Summary

The vscode-mcp-server project provides a useful bridge between VS Code and AI tooling via the Model Context Protocol. The codebase is cleanly organized, well-typed, and reasonably modular. However, it has several critical security issues stemming from the absence of workspace boundary enforcement, a number of correctness bugs (race conditions, double-decrement, orphaned listeners), missing test coverage for virtually all VS Code–dependent tool handlers, and architectural concerns around state management and shutdown hygiene. The `@modelcontextprotocol/sdk` dependency is unused dead weight.

## Findings by Severity

### CRITICAL

1. **Path traversal — no workspace boundary enforcement (`workspace.ts`, `navigation.ts`, `debug.ts`, `lsp.ts`)**  
   `resolvePath()` in `src/utils/path.ts` accepts any input and resolves it against the workspace root when relative, or uses it verbatim when absolute. There is **zero** validation that the resulting path stays within the workspace. A caller can use `/etc/passwd` or `../../../sensitive-file` to read, write, or delete any file the VS Code process can access.  
   **Affected tools**: `read_file`, `write_file`, `create_file`, `delete_file`, `open_file`, `open_file_at_line`, `open_file_at_position`, `add_breakpoint`, `remove_breakpoint`, `reveal_in_explorer`, `get_diagnostics` (when `args.uri` is provided).  
   **Fix**: After resolving, check that the resolved path is within one of the workspace folders. Reject absolute paths outside the workspace.

2. **No CSRF / origin validation — any website can call the server**  
   `Access-Control-Allow-Origin: *` is hardcoded. When `authToken` is empty (the default — empty string means "no auth"), any website loaded in a browser can make POST requests to `http://127.0.0.1:9876/mcp` and execute arbitrary VS Code commands or read/write files. If the user also has `execute_command` exposed (which runs any VS Code command ID), a malicious webpage can exfiltrate workspace files, inject code, or execute commands via extensions with shell capabilities.  
   **Fix**: Validate `Origin` header against an allowlist (e.g., `http://127.0.0.1:<port>` only) unless explicitly configured otherwise. Warn loudly in the output channel when auth is disabled.

3. **`execute_command` — arbitrary VS Code command execution**  
   The `execute_command` tool runs any VS Code command ID by calling `vscode.commands.executeCommand(command, ...cmdArgs)`. While documented, this is a powerful RCE primitive: many extensions register commands that execute shell commands (e.g., `workbench.action.terminal.sendSequence`, `git.commit`, debug launch commands). There is no allowlist or blocklist of permitted commands.  
   **Fix**: At minimum, log every invocation with the command ID and args. Consider an allowlist configuration for sensitive environments.

4. **`write_file` / `create_file` — arbitrary file write with no size or content limits**  
   `write_file` accepts a `path` and `content` string and writes it through `vscode.workspace.fs.writeFile`. There is no maximum content size, no binary-content guard, and no workspace-boundary check (see #1). A caller could write gigabytes of data, fill the disk, or overwrite critical files.  
   **Fix**: Enforce a configurable max write size. Validate path stays within workspace. Consider rejecting binary payloads.

### HIGH

5. **Race condition: `activeRequests` can underflow (`server.ts:137,154,182,186`)**  
   `activeRequests` is decremented in THREE places: (a) the `end` handler after normal processing (line 182), (b) the `end` handler after a 413 response (line 154), and (c) the `error` handler (line 186). If both `end` and `error` events fire (possible on stream destruction races), `activeRequests` underflows, permanently breaking the shutdown logic (which waits for `activeRequests === 0`).  
   **Fix**: Use a single cleanup path. Set a `handled` flag in the `data` event when `req.destroy()` is called. Check it in `end`/`error` and only decrement once.

6. **`req.destroy()` in `data` handler doesn't reliably produce 413 response (`server.ts:145`)**  
   When payload exceeds 10 MB, the `data` handler calls `req.destroy()`, which forcibly terminates the socket. The `end` handler that would send the 413 response never fires. The client sees a connection reset (ECONNRESET), not a clean 413. The test at `server.test.ts:245` acknowledges this ("may return 413 if the response is written before destruction") and only asserts `terminated === true`, making the test pass even if the server silently drops the connection.  
   **Fix**: Instead of destroying, buffer up to MAX_BODY + 1 KB and reject with 413. Or track overflow in the `data` handler, stop buffering, and send 413 in the `end` handler.

7. **Shutdown race: request accepted after `activeRequests === 0` check (`server.ts:73-88`)**  
   The `stop()` method checks `if (this.activeRequests === 0)` and then calls `this.server!.close()`. A new request arriving between the check and the `close()` call will be processed on a closing server. Node may still serve it, or it may fail with a race.  
   **Fix**: Set `shuttingDown = true` first (already done), then use `server.close(callback)` which stops accepting new connections and waits for existing ones to drain naturally. Remove the `activeRequests === 0` optimization.

8. **Port retry creates orphaned `McpServer` instances and duplicate disposables (`extension.ts:107-118`)**  
   Each retry in `startServerWithRetry` calls `new McpServer(opts)` and `registerAllTools(srv, context)` without stopping the previous attempt. The old server may have started listening but failed late (edge case). Worse, `registerTerminalTools` calls `ensureOutputCapture(context)` which pushes a `Disposable` to `context.subscriptions` **on every retry**. This means shell execution listeners accumulate with no cleanup path.  
   **Fix**: Stop the previous server before creating a new one. Track whether `ensureOutputCapture` has already been called (static boolean guard).

9. **Unused `@modelcontextprotocol/sdk` dependency (`package.json:58`)**  
   The package `@modelcontextprotocol/sdk` is listed as a runtime dependency but is never imported anywhere in the TypeScript source. It adds ~3-10 MB to the install size and is dead weight.  
   **Fix**: Remove it.

10. **Terminal output capture leaks on long-running processes (`terminal.ts:26`)**  
    The `for await (const data of event.execution.read())` loop has no timeout or cancellation. If a terminal runs `tail -f` or a watch command, the async iterator never completes, and the listener retains references to the terminal buffer forever.  
    **Fix**: Add a timeout or max-line limit to the async iteration. Or switch to `event.execution.read()` with a finite buffer.

11. **`debug.ts:245` — import statement at bottom of file**  
    `import { resolvePath } from '../../utils/path'` is placed on line 245, AFTER the `registerDebugTools` function that uses it (via `add_breakpoint` and `remove_breakpoint`). While ES module imports are hoisted, this is extremely misleading, breaks readability, and likely indicates a botched refactor.  
    **Fix**: Move the import to the top of the file with the other imports.

### MEDIUM

12. **`resolvePath` fallback uses `path.resolve()` when no workspace is open (`path.ts:18`)**  
    When there is no workspace, relative paths are resolved against the VS Code process's current working directory (often `~` or `/`). This is unpredictable and can silently resolve to unintended locations. Combined with the lack of boundary checks, this makes the "no workspace" case a security wildcard.  
    **Fix**: Either reject relative paths when no workspace is open, or document the behavior and add a warning log.

13. **Auth token comparison is vulnerable to timing attacks (`server.ts:122`)**  
    `auth.slice(7) !== this.options.authToken` uses a direct string comparison (not `timingSafeEqual`). While localhost attacks are unlikely, a token transmitted over HTTP without TLS is trivially sniffable, and this comparison method theoretically leaks the token length and character-by-character timing.  
    **Fix**: Use `crypto.timingSafeEqual` for token comparison. Also: the TLS config warns but still falls back to HTTP — if auth is set, TLS should be strongly encouraged.

14. **No minimum TLS version / cipher configuration (`server.ts:44-48`)**  
    `https.createServer(tlsOpts, …)` uses Node.js defaults, which may include TLS 1.0/1.1 and weak ciphers depending on the Node version.  
    **Fix**: Specify `minVersion: 'TLSv1.2'` in `tlsOpts` and consider `secureOptions` to disable weak ciphers.

15. **`stop()` can call `server.close()` twice (`server.ts:78-86`)**  
    If `activeRequests === 0`, `server.close()` is called immediately (line 86). Then `setTimeout` calls `this.server.close()` again at line 81 if the timeout fires before `close` emits. Node ignores duplicate close(), but the redundant call indicates a logic issue.  
    **Fix**: Track whether close has been initiated.

16. **`vscode.debug.stopDebugging(undefined)` returns success even when nothing stopped (`debug.ts:51`)**  
    The `stop_debugging` tool passes `vscode.debug.activeDebugSession || undefined` to `stopDebugging`. If there is no active debug session, `stopDebugging(undefined)` is a no-op, but the tool returns `"Debug session stopped"` with `isError: false`. The caller has no way to know nothing happened.  
    **Fix**: Check for an active session first and return an error if none exists.

17. **`get_diagnostics` with no arguments can return a massive response (`lsp.ts:167`)**  
    `vscode.languages.getDiagnostics()` called without arguments returns diagnostics for ALL open documents in the workspace. On a large project, this could be megabytes of JSON. There's no page size, no filter, and no cap.  
    **Fix**: Limit to the active editor's diagnostics only, or add a `max` parameter with a reasonable default.

18. **`normaliseLocation` fallback creates garbage URI (`lsp.ts:25`)**  
    The fallback `vscode.Uri.file(String(loc))` converts any unexpected location to a string. If `loc` is an object, this becomes `file:///[object Object]`, which will fail with an opaque error downstream.  
    **Fix**: Return an error instead of trying to construct a nonsensical URI.

19. **`create_file` stat-then-write is racy (`workspace.ts:108-117`)**  
    `create_file` checks `vscode.workspace.fs.stat(uri)` to see if a file exists, then writes. Between the stat and the write, another process or concurrent request could create the file. The write would silently overwrite rather than failing.  
    **Fix**: Use the `create` flag if the VS Code filesystem API supports it, or accept the race with documentation.

20. **`list_files` uses `recursive: false` on delete (`workspace.ts:142`)**  
    The `delete_file` tool sets `{ recursive: false, useTrash }`. This means deleting a directory will fail. The error message will be confusing.  
    **Fix**: Support recursive directory deletion via an explicit parameter, or clarify in the tool description that only files can be deleted.

### LOW

21. **`terminalBuffers` grows unboundedly (`terminal.ts:9`)**  
    Module-level Map `terminalBuffers` accumulates entries for every terminal ever created. When a terminal is closed by the user, its buffer is never cleaned up.  
    **Fix**: Listen to `vscode.window.onDidCloseTerminal` to remove entries from the map.

22. **Config change detection only logs — no hot-reload (`extension.ts:76-80`)**  
    When settings change, the extension just logs "restart VS Code to apply changes". A user changing the port or auth token must reload the window. Dynamic reconfiguration is a common VS Code extension pattern that's missing here.  
    **Fix**: Implement hot-reload: stop the old server and start a new one with the updated config.

23. **JSON-RPC error code mapping is incomplete (`server.ts:166-171`)**  
    The HTTP status mapping handles only standard JSON-RPC error codes. The MCP-specific error codes defined in `ErrorCode` (e.g., `ToolNotFound: -32001`, `ToolExecutionError: -32002`, `VscodeApiError: -32003`) are never used anywhere. They are dead code.  
    **Fix**: Either use them in `transport.ts` or remove them from `types.ts`.

24. **`handleRequest` in `transport.ts` ignores `ErrorCode` constants**  
    The `ErrorCode` object in `types.ts` defines constants like `ParseError: -32700`, but `transport.ts` uses literal numbers (`-32700`, `-32600`, etc.) and `ErrorCode` is never imported.  
    **Fix**: Import and use the `ErrorCode` constants for consistency.

25. **`requireEditor` return type uses `any` casts (`lsp.ts:6-13`)**  
    The return type of `requireEditor()` is a convoluted conditional type that ultimately resorts to `as any` to satisfy the compiler. This bypasses all type safety.  
    **Fix**: Simplify to a discriminated union or return a tuple.

26. **No health-check endpoint**  
    There is no `/health` or `/ping` endpoint. The only valid path is `/mcp`. Clients have no way to verify connectivity without sending a `tools/list` JSON-RPC request.  
    **Fix**: Add a simple `GET /health → 200 OK` endpoint.

27. **Breakpoint comparison by `fsPath` is case-sensitive (`debug.ts:134`)**  
    On macOS (case-insensitive by default) and Windows, `loc.uri.fsPath === uri.fsPath` can miss breakpoints if paths differ only in casing.  
    **Fix**: Compare `uri.toString()` instead.

28. **README lists tools that don't exist**  
    The README includes `run_command`, `run_code_action`, `run_task`, `get_context_actions`, `go_to_line`, `search_files`, `open_settings`, `edit_file`, `search_text`, `set_breakpoints`, `get_debug_state`, `create_terminal`, `send_to_terminal`, `get_terminal_content`, `get_symbols` — none of these exist in the source code. Only 4 of the tools in `navigation.ts` and `workspace.ts` match. The README describes an older or aspirational API.  
    **Fix**: Update README to match actual registered tools.

### INFO

29. **Test coverage for transport.ts is good but pure-logic only**  
    The `transport.test.ts` covers JSON-RPC parsing, schema validation, method dispatch, and error wrapping thoroughly. However, it never exercises real tool handlers, so the tests validate the plumbing but not the actual behavior.

30. **`setup.ts` mock for `vscode` is minimal**  
    The vscode mock is a skeleton: `commands.executeCommand` is a mock, `workspace.fs` is absent, `window.activeTextEditor` is absent, `debug` is absent. Many tool modules cannot be unit-tested against this mock without significant additions.

## Test Coverage Gaps

1. **Zero tests for VS Code–dependent tool handlers** — The following modules have **no functional tests**:
   - `commands.ts` (no test executes `execute_command` or `list_commands`)
   - `navigation.ts` (no test opens files, selects lines, or reveals in explorer)
   - `workspace.ts` (no test reads, writes, creates, or deletes files)
   - `debug.ts` (no test starts/ stops debugging, manages breakpoints, gets variables)
   - `terminal.ts` (no test creates terminals, executes commands, or reads output)
   - `lsp.ts` (no test calls any LSP tool)
   - `extension.ts` (no test for activation, deactivation, port retry)

2. **`tools.test.ts` explicitly skips LSP and terminal** — Lines 62-63: `// LSP tools need document, skip in unit test` and `// registerTerminalTools needs real ExtensionContext, skip`. This leaves 11 tool definitions (LSP: 12 tools, Terminal: 2 tools) with zero coverage.

3. **No path traversal tests** — `path.test.ts` never tests `resolvePath('../../../etc/passwd')` with a workspace open to verify that the extension doesn't prevent directory escape.

4. **No concurrent request tests** — No test sends multiple simultaneous requests to check `activeRequests` accounting, deadlock, or race conditions.

5. **No TLS test** — All server tests use HTTP. TLS cert loading, HTTPS server creation, and behavior with missing/invalid certs are untested.

6. **No shutdown-during-request test** — No test sends a request and calls `stop()` before the request completes.

7. **No payload edge case tests** — No tests for empty body (`""`), deeply nested JSON (stack overflow), duplicate keys, Unicode BOM, or extremely long method names.

8. **No auth edge case tests** — No test for: empty auth token (after setting one), token with extra whitespace, token sent as query param, token in `Authorization: token <x>` (no Bearer prefix).

9. **No port-retry test** — `startServerWithRetry` in `extension.ts` is never called in tests because extension.ts is not tested.

10. **`server.test.ts` payload test is weak** — The "rejects payloads over 10MB" test only asserts `terminated === true` without verifying the HTTP status code or error message.

## Recommendations

### Immediate (Security)
1. **Add workspace boundary enforcement**: After resolving, check the path is within a workspace folder. Reject absolute paths outside the workspace unless explicitly allowed by configuration.
2. **Add Origin header validation**: Restrict `Access-Control-Allow-Origin` to `http://127.0.0.1:<port>` by default. Warn when auth is disabled.
3. **Add an allowlist for `execute_command`**: At minimum, block known-dangerous commands or require explicit configuration.
4. **Add max write-size enforcement**: Cap `write_file` content at a configurable limit (e.g., 1 MB).

### Correctness
5. **Fix `activeRequests` double-decrement**: Use a guard flag. Refactor to a single cleanup path.
6. **Fix 413 response**: Buffer up to MAX_BODY + 1 KB and send a proper 413 in the `end` handler instead of destroying the socket.
7. **Fix shutdown race**: Remove the `activeRequests === 0` optimization. Just call `server.close()` after setting `shuttingDown`.
8. **Fix port retry cleanup**: Stop the previous server instance before creating a new one. Guard `ensureOutputCapture` against duplicate registration.
9. **Move `resolvePath` import in `debug.ts` to the top of the file.**

### Architecture
10. **Remove unused `@modelcontextprotocol/sdk` dependency.**
11. **Convert `terminal.ts` module-level state to instance-based** with proper cleanup on terminal close.
12. **Add hot-reload support** for config changes instead of requiring a VS Code restart.

### Test Coverage
13. **Add integration tests** for all tool handlers using a real or more complete mock of VS Code APIs.
14. **Add path traversal tests** to `path.test.ts`.
15. **Add concurrent request tests** to `server.test.ts`.
16. **Add TLS tests** (at minimum, cert loading from disk).
17. **Add terminal and LSP tool tests** — the current skips in `tools.test.ts` leave a large gap.

### Reliability
18. **Add a timeout to the terminal output `for await` loop** to prevent leaks from long-running commands.
19. **Cap `get_diagnostics` output** to avoid overwhelming responses.
20. **Clean up `terminalBuffers` on terminal close** by listening to `onDidCloseTerminal`.


