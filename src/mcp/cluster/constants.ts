/**
 * Cluster-wide constants for the Master-Worker single-port architecture.
 *
 * Every VS Code window runs one member of the cluster. Exactly one member
 * (the Master) owns the HTTP/SSE port; every other window (Worker) connects
 * to the Master over a local IPC pipe. Keeping these values in one module
 * makes the coordination protocol auditable and testable.
 */

/** Default HTTP port the Master listens on. */
export const DEFAULT_PORT = 6010;

/** /health response signature that identifies a valid Master. */
export const HEALTH_SERVICE = "vscode-mcp-server";

/** Well-known IPC path (POSIX socket or Windows named pipe). */
export const DEFAULT_IPC_PATH =
  process.platform === "win32" ? "\\\\.\\pipe\\vscode-mcp-ipc" : "/tmp/vscode-mcp-ipc.sock";

/** Env override so tests can use per-suite socket paths. */
export function getIpcPath(): string {
  return process.env.VSCODE_MCP_IPC_PATH || DEFAULT_IPC_PATH;
}

/** How many consecutive ports (base, base+1, ...) we scan before giving up. */
export const MAX_PORT_SCAN = Number(process.env.MCP_SERVER_MAX_RETRIES) || 5;

/** Overall bootstrap attempts (each scans MAX_PORT_SCAN ports). */
export const MAX_ELECTION_ATTEMPTS = 8;

/** HTTP GET timeout when probing a candidate master's /health. */
export const PROBE_TIMEOUT_MS = 2000;

/** How long a Worker waits for the Master's WELCOME after registering. */
export const REGISTER_TIMEOUT_MS = 5000;

/** How long a Worker waits for the Master to answer REGISTER before treating
 *  the master as frozen (event-loop blocked) and re-probing. */
export const ZOMBIE_REGISTER_TIMEOUT_MS = 4000;

/** IPC connect timeout (worker → master). */
export const IPC_CONNECT_TIMEOUT_MS = 3000;

/** Worker → Master heartbeat cadence. */
export const HEARTBEAT_INTERVAL_MS = 5000;

/** Missed PONGs (each = one heartbeat interval) before re-election. */
export const HEARTBEAT_MISS_LIMIT = 2;

/** Randomized delay added on top of re-election to avoid a thundering herd. */
export const REELECT_JITTER_MS = 500;

/** Master-side deadline for a proxied worker call (~tool timeout + margin). */
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
  /** Worker → Master: window state changed (active file / open editors). */
  UPDATE: "UPDATE",
} as const;
