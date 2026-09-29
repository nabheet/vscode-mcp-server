/**
 * Cluster bootstrap — the single entry point each VS Code window runs on
 * activation (and re-runs after losing its Leader).
 *
 * Algorithm (bounded retry loop over base..base+MAX_PORT_SCAN-1):
 *  - probe /health on 127.0.0.1:port (this namespace)
 *    • valid   → join as Worker over IPC. If that fails, fall back to
 *                joining over the HTTP member channel on the same host:port
 *                (covers a container leader reachable through a forwarded
 *                port). If both fail, retry the SAME port (never increment —
 *                that fragments the cluster).
 *    • free    → if crossBoundaryHosts is configured, probe each candidate
 *                host (e.g. host.docker.internal) before promoting:
 *                - valid   → join over HTTP. Join failure → retry same port.
 *                - timeout → possible frozen Leader → retry same port.
 *                - free/foreign → try the next candidate host.
 *                Only when every candidate is free/foreign do we promote.
 *    • foreign → unrelated app squatting the port → try next port
 *    • zombie  → occupied, no HTTP signature, but IPC pipe alive: a frozen
 *                or still-starting Leader. Retry registration on the SAME
 *                port (never increment — that fragments the cluster).
 *  - registration/promotion races (leader died mid-handshake, two windows
 *    promoted simultaneously) fall out of the loop naturally: re-probe and
 *    retry with exponential backoff + jitter.
 */

import type { Metrics } from "../../utils/metrics";
import type { ServerLog } from "../../utils/serverLog";
import type { ToolExecutor } from "../executor";
import { getIpcPath, MAX_ELECTION_ATTEMPTS, MAX_PORT_SCAN, REELECT_JITTER_MS } from "./constants";
import { jitter, probeHost, probePort, sleep } from "./election";
import { LeaderCoordinator } from "./leader";
import { HttpMemberTransport, memberBaseUrl } from "./memberTransport";
import type { WindowState } from "./protocol";
import { WorkerCoordinator } from "./worker";

export type ClusterMember = LeaderCoordinator | WorkerCoordinator;

export interface BootstrapOptions {
  basePort: number;
  host: string;
  /** Secondary bind addresses for the leader's HTTP server (Linux hosts). */
  hosts?: string[];
  ipcPath?: string;
  authToken?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  /**
   * Hosts to probe (in order) when the local port is free, before promoting.
   * Container windows pass [host.docker.internal] to reach a Leader running
   * on the host; host windows pass nothing (they reach a container Leader
   * via the loopback valid-probe + HTTP join fallback above).
   */
  crossBoundaryHosts?: string[];
  executor: ToolExecutor;
  metrics?: Metrics;
  logger?: ServerLog;
  workspaceId: string;
  workspacePaths: string[];
  displayName: string;
  /** Stable per-window UUID for wire-level identity (defaults to workspaceId). */
  instanceId?: string;
  /** Human-readable window name (defaults to displayName). */
  instanceName?: string;
  /** Initial window state (active file / open editors). */
  state?: WindowState;
  log?: (msg: string) => void;
}

export async function bootstrapCluster(opts: BootstrapOptions): Promise<ClusterMember> {
  const base = opts.basePort;
  const maxPorts = Math.max(1, MAX_PORT_SCAN);
  const ipcPath = opts.ipcPath ?? getIpcPath();
  const crossHosts = opts.crossBoundaryHosts ?? [];
  let delay = 250;

  for (let attempt = 0; attempt < MAX_ELECTION_ATTEMPTS; attempt++) {
    for (let offset = 0; offset < maxPorts; offset++) {
      const port = base + offset;
      const probe = await probePort(port, ipcPath);

      if (probe.status === "valid") {
        // Fast path: same namespace → IPC. Fallback: HTTP member channel on
        // the same host:port (container leader reachable via forwarded port).
        let worker = await tryJoinIpc(port, opts, ipcPath);
        if (!worker) worker = await tryJoinHttp(port, "127.0.0.1", opts);
        if (worker) {
          opts.log?.(`[mcp] Joined leader on port ${port} as worker`);
          return worker;
        }
        // Leader died mid-handshake: back off and retry the SAME port on
        // the next attempt (never increment — that fragments the cluster).
        break;
      }

      if (probe.status === "zombie") {
        // Frozen leader: do NOT skip the port. Try to rejoin; if that fails,
        // back off and retry this port on the next attempt (it may unfreeze,
        // or die and free the port for promotion).
        const worker = await tryJoinIpc(port, opts, ipcPath);
        if (worker) {
          opts.log?.(`[mcp] Rejoined leader on port ${port} after freeze`);
          return worker;
        }
        break;
      }

      if (probe.status === "free") {
        // Cross-boundary discovery: a Leader may live in another namespace
        // (container ↔ host). Probe candidates before promoting.
        if (crossHosts.length > 0) {
          let joinedOrRetry = false;
          for (const host of crossHosts) {
            const hp = await probeHost(port, host);
            if (hp.status === "valid") {
              const worker = await tryJoinHttp(port, host, opts);
              if (worker) {
                opts.log?.(`[mcp] Joined leader on ${host}:${port} over HTTP member channel`);
                return worker;
              }
              // Leader vanished mid-handshake: retry the SAME port later.
              joinedOrRetry = true;
              break;
            }
            if (hp.status === "timeout") {
              // Occupied but silent — possibly a frozen Leader in the other
              // namespace. Do NOT promote or skip; retry the same port.
              joinedOrRetry = true;
              break;
            }
            // free / foreign → try the next candidate host
          }
          if (joinedOrRetry) break;
        }

        const leader = await tryPromote(port, opts, ipcPath);
        if (leader) {
          opts.log?.(`[mcp] Promoted to leader on port ${port}`);
          return leader;
        }
      }

      // foreign → try next port
    }

    await sleep(delay + jitter(REELECT_JITTER_MS));
    delay = Math.min(delay * 2, 5000);
  }

  throw new Error(
    `Could not elect or join a leader after ${MAX_ELECTION_ATTEMPTS} attempts ` +
      `(ports ${base}..${base + maxPorts - 1})`,
  );
}

