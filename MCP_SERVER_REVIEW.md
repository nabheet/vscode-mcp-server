# Code Review: vscode-mcp-server

## CRITICAL

### 1. debug.ts: SourceBreakpoint condition parameter type mismatch
**File:** `src/mcp/tools/debug.ts:106`
**Issue:** `vscode.SourceBreakpoint(location, condition?, hitCondition?)` expects `condition` as `string | undefined`. Line 106 passes a boolean expression (`cond?.includes('==') || ... ? true : false`), coercing to the string `"true"` or `"false"` — every breakpoint gets `"true"` as its condition string.
**Fix:** Simplify — pass `cond` directly as the condition. Remove the heuristic entirely.

## WARN

### 2. lsp.ts: get_document_symbols assumes flat SymbolInformation
**File:** `src/mcp/tools/lsp.ts:194-196`
**Issue:** `vscode.executeDocumentSymbolProvider` can return `DocumentSymbol[]` (hierarchical, uses `.range`) or `SymbolInformation[]` (flat, uses `.location`). Code assumes `SymbolInformation` — calling `s.location.range.start.line` on a `DocumentSymbol` throws (it has `.range` not `.location`).
**Fix:** Handle both shapes — check for `.location` vs `.range` before accessing.

### 3. extension.ts: Fragile port-in-use detection
**File:** `src/mcp/extension.ts:134`
**Issue:** `err.message.includes('already in use')` — fragile string matching. Won't match if Node or VS Code changes the error message.
**Fix:** Check `err.code === 'EADDRINUSE'` (set by the MCP server's error handler), then fall back to message matching.

### 4. terminal.ts: Shell execution listener never disposed
**File:** `src/mcp/tools/terminal.ts:29`
**Issue:** `vscode.window.onDidStartTerminalShellExecution()` returns a `Disposable`. It's never stored or disposed. On extension deactivate, the listener leaks.
**Fix:** Accept `context: vscode.ExtensionContext` in `registerTerminalTools` and push the disposable to `context.subscriptions`.

### 5. Duplicate resolvePath function
**Files:** `navigation.ts:7`, `workspace.ts:7`, `debug.ts:244`
**Issue:** Same `resolvePath` helper defined 3 times. Maintainability issue — fix in one place misses others.
**Fix:** Extract to `src/utils/path.ts` and import everywhere.

## INFO

### 6. commands.ts: args limited to string array
**File:** `src/mcp/tools/commands.ts:20`
**Issue:** `args` items typed `{ type: 'string' }` in schema — VS Code commands accept any type (numbers, objects, booleans).
**Suggestion:** Use `{}` (any type) or list `['string', 'number', 'boolean', 'object', 'null']`.

### 7. navigation.ts: select_lines no bounds check
**File:** `src/mcp/tools/navigation.ts:124`
**Issue:** `editor.document.lineAt(end)` will throw if `end` >= document line count. No clamp to `editor.document.lineCount - 1`.
**Suggestion:** Clamp `end` before using.

### 8. server.ts stop(): redundant close, timeout doesn't close
**File:** `src/mcp/server.ts:73-95`
**Issue:** The `stop()` method calls `server.close()` twice (promise callback + poll). The timeout at line 90 calls `resolve()` without actually closing the server.
**Suggestion:** Simplify — single `server.close()` in the timeout callback, remove the poll.

### 9. debug.ts: breakpoint condition heuristic unreliable
**File:** `src/mcp/tools/debug.ts:106`
**Issue:** Using `includes('==')` etc. to guess condition vs hitCondition is fragile. A proper condition like `x > 5 && y < 10` works, but `x == 5` could be either.
**Suggestion:** Add explicit `condition` and `hitCondition` fields to the tool schema.
