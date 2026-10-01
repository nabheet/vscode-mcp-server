/**
 * Cluster-wide constants for the Leader-Worker single-port architecture.
 *
 * Every VS Code window runs one member of the cluster. Exactly one member
 * (the Leader) owns the HTTP/SSE port; every other window (Worker) connects
 * to the Leader over the HTTP member channel on that same port. Keeping
 * these values in one module makes the coordination protocol auditable and
 * testable.
 */

/** Default HTTP port the Leader listens on. */
export const DEFAULT_PORT = 9876;

/** /health response signature that identifies a valid Leader. */
export const HEALTH_SERVICE = "vscode-mcp-server";

/** How many consecutive ports (base, base+1, ...) we scan before giving up. */
export const MAX_PORT_SCAN = Number(process.env.MCP_SERVER_MAX_RETRIES) || 5;

/** Overall bootstrap attempts (each scans MAX_PORT_SCAN ports). */
export const MAX_ELECTION_ATTEMPTS = 8;

/** HTTP GET timeout when probing a candidate leader's /health. */
export const PROBE_TIMEOUT_MS = 2000;

/**
 * Consecutive cross-boundary probe timeouts (a candidate host that neither
 * refuses nor answers — e.g. Docker Desktop's VM gateway silently dropping
 * SYNs to unforwarded ports) tolerated before a container promotes itself.
 *
 * A real host leader answers within one probe, so the first timeout usually
 * means "no leader there (or unreachable)" rather than "frozen leader". The
 * bound exists so a container with no host leader still elects itself instead
 * of retrying the same port forever. Each timeout costs up to PROBE_TIMEOUT_MS,
 * so 3 ≈ 6s of patience before promoting locally.
 */
export const CROSS_BOUNDARY_TIMEOUT_LIMIT = 3;

/** How long a Worker waits for the Leader's WELCOME after registering. */
export const REGISTER_TIMEOUT_MS = 5000;

/** Worker → Leader heartbeat cadence. */
export const HEARTBEAT_INTERVAL_MS = 5000;

/** Missed PONGs (each = one heartbeat interval) before re-election. */
export const HEARTBEAT_MISS_LIMIT = 2;

/** Randomized delay added on top of re-election to avoid a thundering herd. */
export const REELECT_JITTER_MS = 500;

/** Leader-side deadline for a proxied worker call (~tool timeout + margin). */
export const PROXY_TIMEOUT_MS = 35_000;

/** Cluster protocol message types. */
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
// The Leader-Worker protocol travels over a TCP/HTTP "member channel" on
// the Leader's single HTTP port, so it works across mount namespaces (a
// dev-container window joining the host leader and vice versa) with no
// extra port or firewall rule:
//
//   Worker → Leader:  POST /cluster/message?id=<sessionId>
//                     body = one JSON IpcMessage; Leader acks 202.
//   Leader → Worker:  GET  /cluster/stream?id=<sessionId>   (SSE)
//                     event: message, one JSON IpcMessage per data: line.
//
// sessionId is a worker-generated UUID; both legs of the channel carry it
// so the Leader can associate the SSE stream with the POSTs that target it.
//
// The bearer token is REQUIRED whenever any bind is non-loopback (C1): the
// member channel proxies tools/call to every connected worker — including
// shell commands — so an unauthenticated non-loopback bind would expose
// remote code execution to anything that can reach those addresses. All
// cluster windows must share the same token. Loopback-only binds (the
// macOS/Windows default) need no token. CORS/origin checks still stop a
// malicious webpage from driving the channel via DNS rebinding. Mutual-auth
// + TLS is planned as an opt-in v2.

/** SSE receive leg of the member channel. */
export const CLUSTER_STREAM_PATH = "/cluster/stream";

/** POST send leg of the member channel. */
export const CLUSTER_MESSAGE_PATH = "/cluster/message";

/** Timeout for member-channel HTTP POSTs (REGISTER / CALL / PING / UPDATE). */
export const MEMBER_HTTP_TIMEOUT_MS = 10_000;

/** Extra attempts for member-channel POSTs before the sender gives up. */
export const MEMBER_POST_RETRIES = 2;

/** Delay between member-channel POST retries. */
export const MEMBER_POST_RETRY_DELAY_MS = 250;

/**
 * How long a silently-occupied local port is retried before it is treated
 * as foreign. A frozen/starting Leader answers nothing but may thaw; a
 * non-HTTP squatter never will. The window (2 min) is longer than the e2e
 * cluster-freeze test (~70s), so a frozen Leader is always re-joined, while
 * a permanent squatter only delays startup by the window.
 */
export const SILENT_PORT_WINDOW_MS = 120_000;

/** Cap on concurrent member-channel connections the Leader will hold. */
export const MAX_MEMBER_PEERS = 64;

/**
 * Default cross-boundary host a container window probes to reach the host
 * leader (Docker Desktop / OrbStack resolve this to the host loopback).
 * Linux docker daemons need `extra_hosts: ["host.docker.internal:host-gateway"]`
 * in devcontainer.json — see the README.
 */
export const CROSS_BOUNDARY_HOST_DEFAULT = "host.docker.internal";