async function tryJoinIpc(
  port: number,
  opts: BootstrapOptions,
  ipcPath: string,
): Promise<WorkerCoordinator | null> {
  const worker = new WorkerCoordinator({
    ipcPath,
    executor: opts.executor,
    workspaceId: opts.workspaceId,
    workspacePaths: opts.workspacePaths,
    displayName: opts.displayName,
    instanceId: opts.instanceId ?? opts.workspaceId,
    instanceName: opts.instanceName ?? opts.displayName,
    state: opts.state,
    log: opts.log,
    // Re-election is wired by the owner (extension.ts) after the member is
    // returned: it must stop this worker, re-run bootstrapCluster, and swap
    // the member + update the UI.
  });
  try {
    await worker.start();
    return worker;
  } catch (err) {
    opts.log?.(
      `[mcp] Join on port ${port} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    await worker.stop(100);
    return null;
  }
}

/** Join a Leader over the HTTP member channel (cross-namespace). */
async function tryJoinHttp(
  port: number,
  host: string,
  opts: BootstrapOptions,
): Promise<WorkerCoordinator | null> {
  const scheme = opts.tlsCertPath && opts.tlsKeyPath ? "https" : "http";
  const transport = new HttpMemberTransport({
    baseUrl: memberBaseUrl(scheme, host, port),
    authToken: opts.authToken,
    log: opts.log,
  });
  const worker = new WorkerCoordinator({
    transport,
    executor: opts.executor,
    workspaceId: opts.workspaceId,
    workspacePaths: opts.workspacePaths,
    displayName: opts.displayName,
    instanceId: opts.instanceId ?? opts.workspaceId,
    instanceName: opts.instanceName ?? opts.displayName,
    state: opts.state,
    log: opts.log,
  });
  try {
    await worker.start();
    return worker;
  } catch (err) {
    opts.log?.(
      `[mcp] HTTP join on ${host}:${port} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    await worker.stop(100);
    return null;
  }
}

async function tryPromote(
  port: number,
  opts: BootstrapOptions,
  ipcPath: string,
): Promise<LeaderCoordinator | null> {
  const leader = new LeaderCoordinator({
    port,
    host: opts.host,
    ...(opts.hosts && opts.hosts.length > 0 ? { hosts: opts.hosts } : {}),
    ipcPath,
    ...(opts.authToken ? { authToken: opts.authToken } : {}),
    ...(opts.tlsCertPath && opts.tlsKeyPath
      ? { tlsCertPath: opts.tlsCertPath, tlsKeyPath: opts.tlsKeyPath }
      : {}),
    executor: opts.executor,
    metrics: opts.metrics,
    logger: opts.logger,
    workspaceId: opts.workspaceId,
    workspacePaths: opts.workspacePaths,
    displayName: opts.displayName,
    instanceId: opts.instanceId ?? opts.workspaceId,
    instanceName: opts.instanceName ?? opts.displayName,
    state: opts.state,
    log: opts.log,
  });
  try {
    await leader.start();
    return leader;
  } catch (err) {
    opts.log?.(
      `[mcp] Promotion on port ${port} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    await leader.stop(100);
    return null;
  }
}
