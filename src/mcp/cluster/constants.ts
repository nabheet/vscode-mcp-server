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
