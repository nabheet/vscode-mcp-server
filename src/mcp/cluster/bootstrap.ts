/**
 * Cluster bootstrap — the single entry point each VS Code window runs on
 * activation (and re-runs after losing its Master).
 *
 * Algorithm (bounded retry loop over base..base+MAX_PORT_SCAN-1):
 *  - probe /health on the port
 *    • valid   → join as Worker. If the join handshake fails, retry the SAME
 *                port (never increment — that fragments the cluster).
 *    • free    → promote to Master (bind IPC pipe + HTTP)
 *    • foreign → unrelated app squatting the port → try next port
 *    • zombie  → occupied, no HTTP signature, but IPC pipe alive: a frozen
 *                or still-starting Master. Retry registration on the SAME
 *                port (never increment — that fragments the cluster).
 *  - registration/promotion races (master died mid-handshake, two windows
 *    promoted simultaneously) fall out of the loop naturally: re-probe and
 *    retry with exponential backoff + jitter.
 */

import type { Metrics } from "../../utils/metrics";
import type { ServerLog } from "../../utils/serverLog";
import type { ToolExecutor } from "../executor";
import { getIpcPath, MAX_ELECTION_ATTEMPTS, MAX_PORT_SCAN, REELECT_JITTER_MS } from "./constants";
import { jitter, probePort, sleep } from "./election";
import { MasterCoordinator } from "./master";
import type { WindowState } from "./protocol";
import { WorkerCoordinator } from "./worker";

export type ClusterMember = MasterCoordinator | WorkerCoordinator;

export interface BootstrapOptions {
  basePort: number;
  host: string;
  ipcPath?: string;
  authToken?: string;
  tlsCertPath?: string;
  tlsKeyPath?: string;
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
  let delay = 250;

  for (let attempt = 0; attempt < MAX_ELECTION_ATTEMPTS; attempt++) {
    for (let offset = 0; offset < maxPorts; offset++) {
      const port = base + offset;
      const probe = await probePort(port, ipcPath);

      if (probe.status === "valid") {
        const worker = await tryJoin(port, opts, ipcPath);
        if (worker) {
          opts.log?.(`[mcp] Joined master on port ${port} as worker`);
          return worker;
        }
        // Master died mid-handshake: back off and retry the SAME port on
        // the next attempt (never increment — that fragments the cluster).
        break;
      }

      if (probe.status === "zombie") {
        // Frozen master: do NOT skip the port. Try to rejoin; if that fails,
        // back off and retry this port on the next attempt (it may unfreeze,
        // or die and free the port for promotion).
        const worker = await tryJoin(port, opts, ipcPath);
        if (worker) {
          opts.log?.(`[mcp] Rejoined master on port ${port} after freeze`);
          return worker;
        }
        break;
      }

      if (probe.status === "free") {
        const master = await tryPromote(port, opts, ipcPath);
        if (master) {
          opts.log?.(`[mcp] Promoted to master on port ${port}`);
          return master;
        }
      }

      // foreign → try next port
    }

    await sleep(delay + jitter(REELECT_JITTER_MS));
    delay = Math.min(delay * 2, 5000);
  }

  throw new Error(
    `Could not elect or join a master after ${MAX_ELECTION_ATTEMPTS} attempts ` +
      `(ports ${base}..${base + maxPorts - 1})`,
  );
}

async function tryJoin(
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

async function tryPromote(
  port: number,
  opts: BootstrapOptions,
  ipcPath: string,
): Promise<MasterCoordinator | null> {
  const master = new MasterCoordinator({
    port,
    host: opts.host,
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
    await master.start();
    return master;
  } catch (err) {
    opts.log?.(
      `[mcp] Promotion on port ${port} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    await master.stop(100);
    return null;
  }
}
