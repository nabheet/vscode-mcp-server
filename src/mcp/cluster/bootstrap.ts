/**
 * Cluster bootstrap — the single entry point each VS Code window runs on
 * activation (and re-runs after losing its Leader).
 *
 * Algorithm (bounded retry loop over base..base+MAX_PORT_SCAN-1):
 *  - probe /health on 127.0.0.1:port (this namespace)
 *    • valid   → join as Worker over the HTTP member channel on the same
 *                host:port. Join failure → retry the SAME port (never
 *                increment — that fragments the cluster).
 *    • free    → if crossBoundaryHosts is configured, probe each candidate
 *                host (e.g. host.docker.internal) before promoting:
 *                - valid   → join over HTTP. Join failure → retry same port.
 *                - timeout → possible frozen Leader in the other namespace,
 *                            but only for CROSS_BOUNDARY_TIMEOUT_LIMIT
 *                            consecutive attempts. A host that never answers
 *                            (e.g. Docker Desktop's VM gateway silently
 *                            dropping SYNs to unforwarded ports) is treated as
 *                            absent after that, and we promote locally — a
 *                            container with no host Leader must be able to
 *                            elect itself.
 *                - free/foreign → try the next candidate host.
 *                Only when every candidate is free/foreign (or the timeout
 *                patience window has been exhausted) do we promote.
 *    • foreign → unrelated app squatting the port → try next port
 *    • timeout → occupied, no HTTP signature: a frozen/starting Leader or a
 *                non-HTTP app. Retry the SAME port (never increment — that
 *                fragments the cluster); it may unfreeze, or die and free
 *                the port for promotion.
 *  - registration/promotion races (leader died mid-handshake, two windows
 *    promoted simultaneously) fall out of the loop naturally: re-probe and
 *    retry with exponential backoff + jitter.
 */

import type { Metrics } from "../../utils/metrics";
import type { ServerLog } from "../../utils/serverLog";
import type { ToolExecutor } from "../executor";
import {
  CROSS_BOUNDARY_TIMEOUT_LIMIT,
  MAX_ELECTION_ATTEMPTS,
  MAX_PORT_SCAN,
  REELECT_JITTER_MS,
} from "./constants";
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
  authToken?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
  /**
   * Hosts to probe (in order) when the local port is free, before promoting.
   * Container windows pass [host.docker.internal] to reach a Leader running
   * on the host; host windows pass nothing (they reach a container Leader
   * via the loopback valid-probe + HTTP join path).
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
  const crossHosts = opts.crossBoundaryHosts ?? [];
  let delay = 250;
  let crossBoundaryTimeoutStreak = 0;

  for (let attempt = 0; attempt < MAX_ELECTION_ATTEMPTS; attempt++) {
    for (let offset = 0; offset < maxPorts; offset++) {
      const port = base + offset;
      const probe = await probePort(port);

      if (probe.status === "valid") {
        // Join over the HTTP member channel on the same host:port (works
        // for same-namespace windows AND a container leader reachable
        // through a forwarded port).
        const worker = await tryJoinHttp(port, "127.0.0.1", opts);
        if (worker) {
          opts.log?.(`[mcp] Joined leader on port ${port} as worker`);
          return worker;
        }
        // Leader died mid-handshake: back off and retry the SAME port on
        // the next attempt (never increment — that fragments the cluster).
        break;
      }

      if (probe.status === "timeout") {
        // Occupied but silent: a frozen/starting Leader (or a non-HTTP app
        // squatting the port). Do NOT skip or promote — retry the SAME port
        // on the next attempt (it may unfreeze, or die and free the port).
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
              // Occupied but silent. Locally this means a frozen Leader and we
              // must keep retrying the same port. Cross-boundary, a host that
              // silently drops SYNs (Docker Desktop's VM gateway) also looks
              // like this — but there may be no Leader at all. Give a real
              // (frozen or starting) host Leader a bounded window, then treat
              // the host as absent and promote locally.
              crossBoundaryTimeoutStreak += 1;
              if (crossBoundaryTimeoutStreak < CROSS_BOUNDARY_TIMEOUT_LIMIT) {
                opts.log?.(
                  `[mcp] Cross-boundary probe ${host}:${port} timed out ` +
                    `(${crossBoundaryTimeoutStreak}/${CROSS_BOUNDARY_TIMEOUT_LIMIT}) — ` +
                    `retrying same port`,
                );
                joinedOrRetry = true;
                break;
              }
              opts.log?.(
                `[mcp] Cross-boundary probe ${host}:${port} timed out ` +
                  `${CROSS_BOUNDARY_TIMEOUT_LIMIT} consecutive attempts — ` +
                  `no host leader reachable, promoting locally`,
              );
              crossBoundaryTimeoutStreak = 0;
              break;
            }
            // free / foreign → try the next candidate host
          }
          if (joinedOrRetry) break;
        }

        const leader = await tryPromote(port, opts);
        if (leader) {
          crossBoundaryTimeoutStreak = 0;
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

/** Join a Leader over the HTTP member channel on the given host:port. */
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

async function tryPromote(port: number, opts: BootstrapOptions): Promise<LeaderCoordinator | null> {
  const leader = new LeaderCoordinator({
    port,
    host: opts.host,
    ...(opts.hosts && opts.hosts.length > 0 ? { hosts: opts.hosts } : {}),
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
