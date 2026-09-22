/**
 * Cluster-wide constants for the Leader-Worker single-port architecture.
 *
 * Every VS Code window runs one member of the cluster. Exactly one member
 * (the Leader) owns the HTTP/SSE port; every other window (Worker) connects
 * to the Leader over a local IPC pipe. Keeping these values in one module
 * makes the coordination protocol auditable and testable.
 */
import * as os from "node:os";
import * as path from "node:path";

/** Default HTTP port the Leader listens on. */
export const DEFAULT_PORT = 9876;

/** /health response signature that identifies a valid Leader. */
export const HEALTH_SERVICE = "vscode-mcp-server";

/**
 * Well-known IPC path (POSIX socket or Windows named pipe).
 *
 * On POSIX the socket lives inside a dedicated subdirectory of the OS temp
 * dir rather than as a bare file in the tmp root — the directory is created
 * on demand (mode 0700) before binding, so the well-known path is
 * `<dir>/<name>` (e.g. `<tmpdir>/vscode-mcp/ipc.sock`). Windows keeps the
 * named pipe unchanged.
 */
export const DEFAULT_IPC_PATH =
  process.platform === "win32"
    ? "\\\\.\\pipe\\vscode-mcp-ipc"
    : path.join(os.tmpdir(), "vscode-mcp", "ipc.sock");

/**
 * Resolve the IPC path with the documented precedence:
 * explicit setting → env var → default.
 */
export function resolveIpcPath(setting?: string, env?: string): string {
  return setting || env || DEFAULT_IPC_PATH;
}

/** Env override so tests can use per-suite socket paths. */
export function getIpcPath(): string {
  return resolveIpcPath(undefined, process.env.VSCODE_MCP_IPC_PATH);
}

/** How many consecutive ports (base, base+1, ...) we scan before giving up. */
export const MAX_PORT_SCAN = Number(process.env.MCP_SERVER_MAX_RETRIES) || 5;

/** Overall bootstrap attempts (each scans MAX_PORT_SCAN ports). */
export const MAX_ELECTION_ATTEMPTS = 8;

/** HTTP GET timeout when probing a candidate leader's /health. */
export const PROBE_TIMEOUT_MS = 2000;

/** How long a Worker waits for the Leader's WELCOME after registering. */
export const REGISTER_TIMEOUT_MS = 5000;

/** How long a Worker waits for the Leader to answer REGISTER before treating
 *  the leader as frozen (event-loop blocked) and re-probing. */
export const ZOMBIE_REGISTER_TIMEOUT_MS = 4000;

/** IPC connect timeout (worker → leader). */
export const IPC_CONNECT_TIMEOUT_MS = 3000;

/** Worker → Leader heartbeat cadence. */
export const HEARTBEAT_INTERVAL_MS = 5000;

/** Missed PONGs (each = one heartbeat interval) before re-election. */
export const HEARTBEAT_MISS_LIMIT = 2;

/** Randomized delay added on top of re-election to avoid a thundering herd. */
export const REELECT_JITTER_MS = 500;

/** Leader-side deadline for a proxied worker call (~tool timeout + margin). */
export const PROXY_TIMEOUT_MS = 35_000;

/** Upper bound for a single IPC frame (protects against corrupt lengths). */
export const MAX_FRAME_BYTES = 256 * 1024 * 1024;

/** IPC message types. */
export const MSG = {
  REGISTER: "REGISTER",
  WELCOME: "WELCOME",
  CALL: "CALL",
  RESULT: "RESULT",
  PING: "PING",
  PONG: "PONG",
  /** Worker → Leader: window state changed (active file / open editors). */
  UPDATE: "UPDATE",
} as const;
