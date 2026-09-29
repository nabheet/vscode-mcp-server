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
 *
 * The setting is typed as `unknown` rather than `string` because
 * `vscode.workspace.getConfiguration().get()` surfaces raw settings.json
 * values at runtime — a hand-edited settings.json can hold a number or bool
 * even though the schema declares a string. A truthy non-string would
 * otherwise flow all the way to `net.createServer().listen(n)` and silently
 * bind a TCP port; we only accept genuine non-empty strings.
 */
export function resolveIpcPath(setting?: unknown, env?: string): string {
  const s = typeof setting === "string" ? sanitizeIpcPath(setting) : "";
  if (s) return s;
  const e = typeof env === "string" ? sanitizeIpcPath(env) : "";
  return e || DEFAULT_IPC_PATH;
}

/**
 * Return a safe socket path, or "" to signal "fall through to the next
 * source". Guards against values that silently change `net.listen()`
 * semantics:
 * - all-digit strings (e.g. `"18099"`) are interpreted by Node as TCP
 *   ports, binding an unauthenticated listener on all interfaces instead
 *   of a unix socket — reject;
 * - whitespace-only strings are a settings.json mistake — treat as unset;
 * - on POSIX a bare relative name (e.g. `"ipc.sock"`) binds in the process
 *   CWD, silently splitting the cluster across windows — require absolute;
 * - trailing slashes are stripped so `dirname()` (used by ensureIpcDir)
 *   and `listen()` agree instead of failing with EACCES.
 */
function sanitizeIpcPath(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed || /^\d+$/.test(trimmed)) return "";
  if (process.platform !== "win32" && !path.isAbsolute(trimmed)) return "";
  return trimmed;
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

// ── Member channel (HTTP/SSE) ────────────────────────────────────────
//
// The same Leader-Worker protocol travels over a TCP/HTTP "member channel"
// when the two windows cannot share the IPC pipe (different mount
// namespaces — a dev-container window joining the host leader and vice
// versa). The channel reuses the Leader's single HTTP port, so no extra
// port or firewall rule is needed:
//
//   Worker → Leader:  POST /cluster/message?id=<sessionId>
//                     body = one JSON IpcMessage; Leader acks 202.
//   Leader → Worker:  GET  /cluster/stream?id=<sessionId>   (SSE)
//                     event: message, one JSON IpcMessage per data: line.
//
// sessionId is a worker-generated UUID; both legs of the channel carry it
// so the Leader can associate the SSE stream with the POSTs that target it.
//
// v1 ships WITHOUT cluster-specific auth (issue #94 scope decision). Two
// cheap guards apply: CORS/origin checks (a malicious webpage cannot drive
// the channel via DNS rebinding) and the existing bearer-token check when
// the server is configured with authToken (all cluster windows must share
// that token). Mutual-auth + TLS is planned as an opt-in v2.

/** SSE receive leg of the member channel. */
export const CLUSTER_STREAM_PATH = "/cluster/stream";

/** POST send leg of the member channel. */
export const CLUSTER_MESSAGE_PATH = "/cluster/message";

/** Timeout for member-channel HTTP POSTs (REGISTER / CALL / PING / UPDATE). */
export const MEMBER_HTTP_TIMEOUT_MS = 10_000;

/**
 * Default cross-boundary host a container window probes to reach the host
 * leader (Docker Desktop / OrbStack resolve this to the host loopback).
 * Linux docker daemons need `extra_hosts: ["host.docker.internal:host-gateway"]`
 * in devcontainer.json — see the README.
 */
export const CROSS_BOUNDARY_HOST_DEFAULT = "host.docker.internal";
